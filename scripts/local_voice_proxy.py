#!/usr/bin/env python3
"""Loopback gate in front of the local Fish-Speech server.

The official server speaks its own CORS policy. A page on the public site
needs Private Network Access headers to call 127.0.0.1. This process binds
to 127.0.0.1, checks the local token, and forwards to the Fish-Speech port.
It does not log the token or the request body.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ALLOWED_HOSTS = ("localhost", "127.0.0.1", "viktorychgroup.github.io", "viktorychapp.pages.dev")


def origin_ok(origin: str) -> bool:
    try:
        parsed = urlparse(origin)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        return False
    if host in ALLOWED_HOSTS:
        return True
    return host.endswith(".viktorychgroup.github.io") or host.endswith(".viktorychapp.pages.dev")


class Proxy(BaseHTTPRequestHandler):
    upstream = "http://127.0.0.1:18080"
    token = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("local-voice " + (fmt % args) + "\n")

    def _cors(self, origin: str) -> list[tuple[str, str]]:
        if not origin_ok(origin):
            return []
        return [
            ("Access-Control-Allow-Origin", origin),
            ("Vary", "Origin"),
            ("Access-Control-Allow-Private-Network", "true"),
            ("Access-Control-Allow-Headers", "Authorization, Content-Type"),
            ("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"),
            ("Access-Control-Expose-Headers", "X-Local-Voice-Engine, X-Local-Voice-Language, X-Local-Voice-Rerouted"),
            ("Access-Control-Max-Age", "600"),
        ]

    def _send(self, code: int, body: bytes, content_type: str, origin: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in self._cors(origin):
            self.send_header(key, value)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin", "")
        if not origin_ok(origin):
            self._send(403, b"", "text/plain", "")
            return
        self._send(204, b"", "text/plain", origin)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not self.token:
            return False
        return header == "Bearer " + self.token

    def _forward(self) -> None:
        origin = self.headers.get("Origin", "")
        if not self._authorized():
            self._send(401, b'{"error":"unauthorized"}', "application/json", origin)
            return
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) if length else None
        url = self.upstream.rstrip("/") + self.path
        req = Request(url, data=payload, method=self.command)
        if payload is not None:
            ctype = self.headers.get("Content-Type")
            if ctype:
                req.add_header("Content-Type", ctype)
        req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urlopen(req, timeout=120) as res:
                body = res.read()
                ctype = res.headers.get("Content-Type", "application/octet-stream")
                extra = {}
                for name in ("X-Local-Voice-Engine", "X-Local-Voice-Language", "X-Local-Voice-Rerouted"):
                    value = res.headers.get(name)
                    if value:
                        extra[name] = value
                self._send(res.status, body, ctype, origin, extra)
        except HTTPError as err:
            body = err.read()
            ctype = err.headers.get("Content-Type", "application/json") if err.headers else "application/json"
            self._send(err.code, body, ctype, origin)
        except URLError:
            message = json.dumps({"error": "not_running"}).encode()
            self._send(503, message, "application/json", origin)

    def do_GET(self) -> None:
        self._forward()

    def do_POST(self) -> None:
        self._forward()

    def do_DELETE(self) -> None:
        self._forward()


def main() -> None:
    host = os.environ.get("LOCAL_VOICE_BIND", "127.0.0.1")
    port = int(os.environ.get("LOCAL_VOICE_PORT", "8080"))
    Proxy.upstream = os.environ.get("LOCAL_VOICE_UPSTREAM", "http://127.0.0.1:18080")
    Proxy.token = os.environ.get("LOCAL_VOICE_TOKEN", "")
    if host != "127.0.0.1":
        raise SystemExit("refusing to bind outside 127.0.0.1")
    if not Proxy.token:
        raise SystemExit("LOCAL_VOICE_TOKEN is empty")
    server = ThreadingHTTPServer((host, port), Proxy)
    server.serve_forever()


if __name__ == "__main__":
    main()
