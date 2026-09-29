import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import promotion_browser_lifecycle as lifecycle
from playwright_controller import BrowserControllerError, ProfileLock, RoleSpec
from session_cookies import METADATA_NAME, business_cookie_scope, persistent_cookie_param


class Session:
    def __init__(self, browser):
        self.browser = browser

    async def send(self, method, params=None):
        browser = self.browser
        browser.events.append(method)
        if not browser.controller._profile_lock.owned:
            raise AssertionError("CDP action without the Profile lock")
        if method == "SystemInfo.getProcessInfo":
            return {"processInfo": [{"type": "browser", "id": browser.pid}]}
        if method == "Storage.getCookies":
            return {"cookies": deepcopy(browser.cookies)}
        if method == "Storage.setCookies":
            if browser.cookie_failure:
                raise RuntimeError("cookie-secret-in-private-protocol-error")
            browser.saved.append(deepcopy(params["cookies"][0]))
            return {}
        if method == "Browser.close":
            assert (Path(browser.controller.config["user_data_dir"]) / METADATA_NAME).is_file()
            browser.closed = browser.can_exit
            if browser.close_error:
                raise RuntimeError("connection closed with private endpoint")
            return {}
        raise AssertionError(method)

    async def detach(self):
        pass


class Browser:
    def __init__(self, context):
        self.contexts = [context]
        self.pid = 1234
        self.closed = False
        self.can_exit = True
        self.close_error = False
        self.cookie_failure = False
        self.events = []
        self.saved = []
        self.cookies = [
            {"name": "session", "value": "private-cookie-value", "domain": ".alimama.com", "path": "/",
             "secure": True, "httpOnly": True, "sameSite": "None", "session": True},
            {"name": "existing", "value": "existing-private", "domain": ".taobao.com", "path": "/",
             "expires": 123456789, "session": False},
            {"name": "other", "value": "unrelated-private", "domain": ".example.com", "session": True},
        ]

    def is_connected(self):
        return not self.closed

    async def new_browser_cdp_session(self):
        return Session(self)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.lock = ProfileLock(self.root, "Default")
        self.lock.acquire()
        context = object()
        self.browser = Browser(context)
        self.controller = SimpleNamespace(
            config={"user_data_dir": str(self.root), "profile_directory": "Default",
                    "browser": "Edge", "remote_debugging_port": 12345},
            specs={"promotion": RoleSpec("promotion", "https://one.alimama.com/")},
            browser=self.browser, context=context, _profile_lock=self.lock, _cdp_port=12345,
            _browser_owned=False, _owned_browser_pid=None, _browser_process=None,
        )
        self.browser.controller = self.controller
        self.executable = self.root / "msedge.exe"
        self.record = {"pid": self.browser.pid, "name": "msedge.exe", "started_at": "2026-09-28T01:02:03Z",
                       "root": lifecycle._normalized_path(self.root), "profile": "Default", "port": 12345,
                       "executable": lifecycle._normalized_path(self.executable)}
        self.monitor = SimpleNamespace(exited=lambda: self.browser.closed, close=lambda: None)
        self.patches = [
            patch.object(lifecycle, "_browser_inventory", side_effect=lambda: [] if self.browser.closed else [deepcopy(self.record)]),
            patch.object(lifecycle, "_resolve_browser_executable", return_value=self.executable),
            patch.object(lifecycle, "_ProcessMonitor", return_value=self.monitor),
            patch.object(lifecycle, "_cdp_version_sync", return_value=None),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.lock.release()
        self.temporary.cleanup()

    async def failure(self, expected_code):
        with self.assertRaises(BrowserControllerError) as raised:
            await lifecycle.save_and_close(self.controller)
        self.assertEqual(raised.exception.code, expected_code)
        envelope = raised.exception.to_dict()
        self.assertIn("cookie_sync", envelope["error"]["details"])
        self.assertNotIn("private", json.dumps(envelope))
        return raised.exception

    async def test_reused_browser_saves_scoped_cookies_and_closes_under_same_lock(self):
        result = await lifecycle.save_and_close(self.controller)
        self.assertEqual(result["status"], "closed")
        self.assertEqual(result["cookie_sync"]["persisted_count"], 1)
        self.assertEqual(result["cookie_sync"]["skipped_count"], 2)
        self.assertTrue(self.lock.owned)
        self.assertFalse(self.controller._browser_owned)
        self.assertTrue(self.controller._native_exit_confirmed)
        self.assertEqual(self.browser.events[-1], "Browser.close")
        self.assertLess(self.browser.events.index("Storage.setCookies"), self.browser.events.index("Browser.close"))
        self.assertEqual(self.browser.saved[0]["domain"], ".alimama.com")
        self.assertTrue(self.browser.saved[0]["secure"])
        self.assertTrue(self.browser.saved[0]["httpOnly"])
        self.assertEqual(self.browser.saved[0]["sameSite"], "None")
        metadata = json.loads((self.root / METADATA_NAME).read_text(encoding="utf-8"))
        self.assertEqual(set(metadata), set(lifecycle.COOKIE_STATUS_KEYS))
        self.assertNotIn("private", json.dumps([result, metadata]))

    async def test_no_owned_lock_rejects_before_any_cdp_call(self):
        self.lock.release()
        await self.failure("browser_ownership_mismatch")
        self.assertEqual(self.browser.events, [])

    async def test_lock_for_another_directory_is_rejected(self):
        self.controller.config["user_data_dir"] = str(self.root / "other")
        await self.failure("browser_ownership_mismatch")
        self.assertEqual(self.browser.events, [])

    async def test_cdp_browser_pid_must_match_profile_process(self):
        self.browser.pid = 9999
        await self.failure("browser_ownership_mismatch")
        self.assertNotIn("Storage.getCookies", self.browser.events)

    async def test_wrong_profile_port_executable_or_start_time_rejects(self):
        for key, value in (("profile", "Other"), ("port", 54321), ("executable", "foreign"), ("started_at", "")):
            with self.subTest(key=key):
                record = {**self.record, key: value}
                with patch.object(lifecycle, "_browser_inventory", return_value=[record]):
                    await self.failure("browser_ownership_mismatch")
        self.assertNotIn("Storage.getCookies", self.browser.events)

    async def test_duplicate_root_or_port_rejects(self):
        for extra in ({**self.record, "pid": 2222, "port": 54321},
                      {**self.record, "pid": 2222, "root": "foreign"}):
            with self.subTest(extra=extra):
                with patch.object(lifecycle, "_browser_inventory", return_value=[self.record, extra]):
                    await self.failure("browser_ownership_mismatch")
        self.assertNotIn("Storage.getCookies", self.browser.events)

    async def test_cookie_failure_keeps_browser_open(self):
        self.browser.cookie_failure = True
        error = await self.failure("cookie_sync_failed")
        self.assertEqual(error.details["cookie_sync"]["failed_count"], 1)
        self.assertNotIn("Browser.close", self.browser.events)
        self.assertTrue(self.lock.owned)

    async def test_partial_cookie_save_keeps_browser_open(self):
        self.browser.cookies.append({"name": "bad", "domain": ".tmall.com", "session": True})
        error = await self.failure("cookie_sync_failed")
        self.assertEqual(error.details["cookie_sync"]["status"], "partial")
        self.assertEqual(error.details["cookie_sync"]["persisted_count"], 1)
        self.assertNotIn("Browser.close", self.browser.events)

    async def test_metadata_failure_keeps_browser_open(self):
        with patch.object(lifecycle, "write_metadata", side_effect=OSError("private disk error")):
            error = await self.failure("cookie_sync_failed")
        self.assertEqual(error.details["reason"], "session_metadata_write_failed")
        self.assertNotIn("Browser.close", self.browser.events)

    async def test_replacement_during_cookie_checkpoint_prevents_close(self):
        replacement = {**self.record, "started_at": "later"}
        with patch.object(lifecycle, "_browser_inventory", side_effect=[
                [self.record], [self.record], [replacement]]):
            error = await self.failure("browser_ownership_mismatch")
        self.assertEqual(error.details["cookie_sync"]["status"], "saved")
        self.assertNotIn("Browser.close", self.browser.events)

    async def test_disconnect_during_close_is_success_only_after_native_exit(self):
        self.browser.close_error = True
        result = await lifecycle.save_and_close(self.controller)
        self.assertEqual(result["status"], "closed")
        self.assertTrue(self.lock.owned)

    async def test_normal_close_timeout_does_not_terminate_process(self):
        self.browser.can_exit = False
        self.browser.close_error = True
        with patch.object(lifecycle, "EXIT_TIMEOUT_SECONDS", 0):
            error = await self.failure("browser_close_failed")
        self.assertEqual(error.details["reason"], "normal_close_timed_out")
        self.assertEqual(self.browser.events.count("Browser.close"), 1)
        self.assertFalse(self.browser.closed)
        self.assertTrue(self.lock.owned)

    async def test_inventory_disappearance_without_native_exit_is_not_success(self):
        self.browser.can_exit = False
        with patch.object(lifecycle, "_browser_inventory", side_effect=[[self.record]] * 3 + [[]]), \
                patch.object(lifecycle, "EXIT_TIMEOUT_SECONDS", 0):
            await self.failure("browser_close_failed")

    async def test_signaled_process_ignores_stale_original_inventory_after_endpoint_gone(self):
        handle_closed = False
        exit_queries = 0
        def exited():
            nonlocal exit_queries
            self.assertFalse(handle_closed, "released process handle must not be queried again")
            exit_queries += 1
            return self.browser.closed
        def close_handle():
            nonlocal handle_closed
            handle_closed = True
        self.monitor.exited = exited
        self.monitor.close = close_handle
        with patch.object(lifecycle, "_browser_inventory", side_effect=[[self.record]] * 4) as inventory:
            result = await lifecycle.save_and_close(self.controller)
        self.assertEqual(result["status"], "closed")
        self.assertEqual(inventory.call_count, 4)
        self.assertEqual(exit_queries, 1)
        self.assertTrue(handle_closed)
        self.assertTrue(self.lock.owned)
        self.assertEqual(self.browser.events.count("Browser.close"), 1)

    async def test_stale_original_inventory_cannot_hide_replacement_endpoint(self):
        with patch.object(lifecycle, "_browser_inventory", return_value=[self.record]), \
                patch.object(lifecycle, "_cdp_version_sync", return_value={"Browser": "other"}):
            error = await self.failure("browser_ownership_mismatch")
        self.assertEqual(error.details["reason"], "replacement_endpoint_detected")
        self.assertTrue(self.browser.closed)

    async def test_exit_during_inventory_sampling_allows_incomplete_original_record(self):
        incomplete = {**self.record, "root": None, "port": None, "executable": None}
        with patch.object(lifecycle, "_browser_inventory", side_effect=[[self.record]] * 3 + [[incomplete]]), \
                patch.object(self.monitor, "exited", side_effect=[False, True]) as exited:
            result = await lifecycle.save_and_close(self.controller)
        self.assertEqual(result["status"], "closed")
        self.assertEqual(exited.call_count, 2)
        self.assertTrue(self.controller._native_exit_confirmed)
        self.assertTrue(self.lock.owned)

    async def test_same_pid_with_different_creation_time_is_still_replacement(self):
        replacement = {**self.record, "started_at": "later", "root": None, "port": None, "executable": None}
        with patch.object(lifecycle, "_browser_inventory", side_effect=[[self.record]] * 3 + [[replacement]]):
            error = await self.failure("browser_ownership_mismatch")
        self.assertEqual(error.details["reason"], "replacement_browser_detected")
        self.assertEqual(self.browser.events.count("Browser.close"), 1)

    async def test_replacement_after_close_is_detected_without_closing_it(self):
        replacement = {**self.record, "pid": 2222, "started_at": "later"}
        with patch.object(lifecycle, "_browser_inventory", side_effect=[[self.record]] * 3 + [[replacement]]):
            error = await self.failure("browser_ownership_mismatch")
        self.assertEqual(error.details["reason"], "replacement_browser_detected")
        self.assertEqual(self.browser.events.count("Browser.close"), 1)

    async def test_replacement_endpoint_after_process_exit_is_detected(self):
        with patch.object(lifecycle, "_cdp_version_sync", return_value={"Browser": "other"}):
            error = await self.failure("browser_ownership_mismatch")
        self.assertEqual(error.details["reason"], "replacement_endpoint_detected")

    async def test_unknown_process_exit_is_failure(self):
        self.monitor.exited = lambda: (_ for _ in ()).throw(ValueError("private"))
        await self.failure("browser_close_failed")


class CookieScopeTests(unittest.TestCase):
    def test_promotion_families_and_explicit_local_fixture_host(self):
        families, hosts = business_cookie_scope("promotion", ["http://127.0.0.1:1/", "https://one.alimama.com/"])
        self.assertEqual(families, {"taobao.com", "tmall.com", "alimama.com"})
        self.assertEqual(hosts, {"127.0.0.1", "one.alimama.com"})

    def test_host_only_partitioned_security_attributes_preserved(self):
        cookie = {"name": "__Host-session", "value": "private", "domain": "one.alimama.com", "path": "/",
                  "secure": True, "httpOnly": True, "sameSite": "None", "priority": "High",
                  "partitionKey": {"topLevelSite": "https://taobao.com", "hasCrossSiteAncestor": True}}
        param = persistent_cookie_param(cookie, 12345)
        self.assertNotIn("domain", param)
        self.assertEqual(param["url"], "https://one.alimama.com/")
        self.assertEqual(param["partitionKey"], cookie["partitionKey"])
        self.assertIsNot(param["partitionKey"], cookie["partitionKey"])
        self.assertEqual(param["priority"], "High")


if __name__ == "__main__":
    unittest.main()
