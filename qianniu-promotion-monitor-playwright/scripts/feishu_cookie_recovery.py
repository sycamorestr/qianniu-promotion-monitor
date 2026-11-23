"""Read a shop's current Feishu attachment and prepare Alimama cookies."""
from __future__ import annotations

import asyncio
import json
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from session_cookies import in_scope, persistent_cookie_param


CONFIG = Path(__file__).resolve().parent.parent / "config.json"
API = "https://open.feishu.cn/open-apis/"
MAX_BYTES = 10 * 1024 * 1024


class CookieRecoveryError(RuntimeError):
    pass


def recovery_config(config_path=CONFIG):
    try:
        data = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        raise CookieRecoveryError("无法读取巡检本机配置") from None
    section = data.get("feishu_cookie_recovery") if isinstance(data, dict) else None
    if section is None:
        return None
    if not isinstance(section, dict):
        raise CookieRecoveryError("飞书 Cookie 恢复配置无效")
    path = section.get("settings_file")
    if path in (None, ""):
        return None
    aliases = section.get("shop_names", {})
    if not isinstance(path, str) or not isinstance(aliases, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) or not v.strip() for k, v in aliases.items()
    ):
        raise CookieRecoveryError("飞书 Cookie 恢复配置无效")
    return config_path.parent / Path(path).expanduser(), aliases


def _request(path, *, token=None, body=None, binary=False):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(API + path, json.dumps(body).encode() if body is not None else None, headers)
    try:
        with urlopen(request, timeout=15) as response:
            raw = response.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise CookieRecoveryError("飞书响应或附件超过大小限制")
        if binary:
            return raw
        payload = json.loads(raw)
    except (OSError, ValueError):
        raise CookieRecoveryError("飞书 Cookie 库读取失败，请检查连接和应用权限") from None
    if not isinstance(payload, dict) or payload.get("code") != 0:
        raise CookieRecoveryError("飞书拒绝读取 Cookie 库，请检查应用权限和配置")
    return payload


def _record_attachment(cfg, token, shop_name):
    table = f"bitable/v1/apps/{quote(cfg['app_token'], safe='')}/tables/{quote(cfg['table_id'], safe='')}/records"
    matches, cursors = [], set()
    query = {"page_size": 100}
    while True:
        data = _request(table + "?" + urlencode(query), token=token).get("data", {})
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise CookieRecoveryError("飞书未返回完整店铺列表")
        for item in items:
            fields = item.get("fields") if isinstance(item, dict) else None
            if not isinstance(fields, dict):
                raise CookieRecoveryError("飞书未返回完整店铺字段")
            name = fields.get("店铺名称")
            if isinstance(name, list):
                name = "".join(str(part.get("text") or "") for part in name if isinstance(part, dict))
            if name == shop_name and fields.get("平台") == cfg.get("platform", "千牛"):
                matches.append(fields.get("Cookie文件"))
        if not data.get("has_more"):
            break
        cursor = data.get("page_token")
        if not cursor or cursor in cursors:
            raise CookieRecoveryError("飞书店铺查询分页未完成")
        cursors.add(cursor)
        query["page_token"] = cursor
    if len(matches) != 1:
        raise CookieRecoveryError("飞书没有唯一匹配的千牛店铺记录")
    files = matches[0]
    if not isinstance(files, list) or len(files) != 1 or not isinstance(files[0], dict):
        raise CookieRecoveryError("飞书店铺须有且仅有一份 Cookie 附件")
    token = files[0].get("file_token")
    if not isinstance(token, str) or not token:
        raise CookieRecoveryError("飞书 Cookie 附件无法下载")
    return token


def alimama_cookie(cookie):
    return in_scope(cookie.get("domain"), {"alimama.com"}, set())


def cookie_param(cookie):
    expiration = float(cookie.get("expires", cookie.get("expirationDate", -1)) or -1)
    result = persistent_cookie_param(cookie, expiration)
    if expiration < 0 or cookie.get("session") is True:
        result.pop("expires", None)
    return result


