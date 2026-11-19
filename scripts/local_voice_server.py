#!/usr/bin/env python3
"""One loopback speech server for the Local voice tab.

The browser talks to the proxy on 127.0.0.1:8080. This process listens on
127.0.0.1:18080. It keeps a single engine loaded. Qwen3-TTS and OmniVoice
are each about 0.6B in float16; a 6 GB card cannot hold both at once.

LOCAL_VOICE_FAKE=1 answers with silence and does not import a model. That is
only for the route test.
"""

from __future__ import annotations

import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import local_voice_route as route

QWEN_LANGUAGE = {"en": "English", "es": "Spanish", "ru": "Russian"}
_resident = {"name": "", "model": None}


def _dir_ready(path: str) -> bool:
    return bool(path) and os.path.isdir(path) and any(os.scandir(path))


def installed() -> dict:
    fake = os.environ.get("LOCAL_VOICE_FAKE") == "1"
    return {
        "qwen": fake or _dir_ready(os.environ.get("LOCAL_VOICE_QWEN_DIR", "")),
        "omnivoice": fake or _dir_ready(os.environ.get("LOCAL_VOICE_OMNI_DIR", "")),
        "fish": bool(os.environ.get("LOCAL_VOICE_FISH_UPSTREAM", "")),
    }


def _silence() -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(24000)
        handle.writeframes(b"\x00\x00" * 4800)
    return buf.getvalue()


def _wav_from_float(samples, sample_rate: int) -> bytes:
    import numpy as np

    arr = np.asarray(samples, dtype="float32").reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    pcm = (arr * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm)
    return buf.getvalue()


def _drop() -> None:
    _resident["name"] = ""
    _resident["model"] = None
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        return


def _load(name: str):
    if _resident["name"] == name and _resident["model"] is not None:
        return _resident["model"]
    if _resident["model"] is not None:
        _drop()
    import torch

    if name == "qwen":
        from qwen_tts import Qwen3TTSModel

        path = os.environ.get("LOCAL_VOICE_QWEN_DIR") or "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
        model = Qwen3TTSModel.from_pretrained(
            path,
            device_map="cuda:0",
            dtype=torch.float16,
            attn_implementation="sdpa",
        )
    elif name == "omnivoice":
        from omnivoice import OmniVoice

        path = os.environ.get("LOCAL_VOICE_OMNI_DIR") or "k2-fsa/OmniVoice"
        model = OmniVoice.from_pretrained(path, device_map="cuda:0", dtype=torch.float16)
    else:
        raise RuntimeError("no-loader")
    _resident["name"] = name
    _resident["model"] = model
    return model


def _write_ref(raw: bytes) -> str:
    folder = os.environ.get("LOCAL_VOICE_TMP") or os.path.join(os.environ.get("TEMP", "/tmp"), "viktorych-local-voice")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "ref.bin")
    with open(path, "wb") as handle:
        handle.write(raw)
    return path


def synthesize(decision: dict, text: str, ref_bytes: bytes, ref_text: str) -> bytes:
    if os.environ.get("LOCAL_VOICE_FAKE") == "1":
        return _silence()
    engine = decision["engine"]
    if engine == "fish":
        return _fish(text, ref_bytes, ref_text)
    model = _load(engine)
    ref_path = _write_ref(ref_bytes) if ref_bytes else ""
    if engine == "qwen":
        wavs, sample_rate = model.generate_voice_clone(
            text=text,
            language=QWEN_LANGUAGE[decision["language"]],
            ref_audio=ref_path,
            ref_text=ref_text or "",
        )
        return _wav_from_float(wavs[0], sample_rate)
    audio = model.generate(text=text, ref_audio=ref_path or None, ref_text=ref_text or None)
    return _wav_from_float(audio[0], 24000)


def _fish(text: str, ref_bytes: bytes, ref_text: str) -> bytes:
    import base64

    upstream = os.environ.get("LOCAL_VOICE_FISH_UPSTREAM", "").rstrip("/")
    token = os.environ.get("LOCAL_VOICE_TOKEN", "")
    body = json.dumps({
        "text": text,
        "format": "wav",
        "references": [{"audio": base64.b64encode(ref_bytes).decode("ascii"), "text": ref_text}],
    }).encode()
    req = Request(upstream + "/v1/tts", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    with urlopen(req, timeout=180) as res:
        return res.read()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("local-voice-server " + (fmt % args) + "\n")

    def _send(self, code: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/v1/health":
            self._send(404, b"{}", "application/json")
            return
        body = json.dumps({
            "status": "ok",
            "resident": _resident["name"] or None,
            "engines": installed(),
        }).encode()
        self._send(200, body, "application/json")

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/v1/tts":
            self._send(404, b"{}", "application/json")
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length).decode() or "{}")
        except json.JSONDecodeError:
            self._send(400, b'{"error":"bad-json"}', "application/json")
            return
        text = str(payload.get("text") or "")
        decision = route.choose(text, str(payload.get("language") or "auto"), str(payload.get("engine") or "auto"))
        ready = installed()
        if not ready.get(decision["engine"]):
            message = json.dumps({"error": "engine_not_installed", "engine": decision["engine"], "language": decision["language"]}).encode()
            self._send(503, message, "application/json")
            return
        refs = payload.get("references") or [{}]
        ref = refs[0] if isinstance(refs, list) and refs else {}
        import base64

        try:
            raw = base64.b64decode(ref.get("audio") or "")
        except Exception:
            raw = b""
        try:
            wav = synthesize(decision, text, raw, str(ref.get("text") or ""))
        except (HTTPError, URLError, RuntimeError):
            message = json.dumps({"error": "not_running", "engine": decision["engine"]}).encode()
            self._send(503, message, "application/json")
            return
        self._send(200, wav, "audio/wav", {
            "X-Local-Voice-Engine": decision["engine"],
            "X-Local-Voice-Language": decision["language"],
            "X-Local-Voice-Rerouted": "1" if decision["rerouted"] else "0",
        })


def main() -> None:
    host = os.environ.get("LOCAL_VOICE_BIND", "127.0.0.1")
    port = int(os.environ.get("LOCAL_VOICE_SERVER_PORT", "18080"))
    if host != "127.0.0.1":
        raise SystemExit("refusing to bind outside 127.0.0.1")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
