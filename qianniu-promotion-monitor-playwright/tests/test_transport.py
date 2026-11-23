"""Transport behavior tests: no real browser or platform requests."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import promotion_adapter
from promotion_adapter import PromotionAdapter, PromotionError


class FakePage:
    def __init__(self, errors=None):
        self.errors = list(errors or [])
        self.evaluations = 0
        self.closes = 0

    async def goto(self, *_args, **_kwargs):
        return None

    async def evaluate(self, _expression):
        if "Identity probe is not ready" in _expression:
            return {"shopName": "测试店", "nickName": "测试店:子账号"}
        self.evaluations += 1
        if self.errors:
            raise self.errors.pop(0)
        return {"writeAttempted": True}

    async def close(self):
        self.closes += 1


class FakeController:
    def __init__(self, _config, **_kwargs):
        self.promotion = FakePage()
        self.write_page = FakePage()
        self.context = self
        self.starts = self.connects = self.closes = 0
        self.open_error = None

    async def start(self, **_kwargs):
        self.starts += 1
        if self.open_error:
            raise self.open_error

    async def connect(self, **_kwargs):
        self.connects += 1

    def page(self, _role):
        return self.promotion

    async def new_page(self):
        return self.write_page

    async def close(self):
        self.closes += 1


class TransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.config = {"limits": {"pageSize": 500, "maxPages": 50, "retries": 1,
                                  "requestTimeoutSeconds": 1},
                       "thresholds": {"closeRoiBelow": 1.5, "closeChargeAbove": 30}}
        self.shop = {"id": "shop01", "store": "测试店", "expected_alimama_shop": "测试店",
                     "login_username": None, "browser_config_value": {}}
        self.factory_patch = patch.object(promotion_adapter, "PlaywrightBrowserController", FakeController)
        self.factory_patch.start()
        self.addCleanup(self.factory_patch.stop)
        self.sleep_patch = patch.object(promotion_adapter.asyncio, "sleep", AsyncMock())
        self.sleep_patch.start()
        self.addCleanup(self.sleep_patch.stop)
        self.recovery_patch = patch.object(promotion_adapter, "recovery_config", return_value=None)
        self.recovery_config = self.recovery_patch.start()
        self.addCleanup(self.recovery_patch.stop)

    async def test_connect_only_never_starts_and_detach_preserves_borrowed_page(self):
        adapter = PromotionAdapter(self.shop, self.config, connect_only=True)
        async with adapter:
            self.assertIs(adapter.page, adapter.controller.promotion)
        self.assertEqual(adapter.controller.starts, 0)
        self.assertEqual(adapter.controller.connects, 1)
        self.assertEqual(adapter.controller.closes, 1)
        self.assertEqual(adapter.controller.promotion.closes, 0)

    async def test_enter_failure_detaches(self):
        adapter = PromotionAdapter(self.shop, self.config)
        adapter.controller.open_error = RuntimeError("fixture failure")
        with self.assertRaises(PromotionError):
            await adapter.__aenter__()
        self.assertEqual(adapter.controller.closes, 1)

    async def test_expired_startup_reports_manual_login_without_cookie_lookup(self):
        adapter = PromotionAdapter(self.shop, self.config)
        adapter.controller.open_error = promotion_adapter.BrowserControllerError("login page", "login_required")
        lookup = Mock(side_effect=AssertionError("External login recovery is disabled"))
        adapter.controller.add_cookies = AsyncMock()
        with patch.object(promotion_adapter, "fetch_shop_cookies", lookup, create=True):
            with self.assertRaises(PromotionError) as raised:
                await adapter.__aenter__()
        self.assertEqual(raised.exception.code, "login_required")
        self.assertEqual(adapter.controller.starts, 1)
        self.assertEqual(adapter.controller.promotion.evaluations, 0)
        self.assertEqual(adapter.controller.closes, 1)
        lookup.assert_not_called()
        adapter.controller.add_cookies.assert_not_awaited()

    async def test_expired_scan_stops_at_failed_type_without_repeating_queries(self):
        for failed_type in promotion_adapter.URLS:
            with self.subTest(failed_type=failed_type):
                adapter = PromotionAdapter(self.shop, self.config)
                calls = []
                async def scan_page(_page, _filename, args):
                    calls.append(args["type"])
                    if args["type"] == ("keyword" if failed_type == "关键词推广" else "all-site"):
                        raise RuntimeError("Authentication required: session expired")
                    return {"shopName": "测试店", "nickName": "测试店:子账号", "rows": []}
                adapter._evaluate = scan_page
                lookup = Mock(side_effect=AssertionError("External login recovery is disabled"))
                adapter.controller.add_cookies = AsyncMock()
                with patch.object(promotion_adapter, "fetch_shop_cookies", lookup, create=True):
                    with self.assertRaises(PromotionError) as raised:
                        async with adapter:
                            await adapter.scan("2026-11-14", True)
                self.assertEqual(raised.exception.code, "login_required")
                self.assertIn("人工登录", str(raised.exception))
                self.assertEqual(calls, ["all-site", "keyword"] if failed_type == "关键词推广" else ["all-site"])
                self.assertEqual(adapter.observed_identity, {"shopName": "测试店", "nickName": "测试店:子账号"})
                lookup.assert_not_called()
                adapter.controller.add_cookies.assert_not_awaited()

    async def test_expired_identity_probe_stops_before_business_query(self):
        adapter = PromotionAdapter(self.shop, self.config)
        adapter.controller.promotion.evaluate = AsyncMock(side_effect=RuntimeError("Authentication required"))
        adapter._evaluate = AsyncMock()
        async with adapter:
            with self.assertRaises(PromotionError) as raised:
                await adapter.scan("2026-11-14", True)
        self.assertEqual(raised.exception.code, "login_required")
        adapter.controller.promotion.evaluate.assert_awaited_once()
        adapter._evaluate.assert_not_awaited()

    async def test_startup_login_failure_recovers_exact_shop_before_scan(self):
        adapter = PromotionAdapter(self.shop, self.config)
        page = adapter.controller.promotion
        page.url = "https://one.alimama.com/index.html#!/login/index"
        page.is_closed = lambda: False
        adapter.controller.context = SimpleNamespace(pages=[page])
        adapter.controller.registrations = {}
        adapter.controller.browser = object()
        adapter.controller.open_error = promotion_adapter.BrowserControllerError("login", "login_required")
        self.recovery_config.return_value = (Path("private.json"), {"测试店": "飞书测试店"})
        attachment = [{"name": "cookie2", "value": "fixture", "domain": ".alimama.com"}]
        installed = []

        @asynccontextmanager
        async def replace(browser, selected, cookies):
            installed.append((browser, selected, cookies))
            yield

        with patch.object(promotion_adapter, "fetch_shop_cookies", return_value=attachment) as fetch, \
             patch.object(promotion_adapter, "replace_alimama_cookies", replace):
            async with adapter:
                self.assertEqual(adapter.observed_identity["shopName"], "测试店")
                self.assertEqual(adapter.login_recovery, {"status": "verified", "cookie_count": 1})
                self.assertEqual(installed, [(adapter.controller.browser, page, attachment)])
                with self.assertRaises(PromotionError):
                    await adapter._recover_login(page, "全站推", PromotionError("login_required", "expired"))
        fetch.assert_called_once_with(Path("private.json"), "飞书测试店")

    async def test_read_only_scan_retries_only_the_failed_promotion_type(self):
        adapter = PromotionAdapter(self.shop, self.config)
        adapter.page = adapter.controller.promotion
        identity = {"shopName": "测试店", "nickName": "测试店:子账号", "rows": []}
        with patch.object(adapter, "_evaluate", AsyncMock(side_effect=[
            identity, PromotionError("login_required", "expired"), identity,
        ])) as read, patch.object(adapter, "_recover_login", AsyncMock(return_value=adapter.page)) as recover:
            self.assertEqual(await adapter.scan("2026-11-23", True), [])
        self.assertEqual([call.args[-1]["type"] for call in read.await_args_list],
                         ["all-site", "keyword", "keyword"])
        recover.assert_awaited_once()

    async def test_cancelled_enter_detaches_and_preserves_cancellation(self):
        adapter = PromotionAdapter(self.shop, self.config)
        adapter.controller.open_error = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await adapter.__aenter__()
        self.assertEqual(adapter.controller.closes, 1)

    async def test_shop_cleanup_saves_and_closes_before_detaching(self):
        adapter = PromotionAdapter(self.shop, self.config, close_after_shop=True)
        adapter.controller.browser = object()
        events = []
        async def shutdown(controller):
            self.assertEqual(controller.closes, 0)
            events.append("native-close")
            return {"status": "closed", "cookie_sync": {"status": "saved"}}
        with patch.object(promotion_adapter, "save_and_close", shutdown):
            async with adapter:
                events.append("business")
        self.assertEqual(events, ["business", "native-close"])
        self.assertEqual(adapter.lifecycle_result["status"], "closed")
        self.assertEqual(adapter.controller.closes, 1)

    async def test_cleanup_failure_preserves_business_error_and_detaches(self):
        adapter = PromotionAdapter(self.shop, self.config, close_after_shop=True)
        adapter.controller.browser = object()
        error = promotion_adapter.BrowserControllerError("private diagnostic", "cookie_sync_failed",
                                                          details={"cookie_sync": {"status": "error"}})
        with patch.object(promotion_adapter, "save_and_close", AsyncMock(side_effect=error)):
            with self.assertRaisesRegex(PromotionError, "business failed"):
                async with adapter:
                    raise PromotionError("page_request_failed", "business failed")
        self.assertEqual(adapter.lifecycle_result["status"], "open")
        self.assertEqual(adapter.cleanup_errors[0]["code"], "cookie_sync_failed")
        self.assertNotIn("private diagnostic", str(adapter.lifecycle_result))
        self.assertEqual(adapter.controller.closes, 1)

    async def test_failed_page_registration_still_saves_attached_native_browser(self):
        adapter = PromotionAdapter(self.shop, self.config, close_after_shop=True)
        adapter.controller.browser = object()
        adapter.controller.open_error = promotion_adapter.BrowserControllerError("login page", "login_required")
        shutdown = AsyncMock(return_value={"status": "closed"})
        with patch.object(promotion_adapter, "save_and_close", shutdown):
            with self.assertRaises(PromotionError) as raised:
                await adapter.__aenter__()
        self.assertEqual(raised.exception.code, "login_required")
        shutdown.assert_awaited_once_with(adapter.controller)
        self.assertEqual(adapter.lifecycle_result["status"], "closed")
        self.assertEqual(adapter.controller.closes, 1)

    async def test_entry_error_is_checkpointed_before_native_cleanup(self):
        adapter = PromotionAdapter(self.shop, self.config, close_after_shop=True)
        adapter.controller.browser = object()
        adapter.controller.open_error = promotion_adapter.BrowserControllerError("login", "login_required")
        events = []
        adapter.on_entry_error = lambda error: events.append(("saved", error.code))
        async def shutdown(_controller):
            self.assertEqual(events, [("saved", "login_required")])
            return {"status": "closed"}
        with patch.object(promotion_adapter, "save_and_close", shutdown):
            with self.assertRaises(PromotionError):
                await adapter.__aenter__()

    async def test_cancelled_native_close_retains_cleanup_error(self):
        adapter = PromotionAdapter(self.shop, self.config, close_after_shop=True)
        adapter.controller.browser = object()
        shutdown = AsyncMock(side_effect=asyncio.CancelledError())
        with patch.object(promotion_adapter, "save_and_close", shutdown):
            with self.assertRaises(asyncio.CancelledError):
                async with adapter:
                    pass
        self.assertEqual(adapter.lifecycle_result["status"], "open")
        self.assertEqual(adapter.lifecycle_result["error"]["code"], "browser_close_failed")
        self.assertEqual(adapter.controller.closes, 1)

    async def test_keep_browser_never_calls_native_shutdown(self):
        adapter = PromotionAdapter(self.shop, self.config, close_after_shop=False)
        adapter.controller.browser = object()
        shutdown = AsyncMock()
        with patch.object(promotion_adapter, "save_and_close", shutdown):
            async with adapter:
                pass
        shutdown.assert_not_awaited()
        self.assertEqual(adapter.lifecycle_result["status"], "kept")

    async def test_pause_closes_only_its_owned_page_after_uncertain_write(self):
        adapter = PromotionAdapter(self.shop, self.config)
        adapter.controller.write_page.errors = [RuntimeError("Pause outcome uncertain; request timed out")]
        async with adapter:
            with self.assertRaises(PromotionError) as raised:
                await adapter.pause({"promotionType": "全站推", "campaignId": "123", "campaignName": "测试计划",
                                     "reportContext": {"startTime": "2026-09-26", "endTime": "2026-09-26"}})
            self.assertEqual(raised.exception.code, "write_uncertain")
        self.assertEqual(adapter.controller.write_page.evaluations, 1)
        self.assertEqual(adapter.controller.write_page.closes, 1)
        self.assertEqual(adapter.controller.promotion.closes, 0)

    async def test_uncertain_error_with_readiness_text_never_replays_write(self):
        adapter = PromotionAdapter(self.shop, self.config)
        page = FakePage([RuntimeError("Page.evaluate: Error: Pause outcome uncertain; do not retry write before reading current status: Campaign list is not ready")])
        with self.assertRaises(PromotionError) as raised:
            await adapter._evaluate(page, "pause_campaign.js", {"execute": True})
        self.assertEqual(raised.exception.code, "write_uncertain")
        self.assertEqual(page.evaluations, 1)

    async def test_exact_initial_readiness_failure_can_retry(self):
        adapter = PromotionAdapter(self.shop, self.config)
        page = FakePage([RuntimeError("Page.evaluate: Error: Campaign list is not ready\n    at pauseCampaignPage")])
        await adapter._evaluate(page, "pause_campaign.js", {"execute": True})
        self.assertEqual(page.evaluations, 2)

    async def test_account_alias_binds_actual_identity_even_with_zero_rows(self):
        self.shop.update(store="显示别名", expected_alimama_shop="显示别名", expected_shop_mode="account", login_username="实际店:子账号")
        adapter = PromotionAdapter(self.shop, self.config)
        events = []
        async def evaluate(_page, source, args):
            events.append((source == promotion_adapter.IDENTITY_PROBE, dict(args)))
            return {"shopName": "实际店", "nickName": "实际店:子账号", "rows": []}
        adapter._evaluate_source = evaluate
        async with adapter:
            self.assertEqual(await adapter.scan("2026-09-28", True), [])
        self.assertEqual(adapter.observed_identity, {"shopName": "实际店", "nickName": "实际店:子账号"})
        self.assertEqual([event[0] for event in events], [True, False, True, False])
        self.assertNotIn("expectedShop", events[0][1])
        self.assertEqual(events[0][1]["expectedAccount"], "实际店:子账号")
        self.assertTrue(all(item[1]["expectedShop"] == "实际店" for item in events[1:]))
        self.assertEqual(self.shop["store"], "显示别名")

    async def test_wrong_account_probe_blocks_first_business_query(self):
        self.shop.update(expected_shop_mode="account", login_username="测试店:正确子账号")
        adapter = PromotionAdapter(self.shop, self.config)
        async with adapter:
            with self.assertRaises(PromotionError) as raised:
                await adapter.scan("2026-09-28", True)
        self.assertEqual(raised.exception.code, "identity_mismatch")
        self.assertEqual(adapter.controller.promotion.evaluations, 0)

    async def test_cross_route_account_change_fails_before_second_query(self):
        self.shop.update(expected_shop_mode="account", login_username="测试店:子账号")
        adapter = PromotionAdapter(self.shop, self.config)
        events = []
        async def evaluate(_page, source, args):
            events.append((source == promotion_adapter.IDENTITY_PROBE, dict(args)))
            return {"shopName": "测试店", "nickName": "测试店:另一个账号" if len(events) == 3 else "测试店:子账号", "rows": []}
        adapter._evaluate_source = evaluate
        async with adapter:
            with self.assertRaises(PromotionError):
                await adapter.scan("2026-09-28", True)
        self.assertEqual([event[0] for event in events], [True, False, True])

    async def test_resume_probe_requires_saved_shop_and_account(self):
        self.shop.update(expected_shop_mode="account", login_username="测试店:子账号",
                         observed_identity={"shopName": "测试店", "nickName": "测试店:子账号"})
        adapter = PromotionAdapter(self.shop, self.config)
        arguments = []
        async def evaluate(_page, source, args):
            arguments.append(dict(args))
            return {"shopName": "别的店", "nickName": "测试店:子账号"}
        adapter._evaluate_source = evaluate
        async with adapter:
            with self.assertRaises(PromotionError):
                await adapter.scan("2026-09-28", True)
        self.assertEqual(len(arguments), 1)
        self.assertEqual(arguments[0]["expectedShop"], "测试店")
        self.assertEqual(arguments[0]["expectedAccount"], "测试店:子账号")


@unittest.skipUnless(shutil.which("node"), "Node is required for the pure JavaScript identity probe fixture")
class IdentityProbeTests(unittest.TestCase):
    def test_probe_reads_only_user_and_requires_exact_account_before_business_requests(self):
        script = r"""
