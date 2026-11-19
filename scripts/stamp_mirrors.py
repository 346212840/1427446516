"""Stamp the deployed service worker with this repository's Pages origins.

The source file keeps placeholders. GitHub Pages and the Cloudflare Pages
mirror both receive the same stamped copy.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from site_paths import DEFAULT_REPO, default_pages, pages_base, repository  # noqa: E402

PAGES = "https://viktorychapp.pages.dev/"


def stamp(site: Path, github: str) -> None:
    base = github if github.endswith("/") else github + "/"
    sw = site / "sw.js"
    if sw.is_file():
        text = sw.read_text(encoding="utf-8")
        text = text.replace("__MIRROR_GITHUB__", base[:-1])
        text = text.replace("__MIRROR_PAGES__", PAGES[:-1])
        sw.write_text(text, encoding="utf-8")
    repo = repository() or DEFAULT_REPO
    for rel in ("shared/mirror.js", "shared/short-link.js"):
        mirror = site / rel
        if not mirror.is_file():
            continue
        raw = mirror.read_text(encoding="utf-8")
        raw = raw.replace('var REPO = "' + DEFAULT_REPO + '"', 'var REPO = "' + repo + '"')
        raw = raw.replace("https://viktorychgroup.github.io/ViktorychApp1427446516/", base)
        raw = raw.replace(default_pages(), base)
        mirror.write_text(raw, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    args = parser.parse_args()
    github = pages_base() or default_pages()
    stamp(Path(args.site), github)
    print("mirror origins stamped")
    return 0


if __name__ == "__main__":
    try:
        from log_redact import auto as _redact_logs

        _redact_logs()
    except ImportError:
        pass
    raise SystemExit(main())
