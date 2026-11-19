#!/usr/bin/env python3
"""Local voice picks Qwen3-TTS or OmniVoice from the text, in Python and in the page."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
import local_voice_route as route
import local_voice_server as server

CASES = [
    ("Hola, ¿cómo estás hoy?", "auto", "auto", "es", "qwen", False),
    ("Hello, this is a test of the local voice.", "auto", "auto", "en", "qwen", False),
    ("Hej, hur mår du idag?", "auto", "auto", "sv", "omnivoice", False),
    ("Bon dia, això és una prova en català.", "auto", "auto", "ca", "omnivoice", False),
    ("Привет, это проверка голоса.", "auto", "auto", "ru", "qwen", False),
    ("Hello there.", "sv", "auto", "sv", "omnivoice", False),
    ("Hej, hur mår du idag?", "auto", "qwen", "sv", "omnivoice", True),
    ("Hello, this is a test.", "auto", "fish", "en", "fish", False),
]


def check_python() -> None:
    for text, language, engine, expect_lang, expect_engine, rerouted in CASES:
        got = route.choose(text, language, engine)
        assert got["language"] == expect_lang, (text, got)
        assert got["engine"] == expect_engine, (text, got)
        assert got["rerouted"] is rerouted, (text, got)
        assert route.supports("qwen", "sv") is False
        assert route.supports("omnivoice", "sv") is True
        assert route.supports("omnivoice", "ca") is True
        assert "sv" not in route.FISH and "ca" not in route.FISH


def check_js() -> None:
    payload = json.dumps([
        {"text": row[0], "language": row[1], "engine": row[2], "languageExpect": row[3], "engineExpect": row[4], "rerouted": row[5]}
        for row in CASES
    ])
    script = r"""
const route = require("./local-voice-route.js");
const cases = JSON.parse(process.argv[1]);
for (const row of cases) {
  const got = route.choose(row.text, row.language, row.engine);
  if (got.language !== row.languageExpect || got.engine !== row.engineExpect || got.rerouted !== row.rerouted) {
    console.error(JSON.stringify({ row, got }));
    process.exit(1);
  }
}
if (route.supports("qwen", "sv") || !route.supports("omnivoice", "ca")) process.exit(1);
console.log("js route ok");
"""
    root = Path(__file__).resolve().parents[1]
    subprocess.run(["node", "-e", script, payload], cwd=root, check=True)


def check_server() -> None:
    os.environ["LOCAL_VOICE_FAKE"] = "1"
    os.environ["LOCAL_VOICE_FISH_UPSTREAM"] = "http://127.0.0.1:9"
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:" + str(httpd.server_address[1])
    with urlopen(base + "/v1/health") as res:
        body = json.loads(res.read().decode())
        assert body["engines"]["qwen"] and body["engines"]["omnivoice"]
    samples = [
        ("Hola, ¿cómo estás hoy?", "es", "qwen"),
        ("Hej, hur mår du idag?", "sv", "omnivoice"),
        ("Bon dia, això és una prova en català.", "ca", "omnivoice"),
        ("Привет, это проверка голоса.", "ru", "qwen"),
    ]
    for text, language, engine in samples:
        req = Request(
            base + "/v1/tts",
            data=json.dumps({"text": text, "language": "auto", "engine": "auto", "references": []}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req) as res:
            assert res.headers["X-Local-Voice-Language"] == language, text
            assert res.headers["X-Local-Voice-Engine"] == engine, text
            assert res.read(4) == b"RIFF"
    forced = Request(
        base + "/v1/tts",
        data=json.dumps({"text": "Hej, hur mår du idag?", "language": "auto", "engine": "qwen", "references": []}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(forced) as res:
        assert res.headers["X-Local-Voice-Engine"] == "omnivoice"
        assert res.headers["X-Local-Voice-Rerouted"] == "1"
    httpd.shutdown()


def main() -> None:
    check_python()
    check_js()
    check_server()
    print("local voice route ok")


if __name__ == "__main__":
    main()
