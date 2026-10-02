"""Read-only local dependency/configuration check; never connects a browser."""
from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import sys

from playwright_controller import BrowserControllerError, _resolve_browser_executable
from run_batch import load_config
from shop_registry import load_registry


def browser_check(shop):
    """Inspect installation paths only; never probe CDP, processes, or locks."""
    config = shop["browser_config_value"]
    browser = str(config.get("browser") or "Edge").lower()
    result = {"name": "browser_executable", "shop_id": shop["id"], "browser": browser}
    try:
        if browser not in {"edge", "chrome"}:
            raise ValueError("当前支持 Windows 上的 Edge 或 Chrome")
        executable = _resolve_browser_executable(config)
        expected = "msedge.exe" if browser == "edge" else "chrome.exe"
        if executable.name.lower() != expected:
            raise ValueError(f"browser 与 executable_path 不一致：{browser} 需要 {expected}")
        result.update(ok=True, executable=str(executable))
    except (BrowserControllerError, OSError, ValueError) as exc:
        result.update(ok=False, message=str(exc))
    return result


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="检查 Playwright 推广巡检依赖和本地配置")
    parser.add_argument("--registry")
    parser.add_argument("--shops", nargs="+")
    parser.add_argument("--config")
    args = parser.parse_args()
    system = platform.system()
    checks = [{"name": "python", "ok": sys.version_info >= (3, 11)},
              {"name": "platform", "ok": system == "Windows", "system": system,
               "message": "当前浏览器进程归属与正常关闭核验支持 Windows"},
              {"name": "playwright", "ok": importlib.util.find_spec("playwright") is not None}]
    try:
        load_config(args.config)
        checks.append({"name": "promotion_config", "ok": True})
        if args.registry:
            registry = load_registry(args.registry, shop_ids=args.shops)
            checks.append({"name": "registry", "ok": True, "shops": len(registry["shops"])})
            checks.extend(browser_check(shop) for shop in registry["shops"])
    except (OSError, ValueError) as exc:
        checks.append({"name": "config", "ok": False, "message": str(exc)})
    print(json.dumps({"ok": all(row["ok"] for row in checks), "checks": checks,
                      "authentication": "not_checked", "note": "只检查本地依赖与配置，不启动浏览器、不登录、不通知、不暂停"}, ensure_ascii=False, indent=2))
    return 0 if all(row["ok"] for row in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