const fs = require('fs'), vm = require('vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let businessRequests = 0, userReads = 0;
const view = {updater:{get:key=>{if(key!=='user')throw Error('Unexpected runtime read');userReads++;return {meta:{nickName:'实际店:子账号'}};}},
 requester:{campaign_horizontal_findPage_post:()=>{businessRequests++;throw Error('Unexpected business request');}}};
const magix={Vframe:{all:()=>({active:{path:'onesite/campaign-list',$v:view}})},Router:{},State:{}};
const sandbox={URL,location:{href:'https://one.alimama.com/index.html#!/manage/onesite'},window:{seajs:{cache:{m:{exports:magix}}}}};
const cases=[{type:'all-site',expectedAccount:'实际店:子账号'}, {type:'all-site',expectedAccount:'实际店:别人'},
 {type:'all-site',expectedShop:'另一个店',expectedAccount:'实际店:子账号'}, {type:'all-site'}];
const output=cases.map(args=>{try{return {value:vm.runInNewContext(input.source.replaceAll('__INPUT__',JSON.stringify(args)),sandbox)}}catch(e){return {error:e.message}}});
process.stdout.write(JSON.stringify({output,businessRequests,userReads}));
"""
        result = subprocess.run([shutil.which("node"), "-e", script], input=json.dumps({"source": promotion_adapter.IDENTITY_PROBE}),
                                text=True, capture_output=True, check=True, encoding="utf-8")
        value = json.loads(result.stdout)
        self.assertEqual(value["businessRequests"], 0)
        self.assertEqual(value["output"][0]["value"], {"shopName": "实际店", "nickName": "实际店:子账号"})
        self.assertIn("Account identity", value["output"][1]["error"])
        self.assertIn("Shop identity", value["output"][2]["error"])
        self.assertIn("expected identity", value["output"][3]["error"])


class NativeExitCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_confirmed_native_exit_only_stops_driver_and_releases_lock(self):
        from playwright_controller import PlaywrightBrowserController
        controller = PlaywrightBrowserController({"user_data_dir": ".",
            "browser_sessions": {"promotion": {"url": "http://localhost/"}}})
        browser = Mock(close=AsyncMock(side_effect=TimeoutError("already exited")))
        runtime = Mock(stop=AsyncMock())
        lock = Mock()
        controller.browser, controller.playwright, controller._profile_lock = browser, runtime, lock
        controller._native_exit_confirmed = True
        await controller.close()
        browser.close.assert_not_awaited()
        runtime.stop.assert_awaited_once()
        lock.release.assert_called_once()
        self.assertIsNone(controller._profile_lock)


if __name__ == "__main__":
    unittest.main()
