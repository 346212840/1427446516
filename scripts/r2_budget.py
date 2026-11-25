"""R2 spending guard for the GitHub sync jobs.

R2 has no spending cap, so the Worker meters every R2 call and publishes a
level at GET /v1/r2-budget (worker/src/r2-meter.js). Scripts that write to R2
ask here first:

    import r2_budget
    if not r2_budget.allow(key):
        return False   # skipped: the free allowance is nearly used

Levels (percent of the free monthly allowance):
    soft  >= 70%  low-priority keys stop (backups, lastgood, caches, live buffers)
    hard  >= 85%  everything except uploads and deletion records stops
    stop  >= 95%  everything stops (fail closed)

The level is read at most once every five minutes per process. When it cannot
be read, low-priority writes wait (the same rule the Worker uses). Self-tests
and R2_BUDGET=off skip the check.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

DEFAULT_API = "https://viktorych-accounts.viktorych-accounts.workers.dev"
EVERY_SEC = 300
TIMEOUT_SEC = 8

HIGH = [
    r"^backup/tg-forget/", r"^deletions\.json$", r"^media/", r"^post-media/", r"^srv/", r"^uploads/",
    r"^users/", r"^accounts/", r"^sealed/", r"^exports/", r"^stories/(?!telegram/)", r"^profile_banners/",
    r"^highlights/", r"^cnotes/", r"^newsletter", r"^follows/", r"^lists/",
]
LOW = [
    r"^backups?/", r"^lastgood/", r"^live-buf/", r"^ops/", r"^x-cache/", r"^unfurl/", r"^sync/",
    r"^pulse/", r"^comments/", r"^data/communities/", r"^discord/", r"^archive/", r"^ytm?/", r"^vsr/",
    r"^snap/", r"^loop/", r"^tg/", r"^stories/telegram/", r"^owner/tiktok-watch\.json$",
    r"^owner/live-(watch|marks|jobs-beat|upload)",
]
_HIGH = [re.compile(p) for p in HIGH]
_LOW = [re.compile(p) for p in LOW]

_STATE = {"at": 0.0, "level": "", "skipped": 0}


def key_priority(key: str) -> str:
    text = str(key or "")
    if any(p.search(text) for p in _HIGH):
        return "high"
    if any(p.search(text) for p in _LOW):
        return "low"
    return "normal"


def allowed(level: str, priority: str) -> bool:
    if level == "stop":
        return False
    if level == "hard":
        return priority == "high"
    if level == "soft":
        return priority != "low"
    return True


def disabled() -> bool:
    if (os.environ.get("R2_BUDGET") or "").strip().lower() == "off":
        return True
    argv = [str(a) for a in sys.argv]
    if "--selftest" in argv:
        return True
    name = os.path.basename(argv[0]) if argv else ""
    return name == "selftest.py" or name.endswith("_test.py")


def api_base() -> str:
    return ((os.environ.get("ACCOUNTS_API") or "").strip() or DEFAULT_API).rstrip("/")


def fetch_level(opener=None) -> str:
    """The Worker's write level, or "" when it cannot be read."""
    req = urllib.request.Request(api_base() + "/v1/r2-budget", headers={"user-agent": "viktorych-r2-budget"})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=TIMEOUT_SEC) as res:
            doc = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return ""
    if not isinstance(doc, dict):
        return ""
    if doc.get("on") is False:
        return "ok"
    level = str(doc.get("write") or "")
    return level if level in ("ok", "soft", "hard", "stop") else ""


def level(now: float | None = None, opener=None) -> str:
    at = time.time() if now is None else now
    if _STATE["level"] and at - _STATE["at"] < EVERY_SEC:
        return _STATE["level"]
    found = fetch_level(opener) or "soft"
    _STATE["level"] = found
    _STATE["at"] = at
    return found


def allow(key: str, now: float | None = None, opener=None) -> bool:
    """True when a write of `key` may go ahead now."""
    if disabled():
        return True
    ok = allowed(level(now, opener), key_priority(key))
    if not ok:
        _STATE["skipped"] += 1
        if _STATE["skipped"] <= 5 or _STATE["skipped"] % 100 == 0:
            print("[r2-budget] skipped an R2 write (%s priority, level %s, %s skipped so far)" % (key_priority(key), _STATE["level"], _STATE["skipped"]), flush=True)
    return ok


def reset() -> None:
    _STATE.update({"at": 0.0, "level": "", "skipped": 0})


def selftest() -> int:
    def check(cond, message):
        if not cond:
            raise SystemExit("FAIL: " + message)
        print("ok", message)

    check(key_priority("backup/telegram-manifest.json") == "low", "backups are low priority")
    check(key_priority("backup/tg-forget/x.json") == "high", "deletion records are high priority")
    check(key_priority("media/avatars/1/a.webp") == "high", "uploads are high priority")
    check(key_priority("feeds.json") == "normal", "the catalog is normal priority")
    check(allowed("soft", "normal") and not allowed("soft", "low"), "soft stops only low-priority writes")
    check(allowed("hard", "high") and not allowed("hard", "normal"), "hard keeps only uploads and deletions")
    check(not allowed("stop", "high"), "stop fails closed")

    class _Res:
        def __init__(self, body):
            self.body = body

        def read(self):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    calls = []

    def opener(body):
        def _open(req, timeout=0):
            calls.append(req.full_url)
            if body is None:
                raise urllib.error.URLError("down")
            return _Res(body)
        return _open

    reset()
    check(level(1000.0, opener(b'{"on":true,"write":"hard"}')) == "hard", "the Worker's level is read")
    check(level(1100.0, opener(b'{"on":true,"write":"ok"}')) == "hard" and len(calls) == 1, "the level is kept for five minutes")
    check(level(1400.0, opener(b'{"on":true,"write":"ok"}')) == "ok", "and read again after")
    reset()
    check(level(0.0, opener(None)) == "soft", "an unreadable level holds back low-priority writes")
    reset()
    check(level(0.0, opener(b'{"on":false}')) == "ok", "a Worker without the guard allows writes")
    reset()
    print("r2 budget selftest ok")
    return 0


if __name__ == "__main__":
    sys.exit(selftest())
