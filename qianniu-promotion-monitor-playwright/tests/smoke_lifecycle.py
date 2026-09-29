"""Opt-in localhost-only normal-close persistence test with a new Edge Profile."""
from __future__ import annotations

import asyncio
import http.server
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from playwright_controller import PlaywrightBrowserController
from promotion_browser_lifecycle import save_and_close


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><title>Promotion lifecycle local fixture</title><p>localhost only</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


async def smoke(root: Path, url: str, port: int):
    config = {"schema_version": 1, "browser": "Edge", "user_data_dir": str(root / "profile"),
              "profile_directory": "Default", "remote_debugging_port": port,
              "download_dir": str(root / "downloads"), "browser_sessions": {"promotion": {"url": url}}}
    controllers = []
    try:
        owner = PlaywrightBrowserController(config, headless=True, timeout_ms=30_000)
        controllers.append(owner)
        await owner.start()
        await owner.page("promotion").evaluate("""() => {
            document.cookie = 'promotion_session=fixture; Path=/; SameSite=Lax';
            localStorage.setItem('promotion_local_fixture', 'retained');
        }""")
        before = [item for item in await owner.context.cookies() if item["name"] == "promotion_session"]
        assert len(before) == 1 and before[0]["expires"] == -1, "fixture must begin as a session cookie"
        await owner.close()

        # Exercise the workbench reuse case: this new controller did not
        # launch the native browser and does not own its process handle.
        attached = PlaywrightBrowserController(config, headless=True, timeout_ms=30_000)
        controllers.append(attached)
        await attached.connect(open_missing=False)
        assert not attached._browser_owned
        first = await save_and_close(attached)
        assert first["status"] == "closed" and first["cookie_sync"]["persisted_count"] >= 1
        assert attached._profile_lock.owned, "close must hold the Profile lock until caller cleanup"
        await attached.close()

        restarted = PlaywrightBrowserController(config, headless=True, timeout_ms=30_000)
        controllers.append(restarted)
        await restarted.start()
        values = await restarted.page("promotion").evaluate("""() => ({
            cookie: document.cookie.split('; ').includes('promotion_session=fixture'),
            local: localStorage.getItem('promotion_local_fixture')
        })""")
        assert values == {"cookie": True, "local": "retained"}, "browser storage must survive normal close and restart"
        after = [item for item in await restarted.context.cookies() if item["name"] == "promotion_session"]
        assert len(after) == 1 and after[0]["expires"] > time.time()
        second = await save_and_close(restarted)
        assert second["status"] == "closed"
        await restarted.close()
    finally:
        errors = []
        for controller in reversed(controllers):
            try:
                if controller.browser is not None and controller.browser.is_connected():
                    await save_and_close(controller)
            except Exception:
                errors.append("temporary browser did not confirm normal exit")
            finally:
                try:
                    await controller.close()
                except Exception:
                    errors.append("temporary controller cleanup failed")
        if errors:
            raise RuntimeError("; ".join(errors))


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    root = Path(tempfile.mkdtemp(prefix="promotion-lifecycle-local-")).resolve()
    try:
        asyncio.run(smoke(root, f"http://127.0.0.1:{server.server_port}/", port))
        # Remove only our fresh test root after confirmed normal exit. On any
        # error, retain it for diagnosis; never delete an active Profile.
        assert root.parent == Path(tempfile.gettempdir()).resolve()
        assert root.name.startswith("promotion-lifecycle-local-")
        for attempt in range(20):
            try:
                shutil.rmtree(root)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.25)
    finally:
        server.shutdown()
        server.server_close()
    print("PASS: reused temporary Edge normally closed; session cookie and localStorage survived restart; test browser closed")


if __name__ == "__main__":
    main()
