"""Business runner tests using isolated registries and in-memory adapters only."""
from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_batch
from browser_lock import FileMutex, FileMutexBusy
from promotion_adapter import PromotionAdapter, PromotionError, classify_error


DATE = "2026-09-25"


def row(sid, cid="101", **changes):
    value = {"recordType": "campaign", "shopId": sid, "shopName": "店铺" + sid,
             "promotionType": "全站推", "campaignId": cid, "campaignName": "计划" + cid,
             "roi": 1.4, "charge": 30.1, "displayStatus": "start", "onlineStatus": 1,
             "reportContext": {"startTime": DATE, "endTime": DATE, "isRt": False,
                               "sourceList": ["source"], "adzonePkgIdList": [],
                               "effectEqual": "equal", "unifyType": "retained"}}
    value.update(changes)
    return value


class FakeFactory:
    def __init__(self, rows=None):
        self.rows = rows or {}
        self.events = []
        self.paused = set()
        self.enter_errors = {}
        self.scan_errors = {}
        self.pause_errors = {}
        self.active_after_pause = False
        self.verification_changes = {}
        self.identities = {}
        self.constructed_shops = []
        self.exit_errors = {}
        self.close_modes = []
        self.before_exit = None
        self.exit_snapshots = {}

    def __call__(self, shop, config, *, connect_only=False, close_after_shop=True):
        owner = self
        sid = shop["id"]
        self.constructed_shops.append(copy.deepcopy(shop))
        self.close_modes.append((sid, close_after_shop))

        class FakeAdapter:
            observed_identity = None

            def __init__(self):
                self.lifecycle_result = {"status": "open"}
                self.cleanup_errors = []

            async def __aenter__(self):
                owner.events.append(("enter", sid, connect_only))
                if sid in owner.enter_errors:
                    self.lifecycle_result = {"status": "closed" if close_after_shop else "kept"}
                    raise owner.enter_errors[sid]
                return self

            async def __aexit__(self, *_):
                if owner.before_exit:
                    owner.exit_snapshots[sid] = owner.before_exit(sid)
                owner.events.append(("exit", sid))
                if sid in owner.exit_errors:
                    error = owner.exit_errors[sid]
                    if isinstance(error, asyncio.CancelledError):
                        raise error
                    detail = {"code": getattr(error, "code", "browser_close_failed"), "message": str(error)}
                    self.lifecycle_result = {"status": "open", "error": detail}
                    self.cleanup_errors.append(detail)
                    return
                self.lifecycle_result = {"status": "closed" if close_after_shop else "kept"}

            async def scan(self, date, is_rt, targets=None):
                self.observed_identity = copy.deepcopy(owner.identities.get(sid, {
                    "shopName": "店铺" + sid, "nickName": shop.get("login_username") or "店铺" + sid,
                }))
                owner.events.append(("scan", sid, None if targets is None else
                                     [(x["promotionType"], x["campaignId"]) for x in targets]))
                if sid in owner.scan_errors:
                    raise owner.scan_errors[sid]
                if targets is None:
                    return copy.deepcopy(owner.rows.get(sid, [row(sid)]))
                result = []
                for target in targets:
                    current = copy.deepcopy(target)
                    current.pop("latest", None)
                    is_paused = (sid, target["promotionType"], target["campaignId"]) in owner.paused
                    current.update(recordType="verification", verified=True,
                                   outcome="inactive" if is_paused else "active",
                                   displayStatus="pause" if is_paused else "start",
                                   onlineStatus=0 if is_paused else 1)
                    current.update(owner.verification_changes)
                    result.append(current)
                return result

            async def pause(self, target):
                identity = (sid, target["promotionType"], target["campaignId"])
                owner.events.append(("pause", *identity))
                if identity in owner.pause_errors:
                    raise owner.pause_errors[identity]
                if not owner.active_after_pause:
                    owner.paused.add(identity)
                return {"writeAttempted": True, "verified": False}

        return FakeAdapter()


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="promotion-runner-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.registry = self.root / "shops.json"
        self.write_registry()
        self.webhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-only"
        self.local_config = self.root / "config.json"
        self.local_config.write_text(json.dumps({"wechat_webhook_url": self.webhook}), encoding="utf-8")
        local_config_patch = patch.object(run_batch, "LOCAL_CONFIG", self.local_config)
        local_config_patch.start()
        self.addCleanup(local_config_patch.stop)
        self.sent = []

    async def test_local_webhook_is_used_without_environment_and_never_persisted_in_results(self):
        fake = FakeFactory()
        destinations = []

        def sender(webhook, content):
            destinations.append(webhook)
            self.sender(webhook, content)

        with patch.dict(os.environ, {"WECHAT_WEBHOOK_URL": "https://example.invalid/unused"}):
            run_dir, state = await run_batch.run(self.args("--mode", "dry-run"),
                                               adapter_factory=fake, sender=sender)
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertTrue(destinations)
        self.assertEqual(set(destinations), {self.webhook})
        self.assertFalse(any(event[0] == "pause" for event in fake.events))
        for path in run_dir.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"fixture-only", path.read_bytes(), str(path))

    async def test_invalid_local_config_stops_before_browser_or_writes_without_leaking_value(self):
        cases = [None, '{"wechat_webhook_url": "fixture-only",', '[]',
                 '{"wechat_webhook_url": ""}', '{"wechat_webhook_url": 123}',
                 '{"wechat_webhook_url": "https://[fixture-only"}']
        for payload in cases:
            with self.subTest(payload=payload):
                if payload is None:
                    self.local_config.unlink(missing_ok=True)
                else:
                    self.local_config.write_text(payload, encoding="utf-8")
                fake = FakeFactory()
                with patch.dict(os.environ, {"WECHAT_WEBHOOK_URL": self.webhook}):
                    with self.assertRaises(ValueError) as caught:
                        await run_batch.run(self.args("--mode", "execute"),
                                            adapter_factory=fake, sender=self.sender)
                self.assertNotIn("fixture-only", str(caught.exception))
                self.assertFalse(fake.events)
                self.assertFalse(self.sent)

    def write_registry(self, accounts=None):
        shops = []
        for index, sid in enumerate(("shop01", "shop02")):
            config = self.root / (sid + ".json")
            config.write_text(json.dumps({"schema_version": 1, "browser": "Edge",
                "user_data_dir": str(self.root / "profiles" / sid), "profile_directory": "Default",
                "remote_debugging_port": 19222 + index, "download_dir": str(self.root / "downloads" / sid),
                "browser_sessions": {"home": {"url": "https://myseller.taobao.com/home.htm"}}}), encoding="utf-8")
            item = {"id": sid, "store": "店铺" + sid, "browser_config": str(config)}
            if accounts and sid in accounts:
                item["login_username"] = accounts[sid]
            shops.append(item)
        self.registry.write_text(json.dumps({"schema_version": 1, "shops": shops}), encoding="utf-8")

    def args(self, *extra):
        return run_batch.parser().parse_args(["--registry", str(self.registry), "--date", DATE,
                                             "--output-root", str(self.root / "outputs"), *extra])

    def sender(self, webhook, content):
        self.sent.append(content)

    def record(self, run_dir, state, sid="shop01"):
        return run_batch.load_shop(run_dir, state["shops"][sid])

    async def closing_checkpoint(self, fake):
        # Preserve the real durable state at cleanup entry, then restore its
        # immutable pointers to model a process dying before cleanup completes.
        def before_exit(_sid):
            run_dir = next((self.root / "outputs").iterdir())
            return run_batch.read_json(run_dir / "batch-state.json")

        fake.before_exit = before_exit
        run_dir, _ = await run_batch.run(self.args("--mode", "execute", "--no-notify"),
                                          adapter_factory=fake, sender=self.sender)
        state = fake.exit_snapshots["shop01"]
        self.assertEqual(state["shops"]["shop01"]["status"], "closing")
        self.assertNotIn("shop02", state["shops"])
        self.assertEqual(self.record(run_dir, state)["browser_cleanup"], {"status": "pending"})
        run_batch.atomic_json(run_dir / "batch-state.json", state)
        return run_dir, state

    async def test_report_is_serial_and_never_writes_or_notifies(self):
        self.local_config.unlink()
        fake = FakeFactory()
        run_dir, state = await run_batch.run(self.args(), adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["notification"]["status"], "disabled")
        self.assertEqual(fake.events, [("enter", "shop01", False), ("scan", "shop01", None),
                                      ("exit", "shop01"), ("enter", "shop02", False),
                                      ("scan", "shop02", None), ("exit", "shop02")])
        self.assertFalse(self.sent)
        self.assertEqual(self.record(run_dir, state)["candidates"][0]["outcome"], "pending")

    async def test_empty_scan_persists_account_bound_platform_identity_with_display_alias(self):
        account = "真实主账号:运营"
        self.write_registry(accounts={"shop01": account})
        observed = {"shopName": "真实主账号", "nickName": account}
        fake = FakeFactory({"shop01": []})
        fake.identities["shop01"] = observed
        run_dir, state = await run_batch.run(self.args("--shops", "shop01"), adapter_factory=fake, sender=self.sender)
        saved = self.record(run_dir, state)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(saved["store"], "店铺shop01")
        self.assertEqual(saved["scan_identity"], observed)
        self.assertEqual(saved["rows"], [])
        self.assertEqual(saved["candidates"], [])
        self.assertTrue(saved["scan_complete"])

    async def test_saved_empty_scan_identity_is_supplied_to_resumed_adapter(self):
        account = "真实主账号:运营"
        self.write_registry(accounts={"shop01": account})
        observed = {"shopName": "真实主账号", "nickName": account}
        fake = FakeFactory({"shop01": []})
        fake.identities["shop01"] = observed
        fake.exit_errors["shop01"] = PromotionError("page_missing", "fixture transport ended after empty scan")
        run_dir, state = await run_batch.run(self.args("--shops", "shop01"), adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "stopped")
        self.assertEqual(self.record(run_dir, state)["scan_identity"], observed)
        resumed = FakeFactory({"shop01": []})
        resumed.identities["shop01"] = observed
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual(resumed.constructed_shops[0]["observed_identity"], observed)
        self.assertEqual(resumed.constructed_shops[0]["expected_alimama_shop"], observed["shopName"])
        self.assertEqual(resumed.constructed_shops[0]["login_username"], account)
        self.assertEqual(self.record(run_dir, state)["scan_identity"], observed)
        self.assertEqual(state["status"], "complete")

    async def test_resume_rejects_changed_observed_shop_or_account_before_retry_write(self):
        account = "真实主账号:运营"
        self.write_registry(accounts={"shop01": account})
        observed = {"shopName": "真实主账号", "nickName": account}
        fake = FakeFactory({"shop01": [row("shop01", shopName=observed["shopName"], accountNick=account)]})
        fake.identities["shop01"] = observed
        fake.pause_errors[("shop01", "全站推", "101")] = PromotionError("write_uncertain", "fixture unknown", write_attempted=True)
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "needs_review")
        retry_file = self.root / "identity-retry.json"
        retry_file.write_text(json.dumps([{"shopId": "shop01", "promotionType": "全站推", "campaignId": "101",
                                          "operation_settled": True, "reason": "fixture old owned page closed"}]), encoding="utf-8")
        for changed in ({"shopName": "另一主账号", "nickName": account},
                        {"shopName": observed["shopName"], "nickName": "真实主账号:另一个运营"}):
            with self.subTest(observed=changed):
                resumed = FakeFactory()
                resumed.identities["shop01"] = changed
                _, state = await run_batch.run(self.args("--resume", str(run_dir), "--retry-targets", str(retry_file)),
                                               adapter_factory=resumed, sender=self.sender)
                self.assertEqual(resumed.constructed_shops[0]["observed_identity"], observed)
                saved = self.record(run_dir, state)
                self.assertEqual(saved["scan_identity"], observed)
                self.assertEqual(saved["errors"][-1]["code"], "identity_mismatch")
                self.assertEqual(state["status"], "needs_review")
                self.assertFalse([event for event in resumed.events if event[0] == "pause"])
                self.assertFalse(self.sent)

    async def test_empty_account_mode_scan_without_verified_identity_is_rejected(self):
        self.write_registry(accounts={"shop01": "真实主账号:运营"})
        fake = FakeFactory({"shop01": []})
        fake.identities["shop01"] = None
        run_dir, state = await run_batch.run(self.args("--shops", "shop01"), adapter_factory=fake, sender=self.sender)
        saved = self.record(run_dir, state)
        self.assertEqual(state["status"], "needs_review")
        self.assertFalse(saved["scan_complete"])
        self.assertEqual(saved["errors"][-1]["code"], "identity_mismatch")

    async def test_execute_uses_strict_candidates_and_exact_final_target_verification(self):
        source = [row("shop01"), row("shop01", promotionType="关键词推广"),
                  row("shop01", "at-charge", charge=30), row("shop01", "at-roi", roi=1.5),
                  row("shop01", "missing", roi=None), row("shop01", "inactive", displayStatus="pause", onlineStatus=0)]
        fake = FakeFactory({"shop01": source})
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertEqual([event for event in fake.events if event[0] == "pause"],
                         [("pause", "shop01", "全站推", "101"), ("pause", "shop01", "关键词推广", "101"),
                          ("pause", "shop01", "全站推", "missing")])
        self.assertEqual([event for event in fake.events if event[0] == "scan"],
                         [("scan", "shop01", None), ("scan", "shop01", [("全站推", "101"), ("关键词推广", "101"), ("全站推", "missing")])])
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertEqual({r["outcome"] for r in self.record(run_dir, state)["candidates"]}, {"paused"})
        self.assertTrue(self.sent[-1].startswith("# 暂停操作汇总"))
        self.assertEqual(self.record(run_dir, state)["candidates"][-1]["roi"], 0)

    async def test_resume_skips_complete_shops_and_checks_hashes_before_any_adapter(self):
        fake = FakeFactory()
        fake.enter_errors["shop02"] = PromotionError("login_required", "fixture login missing")
        run_dir, state = await run_batch.run(self.args(), adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "needs_review")
        successful_hash = state["shops"]["shop01"]["sha256"]
        resumed = FakeFactory()
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual([event[1] for event in resumed.events if event[0] == "enter"], ["shop02"])
        self.assertEqual(state["shops"]["shop01"]["sha256"], successful_hash)
        audit = run_dir / state["shops"]["shop01"]["file"]
        audit.write_text(audit.read_text(encoding="utf-8") + " ", encoding="utf-8")
        guarded = FakeFactory()
        with self.assertRaisesRegex(ValueError, "哈希"):
            await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=guarded, sender=self.sender)
        self.assertFalse(guarded.events)

    async def test_uncertain_write_is_read_back_and_resume_never_automatically_repeats_it(self):
        fake = FakeFactory()
        identity = ("shop01", "全站推", "101")
        fake.pause_errors[identity] = PromotionError("write_uncertain", "fixture unknown", write_attempted=True)
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "needs_review")
        self.assertEqual(self.record(run_dir, state)["attempts"][0]["status"], "uncertain")
        self.assertFalse(self.sent)
        resumed = FakeFactory()
        _, resumed_state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])
        self.assertTrue(all(event[2] is not None for event in resumed.events if event[0] == "scan"))
        self.assertEqual(resumed_state["status"], "needs_review")

    async def test_active_final_target_with_missing_metrics_remains_unresolved(self):
        fake = FakeFactory()
        fake.active_after_pause = True
        fake.verification_changes = {"roi": None}
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertEqual(self.record(run_dir, state)["candidates"][0]["outcome"], "active")
        self.assertEqual(state["status"], "needs_review")
        self.assertFalse(self.sent)

    async def test_empty_type_does_not_block_other_type_pause_or_report_an_exception(self):
        valid = row("shop01", "valid-allsite")
        empty = row("shop01", "empty-keyword", promotionType="关键词推广", roi=None, charge=None)
        fake = FakeFactory({"shop01": [valid, empty]})
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        saved = self.record(run_dir, state)
        self.assertEqual(state["status"], "complete")
        self.assertTrue(saved["scan_complete"])
        self.assertEqual(saved["rows"][1]["roi"], 0)
        self.assertEqual(saved["rows"][1]["charge"], 0)
        self.assertEqual([item["campaignId"] for item in saved["candidates"]], ["valid-allsite"])
        self.assertEqual(saved["candidates"][0]["outcome"], "paused")
        self.assertEqual(saved["errors"], [])
        self.assertEqual([event for event in fake.events if event[0] == "pause"],
                         [("pause", "shop01", "全站推", "valid-allsite")])
        report = (run_dir / "report.md").read_text(encoding="utf-8")
        self.assertIn("ROI 0.00｜花费 0.00", report)
        self.assertNotIn("缺失", report)
        self.assertNotIn("需复核", report)
        summary = run_batch.read_json(run_dir / "batch-summary.json")["shops"][0]
        self.assertEqual((summary["scanned"], summary["to_pause"], summary["paused"]), (2, 1, 1))
        self.assertNotIn("missing_metrics", summary)
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertTrue(self.sent)

    async def test_all_empty_metrics_complete_without_pause_and_notify_without_missing_warning(self):
        fake = FakeFactory({"shop01": [row("shop01", roi=None, charge=None)]})
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(self.record(run_dir, state)["errors"], [])
        self.assertFalse([event for event in fake.events if event[0] == "pause"])
        self.assertNotIn("缺失", "\n".join(self.sent))
        self.assertNotIn("需复核", self.sent[-1])
        self.assertIn("暂无符合暂停条件", self.sent[-1])

    async def test_empty_charge_in_active_readback_is_zero_and_no_longer_meets_pause_rule(self):
        fake = FakeFactory()
        fake.active_after_pause = True
        fake.verification_changes = {"charge": None}
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "complete")
        candidate = self.record(run_dir, state)["candidates"][0]
        self.assertEqual(candidate["outcome"], "active")
        self.assertEqual(candidate["latest"]["charge"], 0)
        self.assertIn("最新指标不符合暂停条件", self.sent[-1])

    async def test_resume_of_previously_unreached_shop_remains_readonly(self):
        fake = FakeFactory()
        fake.enter_errors["shop01"] = PromotionError("global_failure", "fixture unknown stop")
        with self.assertRaises(PromotionError):
            await run_batch.run(self.args("--mode", "execute", "--no-notify"), adapter_factory=fake, sender=self.sender)
        run_dir = next((self.root / "outputs").iterdir())
        original = run_batch.read_json(run_dir / "batch-state.json")
        self.assertNotIn("shop02", original["shops"])
        resumed = FakeFactory()
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual([event[1] for event in resumed.events if event[0] == "enter"], ["shop01", "shop02"])
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])
        self.assertEqual(state["status"], "needs_review")
        self.assertFalse(self.sent)

    async def test_execute_no_notify_needs_no_webhook_and_only_writes_local_results(self):
        self.local_config.unlink()
        fake = FakeFactory()
        _, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                       adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["notification"]["status"], "disabled")
        self.assertEqual(len([event for event in fake.events if event[0] == "pause"]), 1)
        self.assertFalse(self.sent)

    async def test_explicit_retry_has_persisted_per_target_budget(self):
        fake = FakeFactory({"shop01": [row("shop01"), row("shop01", "102")]})
        identity = ("shop01", "全站推", "101")
        fake.pause_errors[identity] = PromotionError("write_uncertain", "fixture unknown", write_attempted=True)
        fake.pause_errors[("shop01", "全站推", "102")] = PromotionError("write_uncertain", "fixture unknown", write_attempted=True)
        run_dir, _ = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                         adapter_factory=fake, sender=self.sender)
        retry_file = self.root / "retry.json"
        retry_file.write_text(json.dumps([{"shopId": "shop01", "promotionType": "全站推", "campaignId": "101",
                                          "operation_settled": True, "reason": "fixture old owned page closed"}]), encoding="utf-8")
        retry = FakeFactory()
        retry.active_after_pause = True
        _, state = await run_batch.run(self.args("--resume", str(run_dir), "--retry-targets", str(retry_file)),
                                       adapter_factory=retry, sender=self.sender)
        self.assertEqual(len([event for event in retry.events if event[0] == "pause"]), 1)
        self.assertEqual(self.record(run_dir, state)["candidates"][0]["recovery_writes"], 1)
        retry_file.write_text(json.dumps([{"shopId": "shop01", "promotionType": "全站推", "campaignId": cid,
                                          "operation_settled": True, "reason": "fixture old owned page closed"}
                                         for cid in ("101", "102")]), encoding="utf-8")
        second = FakeFactory()
        _, state = await run_batch.run(self.args("--resume", str(run_dir), "--retry-targets", str(retry_file)),
                                       adapter_factory=second, sender=self.sender)
        self.assertEqual([event for event in second.events if event[0] == "pause"],
                         [("pause", "shop01", "全站推", "102")])
        saved = self.record(run_dir, state)
        self.assertEqual(saved["candidates"][0]["recovery_writes"], 1)
        self.assertEqual(saved["candidates"][1]["recovery_writes"], 1)
        self.assertTrue(any(error["code"] == "retry_budget_exhausted" for error in saved["errors"]))
        self.assertEqual(state["status"], "needs_review")

    async def test_resume_no_notify_suppresses_next_round_permanently(self):
        fake = FakeFactory()
        identity = ("shop01", "全站推", "101")
        fake.pause_errors[identity] = PromotionError("write_uncertain", "fixture unknown", write_attempted=True)
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["notification"]["status"], "sent")
        self.sent.clear()
        resumed = FakeFactory()
        resumed.paused.add(identity)
        self.local_config.unlink()
        _, state = await run_batch.run(self.args("--resume", str(run_dir), "--no-notify"),
                                       adapter_factory=resumed, sender=self.sender)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["notification"]["status"], "disabled")
        self.assertFalse(self.sent)
        final_adapter = FakeFactory()
        _, state = await run_batch.run(self.args("--resume", str(run_dir)),
                                       adapter_factory=final_adapter, sender=self.sender)
        self.assertEqual(state["notification"]["status"], "disabled")
        self.assertFalse(final_adapter.events)
        self.assertFalse(self.sent)

    async def test_each_shop_is_verified_and_saved_before_close_then_next_shop_then_notification(self):
        fake = FakeFactory()

        def before_exit(sid):
            run_dir = next((self.root / "outputs").iterdir())
            state = run_batch.read_json(run_dir / "batch-state.json")
            saved = self.record(run_dir, state, sid)
            self.assertEqual(saved["status"], "closing")
            self.assertEqual(saved["business_status"], "complete")
            self.assertTrue(saved["scan_complete"])
            self.assertEqual(saved["candidates"][0]["outcome"], "paused")
            self.assertEqual(saved["attempts"][0]["status"], "requested")
            return copy.deepcopy(saved)

        def sender(webhook, content):
            self.assertEqual([event[1] for event in fake.events if event[0] == "exit"], ["shop01", "shop02"])
            fake.events.append(("notify",))
            self.sender(webhook, content)

        fake.before_exit = before_exit
        run_dir, state = await run_batch.run(self.args("--mode", "execute"), adapter_factory=fake, sender=sender)
        self.assertEqual(fake.close_modes, [("shop01", True), ("shop02", True)])
        events = [event for event in fake.events if event[0] != "notify"]
        self.assertEqual(events, [
            ("enter", "shop01", False), ("scan", "shop01", None), ("pause", "shop01", "全站推", "101"),
            ("scan", "shop01", [("全站推", "101")]), ("exit", "shop01"),
            ("enter", "shop02", False), ("scan", "shop02", None), ("pause", "shop02", "全站推", "101"),
            ("scan", "shop02", [("全站推", "101")]), ("exit", "shop02"),
        ])
        for sid in ("shop01", "shop02"):
            self.assertEqual(self.record(run_dir, state, sid)["browser_cleanup"]["status"], "closed")
        self.assertEqual(state["notification_policy"], "after_batch")
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertEqual(state["notification"]["round"], 1)
        self.assertEqual(state["notification"]["snapshot"]["shops"], state["shops"])

    async def test_local_business_failures_close_and_continue_then_notify_partial_summary(self):
        for failure in ("login", "request"):
            with self.subTest(failure=failure):
                self.sent.clear()
                fake = FakeFactory({"shop01": [row("shop01", roi=None, charge=None)]})
                if failure == "login":
                    fake.enter_errors["shop01"] = PromotionError("login_required", "fixture login missing")
                else:
                    fake.scan_errors["shop01"] = PromotionError("page_request_failed", "fixture request failed")
                run_dir, state = await run_batch.run(self.args("--mode", "execute"), adapter_factory=fake, sender=self.sender)
                self.assertEqual(state["status"], "needs_review")
                self.assertEqual([event[1] for event in fake.events if event[0] == "enter"], ["shop01", "shop02"])
                self.assertEqual(self.record(run_dir, state)["browser_cleanup"]["status"], "closed")
                self.assertEqual(self.record(run_dir, state, "shop02")["status"], "complete")
                self.assertEqual(state["notification"]["status"], "sent")
                self.assertTrue(self.sent)
                text = "\n".join(self.sent)
                self.assertIn("店铺shop01", text)
                self.assertIn("店铺shop02", text)
                self.assertTrue("未完成" in text or "缺失" in text or "异常" in text)

    async def test_closing_checkpoint_resume_rechecks_and_closes_without_replaying_writes(self):
        run_dir, crashed = await self.closing_checkpoint(FakeFactory())
        original = self.record(run_dir, crashed)
        self.assertEqual(original["business_status"], "complete")
        self.assertEqual(original["candidates"][0]["outcome"], "paused")
        resumed = FakeFactory()
        resumed.paused.add(("shop01", "全站推", "101"))
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual([event[1] for event in resumed.events if event[0] == "enter"], ["shop01", "shop02"])
        self.assertLess(resumed.events.index(("exit", "shop01")), resumed.events.index(("enter", "shop02", False)))
        self.assertEqual([event for event in resumed.events if event[0] == "scan" and event[1] == "shop01"],
                         [("scan", "shop01", [("全站推", "101")])] * 2)
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])
        saved = self.record(run_dir, state)
        self.assertEqual(saved["status"], "complete")
        self.assertEqual(saved["browser_cleanup"]["status"], "closed")
        self.assertEqual(saved["attempts"], original["attempts"])
        self.assertNotIn("business_status", saved)
        next_shop = self.record(run_dir, state, "shop02")
        self.assertTrue(next_shop["scan_complete"])
        self.assertEqual(next_shop["attempts"], [])
        self.assertEqual(next_shop["status"], "needs_review")
        self.assertFalse(self.sent)

    async def test_closing_checkpoint_business_status_cannot_hide_resume_login_failure(self):
        run_dir, crashed = await self.closing_checkpoint(FakeFactory())
        self.assertEqual(self.record(run_dir, crashed)["business_status"], "complete")
        resumed = FakeFactory({"shop02": []})
        resumed.enter_errors["shop01"] = PromotionError("login_required", "fixture login expired after crash")
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        saved = self.record(run_dir, state)
        self.assertEqual(state["status"], "needs_review")
        self.assertEqual(saved["status"], "needs_review")
        self.assertEqual(saved["errors"][-1]["code"], "login_required")
        self.assertNotIn("business_status", saved)
        self.assertEqual(saved["browser_cleanup"]["status"], "closed")
        self.assertEqual(self.record(run_dir, state, "shop02")["status"], "complete")
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])
        self.assertFalse(self.sent)

    async def test_closing_checkpoint_with_incomplete_scan_rescans_without_automatic_writes(self):
        fake = FakeFactory()
        fake.scan_errors["shop01"] = PromotionError("page_request_failed", "fixture request failed")
        run_dir, crashed = await self.closing_checkpoint(fake)
        self.assertFalse(self.record(run_dir, crashed)["scan_complete"])
        resumed = FakeFactory({"shop02": []})
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        saved = self.record(run_dir, state)
        self.assertIn(("scan", "shop01", None), resumed.events)
        self.assertTrue(saved["scan_complete"])
        self.assertEqual(saved["candidates"][0]["outcome"], "active")
        self.assertEqual(saved["attempts"], [])
        self.assertEqual(saved["status"], "needs_review")
        self.assertEqual(saved["browser_cleanup"]["status"], "closed")
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])
        self.assertFalse(self.sent)

    async def test_cancelled_cleanup_stays_incomplete_and_resume_handles_shop_before_next(self):
        fake = FakeFactory()
        fake.exit_errors["shop01"] = asyncio.CancelledError("fixture cancelled during browser close")
        with self.assertRaises(asyncio.CancelledError):
            await run_batch.run(self.args("--mode", "execute", "--no-notify"), adapter_factory=fake, sender=self.sender)
        run_dir = next((self.root / "outputs").iterdir())
        state = run_batch.read_json(run_dir / "batch-state.json")
        saved = self.record(run_dir, state)
        self.assertEqual(state["status"], "stopped")
        self.assertEqual(saved["status"], "needs_review")
        self.assertNotEqual(saved["browser_cleanup"]["status"], "closed")
        self.assertEqual(saved["candidates"][0]["outcome"], "paused")
        self.assertNotIn("shop02", state["shops"])
        resumed = FakeFactory({"shop02": []})
        resumed.paused.add(("shop01", "全站推", "101"))
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual([event[1] for event in resumed.events if event[0] == "enter"], ["shop01", "shop02"])
        self.assertLess(resumed.events.index(("exit", "shop01")), resumed.events.index(("enter", "shop02", False)))
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])
        self.assertEqual(self.record(run_dir, state)["browser_cleanup"]["status"], "closed")
        self.assertEqual(state["status"], "complete")
        self.assertFalse(self.sent)

    async def test_browser_close_failure_stops_next_shop_but_keeps_verified_results_and_notifies(self):
        fake = FakeFactory()
        fake.exit_errors["shop01"] = PromotionError("browser_close_failed", "fixture process still open")
        run_dir, state = await run_batch.run(self.args("--mode", "execute"), adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "stopped")
        self.assertEqual([event[1] for event in fake.events if event[0] == "enter"], ["shop01"])
        saved = self.record(run_dir, state)
        self.assertEqual(saved["candidates"][0]["outcome"], "paused")
        self.assertEqual(saved["browser_cleanup"]["status"], "open")
        self.assertEqual(saved["browser_cleanup"]["error"]["code"], "browser_close_failed")
        summary = run_batch.read_json(run_dir / "batch-summary.json")
        self.assertEqual(summary["shops"][1]["status"], "not_run")
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertIn("店铺shop02", "\n".join(self.sent))
        self.assertIn("未执行", "\n".join(self.sent))

    async def test_session_save_failure_stops_next_shop_and_notifies(self):
        fake = FakeFactory()
        fake.exit_errors["shop01"] = PromotionError("session_save_failed", "fixture session persistence failed")
        run_dir, state = await run_batch.run(self.args("--mode", "dry-run"), adapter_factory=fake, sender=self.sender)
        self.assertEqual(state["status"], "stopped")
        self.assertEqual([event[1] for event in fake.events if event[0] == "enter"], ["shop01"])
        self.assertEqual(self.record(run_dir, state)["browser_cleanup"]["error"]["code"], "session_save_failed")
        self.assertFalse([event for event in fake.events if event[0] == "pause"])
        self.assertEqual(state["notification"]["status"], "sent")

    async def test_unknown_failure_still_persists_and_notifies_done_and_not_run_shops(self):
        fake = FakeFactory()
        fake.enter_errors["shop01"] = PromotionError("global_failure", "fixture unknown stop")
        with self.assertRaises(PromotionError):
            await run_batch.run(self.args("--mode", "execute"), adapter_factory=fake, sender=self.sender)
        run_dir = next((self.root / "outputs").iterdir())
        state = run_batch.read_json(run_dir / "batch-state.json")
        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertEqual([event[1] for event in fake.events if event[0] == "enter"], ["shop01"])
        self.assertEqual(self.record(run_dir, state)["errors"][-1]["code"], "global_failure")
        self.assertIn("店铺shop02", "\n".join(self.sent))
        self.assertIn("未执行", "\n".join(self.sent))

    async def test_partial_notification_snapshot_survives_readonly_resume_and_completed_round_is_noop(self):
        fake = FakeFactory()
        identity = ("shop01", "全站推", "101")
        fake.pause_errors[identity] = PromotionError("write_uncertain", "fixture unknown", write_attempted=True)
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        original = copy.deepcopy(state["notification"])
        original_receipt = copy.deepcopy(state["shops"]["shop01"])
        self.assertEqual(original["status"], "sent")
        self.assertEqual(original["snapshot"]["status"], "needs_review")
        resumed = FakeFactory()
        resumed.paused.add(identity)
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["notification_history"], [original])
        self.assertEqual(state["notification"]["round"], 2)
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertEqual(state["notification"]["snapshot"]["shops"], state["shops"])
        self.assertEqual(run_batch.load_shop(run_dir, original_receipt)["candidates"][0]["outcome"], "active")
        delivered = list(self.sent)
        third = FakeFactory()
        _, final_state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=third, sender=self.sender)
        self.assertEqual(self.sent, delivered)
        self.assertFalse(third.events)
        self.assertEqual(final_state["notification"], state["notification"])
        self.assertEqual(final_state["notification_history"], [original])

    async def test_keep_browser_persists_and_resume_cannot_change_close_policy(self):
        fake = FakeFactory()
        fake.active_after_pause = True
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--keep-browser", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        self.assertIs(state["close_after_shop"], False)
        self.assertEqual(fake.close_modes, [("shop01", False)])
        self.assertEqual(self.record(run_dir, state)["browser_cleanup"]["status"], "kept")
        resumed = FakeFactory()
        await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual(resumed.close_modes, [("shop01", False)])
        close_default = FakeFactory()
        close_default.active_after_pause = True
        other_dir, _ = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                          adapter_factory=close_default, sender=self.sender)
        guarded = FakeFactory()
        with self.assertRaises(ValueError):
            await run_batch.run(self.args("--resume", str(other_dir), "--keep-browser"), adapter_factory=guarded, sender=self.sender)
        self.assertFalse(guarded.events)

    async def test_legacy_batch_keeps_browser_old_notification_policy_and_sent_resume_block(self):
        fake = FakeFactory()
        fake.active_after_pause = True
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        state.pop("notification_policy", None)
        state.pop("close_after_shop", None)
        state["notification"] = {"status": "pending", "sent": 0}
        run_batch.atomic_json(run_dir / "batch-state.json", state)
        resumed = FakeFactory()
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual(resumed.close_modes, [("shop01", False)])
        self.assertEqual(self.record(run_dir, state)["browser_cleanup"]["status"], "kept")
        self.assertEqual(state["notification"]["status"], "pending")
        self.assertFalse(self.sent)
        state["notification"]["status"] = "sent"
        run_batch.atomic_json(run_dir / "batch-state.json", state)
        guarded = FakeFactory()
        with self.assertRaises(ValueError):
            await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=guarded, sender=self.sender)
        self.assertFalse(guarded.events)

    async def test_sending_or_unknown_notification_blocks_resume_before_browser_calls(self):
        fake = FakeFactory()
        fake.active_after_pause = True
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        for status in ("sending", "delivery_unknown"):
            with self.subTest(status=status):
                state["notification"]["status"] = status
                run_batch.atomic_json(run_dir / "batch-state.json", state)
                guarded = FakeFactory()
                with self.assertRaises(ValueError):
                    await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=guarded, sender=self.sender)
                self.assertFalse(guarded.events)
                self.assertFalse(self.sent)

    async def test_unsent_prepared_notification_is_rebuilt_after_resume(self):
        fake = FakeFactory()
        fake.active_after_pause = True
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                             adapter_factory=fake, sender=self.sender)
        old_snapshot = {"status": state["status"], "shops": copy.deepcopy(state["shops"])}
        state["notification"] = {"status": "pending", "sent": 0, "round": 1,
                                  "messages": ["fixture old unsent summary"], "snapshot": old_snapshot}
        run_batch.atomic_json(run_dir / "batch-state.json", state)
        resumed = FakeFactory()
        resumed.paused.add(("shop01", "全站推", "101"))
        _, state = await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=resumed, sender=self.sender)
        self.assertEqual(state["status"], "complete")
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertEqual(state["notification"]["round"], 1)
        self.assertEqual(state["notification"]["snapshot"], {"status": "complete", "shops": state["shops"]})
        self.assertNotEqual(state["notification"]["snapshot"], old_snapshot)
        self.assertEqual(self.sent, state["notification"]["messages"])
        self.assertNotIn("fixture old unsent summary", "\n".join(self.sent))
        self.assertIn("已暂停", "\n".join(self.sent))
        self.assertFalse(state["notification_history"])
        self.assertFalse([event for event in resumed.events if event[0] == "pause"])

    async def test_partially_sent_prepared_notification_blocks_resume_but_finalize_uses_frozen_messages(self):
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify", "--shops", "shop01"),
                                             adapter_factory=FakeFactory(), sender=self.sender)
        snapshot = {"status": state["status"], "shops": copy.deepcopy(state["shops"])}
        notices = ["fixture first delivered chunk", "fixture second frozen chunk"]
        state["notification"] = {"status": "pending", "sent": 1, "round": 1,
                                  "messages": notices, "snapshot": snapshot}
        run_batch.atomic_json(run_dir / "batch-state.json", state)
        guarded = FakeFactory()
        with self.assertRaises(ValueError):
            await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=guarded, sender=self.sender)
        self.assertFalse(guarded.events)
        self.assertFalse(self.sent)
        _, state = await run_batch.run(self.args("--finalize", str(run_dir)), adapter_factory=guarded, sender=self.sender)
        self.assertFalse(guarded.events)
        self.assertEqual(self.sent, [notices[1]])
        self.assertEqual(state["notification"]["messages"], notices)
        self.assertEqual(state["notification"]["snapshot"], snapshot)
        self.assertEqual(state["notification"]["status"], "sent")

    async def test_registry_wide_lock_blocks_another_batch_before_browser_or_notification(self):
        fake = FakeFactory()
        with FileMutex(self.registry.with_name(".promotion-monitor.lock"), {"fixture": True}):
            with self.assertRaises(FileMutexBusy):
                await run_batch.run(self.args("--mode", "execute"), adapter_factory=fake, sender=self.sender)
        self.assertFalse(fake.events)
        self.assertFalse(fake.constructed_shops)
        self.assertFalse(self.sent)

    async def test_changed_scan_identity_never_writes_and_other_shop_still_runs(self):
        fake = FakeFactory({"shop01": [row("shop01", shopName="其他店铺")]})
        run_dir, state = await run_batch.run(self.args("--mode", "execute", "--no-notify"), adapter_factory=fake, sender=self.sender)
        self.assertEqual(self.record(run_dir, state)["status"], "failed")
        self.assertEqual(self.record(run_dir, state, "shop02")["status"], "complete")
        self.assertEqual([event[1] for event in fake.events if event[0] == "pause"], ["shop02"])
        self.assertFalse(self.sent)

    async def test_registry_account_change_blocks_resume_before_browser_calls(self):
        fake = FakeFactory()
        run_dir, _ = await run_batch.run(self.args(), adapter_factory=fake, sender=self.sender)
        self.write_registry(accounts={"shop01": "店铺shop01:新账号"})
        guarded = FakeFactory()
        with self.assertRaisesRegex(ValueError, "账号或浏览器配置已改变"):
            await run_batch.run(self.args("--resume", str(run_dir)), adapter_factory=guarded, sender=self.sender)
        self.assertFalse(guarded.events)

    async def test_notification_finalize_is_idempotent_and_never_opens_browser(self):
        fake = FakeFactory()
        run_dir, state = await run_batch.run(self.args("--mode", "dry-run"), adapter_factory=fake, sender=self.sender)
        original = list(self.sent)
        guarded = FakeFactory()
        _, state = await run_batch.run(self.args("--finalize", str(run_dir)), adapter_factory=guarded, sender=self.sender)
        self.assertEqual(self.sent, original)
        self.assertEqual(state["notification"]["status"], "sent")
        self.assertFalse(guarded.events)

    async def test_uncertain_notification_delivery_never_auto_resends(self):
        def failed_sender(_webhook, _content):
            raise RuntimeError("fixture delivery unknown")
        with self.assertRaises(RuntimeError):
            await run_batch.run(self.args("--mode", "dry-run"), adapter_factory=FakeFactory(), sender=failed_sender)
        run_dir = next((self.root / "outputs").iterdir())
        state = run_batch.read_json(run_dir / "batch-state.json")
        self.assertEqual(state["notification"]["status"], "delivery_unknown")
        with self.assertRaisesRegex(ValueError, "通知送达状态未知"):
            await run_batch.run(self.args("--finalize", str(run_dir)), adapter_factory=FakeFactory(), sender=self.sender)
        self.assertFalse(self.sent)


