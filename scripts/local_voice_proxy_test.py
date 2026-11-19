#!/usr/bin/env python3
"""The loopback gate allows the site, hides the token, and answers preflight."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

import local_voice_proxy as proxy


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:
        auth = self.headers.get("Authorization", "")
        if auth != "Bearer local-test-token":
            self.send_response(401)
            self.end_headers()
            return
        body = json.dumps({"status": "ok"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    proxy.Proxy.upstream = "http://127.0.0.1:" + str(upstream.server_address[1])
    proxy.Proxy.token = "local-test-token"
    gate = ThreadingHTTPServer(("127.0.0.1", 0), proxy.Proxy)
    threading.Thread(target=gate.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:" + str(gate.server_address[1])
    origin = "https://viktorychapp.pages.dev"
    pre = Request(base + "/v1/health", method="OPTIONS", headers={"Origin": origin})
    with urlopen(pre) as res:
        assert res.status == 204, res.status
        assert res.headers["Access-Control-Allow-Private-Network"] == "true"
        assert res.headers["Access-Control-Allow-Origin"] == origin
    bad = Request(base + "/v1/health", headers={"Origin": origin})
    try:
        urlopen(bad)
        raise SystemExit("missing token was accepted")
    except Exception as err:
        assert getattr(err, "code", None) == 401, err
    ok = Request(
        base + "/v1/health",
        headers={"Origin": origin, "Authorization": "Bearer local-test-token"},
    )
    with urlopen(ok) as res:
        body = json.loads(res.read().decode())
        assert body["status"] == "ok"
        assert "local-test-token" not in json.dumps(dict(res.headers))
    print("local voice proxy ok")


if __name__ == "__main__":
    main()
