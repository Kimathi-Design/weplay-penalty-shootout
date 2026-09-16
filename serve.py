#!/usr/bin/env python3
"""Local static server for the Weplay arcade penalty game.

Same folder layout works on any static host — upload the whole project folder
and open index.html. No path rewriting required for production.
"""

from __future__ import annotations

import mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8765

# Long-lived assets (Digita engine + sprites). HTML/config stay fresh.
IMMUTABLE_PREFIXES = (
    "/prod/",
    "/media/",
    "/iframeResizer.min.js",
    "/weplay-bridge.js",
)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        path = self.path.split("?", 1)[0]
        if any(path.startswith(p) for p in IMMUTABLE_PREFIXES):
            # Warm lobby preloads + remounts should hit disk/HTTP cache
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        elif path.endswith((".html", ".json")):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        super().end_headers()

    def log_message(self, fmt: str, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)


def main() -> None:
    import socket

    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("application/json", ".json")
    mimetypes.add_type("image/png", ".png")
    mimetypes.add_type("image/webp", ".webp")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)

    lan = "unknown"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan = s.getsockname()[0]
        s.close()
    except OSError:
        pass

    print(f"Local  → http://127.0.0.1:{PORT}/", flush=True)
    print(f"Phones → http://{lan}:{PORT}/  (same Wi‑Fi)", flush=True)
    print(f"Root   → {ROOT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
