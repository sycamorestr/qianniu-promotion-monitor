"""Validate exact attachment selection and browser cookie rollback."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import feishu_cookie_recovery as recovery


def record(name, file_token):
    return {"fields": {"平台": "千牛", "店铺名称": name, "Cookie文件": [{"file_token": file_token}]}}


class FeishuCookieRecoveryTests(unittest.TestCase):
    def test_attachment_matches_exact_store_even_across_pages(self):
        responses = [
            {"data": {"items": [record("测试店旗舰店", "other")], "has_more": True, "page_token": "next"}},
            {"data": {"items": [record([{"text": "测试店"}], "same")], "has_more": False}},
        ]
        with patch.object(recovery, "_request", side_effect=responses) as get:
            self.assertEqual(recovery._record_attachment({"app_token": "app", "table_id": "table"}, "test", "测试店"), "same")
        self.assertIn("page_token=next", get.call_args.args[0])

    def test_nickname_only_snapshot_cannot_replace_login(self):
        rows = [
            {"name": "cookie2", "value": "fixture", "domain": ".taobao.com"},
            {"name": "cna", "value": "fixture", "domain": ".alimama.com"},
        ]
        with self.assertRaisesRegex(recovery.CookieRecoveryError, "cookie2"):
            recovery._attachment_cookies({"cookies": rows})


class CookieRollbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_identity_restores_only_alimama_cookies(self):
        old = {"name": "cookie2", "value": "old", "domain": ".alimama.com", "path": "/", "expires": -1}
        unrelated = {"name": "cookie2", "value": "keep", "domain": ".taobao.com", "path": "/", "expires": -1}
        incoming = {"name": "cookie2", "value": "incoming", "domain": ".alimama.com", "path": "/"}
        jar = [old, unrelated]

        async def send(command, params):
            if command == "Target.getTargetInfo":
                return {"targetInfo": {"browserContextId": "profile"}}
            if command == "Target.getBrowserContexts":
                return {"browserContextIds": ["profile"]}
            if command == "Storage.getCookies":
                return {"cookies": jar.copy()}
            if command == "Storage.setCookies":
                jar.extend(params["cookies"])
            if command == "Network.deleteCookies":
                jar[:] = [row for row in jar if any(row[k] != params[k] for k in ("name", "domain", "path"))]

        session = SimpleNamespace(send=send, detach=AsyncMock())
        context = SimpleNamespace(new_cdp_session=AsyncMock(return_value=session))
        page = SimpleNamespace(context=context)
        browser = SimpleNamespace(new_browser_cdp_session=AsyncMock(return_value=session))

        with self.assertRaisesRegex(ValueError, "wrong identity"):
            async with recovery.replace_alimama_cookies(browser, page, [incoming]):
                self.assertEqual(jar, [unrelated, incoming])
                raise ValueError("wrong identity")
        self.assertEqual({row["domain"]: row["value"] for row in jar},
                         {".taobao.com": "keep", ".alimama.com": "old"})
