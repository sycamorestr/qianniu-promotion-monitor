"""Offline coverage of bounded lock waits and safe per-shop continuation."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import promotion_adapter
import run_batch
from browser_lock import FileMutexBusy
from playwright_controller import BrowserControllerError, PlaywrightBrowserController, ProfileLock
from promotion_adapter import PromotionAdapter, PromotionError


DATE = "2026-09-30"


class OfflineController(PlaywrightBrowserController):
    """Exercise the real local mutex; never start Playwright or contact CDP."""

    def __init__(self, config, owner, **kwargs):
        super().__init__(config, **kwargs)
        self.owner = owner
        self.sid = Path(self.config["user_data_dir"]).name

    async def start(self, **_kwargs):
        self.owner.events.append(("start", self.sid))
        if self.sid in self.owner.entry_errors:
            raise self.owner.entry_errors[self.sid]
        self._profile_lock = ProfileLock(Path(self.config["user_data_dir"]), "Default")
        await self._acquire_profile_lock()
        self.browser = object()
        self.context = object()

    async def connect(self, **kwargs):
        await self.start(**kwargs)

    def page(self, _role):
        return object()

    async def close(self):
        if self._profile_lock is not None:
            self._profile_lock.release()
            self._profile_lock = None
        self.browser = self.context = None
        self.owner.events.append(("detach", self.sid))
        if self.sid in self.owner.detach_errors:
            raise self.owner.detach_errors[self.sid]


class OfflineFactory:
    def __init__(self):
        self.events = []
        self.controllers = []
        self.entry_errors = {}
        self.cleanup_errors = {}
        self.detach_errors = {}
        self.pause_errors = {}
        self.paused = set()

    def controller(self, config, **kwargs):
        controller = OfflineController(config, self, **kwargs)
        self.controllers.append(controller)
        return controller

    async def save_and_close(self, controller):
        self.events.append(("save-close", controller.sid))
        if controller.sid in self.cleanup_errors:
            raise self.cleanup_errors[controller.sid]
        return {"status": "closed", "cookie_sync": {"status": "saved"}}

    def __call__(self, shop, config, **kwargs):
        adapter = PromotionAdapter(shop, config, **kwargs)
        sid = shop["id"]

        async def scan(date, is_rt, targets=None):
            self.events.append(("scan", sid, targets is not None))
            adapter.observed_identity = {"shopName": shop["store"], "nickName": shop["store"]}
            if targets is None:
                return [{"recordType": "campaign", "shopId": sid, "shopName": shop["store"],
                         "promotionType": "全站推", "campaignId": "101", "campaignName": "测试计划",
                         "roi": 1, "charge": 50, "displayStatus": "start", "onlineStatus": 1,
                         "reportContext": {"startTime": date, "endTime": date, "isRt": is_rt}}]
            rows = []
            for target in targets:
                current = deepcopy(target)
                current.pop("latest", None)
                inactive = (sid, target["campaignId"]) in self.paused
                current.update(recordType="verification", verified=True,
                               outcome="inactive" if inactive else "active",
                               displayStatus="pause" if inactive else "start", onlineStatus=0 if inactive else 1)
                rows.append(current)
            return rows

        async def pause(target):
            self.events.append(("pause", sid, target["campaignId"]))
            if sid in self.pause_errors:
                raise self.pause_errors[sid]
            self.paused.add((sid, target["campaignId"]))
            return {"writeAttempted": True, "verified": False}

        adapter.scan = scan
        adapter.pause = pause
        return adapter


class LockContentionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="promotion-lock-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.registry = self.root / "shops.json"
        shops = []
        for index, sid in enumerate(("shop01", "shop02")):
            config_path = self.root / (sid + ".json")
            config_path.write_text(json.dumps({
                "schema_version": 1, "browser": "Edge", "user_data_dir": str(self.root / "profiles" / sid),
                "download_dir": str(self.root / "downloads" / sid), "profile_directory": "Default",
                "remote_debugging_port": 19401 + index,
                "browser_sessions": {"home": "https://myseller.taobao.com/"},
            }), encoding="utf-8")
            shops.append({"id": sid, "store": "店铺" + sid, "browser_config": str(config_path)})
        self.registry.write_text(json.dumps({"schema_version": 1, "shops": shops}), encoding="utf-8")
        self.factory = OfflineFactory()
        for item in (patch.object(promotion_adapter, "PlaywrightBrowserController", self.factory.controller),
                     patch.object(promotion_adapter, "save_and_close", self.factory.save_and_close)):
            item.start()
            self.addCleanup(item.stop)

    def args(self, *extra):
        return run_batch.parser().parse_args([
            "--registry", str(self.registry), "--date", DATE,
            "--output-root", str(self.root / "outputs"), "--no-notify", *extra,
        ])

    def sender(self, *_args):
        self.fail("Offline contention tests must not send notifications")

    async def run_batch(self, *extra):
        return await run_batch.run(self.args(*extra), adapter_factory=self.factory, sender=self.sender)

    def record(self, run_dir, state, sid):
        return run_batch.load_shop(run_dir, state["shops"][sid])

    def external_lock(self, sid="shop01"):
        lock = ProfileLock(self.root / "profiles" / sid, "Default")
        lock.acquire()
        self.addCleanup(lock.release)
        return lock

    async def test_temporary_lock_release_waits_and_executes_business_once(self):
        lock = self.external_lock()

        async def release_soon():
            await asyncio.sleep(0.15)
            lock.release()

        release = asyncio.create_task(release_soon())
        try:
            _, state = await self.run_batch("--mode", "execute", "--shops", "shop01")
        finally:
            await release
        self.assertEqual(state["status"], "complete")
        self.assertEqual(self.factory.controllers[0].lock_wait_ms, 5000)
        self.assertEqual(self.factory.events.count(("start", "shop01")), 1)
        self.assertEqual(self.factory.events.count(("scan", "shop01", False)), 1)
        self.assertEqual(self.factory.events.count(("pause", "shop01", "101")), 1)

    async def test_persistent_lock_is_bounded_and_only_blocks_its_shop(self):
        lock = self.external_lock()
        started = time.monotonic()
        run_dir, state = await self.run_batch("--mode", "execute")
        elapsed = time.monotonic() - started
        # Permit slow filesystem scheduling, but detect missing waits or an
        # accidental unbounded retry. The configured budget remains exactly 5s.
        self.assertGreaterEqual(elapsed, 4.5)
        self.assertLess(elapsed, 10)
        self.assertEqual(self.factory.controllers[0].lock_wait_ms, 5000)
        first = self.record(run_dir, state, "shop01")
        self.assertEqual(first["status"], "failed")
        self.assertEqual(first["browser_cleanup"], {"status": "not_connected", "reason": "profile_lock_busy"})
        self.assertEqual([error["code"] for error in first["last_run_errors"]], ["profile_locked"])
        self.assertEqual(state["shops"]["shop02"]["status"], "complete")
        self.assertEqual(state["status"], "needs_review")
        self.assertFalse(any(event[0] in {"scan", "pause", "save-close"} and event[1] == "shop01"
                             for event in self.factory.events))
        self.assertTrue(lock.owned)

    async def test_profile_locked_without_mutex_cause_still_stops_the_batch(self):
        self.factory.entry_errors["shop01"] = BrowserControllerError("fixture ambiguous owner", "profile_locked")
        run_dir, state = await self.run_batch("--mode", "execute")
        first = self.record(run_dir, state, "shop01")
        self.assertEqual(state["status"], "stopped")
        self.assertNotIn("shop02", state["shops"])
        self.assertNotEqual(first["browser_cleanup"].get("reason"), "profile_lock_busy")
        self.assertIn("browser_close_failed", [error["code"] for error in first["last_run_errors"]])

    async def test_actual_save_or_close_failure_stops_later_shops(self):
        for code in ("cookie_sync_failed", "browser_close_failed"):
            with self.subTest(code=code):
                self.factory.cleanup_errors["shop01"] = BrowserControllerError("fixture cleanup failed", code)
                self.factory.events.clear()
                run_dir, state = await self.run_batch("--mode", "execute")
                first = self.record(run_dir, state, "shop01")
                self.assertEqual(state["status"], "stopped")
                self.assertNotIn("shop02", state["shops"])
                self.assertEqual(first["browser_cleanup"]["status"], "open")
                self.assertIn(code, [error["code"] for error in first["last_run_errors"]])
                self.assertNotIn(("start", "shop02"), self.factory.events)

    async def test_keep_browser_preserves_preconnection_lock_evidence(self):
        busy = BrowserControllerError("fixture mutex busy", "profile_locked")
        busy.__cause__ = FileMutexBusy("fixture lock")
        self.factory.entry_errors["shop01"] = busy
        run_dir, state = await self.run_batch("--mode", "execute", "--keep-browser", "--shops", "shop01")
        first = self.record(run_dir, state, "shop01")
        self.assertEqual(first["browser_cleanup"], {"status": "not_connected", "reason": "profile_lock_busy"})
        self.assertEqual(first["status"], "failed")
        self.assertEqual(state["status"], "needs_review")

    async def test_detach_failure_after_mutex_conflict_still_stops_later_shops(self):
        busy = BrowserControllerError("fixture mutex busy", "profile_locked")
        busy.__cause__ = FileMutexBusy("fixture lock")
        self.factory.entry_errors["shop01"] = busy
        self.factory.detach_errors["shop01"] = RuntimeError("fixture detach failure")
        run_dir, state = await self.run_batch("--mode", "execute")
        first = self.record(run_dir, state, "shop01")
        self.assertEqual(state["status"], "stopped")
        self.assertNotIn("shop02", state["shops"])
        self.assertEqual(first["browser_cleanup"]["error"]["code"], "browser_close_failed")
        self.assertNotIn(("start", "shop02"), self.factory.events)

    async def test_resume_after_lock_conflict_never_replays_uncertain_pause(self):
        busy = BrowserControllerError("fixture mutex busy", "profile_locked")
        busy.__cause__ = FileMutexBusy("fixture lock")
        self.factory.entry_errors["shop01"] = busy
        self.factory.pause_errors["shop02"] = PromotionError("write_uncertain", "fixture unknown", write_attempted=True)
        run_dir, state = await self.run_batch("--mode", "execute")
        self.assertEqual(self.factory.events.count(("pause", "shop02", "101")), 1)
        self.assertEqual(state["status"], "needs_review")
        original_identity = deepcopy(state["identity"])
        self.factory.entry_errors.clear()
        self.factory.pause_errors.clear()
        self.factory.events.clear()
        _, resumed = await self.run_batch("--resume", str(run_dir))
        self.assertEqual(resumed["identity"], original_identity)
        self.assertFalse(any(event[0] == "pause" for event in self.factory.events))
        self.assertIn(("scan", "shop01", False), self.factory.events)
        self.assertIn(("scan", "shop02", True), self.factory.events)
        self.assertEqual(len(self.record(run_dir, resumed, "shop02")["attempts"]), 1)

    async def test_resume_lock_conflict_cannot_clear_previous_close_failure(self):
        self.factory.cleanup_errors["shop01"] = BrowserControllerError("fixture close failed", "browser_close_failed")
        run_dir, original = await self.run_batch("--mode", "execute")
        self.assertEqual(original["status"], "stopped")
        self.assertEqual(self.factory.events.count(("pause", "shop01", "101")), 1)
        previous = self.record(run_dir, original, "shop01")
        self.assertEqual(previous["browser_cleanup"]["status"], "open")
        self.assertNotIn("shop02", original["shops"])

        busy = BrowserControllerError("fixture mutex busy", "profile_locked")
        busy.__cause__ = FileMutexBusy("fixture lock")
        self.factory.entry_errors["shop01"] = busy
        self.factory.cleanup_errors.clear()
        self.factory.events.clear()
        _, blocked = await self.run_batch("--resume", str(run_dir))
        still_open = self.record(run_dir, blocked, "shop01")
        self.assertEqual(blocked["status"], "stopped")
        self.assertNotIn("shop02", blocked["shops"])
        self.assertTrue(still_open["browser_cleanup"]["unresolved_previous_cleanup"])
        self.assertEqual(still_open["browser_cleanup"]["error"]["code"], "browser_close_failed")
        self.assertEqual(still_open["attempts"], previous["attempts"])
        self.assertFalse(any(event[0] in {"scan", "pause", "save-close"} for event in self.factory.events))

        self.factory.entry_errors.clear()
        self.factory.events.clear()
        _, recovered = await self.run_batch("--resume", str(run_dir))
        first = self.record(run_dir, recovered, "shop01")
        self.assertEqual(first["browser_cleanup"]["status"], "closed")
        self.assertNotIn("unresolved_previous_cleanup", first["browser_cleanup"])
        self.assertNotIn("error", first["browser_cleanup"])
        self.assertNotEqual(recovered["status"], "stopped")
        self.assertIn("shop02", recovered["shops"])
        self.assertLess(self.factory.events.index(("save-close", "shop01")),
                        self.factory.events.index(("start", "shop02")))
        self.assertFalse(any(event[0] == "pause" for event in self.factory.events))
        self.assertEqual(first["attempts"], previous["attempts"])


if __name__ == "__main__":
    unittest.main()