class TransportArgumentsTests(unittest.TestCase):
    def test_optional_account_is_omitted_instead_of_null(self):
        # Constructor-independent: no Playwright runtime or real profile is used.
        adapter = object.__new__(PromotionAdapter)
        adapter.shop = {"expected_alimama_shop": "示例店", "login_username": None}
        adapter.config = copy.deepcopy(run_batch.DEFAULTS)
        value = adapter._args("全站推", DATE, False)
        self.assertNotIn("expectedAccount", value)
        adapter.shop["login_username"] = "示例店:子账号"
        self.assertEqual(adapter._args("全站推", DATE, False)["expectedAccount"], "示例店:子账号")

    def test_postwrite_uncertainty_takes_priority_over_nested_identity_or_login_text(self):
        for nested in ("Shop identity does not match expected-shop", "Authentication required"):
            error = classify_error(RuntimeError("Pause outcome uncertain; do not retry write: " + nested))
            self.assertEqual(error.code, "write_uncertain")
            self.assertIs(error.write_attempted, True)


class TransportRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_postwrite_readiness_text_does_not_repeat_page_evaluation(self):
        adapter = object.__new__(PromotionAdapter)
        adapter.config = copy.deepcopy(run_batch.DEFAULTS)
        calls = []

        class Page:
            async def evaluate(self, _expression):
                calls.append(1)
                raise RuntimeError("Pause outcome uncertain; do not retry write: Campaign list is not ready")

        with patch("promotion_adapter.asyncio.sleep", new_callable=AsyncMock):
            with self.assertRaises(PromotionError):
                await adapter._evaluate(Page(), "pause_campaign.js", {})
        self.assertEqual(len(calls), 1)


class CheckpointCrashTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="promotion-checkpoint-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = {"shops": {}}
        self.old = {"id": "shop01", "status": "running", "version": "old"}
        self.new = {"id": "shop01", "status": "complete", "version": "new"}
        run_batch.save_shop(self.root, self.state, self.old)

    def test_failure_refreshing_public_alias_keeps_committed_new_revision_loadable(self):
        original = run_batch.atomic_json
        alias = self.root / "shops" / "shop01" / "audit.json"

        def fail_alias(path, value):
            if path == alias:
                raise OSError("fixture crash after state commit")
            original(path, value)

        with patch.object(run_batch, "atomic_json", side_effect=fail_alias):
            with self.assertRaises(OSError):
                run_batch.save_shop(self.root, self.state, self.new)
        committed = run_batch.read_json(self.root / "batch-state.json")
        self.assertEqual(run_batch.load_shop(self.root, committed["shops"]["shop01"]), self.new)
        self.assertEqual(run_batch.read_json(alias), self.old)

    def test_failure_before_state_commit_keeps_old_revision_loadable(self):
        original = run_batch.atomic_json
        state_path = self.root / "batch-state.json"

        def fail_state(path, value):
            if path == state_path:
                raise OSError("fixture crash before state commit")
            original(path, value)

        with patch.object(run_batch, "atomic_json", side_effect=fail_state):
            with self.assertRaises(OSError):
                run_batch.save_shop(self.root, self.state, self.new)
        committed = run_batch.read_json(state_path)
        self.assertEqual(run_batch.load_shop(self.root, committed["shops"]["shop01"]), self.old)
        self.assertEqual(run_batch.read_json(self.root / "shops" / "shop01" / "audit.json"), self.old)


if __name__ == "__main__":
    unittest.main()