def _attachment_cookies(document):
    rows = document.get("cookies") if isinstance(document, dict) else document
    if not isinstance(rows, list):
        raise CookieRecoveryError("飞书 Cookie 附件格式无效")
    now = time.time()
    result = []
    has_login_cookie = False
    try:
        for row in rows:
            if not isinstance(row, dict) or not alimama_cookie(row):
                continue
            expires = row.get("expires", row.get("expirationDate", -1))
            if expires not in (None, "") and 0 <= float(expires) <= now and not row.get("session"):
                continue
            if not isinstance(row.get("name"), str) or not row["name"] or not isinstance(row.get("value"), str):
                raise ValueError
            result.append(cookie_param(row))
            if row["name"] == "cookie2" and row["domain"].lower() == ".alimama.com" and row["value"]:
                has_login_cookie = True
    except (TypeError, ValueError):
        raise CookieRecoveryError("飞书附件中的阿里妈妈 Cookie 格式无效") from None
    if not has_login_cookie:
        raise CookieRecoveryError("飞书附件缺少有效期内的阿里妈妈 cookie2，请在该店登录后重新保存")
    return result


def fetch_shop_cookies(settings_path, shop_name):
    try:
        cfg = json.loads(settings_path.read_text(encoding="utf-8-sig"))["feishu"]
        fields = ("app_id", "app_secret", "app_token", "table_id")
        if not all(isinstance(cfg.get(k), str) and cfg[k].strip() for k in fields):
            raise ValueError
    except (OSError, KeyError, TypeError, AttributeError, ValueError):
        raise CookieRecoveryError("飞书 Cookie 库的本机设置无效") from None
    login = _request("auth/v3/tenant_access_token/internal",
                     body={"app_id": cfg["app_id"], "app_secret": cfg["app_secret"]})
    token = login.get("tenant_access_token")
    if not isinstance(token, str) or not token:
        raise CookieRecoveryError("飞书没有返回应用访问令牌")
    file_token = _record_attachment(cfg, token, shop_name)
    raw = _request("drive/v1/medias/" + quote(file_token, safe="") + "/download", token=token, binary=True)
    try:
        document = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeError, ValueError):
        raise CookieRecoveryError("飞书 Cookie 附件不是有效 JSON") from None
    return _attachment_cookies(document)


def is_challenge(url):
    # Match the route only. A return URL in the query can include other routes.
    return bool(re.search(r"captcha|punish|security[-_/]?check|risk[-_/]?verify", url.split("?", 1)[0], re.I))


class CookieRollbackError(CookieRecoveryError):
    pass


@asynccontextmanager
async def replace_alimama_cookies(browser, page, cookies):
    page_session = await page.context.new_cdp_session(page)
    session = None
    try:
        session = await browser.new_browser_cdp_session()

        async def send(client, command, arguments=None):
            return await asyncio.wait_for(client.send(command, arguments or {}), 8)

        info = await send(page_session, "Target.getTargetInfo")
        context_id = info["targetInfo"].get("browserContextId")
        contexts = await send(session, "Target.getBrowserContexts")
        if context_id in contexts["browserContextIds"]:
            scope = {"browserContextId": context_id}
        elif browser.contexts and page.context is browser.contexts[0]:
            scope = {}
        else:
            raise CookieRecoveryError("无法核实 Cookie 所属的浏览器环境")

        async def read():
            result = await send(session, "Storage.getCookies", scope)
            return [cookie for cookie in result["cookies"] if alimama_cookie(cookie)]

        async def clear(items):
            for cookie in items:
                params = {key: cookie[key] for key in ("name", "domain", "path", "partitionKey") if key in cookie}
                await send(page_session, "Network.deleteCookies", params)
            if await read():
                raise CookieRecoveryError("无法清理该店旧的阿里妈妈 Cookie")

        original = await read()
        # Prepare the rollback before deleting any cookie.
        original_params = [cookie_param(cookie) for cookie in original]
        try:
            await clear(original)
            await send(session, "Storage.setCookies", {**scope, "cookies": cookies})
            yield
        except BaseException:
            try:
                await clear(await read())
                if original_params:
                    await send(session, "Storage.setCookies", {**scope, "cookies": original_params})
                key = lambda c: (c["name"], c["domain"], c["path"], c["value"], json.dumps(c.get("partitionKey"), sort_keys=True))
                if {key(c) for c in await read()} != {key(c) for c in original}:
                    raise CookieRecoveryError("旧会话核验失败")
            except Exception:
                raise CookieRollbackError("旧会话还原未确认，保留该店浏览器供核验") from None
            raise
    finally:
        for client in (session, page_session):
            if client is not None:
                try:
                    await asyncio.wait_for(client.detach(), 2)
                except Exception:
                    pass
