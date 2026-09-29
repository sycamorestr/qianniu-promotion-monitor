"""Keep eligible session cookies in their original Chromium profile.

Cookie secrets exist only in the browser and this short-lived CDP call. The
returned status and optional metadata file contain counts and timestamps only.
This does not extend a platform's server-side session lifetime.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import time
from typing import Any, Callable, Iterable
from urllib.parse import urlsplit


RETENTION_DAYS = 30
METADATA_NAME = ".browser-workbench-cookie-sync.json"
MESSAGES = {
    "idle": "尚未保存当前浏览器会话",
    "saved": "会话已保存到原浏览器目录；平台仍可使登录失效",
    "partial": "部分会话未保存成功，浏览器保持运行，请重试保存",
    "error": "会话保存失败，浏览器保持运行，请重试保存",
}


def empty_status() -> dict[str, Any]:
    return {"status": "idle", "last_saved_at": None, "persisted_count": 0,
            "failed_count": 0, "skipped_count": 0, "message": MESSAGES["idle"]}


def business_cookie_scope(kind: str, configured_urls: Iterable[str]) -> tuple[set[str], set[str]]:
    """Known business families plus exact hosts explicitly configured locally."""
    families = {"erp321.com"} if kind == "shared" else {"taobao.com", "tmall.com", "alimama.com"}
    hosts = set()
    for url in configured_urls:
        parsed = urlsplit(url)
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            hosts.add(parsed.hostname.lower().rstrip("."))
    return families, hosts


def in_scope(domain: Any, families: set[str], hosts: set[str]) -> bool:
    if not isinstance(domain, str):
        return False
    host = domain.lower().lstrip(".").rstrip(".")
    return host in hosts or any(host == family or host.endswith("." + family) for family in families)


def persistent_cookie_param(cookie: dict[str, Any], expires: float) -> dict[str, Any]:
    """Preserve host-only, security and partition attributes when adding expiry."""
    if cookie.get("partitionKeyOpaque"):
        raise ValueError("opaque cookie cannot be restored")
    domain = cookie["domain"]
    name = cookie["name"]
    path = cookie.get("path") or "/"
    host_only = bool(cookie.get("hostOnly", not domain.startswith("."))) or name.startswith("__Host-")
    result = {"name": name, "value": cookie["value"], "path": path,
              "secure": bool(cookie.get("secure")), "httpOnly": bool(cookie.get("httpOnly")),
              "expires": expires}
    if host_only:
        scheme = "https" if cookie.get("secure") or cookie.get("sourceScheme") == "Secure" else "http"
        host = domain.lstrip(".")
        if ":" in host and not host.startswith("["):
            host = "[" + host + "]"
        result["url"] = f"{scheme}://{host}{path}"
    else:
        result["domain"] = domain
    for key in ("sameSite", "priority", "sameParty", "sourceScheme", "sourcePort", "partitionKey"):
        if key in cookie:
            result[key] = deepcopy(cookie[key])
    return result


async def persist_session_cookies(browser: Any, families: set[str], hosts: set[str], *,
                                  should_continue: Callable[[], bool] | None = None) -> dict[str, Any]:
    """Bound one checkpoint and report partial failures without secret text."""
    result = empty_status()
    session = None
    pending_count = 0
    try:
        session = await asyncio.wait_for(browser.new_browser_cdp_session(), timeout=3)
        response = await asyncio.wait_for(session.send("Storage.getCookies"), timeout=3)
        cookies = response.get("cookies")
        if not isinstance(cookies, list):
            raise ValueError("invalid cookie response")
        eligible = []
        for cookie in cookies:
            if (not isinstance(cookie, dict) or not in_scope(cookie.get("domain"), families, hosts)
                    or cookie.get("session") is not True or cookie.get("partitionKeyOpaque")):
                result["skipped_count"] += 1
                continue
            eligible.append(cookie)
        pending_count = len(eligible)
        deadline = time.monotonic() + 8
        expires = time.time() + RETENTION_DAYS * 86400
        for cookie in eligible:
            if (should_continue is not None and not should_continue()) or time.monotonic() >= deadline:
                # Unattempted eligible cookies are not silently counted as saved.
                result["failed_count"] += pending_count
                pending_count = 0
                break
            try:
                param = persistent_cookie_param(cookie, expires)
                await asyncio.wait_for(session.send("Storage.setCookies", {"cookies": [param]}),
                                       timeout=min(2, max(0.05, deadline - time.monotonic())))
                result["persisted_count"] += 1
            except Exception:
                result["failed_count"] += 1
            pending_count -= 1
        result["status"] = ("partial" if result["persisted_count"] else "error") if result["failed_count"] else "saved"
    except Exception:
        result["failed_count"] += pending_count
        result["status"] = "partial" if result["persisted_count"] else "error"
    finally:
        if session is not None:
            try:
                await asyncio.wait_for(session.detach(), timeout=1)
            except Exception:
                pass
    if result["status"] == "saved" or result["persisted_count"]:
        result["last_saved_at"] = datetime.now(timezone.utc).isoformat()
    result["message"] = MESSAGES[result["status"]]
    return result


def read_metadata(root: Path) -> dict[str, Any]:
    result = empty_status()
    try:
        data = json.loads((root / METADATA_NAME).read_text(encoding="utf-8"))
        if data.get("status") not in MESSAGES:
            return result
        timestamp = data.get("last_saved_at")
        if timestamp is not None:
            parsed = datetime.fromisoformat(timestamp)
            if parsed.tzinfo is None:
                return result
            timestamp = parsed.isoformat()
        counts = [data.get(key) for key in ("persisted_count", "failed_count", "skipped_count")]
        if any(type(value) is not int or value < 0 for value in counts):
            return result
        result.update(status=data["status"], last_saved_at=timestamp,
                      persisted_count=counts[0], failed_count=counts[1], skipped_count=counts[2],
                      message=MESSAGES[data["status"]])
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return result


def write_metadata(root: Path, value: dict[str, Any]) -> None:
    """Atomic allowlisted status write; never serialize CDP payloads/errors."""
    safe = {key: value[key] for key in ("status", "last_saved_at", "persisted_count", "failed_count", "skipped_count")}
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=root,
                                         prefix=".cookie-sync-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(safe, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / METADATA_NAME)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
