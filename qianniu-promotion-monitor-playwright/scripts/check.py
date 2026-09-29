"""Read-only local dependency/configuration check; never connects a browser."""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys

from run_batch import load_config
from shop_registry import load_registry


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="检查 Playwright 推广巡检依赖和本地配置")
    parser.add_argument("--registry")
    parser.add_argument("--config")
    args = parser.parse_args()
    checks = [{"name": "python", "ok": sys.version_info >= (3, 11)},
              {"name": "playwright", "ok": importlib.util.find_spec("playwright") is not None}]
    try:
        load_config(args.config)
        checks.append({"name": "promotion_config", "ok": True})
        if args.registry:
            registry = load_registry(args.registry)
            checks.append({"name": "registry", "ok": True, "shops": len(registry["shops"])})
    except ValueError as exc:
        checks.append({"name": "config", "ok": False, "message": str(exc)})
    print(json.dumps({"ok": all(row["ok"] for row in checks), "checks": checks,
                      "authentication": "not_checked", "note": "只检查本地依赖与配置，不启动浏览器、不登录、不通知、不暂停"}, ensure_ascii=False, indent=2))
    return 0 if all(row["ok"] for row in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
