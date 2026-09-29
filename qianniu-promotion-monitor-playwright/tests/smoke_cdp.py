"""Opt-in local CDP smoke test. No business site or account is accessed."""
from __future__ import annotations

import asyncio
import http.server
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from playwright_controller import PlaywrightBrowserController


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<!doctype html><title>Promotion CDP local fixture</title><p>local fixture</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


async def smoke(root, url, port):
    config = {"schema_version": 1, "browser": "Edge", "user_data_dir": str(root / "profile"),
              "profile_directory": "Default", "remote_debugging_port": port,
              "download_dir": str(root / "downloads"), "browser_sessions": {"promotion": {"url": url}}}
    owner = PlaywrightBrowserController(config, headless=True, timeout_ms=30_000)
    attached = None
    try:
        await owner.start()
        assert await owner.page("promotion").evaluate("({value: 21 * 2, title: document.title})") == {
            "value": 42, "title": "Promotion CDP local fixture"}
        await owner.close()
        attached = PlaywrightBrowserController(config)
        await attached.connect(open_missing=False)
        assert await attached.page("promotion").evaluate("document.title") == "Promotion CDP local fixture"
        await attached.close()
        # Reconnect the owner so cleanup retains verified process ownership.
        await owner.connect()
    finally:
        if attached is not None:
            await attached.close()
        await owner.stop()


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    try:
        temporary = tempfile.TemporaryDirectory(prefix="promotion-cdp-local-")
        try:
            asyncio.run(smoke(Path(temporary.name), f"http://127.0.0.1:{server.server_port}/", port))
        finally:
            # Chromium children can release cache handles shortly after the
            # owned root process exits. Only this fresh temp directory is used.
            for attempt in range(20):
                try:
                    temporary.cleanup()
                    break
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(.25)
    finally:
        server.shutdown()
        server.server_close()
    print("PASS: local native Edge launch, CDP evaluation, disconnect, reconnect and owned-process cleanup")


if __name__ == "__main__":
    main()
