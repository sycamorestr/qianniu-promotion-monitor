"""Save the attached shop's session and close its verified native browser.

The caller owns the Profile lock for this entire operation and must call
``controller.close()`` afterwards to detach and release that lock. No process
termination API is used, including when normal close fails.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import time
from typing import Any

from playwright_controller import (
    BrowserControllerError, _cdp_version_sync, _configured_debug_port,
    _resolve_browser_executable,
)
from session_cookies import business_cookie_scope, empty_status, persist_session_cookies, write_metadata


EXIT_TIMEOUT_SECONDS = 15.0
COOKIE_STATUS_KEYS = ("status", "last_saved_at", "persisted_count", "failed_count", "skipped_count")


def _normalized_path(value: str | Path) -> str:
    return os.path.normcase(str(Path(value).expanduser().resolve())).rstrip("\\/")


def _windows_arguments(command: str) -> list[str]:
    import ctypes
    from ctypes import wintypes
    count = ctypes.c_int()
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    shell32.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
    values = shell32.CommandLineToArgvW(command, ctypes.byref(count))
    if not values:
        raise ValueError("unreadable process arguments")
    try:
        return [values[index] for index in range(count.value)]
    finally:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
        kernel32.LocalFree.restype = wintypes.HLOCAL
        kernel32.LocalFree(ctypes.cast(values, wintypes.HLOCAL))


def _flag(arguments: list[str], name: str, default: str | None = None) -> str | None:
    values = []
    for index, argument in enumerate(arguments):
        if argument.startswith(name + "="):
            values.append(argument[len(name) + 1:])
        elif argument == name and index + 1 < len(arguments):
            values.append(arguments[index + 1])
    # Ambiguous command lines must never authorize browser shutdown.
    if len(values) > 1:
        raise ValueError("duplicate browser flag")
    return values[0] if values else default


def _browser_inventory() -> list[dict[str, Any]]:
    """Read every native browser root; never return raw arguments to callers."""
    if os.name != "nt":
        raise ValueError("native browser ownership currently requires Windows")
    script = (
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | "
        "Select-Object ProcessId,Name,ExecutablePath,CommandLine,"
        "@{Name='StartedAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | "
        "ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=8,
        check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    values = json.loads(result.stdout or "[]")
    if isinstance(values, dict):
        values = [values]
    if values is None:
        values = []
    if not isinstance(values, list):
        raise ValueError("invalid process inventory")
    records = []
    for value in values:
        args = _windows_arguments(str(value.get("CommandLine") or ""))
        if any(arg == "--type" or arg.startswith("--type=") for arg in args):
            continue
        root = _flag(args, "--user-data-dir")
        port = _flag(args, "--remote-debugging-port")
        executable = str(value.get("ExecutablePath") or "")
        records.append({
            "pid": int(value["ProcessId"]), "name": str(value.get("Name") or "").lower(),
            "executable": _normalized_path(executable) if executable else None,
            "root": _normalized_path(root) if root else None,
            "profile": _flag(args, "--profile-directory", "Default"),
            "port": int(port) if port and port.isdigit() else None,
            "started_at": str(value.get("StartedAt") or ""),
        })
    return records


class _ProcessMonitor:
    """Hold a Windows process handle so PID reuse cannot imply process exit."""

    def __init__(self, pid: int):
        if os.name != "nt":
            raise ValueError("native process monitoring currently requires Windows")
        import ctypes
        from ctypes import wintypes
        self._api = ctypes.WinDLL("kernel32", use_last_error=True)
        self._api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self._api.OpenProcess.restype = wintypes.HANDLE
        self._api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self._api.WaitForSingleObject.restype = wintypes.DWORD
        self._api.CloseHandle.argtypes = [wintypes.HANDLE]
        self._api.CloseHandle.restype = wintypes.BOOL
        self._handle = self._api.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only
        if not self._handle:
            raise ValueError("cannot monitor process exit")

    def exited(self) -> bool:
        result = self._api.WaitForSingleObject(self._handle, 0)
        if result == 0:
            return True
        if result == 0x00000102:  # WAIT_TIMEOUT
            return False
        raise ValueError("cannot confirm process exit")

    def close(self) -> None:
        if self._handle:
            self._api.CloseHandle(self._handle)
            self._handle = None


def _safe_cookie_sync(value: dict[str, Any]) -> dict[str, Any]:
    return {key: value[key] for key in COOKIE_STATUS_KEYS}


def _failure(code: str, reason: str, cookie_sync: dict[str, Any]) -> BrowserControllerError:
    messages = {
        "browser_ownership_mismatch": "浏览器归属或退出状态无法确认",
        "cookie_sync_failed": "会话保存失败，浏览器保持运行，请检查后重试",
        "browser_close_failed": "浏览器尚未确认正常退出，未执行强制关闭",
    }
    return BrowserControllerError(messages[code], code, details={
        "reason": reason, "cookie_sync": _safe_cookie_sync(cookie_sync),
    })


def _require_lock(controller: Any, cookie_sync: dict[str, Any]) -> None:
    lock = getattr(controller, "_profile_lock", None)
    if (lock is None or not lock.owned or lock.path.name != ".qianniu-browser.lock"
            or _normalized_path(lock.path.parent) != _normalized_path(controller.config["user_data_dir"])):
        raise _failure("browser_ownership_mismatch", "profile_lock_not_owned", cookie_sync)


def _fingerprint(record: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(record[key] for key in ("pid", "started_at", "root", "profile", "port", "executable"))


async def _require_owner(controller: Any, browser: Any, session: Any,
                         cookie_sync: dict[str, Any], expected: dict[str, Any] | None = None) -> dict[str, Any]:
    _require_lock(controller, cookie_sync)
    try:
        if (controller.browser is not browser or not browser.is_connected()
                or controller.context is None or controller.context not in browser.contexts):
            raise ValueError("browser connection changed")
        config = controller.config
        root = _normalized_path(config["user_data_dir"])
        port = _configured_debug_port(config)
        if controller._cdp_port != port:
            raise ValueError("browser endpoint changed")
        inventory = await asyncio.to_thread(_browser_inventory)
        same_root = [item for item in inventory if item["root"] == root]
        same_port = [item for item in inventory if item["port"] == port]
        if len(same_root) != 1 or len(same_port) != 1 or same_root[0] != same_port[0]:
            raise ValueError("ambiguous browser ownership")
        record = same_root[0]
        expected_name = "msedge.exe" if str(config.get("browser", "Edge")).lower() == "edge" else "chrome.exe"
        if (record["name"] != expected_name or record["profile"] != config.get("profile_directory", "Default")
                or record["executable"] != _normalized_path(_resolve_browser_executable(config))
                or not record["started_at"] or record["pid"] <= 0):
            raise ValueError("browser identity differs")
        if expected is not None and _fingerprint(record) != _fingerprint(expected):
            raise ValueError("browser process replaced")
        processes = await asyncio.wait_for(session.send("SystemInfo.getProcessInfo"), timeout=3)
        browser_pids = [item.get("id") for item in processes.get("processInfo", []) if item.get("type") == "browser"]
        if len(browser_pids) != 1 or browser_pids[0] != record["pid"]:
            raise ValueError("CDP connection belongs to another process")
        _require_lock(controller, cookie_sync)
        return record
    except BrowserControllerError as exc:
        if exc.code == "browser_ownership_mismatch":
            raise
        raise _failure("browser_ownership_mismatch", "process_identity_unverified", cookie_sync) from None
    except Exception:
        raise _failure("browser_ownership_mismatch", "process_identity_unverified", cookie_sync) from None


async def _wait_for_exit(controller: Any, record: dict[str, Any], monitor: Any,
                         cookie_sync: dict[str, Any]) -> None:
    deadline = time.monotonic() + EXIT_TIMEOUT_SECONDS
    confirmed_exit = False

    def confirm_exit() -> None:
        nonlocal confirmed_exit
        if not confirmed_exit and monitor.exited():
            confirmed_exit = True
            # Release the signaled process object. PID plus creation time
            # still distinguishes its stale WMI record from a new process.
            monitor.close()

    while True:
        _require_lock(controller, cookie_sync)
        try:
            confirm_exit()
            inventory = await asyncio.to_thread(_browser_inventory)
            # Enumeration takes time: the process can exit while WMI is
            # sampling, leaving an incomplete original record in its result.
            confirm_exit()
            related = [item for item in inventory if item["pid"] == record["pid"]
                       or item["root"] == record["root"] or item["port"] == record["port"]]
            if confirmed_exit:
                related = [item for item in related if not (
                    item["pid"] == record["pid"] and item["started_at"] == record["started_at"]
                )]
            if any(_fingerprint(item) != _fingerprint(record) for item in related):
                raise _failure("browser_ownership_mismatch", "replacement_browser_detected", cookie_sync)
            # Ignore only the original process after its handle confirms exit;
            # also require the endpoint to disappear before reporting success.
            if confirmed_exit and not related:
                endpoint = await asyncio.to_thread(_cdp_version_sync, record["port"], 0.25)
                if endpoint is not None:
                    raise _failure("browser_ownership_mismatch", "replacement_endpoint_detected", cookie_sync)
                _require_lock(controller, cookie_sync)
                return
        except BrowserControllerError:
            raise
        except Exception:
            raise _failure("browser_close_failed", "process_exit_unverified", cookie_sync) from None
        if time.monotonic() >= deadline:
            raise _failure("browser_close_failed", "normal_close_timed_out", cookie_sync)
        await asyncio.sleep(0.25)


async def save_and_close(controller: Any) -> dict[str, Any]:
    """Persist scoped session cookies and normally close a locked shop browser.

    Works for both a browser launched by this controller and one reused from
    the workbench. On every return/error the caller still owns the Profile
    lock and must detach with ``controller.close()`` in its finally block.
    """
    cookie_sync = empty_status()
    browser = controller.browser
    session = monitor = None
    _require_lock(controller, cookie_sync)
    try:
        try:
            session = await asyncio.wait_for(browser.new_browser_cdp_session(), timeout=3)
        except Exception:
            raise _failure("browser_ownership_mismatch", "browser_connection_unverified", cookie_sync) from None
        record = await _require_owner(controller, browser, session, cookie_sync)
        try:
            monitor = _ProcessMonitor(record["pid"])
        except Exception:
            raise _failure("browser_ownership_mismatch", "process_monitor_unavailable", cookie_sync) from None
        await _require_owner(controller, browser, session, cookie_sync, record)
        urls = [spec.url for spec in controller.specs.values()]
        families, hosts = business_cookie_scope("promotion", urls)
        cookie_sync = await persist_session_cookies(
            browser, families, hosts,
            should_continue=lambda: bool(controller._profile_lock and controller._profile_lock.owned),
        )
        _require_lock(controller, cookie_sync)
        try:
            write_metadata(Path(controller.config["user_data_dir"]), cookie_sync)
        except Exception:
            cookie_sync["status"] = "error"
            raise _failure("cookie_sync_failed", "session_metadata_write_failed", cookie_sync) from None
        if cookie_sync["status"] != "saved":
            raise _failure("cookie_sync_failed", "session_cookie_checkpoint_failed", cookie_sync)
        await _require_owner(controller, browser, session, cookie_sync, record)
        try:
            await asyncio.wait_for(session.send("Browser.close"), timeout=5)
        except Exception:
            # CDP often disconnects before the close response. Only the native
            # process handle plus a fresh inventory can establish success.
            pass
        await _wait_for_exit(controller, record, monitor, cookie_sync)
        controller._native_exit_confirmed = True
        # A later legacy stop() must not act on the exited process's old PID.
        controller._browser_process = None
        controller._owned_browser_pid = None
        controller._browser_owned = False
        return {"status": "closed", "cookie_sync": _safe_cookie_sync(cookie_sync)}
    finally:
        if monitor is not None:
            monitor.close()
        if session is not None:
            try:
                await asyncio.wait_for(session.detach(), timeout=1)
            except Exception:
                pass
