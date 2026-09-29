"""Explicit setup/status commands using the same registered shop profiles."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

from playwright_controller import PlaywrightBrowserController, BrowserControllerError
from shop_registry import load_registry, selected_identity


async def manage(args):
    registry = load_registry(args.registry)
    identity = selected_identity(registry, args.shops or [])
    by_id = {shop["id"]: shop for shop in registry["shops"]}
    results = []
    for sid in identity["shop_ids"]:
        shop = by_id[sid]
        controller = PlaywrightBrowserController(shop["browser_config_value"])
        try:
            if args.command == "start":
                await controller.start(open_missing=True)
            else:
                await controller.connect(open_missing=False)
            results.append({"id": sid, "store": shop["store"], "ok": True, "authentication": "not_checked"})
        except BrowserControllerError as exc:
            results.append({"id": sid, "store": shop["store"], "ok": False, "code": exc.code, "authentication": "not_checked"})
        finally:
            await controller.close()
    return results


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="按店铺清单启动或只读检查原生 Edge")
    parser.add_argument("--registry", required=True)
    parser.add_argument("--shops", nargs="+")
    parser.add_argument("command", choices=("start", "status"))
    args = parser.parse_args()
    try:
        results = asyncio.run(manage(args))
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0 if all(row["ok"] for row in results) else 2
    except ValueError as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
