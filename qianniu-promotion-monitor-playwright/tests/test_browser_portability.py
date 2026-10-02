"""Offline coverage of relocatable browser config and independent lock budgets."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import playwright_controller as controller_module
from browser_lock import FileMutexBusy
from playwright_controller import (
    BrowserControllerError, PlaywrightBrowserController, ProfileLock,
    _resolve_browser_executable, load_browser_config,
)
from promotion_adapter import PromotionAdapter


class BrowserConfigPortabilityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="promotion-portability-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config_dir = self.root / "config"
        self.config_dir.mkdir()
        self.config_path = self.config_dir / "browser.json"
        self.browser = self.root / "browser" / "chrome.exe"
        self.browser.parent.mkdir()
        self.browser.write_bytes(b"offline fixture")
        self.value = {
            "schema_version": 1, "browser": "Chrome", "user_data_dir": "../profiles/shop01",
            "download_dir": "../downloads/shop01", "remote_debugging_port": 19401,
            "browser_sessions": {"home": "https://myseller.taobao.com/"},
        }

    def load(self, value=None):
        self.config_path.write_text(json.dumps(self.value if value is None else value), encoding="utf-8")
        return load_browser_config(self.config_path)[0]

    def test_absent_optional_settings_preserve_old_normalized_identity(self):
        # The previous loader left explicit absolute executable strings intact.
        # Preserve spelling, including forward slashes on Windows, in hashes.
        self.value["executable_path"] = self.browser.as_posix()
        self.value["playwright"] = {"browser_executable": self.browser.as_posix()}
        expected = {
            **self.value,
            "user_data_dir": str(self.root / "profiles" / "shop01"),
            "profile_directory": "Default",
            "download_dir": str(self.root / "downloads" / "shop01"),
            "download_root": str(self.root / "downloads" / "shop01"),
            "playwright": {
                "browser_executable": self.browser.as_posix(), "profile_directory": "Default",
                "download_dir": str(self.root / "downloads" / "shop01"),
            },
        }
        normalized = self.load()
        self.assertEqual(normalized, expected)
        self.assertNotIn("lock_wait_seconds", normalized)

    def test_all_executable_aliases_are_relative_to_config_not_cwd(self):
        other_cwd = self.root / "unrelated-working-directory"
        other_cwd.mkdir()
        previous_cwd = Path.cwd()
        try:
            os.chdir(other_cwd)
            for nested in (False, True):
                for key in ("executable_path", "browser_executable"):
                    with self.subTest(nested=nested, key=key):
                        value = dict(self.value)
                        section = value.setdefault("playwright", {}) if nested else value
                        section[key] = "../browser/chrome.exe"
                        normalized = self.load(value)
                        self.assertEqual(_resolve_browser_executable(normalized), self.browser)
                        self.assertEqual(normalized["user_data_dir"], str(self.root / "profiles" / "shop01"))
        finally:
            os.chdir(previous_cwd)

    def test_paths_expand_environment_and_user_home_without_shell_execution(self):
        with patch.dict(os.environ, {"PROMOTION_PORTABLE_ROOT": str(self.root)}):
            self.value.update({
                "user_data_dir": "${PROMOTION_PORTABLE_ROOT}/profiles/shop01",
                "download_dir": "${PROMOTION_PORTABLE_ROOT}/downloads/shop01",
                "executable_path": "${PROMOTION_PORTABLE_ROOT}/browser/chrome.exe",
            })
            normalized = self.load()
        self.assertEqual(normalized["user_data_dir"], str(self.root / "profiles" / "shop01"))
        self.assertEqual(normalized["download_dir"], str(self.root / "downloads" / "shop01"))
        self.assertEqual(_resolve_browser_executable(normalized), self.browser)
        self.value["user_data_dir"] = "~/promotion-portability-fixture"
        normalized = self.load()
        self.assertEqual(normalized["user_data_dir"], str((Path.home() / "promotion-portability-fixture").resolve()))

    def test_lock_wait_rejects_malformed_nonfinite_and_out_of_range_values(self):
        for value in (True, False, None, "30", {}, [], -0.01, 120.01, float("nan"),
                      float("inf"), float("-inf"), 10 ** 1000):
            with self.subTest(value=value):
                self.value["lock_wait_seconds"] = value
                with self.assertRaises(BrowserControllerError) as raised:
                    self.load()
                self.assertEqual(raised.exception.code, "configuration")
                self.assertIn("lock_wait_seconds", str(raised.exception))

    def test_promotion_default_and_explicit_budget_reach_controller_unchanged(self):
        normalized = self.load()
        adapter = PromotionAdapter({"browser_config_value": normalized}, {})
        self.assertEqual(adapter.controller.lock_wait_ms, 5000)
        self.assertEqual(PlaywrightBrowserController(normalized).lock_wait_ms, 0)
        for seconds in (0, 0.125, 45, 120):
            with self.subTest(seconds=seconds):
                self.value["lock_wait_seconds"] = seconds
                normalized = self.load()
                adapter = PromotionAdapter({"browser_config_value": normalized}, {})
                self.assertEqual(adapter.controller.lock_wait_ms, seconds * 1000)
                self.assertEqual(PlaywrightBrowserController(normalized).lock_wait_ms, seconds * 1000)


class BrowserLockBudgetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="promotion-wait-budget-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.owner = ProfileLock(self.root, "Default")
        self.owner.acquire()
        self.addCleanup(self.owner.release)
        self.now = 100.0
        self.sleeps = []
        self.release_at = None
        self.controller = PlaywrightBrowserController({
            "user_data_dir": str(self.root), "lock_wait_seconds": 40,
            "browser_sessions": {"home": "https://myseller.taobao.com/"},
        }, timeout_ms=30_000)
        self.controller._profile_lock = ProfileLock(self.root, "Default")
        self.addAsyncCleanup(self.controller.close)

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds
        if self.release_at is not None and self.now >= self.release_at:
            self.owner.release()

    async def acquire_with_simulated_clock(self):
        # Replace module references, not the process-wide event-loop clock.
        with patch.object(controller_module, "time", SimpleNamespace(monotonic=lambda: self.now)), \
                patch.object(controller_module, "asyncio", SimpleNamespace(sleep=self.sleep)):
            await self.controller._acquire_profile_lock()

    async def test_real_mutex_release_after_35_seconds_uses_full_configured_budget(self):
        self.release_at = self.now + 35
        await self.acquire_with_simulated_clock()
        self.assertTrue(self.controller._profile_lock.owned)
        self.assertGreaterEqual(sum(self.sleeps), 35)
        self.assertLess(sum(self.sleeps), 35.2)
        self.assertFalse(self.owner.owned)

    async def test_persistent_real_mutex_times_out_at_independent_budget(self):
        started = self.now
        with self.assertRaises(BrowserControllerError) as raised:
            await self.acquire_with_simulated_clock()
        self.assertEqual(raised.exception.code, "profile_locked")
        self.assertIsInstance(raised.exception.__cause__, FileMutexBusy)
        self.assertAlmostEqual(self.now - started, 40)
        self.assertIsNone(self.controller._profile_lock)
        self.assertTrue(self.owner.owned)

    async def test_zero_budget_attempts_once_without_sleep(self):
        self.controller.lock_wait_ms = 0
        with self.assertRaises(BrowserControllerError):
            await self.acquire_with_simulated_clock()
        self.assertEqual(self.sleeps, [])
        self.assertTrue(self.owner.owned)

    async def test_profile_error_without_mutex_cause_is_not_retried(self):
        error = BrowserControllerError("ownership cannot be established", "profile_locked")
        with patch.object(self.controller._profile_lock, "acquire", side_effect=error) as acquire:
            with self.assertRaises(BrowserControllerError) as raised:
                await self.acquire_with_simulated_clock()
        self.assertIs(raised.exception, error)
        self.assertEqual(acquire.call_count, 1)
        self.assertEqual(self.sleeps, [])


if __name__ == "__main__":
    unittest.main()
