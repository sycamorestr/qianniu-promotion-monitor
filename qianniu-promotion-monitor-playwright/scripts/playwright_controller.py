"""Persistent Playwright browser controller for the Qianniu promotion workflow.

This module attaches to a native Edge/Chromium browser profile,
reuses the configured business pages, and exposes small, structured
operations for the online coordinator.  Playwright is imported lazily so the
local file-processing and unit-test paths do not require a browser package.

The controller does not decide which campaigns to change.  It starts or reuses
a native browser, registers page roles, and evaluates caller-supplied scripts.
Business identity checks and write authorization belong to the runner.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from browser_lock import FileMutex, FileMutexBusy


# Keep legacy role names readable so callers can derive promotion-only roles
# in memory from an existing invoice/workbench config without rewriting it.
ROLE_NAMES = ("home", "invoice", "orders", "goods", "promotion", "all_site", "keyword")
SUPPORTED_SCHEMA = 1
LOGIN_URL_RE = re.compile(
    r"(?:^|[/?#._-])(login|signin|sign-in|passport|account/login|member/login)"
    r"(?:[/?#._-]|$)",
    re.IGNORECASE,
)


def _redact_runtime_text(value: str) -> str:
    """Hide local CDP endpoint details from public error envelopes."""
    value = re.sub(r"(?i)(https?://(?:127\.0\.0\.1|localhost|\[::1\]):)\d+", r"\1<local>", value)
    value = re.sub(r"(?i)(remote[-_ ]debugging[-_ ]port[= ])\d+", r"\1<local>", value)
    return value


class BrowserControllerError(RuntimeError):
    """An actionable, serializable controller failure."""

    def __init__(
        self,
        message: str,
        code: str = "browser_failed",
        *,
        details: Mapping[str, Any] | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})
        self.retryable = bool(retryable)

    def to_dict(self) -> dict[str, Any]:
        def redact(value: Any) -> Any:
            if isinstance(value, Mapping):
                return {
                    key: redact(item)
                    for key, item in value.items()
                    if str(key).lower() not in {
                        "port", "debug_port", "remote_debugging_port", "cdp_port",
                        "endpoint", "cdp_endpoint", "websocket_url",
                    }
                }
            if isinstance(value, list):
                return [redact(item) for item in value]
            if isinstance(value, str):
                return _redact_runtime_text(value)
            return value
        return {
            "ok": False,
            "error": {
                "code": self.code,
                "message": _redact_runtime_text(str(self)),
                "retryable": self.retryable,
                "details": redact(self.details),
            },
        }

    def __str__(self) -> str:
        return _redact_runtime_text(super().__str__())


@dataclass(frozen=True)
class RoleSpec:
    role: str
    url: str
    login_positive_patterns: tuple[str, ...] = ()
    login_positive_selectors: tuple[str, ...] = ()


@dataclass
class PageRegistration:
    role: str
    page: Any
    target_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    created: bool = False

    def to_dict(self) -> dict[str, Any]:
        page = self.page
        closed = bool(page.is_closed()) if page is not None else True
        return {
            "role": self.role,
            "target_id": self.target_id,
            "url": "" if page is None else str(getattr(page, "url", "")),
            "closed": closed,
            "created": self.created,
        }


class ProfileLock:
    """One job owns the entire Chromium user-data root, across profiles."""

    def __init__(self, root: Path, profile: str) -> None:
        self.path = root / ".qianniu-browser.lock"
        self._mutex = FileMutex(self.path, {"profile_directory": profile})

    @property
    def owned(self) -> bool:
        return self._mutex.owned

    def acquire(self) -> None:
        try:
            self._mutex.acquire()
        except FileMutexBusy as exc:
            raise BrowserControllerError(
                "浏览器数据目录正被其他作业占用", "profile_locked",
                details={"user_data_dir": str(self.path.parent)}, retryable=True,
            ) from exc

    def release(self) -> None:
        self._mutex.release()


def _absolute_path(value: str | os.PathLike[str], *, base: Path | None = None) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute() and base is not None:
        candidate = base / candidate
    return candidate.resolve()


def _url_from_role(value: Any, role: str) -> str:
    if isinstance(value, str):
        url = value
    elif isinstance(value, Mapping):
        url = value.get("url") or value.get("href")
        if not url:
            urls = value.get("urls")
            if isinstance(urls, list) and urls:
                url = urls[0]
    else:
        url = None
    if not isinstance(url, str) or not url.strip():
        raise BrowserControllerError(
            f"browser_sessions.{role} must contain one URL", "configuration"
        )
    url = url.strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise BrowserControllerError(
            f"browser_sessions.{role} URL must be absolute http/https", "configuration"
        )
    return url


def load_browser_config(
    config_path: str | os.PathLike[str],
    *,
    profile_directory: str | None = None,
) -> tuple[dict[str, Any], Path]:
    """Read and normalize a browser config without starting a browser.

    ``profile_directory`` is a Chromium profile name (for example ``Default``
    or ``Profile 1``), while ``user_data_dir`` remains the profile root.  The
    option can be provided at the top level, under ``playwright``, or as a
    caller override.
    """

    path = Path(config_path).expanduser().resolve()
    if not path.is_file():
        raise BrowserControllerError(f"浏览器配置不存在: {path}", "configuration")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BrowserControllerError(f"浏览器配置无法读取: {path}: {exc}", "configuration") from exc
    if not isinstance(value, dict):
        raise BrowserControllerError("浏览器配置必须是 JSON 对象", "configuration")
    if value.get("schema_version") != SUPPORTED_SCHEMA:
        raise BrowserControllerError(
            f"浏览器配置 schema_version 必须为 {SUPPORTED_SCHEMA}", "configuration"
        )
    data_dir = value.get("user_data_dir")
    if not isinstance(data_dir, str) or not data_dir.strip():
        raise BrowserControllerError("浏览器配置缺少 user_data_dir", "configuration")
    sessions = value.get("browser_sessions")
    role_specs(value)

    playwright = value.get("playwright")
    if playwright is None:
        playwright = {}
    if not isinstance(playwright, Mapping):
        raise BrowserControllerError("browser 配置 playwright 必须是对象", "configuration")
    selected_profile = profile_directory or value.get("profile_directory") or playwright.get("profile_directory") or "Default"
    if not isinstance(selected_profile, str) or not selected_profile.strip():
        raise BrowserControllerError("profile_directory 不能为空", "configuration")
    selected_profile = selected_profile.strip()
    if any(part in selected_profile for part in ("/", "\\")) or selected_profile in {".", ".."}:
        raise BrowserControllerError("profile_directory 必须是 Chromium profile 名称", "configuration")
    root = path.parent
    resolved_data = _absolute_path(data_dir, base=root)
    download_value = (value.get("download_dir") or value.get("download_root") or
                      playwright.get("download_dir") or playwright.get("download_root"))
    if download_value:
        # A template keeps concurrent shop profiles from sharing a download
        # directory.  A concrete path remains supported for one-profile jobs.
        rendered_download = str(download_value).replace("{profile_directory}", selected_profile)
        download_dir = _absolute_path(rendered_download, base=root)
    else:
        # Chromium profile names may contain spaces (``Profile 1``).  Keep
        # those readable in the download path while rejecting path separators.
        safe_profile = re.sub(r"[^A-Za-z0-9_. -]+", "_", selected_profile)
        download_dir = resolved_data / "downloads" / safe_profile

    normalized = dict(value)
    normalized["user_data_dir"] = str(resolved_data)
    normalized["profile_directory"] = selected_profile
    normalized["download_dir"] = str(download_dir)
    normalized["download_root"] = str(download_dir)
    normalized["playwright"] = dict(playwright)
    normalized["playwright"].update({"profile_directory": selected_profile, "download_dir": str(download_dir)})
    normalized["browser_sessions"] = dict(sessions)
    return normalized, path


def role_specs(config: Mapping[str, Any]) -> dict[str, RoleSpec]:
    sessions = config.get("browser_sessions")
    if not isinstance(sessions, Mapping) or not sessions:
        raise BrowserControllerError("browser_sessions 必须是非空角色对象", "configuration")
    unknown = set(sessions) - set(ROLE_NAMES)
    if unknown:
        raise BrowserControllerError("browser_sessions 包含未知页面角色", "configuration")
    result: dict[str, RoleSpec] = {}
    for role in ROLE_NAMES:
        if role not in sessions:
            continue
        raw = sessions.get(role)
        url = _url_from_role(raw, role)
        patterns: tuple[str, ...] = ()
        selectors: tuple[str, ...] = ()
        if isinstance(raw, Mapping):
            p = raw.get("login_positive_patterns") or raw.get("positive_url_patterns") or ()
            s = raw.get("login_positive_selectors") or raw.get("positive_selectors") or ()
            if isinstance(p, str):
                p = (p,)
            if isinstance(s, str):
                s = (s,)
            if isinstance(p, Iterable):
                patterns = tuple(str(item) for item in p)
            if isinstance(s, Iterable):
                selectors = tuple(str(item) for item in s)
        result[role] = RoleSpec(role, url, patterns, selectors)
    return result


def _same_site(url: str, expected: str) -> bool:
    actual = urlsplit(url)
    target = urlsplit(expected)
    return bool(actual.scheme in {"http", "https"} and actual.netloc.lower() == target.netloc.lower())


def _same_role_page(url: str, expected: str, role: str | None = None) -> bool:
    """Match a persisted tab to a role without conflating same-site roles."""
    if not _same_site(url, expected):
        return False
    actual, target = urlsplit(url), urlsplit(expected)
    actual_path = actual.path.rstrip("/") or "/"
    expected_path = target.path.rstrip("/") or "/"
    if (target.hostname or "").lower() == "one.alimama.com":
        # Both promotion products use index.html and differ only by hash
        # route. A single promotion role may reuse either campaign-list tab;
        # dedicated product roles must retain their exact product route.
        if actual_path != expected_path:
            return False
        def campaign_route(fragment: str) -> str:
            route = fragment[1:] if fragment.startswith("!") else fragment
            return urlsplit(route).path.rstrip("/")
        actual_route = campaign_route(actual.fragment)
        expected_route = campaign_route(target.fragment)
        if role == "promotion":
            return actual_route in {"/manage/onesite", "/manage/search"}
        return bool(expected_route) and actual_route == expected_route
    if expected_path == "/" and (urlsplit(expected).hostname or "").lower() == "myseller.taobao.com":
        # Match the workbench's home role without treating order/invoice
        # routes as the homepage or navigating over an unrelated user tab.
        return actual_path in {"/", "/home.htm", "/home.htm/QnworkbenchHome"}
    return actual_path == expected_path or actual_path.startswith(expected_path + "/")


def _same_site_family(url: str, expected: str) -> bool:
    """Allow a persisted role to retain a login redirect on the same domain."""
    actual_name = (urlsplit(url).hostname or "").lower()
    expected_name = (urlsplit(expected).hostname or "").lower()
    if expected_name == "one.alimama.com" and actual_name in {
        "login.taobao.com", "loginmyseller.taobao.com", "passport.taobao.com",
        "login.tmall.com", "passport.tmall.com", "login.alimama.com",
        "passport.alimama.com",
    }:
        return True
    actual_host = (urlsplit(url).hostname or "").lower().split(".")
    expected_host = (urlsplit(expected).hostname or "").lower().split(".")
    if len(actual_host) < 2 or len(expected_host) < 2:
        return False
    return actual_host[-2:] == expected_host[-2:]


def _url_is_login(url: str) -> bool:
    host = (urlsplit(url or "").hostname or "").lower()
    return host in {"jstlogin.erp321.com", "loginmyseller.taobao.com"} or bool(LOGIN_URL_RE.search(url or ""))


def _runtime_state_path(data_dir: Path, profile: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", profile or "Default")
    return data_dir / f".qianniu-playwright-{safe}.runtime.json"


def _configured_debug_port(config: Mapping[str, Any]) -> int:
    """Return the explicit non-zero CDP port used by the native browser.

    A deterministic default is intentional: Chromium must receive a concrete
    non-zero port.  The value is kept internal to
    the controller and is not included in status/error envelopes.
    """
    playwright = config.get("playwright")
    if not isinstance(playwright, Mapping):
        playwright = {}
    value = config.get("remote_debugging_port")
    if value in (None, ""):
        value = playwright.get("remote_debugging_port", 9222)
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise BrowserControllerError(
            "remote_debugging_port 必须是整数", "configuration"
        ) from exc
    if not 1 <= port <= 65535:
        raise BrowserControllerError(
            "remote_debugging_port 必须在 1-65535 范围内", "configuration"
        )
    return port


def _resolve_browser_executable(config: Mapping[str, Any]) -> Path:
    configured = (
        config.get("executable_path")
        or config.get("browser_executable")
        or (config.get("playwright", {}).get("executable_path")
            if isinstance(config.get("playwright"), Mapping) else None)
        or (config.get("playwright", {}).get("browser_executable")
            if isinstance(config.get("playwright"), Mapping) else None)
    )
    if configured:
        executable = Path(str(configured)).expanduser().resolve()
        if executable.is_file():
            return executable
        raise BrowserControllerError(
            f"浏览器可执行文件不存在: {executable}", "configuration"
        )
    browser_name = str(config.get("browser") or "Edge").lower()
    if browser_name not in {"edge", "chrome"}:
        raise BrowserControllerError(
            f"不支持的浏览器: {browser_name}", "configuration"
        )
    executable_name = "msedge.exe" if browser_name == "edge" else "chrome.exe"
    candidates: list[Path] = []
    for env_name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        value = os.environ.get(env_name)
        if not value:
            continue
        base = Path(value)
        relative = (
            Path("Microsoft") / "Edge" / "Application" / executable_name
            if browser_name == "edge"
            else Path("Google") / "Chrome" / "Application" / executable_name
        )
        candidates.append(base / relative)
    # App Paths is useful on Windows installations outside the conventional
    # directories.  Keep registry access optional for non-Windows tests.
    if os.name == "nt":
        try:
            import winreg  # type: ignore
            for hive, key_name in (
                (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{executable_name}"),
                (winreg.HKEY_LOCAL_MACHINE, rf"Software\Microsoft\Windows\CurrentVersion\App Paths\{executable_name}"),
                (winreg.HKEY_LOCAL_MACHINE, rf"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{executable_name}"),
            ):
                try:
                    with winreg.OpenKey(hive, key_name) as key:
                        value, _ = winreg.QueryValueEx(key, None)
                    candidates.insert(0, Path(str(value)))
                except OSError:
                    continue
        except ImportError:
            pass
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise BrowserControllerError(
        f"找不到 {browser_name} 浏览器可执行文件，请在配置中指定 executable_path",
        "configuration",
    )


def _runtime_write(path: Path, *, pid: int, port: int, data_dir: Path, profile: str) -> None:
    payload = {
        "pid": int(pid),
        "port": int(port),
        "started_at": time.time(),
        "user_data_dir": str(data_dir),
        "profile_directory": profile,
    }
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def _runtime_remove(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _cdp_version_sync(port: int, timeout: float = 0.5) -> dict[str, Any] | None:
    try:
        request = Request(f"http://127.0.0.1:{port}/json/version", method="GET")
        with urlopen(request, timeout=timeout) as response:  # nosec B310 - localhost only
            value = json.loads(response.read().decode("utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _running_profile_process(config: Mapping[str, Any], data_dir: Path) -> dict[str, Any] | None:
    """Identify a Windows browser's root process without exposing its args."""
    if os.name != "nt":
        return None
    browser_name = str(config.get("browser") or "Edge").lower()
    process_name = "msedge.exe" if browser_name == "edge" else "chrome.exe"
    script = (
        f"Get-CimInstance Win32_Process -Filter \"Name = '{process_name}'\" | "
        "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=8, check=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        values = json.loads(result.stdout or "[]")
    except Exception as exc:
        raise BrowserControllerError(
            "无法验证浏览器进程与专用 Profile 的归属", "browser_identity_unverified"
        ) from exc
    if isinstance(values, dict):
        values = [values]
    root = str(data_dir).rstrip("\\/")
    pattern = re.compile(r"--user-data-dir=" + re.escape(root) + r"(?:\s|$)", re.I)
    for value in values:
        command = str(value.get("CommandLine") or "").replace('"', "")
        if "--type=" in command or not pattern.search(command):
            continue
        match = re.search(r"--remote-debugging-port=(\d+)(?:\s|$)", command)
        selected_profile = re.search(r"--profile-directory=(.*?)(?=\s--|\shttps?://|$)", command)
        return {
            "pid": int(value["ProcessId"]),
            "port": int(match.group(1)) if match else None,
            "profile_directory": selected_profile.group(1).strip() if selected_profile else "Default",
        }
    return None


async def _terminate_owned_process(process: subprocess.Popen[Any] | None, pid: int | None = None) -> None:
    """Stop only the native browser process created by this controller."""
    if os.name == "nt" and pid is not None and (process is None or pid != process.pid):
        try:
            await asyncio.to_thread(
                subprocess.run,
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False, timeout=5, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            pass
        return
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
        await asyncio.to_thread(process.wait, 5)
        return
    except Exception:
        pass
    if os.name == "nt" and process.poll() is None:
        try:
            killer = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=5,
            )
            if killer.returncode == 0:
                return
        except Exception:
            pass
    try:
        process.kill()
    except Exception:
        pass


class PlaywrightBrowserController:
    """Attach to one native Edge CDP context and reuse configured role pages."""

    def __init__(
        self,
        config: Mapping[str, Any],
        *,
        headless: bool = False,
        timeout_ms: int = 30_000,
        lock_wait_ms: int = 0,
        retain_on_page_error: bool = False,
    ) -> None:
        self.config = dict(config)
        self.config.setdefault("profile_directory", "Default")
        self.config.setdefault("download_dir", str(Path(self.config["user_data_dir"]) / "downloads" / self.config["profile_directory"]))
        self.headless = bool(headless)
        self.timeout_ms = int(timeout_ms)
        self.lock_wait_ms = max(0, min(int(lock_wait_ms), 5_000))
        self.retain_on_page_error = bool(retain_on_page_error)
        self.specs = role_specs(self.config)
        self.playwright: Any = None
        self.browser: Any = None
        self.context: Any = None
        self.registrations: dict[str, PageRegistration] = {}
        self._profile_lock: ProfileLock | None = None
        self._browser_process: subprocess.Popen[Any] | None = None
        self._owned_browser_pid: int | None = None
        self._browser_owned = False
        self._runtime_path: Path | None = None
        self._runtime_owned = False
        self._cdp_port: int | None = None
        self._native_exit_confirmed = False

    @classmethod
    def from_config_path(cls, config_path: str | os.PathLike[str], **kwargs: Any) -> "PlaywrightBrowserController":
        config, _ = load_browser_config(config_path, profile_directory=kwargs.pop("profile_directory", None))
        return cls(config, **kwargs)

    async def start(self, *, open_missing: bool = True) -> dict[str, Any]:
        """Explicit setup entry point: may launch Edge or open missing roles."""
        return await self._open(allow_launch=True, open_missing=open_missing)

    async def connect(self, *, open_missing: bool = False) -> dict[str, Any]:
        """Attach to existing Edge; optionally restore missing role URLs once.

        Diagnostics keep the default read-only page registration. Business
        jobs opt in to initial missing-page recovery, without gaining browser
        launch permission. Registered pages that later disappear still stop.
        """
        return await self._open(allow_launch=False, open_missing=open_missing)

    async def _acquire_profile_lock(self) -> None:
        """Wait only for the local job mutex, before touching any browser."""
        deadline = time.monotonic() + min(self.lock_wait_ms, max(0, self.timeout_ms)) / 1000
        try:
            while True:
                try:
                    self._profile_lock.acquire()
                    return
                except BrowserControllerError as exc:
                    remaining = deadline - time.monotonic()
                    if (exc.code != "profile_locked" or
                            not isinstance(exc.__cause__, FileMutexBusy) or remaining <= 0):
                        raise
                    await asyncio.sleep(min(0.1, remaining))
        except BaseException:
            # Failed attempts own no handle. Cancellation must also leave no
            # controller reference behind; never unlink the shared lock file.
            self._profile_lock.release()
            self._profile_lock = None
            raise

    async def _open(self, *, allow_launch: bool, open_missing: bool) -> dict[str, Any]:
        if self.context is not None:
            return await self.register_roles(open_missing=open_missing)
        self._native_exit_confirmed = False
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise BrowserControllerError(
                "未安装 Playwright；请在运行环境安装 playwright Python 包。当前配置使用本机 Edge，不要求下载 Chromium",
                "dependency_missing",
            ) from exc
        data_dir = Path(str(self.config["user_data_dir"])).expanduser().resolve()
        download_dir = Path(str(self.config["download_dir"])).expanduser().resolve()
        data_dir.mkdir(parents=True, exist_ok=True)
        download_dir.mkdir(parents=True, exist_ok=True)
        profile = str(self.config.get("profile_directory") or "Default")
        self._runtime_path = _runtime_state_path(data_dir, profile)
        self._cdp_port = _configured_debug_port(self.config)
        self._profile_lock = ProfileLock(data_dir, profile)
        await self._acquire_profile_lock()
        try:
            self.playwright = await async_playwright().start()
        except BaseException as exc:
            self._profile_lock.release()
            self._profile_lock = None
            if not isinstance(exc, Exception):
                raise
            raise BrowserControllerError(
                f"Playwright 运行时启动失败: {exc}", "browser_launch_failed", retryable=True
            ) from exc
        debug_port = int(self._cdp_port)
        endpoint = f"http://127.0.0.1:{debug_port}"
        launched = False
        try:
            # A controller from a previous run may have left a native Edge
            # alive.  Reuse it only when its configured CDP endpoint responds;
            # never start a second browser against the same profile.
            existing_endpoint = await asyncio.to_thread(_cdp_version_sync, debug_port)
            profile_process = await asyncio.to_thread(_running_profile_process, self.config, data_dir)
            if profile_process is not None and (
                profile_process["port"] != debug_port
                or profile_process["profile_directory"] != profile
            ):
                raise BrowserControllerError(
                    "专用 Profile 已由不同启动配置的浏览器占用，请先关闭该专用窗口",
                    "profile_locked", retryable=False,
                )
            if existing_endpoint is not None:
                if os.name == "nt" and profile_process is None:
                    raise BrowserControllerError(
                        "现有 CDP 浏览器不属于配置的专用 Profile", "context_changed"
                    )
                # A reconnect by this same controller retains ownership;
                # attaching to a browser from another process never gains it.
                self._browser_owned = bool(
                    self._browser_owned and self._owned_browser_pid is not None
                    and profile_process is not None
                    and profile_process["pid"] == self._owned_browser_pid
                )
            else:
                if not allow_launch:
                    raise BrowserControllerError(
                        "专用浏览器未运行或连接不可用，请先启动专用浏览器并完成登录",
                        "browser_disconnected", retryable=False,
                    )
                if profile_process is not None:
                    raise BrowserControllerError(
                        "专用 Profile 浏览器已经运行，但其 CDP 接口尚不可用",
                        "browser_disconnected", retryable=True,
                    )
                executable_path = _resolve_browser_executable(self.config)
                if (data_dir / "SingletonLock").exists():
                    raise BrowserControllerError(
                        f"浏览器 Profile 正被其他进程占用: {data_dir}",
                        "profile_locked",
                        details={"user_data_dir": str(data_dir), "profile_directory": profile},
                        retryable=True,
                    )
                browser_name = str(self.config.get("browser") or "Edge").lower()
                args: list[str] = [
                    "--new-window",
                    "--no-first-run",
                    "--no-default-browser-check",
                    f"--user-data-dir={data_dir}",
                    "--remote-debugging-address=127.0.0.1",
                    f"--remote-debugging-port={debug_port}",
                ]
                if profile and profile.lower() != "default":
                    args.append(f"--profile-directory={profile}")
                args.extend(spec.url for spec in self.specs.values())
                if self.headless:
                    args.append("--headless=new")
                creationflags = 0
                if os.name == "nt":
                    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
                try:
                    self._browser_process = subprocess.Popen(
                        [str(executable_path), *args],
                        cwd=str(executable_path.parent),
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=creationflags,
                    )
                except OSError as exc:
                    raise BrowserControllerError(
                        f"无法启动 {browser_name} 浏览器: {exc}",
                        "browser_launch_failed", retryable=True,
                    ) from exc
                self._browser_owned = True
                launched = True
                self._owned_browser_pid = self._browser_process.pid
                if self._runtime_path is not None:
                    _runtime_write(
                        self._runtime_path,
                        pid=self._browser_process.pid,
                        port=debug_port,
                        data_dir=data_dir,
                        profile=profile,
                    )
                    self._runtime_owned = True
                deadline = time.monotonic() + max(10.0, self.timeout_ms / 1000)
                while time.monotonic() < deadline:
                    if _cdp_version_sync(debug_port) is not None:
                        break
                    await asyncio.sleep(0.2)
                else:
                    raise BrowserControllerError(
                        "浏览器 CDP 接口未就绪", "browser_launch_failed", retryable=True
                    )
                # Edge can relaunch its initial executable through a Windows
                # compatibility shim. Track the verified root process, not
                # merely the short-lived launcher PID.
                profile_process = await asyncio.to_thread(_running_profile_process, self.config, data_dir)
                if os.name == "nt":
                    if profile_process is None or profile_process["port"] != debug_port:
                        raise BrowserControllerError(
                            "无法验证新启动浏览器的专用 Profile", "browser_identity_unverified"
                        )
                    self._owned_browser_pid = profile_process["pid"]
                if self._runtime_path is not None:
                    _runtime_write(
                        self._runtime_path, pid=int(self._owned_browser_pid), port=debug_port,
                        data_dir=data_dir, profile=profile,
                    )
            self.browser = await self.playwright.chromium.connect_over_cdp(endpoint)
            contexts = list(self.browser.contexts)
            if not contexts:
                raise BrowserControllerError(
                    "CDP 浏览器没有可用上下文", "browser_disconnected", retryable=True
                )
            self.context = contexts[0]
        except Exception as exc:
            await self._cleanup_failed_start()
            if isinstance(exc, BrowserControllerError):
                raise
            message = str(exc)
            lowered = message.lower()
            if "already in use" in lowered or "singletonlock" in lowered or ("profile" in lowered and "lock" in lowered):
                raise BrowserControllerError(
                    f"浏览器 Profile 正被其他进程占用: {data_dir}",
                    "profile_locked",
                    details={"user_data_dir": str(data_dir), "profile_directory": profile},
                    retryable=True,
                ) from exc
            raise BrowserControllerError(
                f"无法启动 Playwright 浏览器: {message}",
                "browser_launch_failed",
                details={"user_data_dir": str(data_dir), "profile_directory": profile},
                retryable=True,
            ) from exc
        try:
            self.context.set_default_timeout(self.timeout_ms)
        except Exception:
            pass
        try:
            if launched:
                # The native command already opened all role URLs. Wait for
                # their delayed targets/redirects; never create duplicates.
                return await self._wait_for_startup_roles()
            return await self.register_roles(open_missing=open_missing)
        except Exception:
            # Promotion jobs save the session and close the native browser
            # while still holding the profile lock, including login redirects.
            if not self.retain_on_page_error:
                await self.close()
            raise

    async def _cleanup_failed_start(self) -> None:
        browser, self.browser = self.browser, None
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                pass
        await self._stop_playwright()
        process, self._browser_process = self._browser_process, None
        if self._browser_owned:
            await _terminate_owned_process(process, self._owned_browser_pid)
        self._owned_browser_pid = None
        if self._runtime_owned:
            _runtime_remove(self._runtime_path)
        self._runtime_owned = False
        self._browser_owned = False
        self.context = None
        if self._profile_lock is not None:
            self._profile_lock.release()
            self._profile_lock = None

    async def _stop_playwright(self) -> None:
        if self.playwright is not None:
            try:
                await self.playwright.stop()
            except Exception:
                pass
        self.playwright = None

    async def close(self) -> None:
        """Disconnect this job, leaving the native Edge and its pages alive."""
        self.context = None
        browser, self.browser = self.browser, None
        self.registrations.clear()
        try:
            # Browser.close() disconnects a CDP client and clears only
            # contexts created by the client; it does not force-quit the
            # already-running native browser. Native process shutdown is an
            # explicit stop() operation, never ordinary task cleanup.
            if browser is not None and not self._native_exit_confirmed:
                await asyncio.wait_for(browser.close(), timeout=5)
        finally:
            try:
                await asyncio.wait_for(self._stop_playwright(), timeout=5)
            finally:
                # Even cancellation during runtime shutdown must release the
                # OS lock; native browser processes remain untouched.
                if self._profile_lock is not None:
                    self._profile_lock.release()
                    self._profile_lock = None

    async def stop(self) -> None:
        """Disconnect and stop only an Edge process started by this instance."""
        try:
            await self.close()
        finally:
            process, self._browser_process = self._browser_process, None
            if self._browser_owned:
                await _terminate_owned_process(process, self._owned_browser_pid)
            self._owned_browser_pid = None
            self._browser_owned = False
            if self._runtime_owned:
                _runtime_remove(self._runtime_path)
            self._runtime_owned = False
            self._runtime_path = None
            self._cdp_port = None

    def _pages(self) -> list[Any]:
        if self.context is None:
            return []
        return [page for page in self.context.pages if not page.is_closed()]

    async def _wait_for_startup_roles(self) -> dict[str, Any]:
        deadline = time.monotonic() + max(0.1, self.timeout_ms / 1000)
        while True:
            try:
                await self.register_roles(open_missing=False)
            except BrowserControllerError as exc:
                if exc.code != "page_missing" or time.monotonic() >= deadline:
                    raise
                await asyncio.sleep(min(0.1, max(0, deadline - time.monotonic())))
                continue
            # A target can acquire its requested URL before its login redirect
            # completes. Settle initial navigation once and classify again.
            remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
            try:
                await asyncio.gather(*(
                    item.page.wait_for_load_state("domcontentloaded", timeout=remaining_ms)
                    for item in self.registrations.values()
                ))
            except Exception as exc:
                # Preserve a clear login redirect even when a different
                # loading page timed out.
                for role, item in self.registrations.items():
                    if _url_is_login(str(item.page.url or "")):
                        raise BrowserControllerError(
                            f"业务页面需要人工登录: {role}", "login_required",
                            details={"role": role},
                        ) from exc
                raise BrowserControllerError(
                    "浏览器启动页面尚未就绪，请待页面加载完成后连接", "page_missing"
                ) from exc
            return await self.register_roles(open_missing=False)

    async def register_roles(self, *, open_missing: bool = False) -> dict[str, Any]:
        if self.context is None:
            raise BrowserControllerError("浏览器尚未启动", "browser_not_started")
        pages = self._pages()
        # Unrelated pages, including blank/new-tab pages, belong to the user.
        # Registration only matches business pages; it never closes them.
        # Check redirected roles before opening anything, including when an
        # earlier role is absent and a later role is on a login page.
        for role, spec in self.specs.items():
            has_business_page = any(
                _same_role_page(str(page.url or ""), spec.url, role)
                and not _url_is_login(str(page.url or "")) for page in pages
            )
            if not has_business_page and any(
                _url_is_login(str(page.url or ""))
                and _same_site_family(str(page.url or ""), spec.url) for page in pages
            ):
                raise BrowserControllerError(
                    f"业务页面需要人工登录: {role}", "login_required",
                    details={"role": role},
                )
        used: set[int] = set()
        for role, spec in self.specs.items():
            registered = self.registrations.get(role)
            if registered is not None and not registered.page.is_closed():
                current = str(registered.page.url or "")
                if _url_is_login(current):
                    raise BrowserControllerError(
                        f"业务页面需要人工登录: {role}", "login_required",
                        details={"role": role},
                    )
                if _same_role_page(current, spec.url, role):
                    used.add(id(registered.page))
                    continue
            match = None
            for page in pages:
                if id(page) in used or page.is_closed():
                    continue
                current = str(page.url or "")
                if current in {"", "about:blank", "chrome://newtab/"}:
                    continue
                if _same_role_page(current, spec.url, role) and not _url_is_login(current):
                    match = page
                    break
            if match is not None:
                used.add(id(match))
                self.registrations[role] = PageRegistration(role, match, created=False)
                continue
            if any(_url_is_login(str(page.url or ""))
                   and _same_site_family(str(page.url or ""), spec.url)
                   for page in pages):
                raise BrowserControllerError(
                    f"业务页面需要人工登录: {role}", "login_required",
                    details={"role": role},
                )
            # A role that was already registered belongs to this context. If
            # it disappeared or drifted, stop with a typed page_missing
            # result instead of silently growing another tab mid-batch.
            if role in self.registrations:
                raise BrowserControllerError(
                    f"业务页面失效: {role}",
                    "page_missing",
                    details={"role": role, "url": spec.url},
                    retryable=True,
                )
            if not open_missing:
                raise BrowserControllerError(
                    f"业务页面缺失: {role}",
                    "page_missing",
                    details={"role": role, "url": spec.url},
                    retryable=True,
                )
            page = None
            try:
                page = await self.context.new_page()
                # Record ownership before navigation so a failed recovery
                # cannot grow another replacement tab in this controller.
                self.registrations[role] = PageRegistration(role, page, created=True)
                await page.goto(spec.url, wait_until="domcontentloaded", timeout=self.timeout_ms)
            except Exception as exc:
                if page is not None and _url_is_login(str(page.url or "")):
                    # Keep the login page available for manual intervention,
                    # including when another resource made goto time out.
                    raise BrowserControllerError(
                        f"业务页面需要人工登录: {role}", "login_required",
                        details={"role": role},
                    ) from exc
                try:
                    if page is not None:
                        await page.close()
                except Exception:
                    pass
                raise BrowserControllerError(
                    f"无法打开业务页面 {role}: {exc}",
                    "page_navigation_failed",
                    details={"role": role, "url": spec.url},
                    retryable=True,
                ) from exc
            if _url_is_login(str(page.url or "")):
                raise BrowserControllerError(
                    f"业务页面需要人工登录: {role}", "login_required",
                    details={"role": role},
                )
            pages.append(page)
            used.add(id(page))
        return self.status()

    def page(self, role: str) -> Any:
        if role not in self.specs:
            raise BrowserControllerError(f"未知页面角色: {role}", "unknown_role", details={"role": role})
        registration = self.registrations.get(role)
        if registration is None or registration.page.is_closed():
            raise BrowserControllerError(
                f"业务页面缺失: {role}", "page_missing", details={"role": role}, retryable=True
            )
        return registration.page

    async def check_login(self, role: str) -> dict[str, Any]:
        page = self.page(role)
        spec = self.specs[role]
        current = str(page.url or "")
        if _url_is_login(current):
            return {
                "role": role,
                "is_login": False,
                "is_logged_in": False,
                "code": "login_required",
                "url": current,
                "signals": ["login_url"],
            }
        signals: list[str] = []
        positive = False
        if _same_site(current, spec.url):
            signals.append("same_site")
        for pattern in spec.login_positive_patterns:
            if re.search(pattern, current, re.IGNORECASE):
                signals.append("url_pattern:" + pattern)
        for selector in spec.login_positive_selectors:
            try:
                if (_same_role_page(current, spec.url, role)
                        and await page.locator(selector).first.is_visible(timeout=min(self.timeout_ms, 3000))):
                    positive = True
                    signals.append("selector:" + selector)
            except Exception:
                continue
        result = {
            "role": role,
            "is_login": positive,
            "is_logged_in": positive,
            "url": current,
            "signals": signals,
        }
        if not positive:
            # A non-login URL is only a route signal, not authentication
            # evidence. The adapter's context probes verify shop and issuer.
            result["code"] = "context_missing"
        return result

    async def check_logins(self, roles: Iterable[str] | None = None) -> dict[str, Any]:
        results = [await self.check_login(role) for role in (self.specs if roles is None else roles)]
        return {
            "ok": all(item["is_login"] for item in results),
            "roles": results,
        }

    async def evaluate(self, role: str, expression: str, arg: Any = None) -> Any:
        page = self.page(role)
        try:
            return await page.evaluate(expression, arg)
        except Exception as exc:
            raise BrowserControllerError(
                f"页面脚本执行失败: {exc}",
                "script_failed",
                details={"role": role},
                retryable=True,
            ) from exc

    async def evaluate_file(
        self,
        role: str,
        source_path: str | os.PathLike[str],
        input_value: Any = None,
        *,
        frame_url: str | None = None,
    ) -> Any:
        """Evaluate one of the skill's page scripts in a managed page/frame.

        Scripts either contain a ``__INPUT__`` placeholder, are self-invoking
        expressions, or are async functions accepting ``(element, input)``.
        Input and output are structured objects. Loading scripts directly
        avoids passing large JavaScript sources through a shell.
        """
        page = self.page(role)
        try:
            source = Path(source_path).read_text(encoding="utf-8-sig")
        except OSError as exc:
            raise BrowserControllerError(
                f"页面脚本读取失败: {source_path}: {exc}",
                "script_failed",
                details={"role": role},
                retryable=False,
            ) from exc

        input_json = json.dumps(input_value, ensure_ascii=False, separators=(",", ":"))
        stripped_source = source.lstrip()
        if frame_url:
            frame = next(
                (
                    candidate
                    for candidate in page.frames
                    if candidate is not page.main_frame
                    and frame_url in str(candidate.url or "")
                ),
                None,
            )
            if frame is None:
                raise BrowserControllerError(
                    f"业务 iframe 未找到: {frame_url}",
                    "page_missing",
                    details={"role": role, "frame_url": frame_url},
                    retryable=True,
                )
            target = frame
        else:
            target = page

        try:
            if "__INPUT__" in source:
                expression = source.replace("__INPUT__", input_json)
            elif re.match(r"^\(?\s*(?:async\s+)?function\b", stripped_source):
                # The goods collector returns a structured object directly.
                expression = (
                    "(async()=>await ("
                    + source
                    + ")(null,"
                    + input_json
                    + "))()"
                )
            else:
                # Context scripts are self-invoking async expressions.  They
                # must be evaluated as-is; wrapping an IIFE as a function call
                # causes the ``... is not a function`` failure seen in the JST
                # context probe.
                expression = source
            return await target.evaluate(expression)
        except BrowserControllerError:
            raise
        except Exception as exc:
            raise BrowserControllerError(
                f"页面脚本执行失败: {exc}",
                "script_failed",
                details={"role": role, "frame_url": frame_url} if frame_url else {"role": role},
                retryable=True,
            ) from exc

    async def wait_for_download(self, role: str, action: Any) -> dict[str, Any]:
        """Run an async Playwright action and save its download to download_dir."""
        page = self.page(role)
        try:
            async with page.expect_download(timeout=self.timeout_ms) as info:
                await action()
            download = await info.value
            suggested = Path(download.suggested_filename or f"download-{uuid.uuid4().hex}").name
            destination = Path(str(self.config["download_dir"])) / suggested
            await download.save_as(str(destination))
            return {"path": str(destination.resolve()), "suggested_filename": suggested}
        except BrowserControllerError:
            raise
        except Exception as exc:
            raise BrowserControllerError(
                f"下载失败: {exc}", "download_failed", details={"role": role}, retryable=True
            ) from exc

    def status(self) -> dict[str, Any]:
        pages = self._pages()
        return {
            "ok": self.context is not None,
            "authentication": "not_checked",
            "browser": self.config.get("browser", "Edge"),
            "user_data_dir": str(self.config.get("user_data_dir", "")),
            "profile_directory": str(self.config.get("profile_directory", "Default")),
            "download_dir": str(self.config.get("download_dir", "")),
            "pages": [{"url": str(page.url or ""), "title": ""} for page in pages],
            "roles": {role: registration.to_dict() for role, registration in self.registrations.items()},
        }


async def _cli_async(args: argparse.Namespace) -> dict[str, Any]:
    config, _ = load_browser_config(args.config, profile_directory=args.profile_directory)
    controller = PlaywrightBrowserController(config, headless=args.headless, timeout_ms=args.timeout)
    try:
        if args.command == "start":
            await controller.start(open_missing=not args.no_open)
        else:
            await controller.connect()
        if args.command == "status":
            return controller.status()
        if args.command == "check-login":
            return await controller.check_logins()
        if args.command == "register":
            return controller.status()
        if args.command == "start":
            result = controller.status()
            if args.keep_open:
                while True:
                    await asyncio.sleep(1)
            return result
        raise BrowserControllerError(f"未知命令: {args.command}", "configuration")
    finally:
        if not args.keep_open:
            await controller.close()


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError):
            pass
    parser = argparse.ArgumentParser(description="Playwright persistent browser controller")
    parser.add_argument("--config", required=True, help="browser config JSON")
    parser.add_argument("--profile-directory", help="Chromium profile name, e.g. Profile 1")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--timeout", type=int, default=30_000)
    parser.add_argument("--no-open", action="store_true", help="do not create missing role pages")
    parser.add_argument("--keep-open", action="store_true", help="keep the browser/controller alive")
    parser.add_argument("command", choices=("start", "status", "check-login", "register"))
    args = parser.parse_args(argv)
    try:
        value = asyncio.run(_cli_async(args))
    except BrowserControllerError as exc:
        print(json.dumps(exc.to_dict(), ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
