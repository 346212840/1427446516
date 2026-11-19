"""Fail if a runtime path hardcodes a repository name.

Pages and GitHub API paths come from the address, from GITHUB_REPOSITORY,
or from GitHub's rename redirect. The one configured name lives in
worker/src/site-repo.js and worker/wrangler.toml. The retired project
segment must not appear anywhere.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RETIRED = "ViktorychApp" + "1427446516"
RUNTIME_MARKERS = (
    "github.io/Viktorych",
    "github.com/ViktorychGroup/Viktorych",
    "repos/ViktorychGroup/Viktorych",
)
RUNTIME_DIRS = (
    "worker/src",
    "shared",
    ".github/workflows",
    "android-tv",
)
RUNTIME_FILES = {
    "app.js",
    "tv.js",
    "index.html",
    "sw.js",
    "direct.js",
    "scripts/stamp_mirrors.py",
    "scripts/radio_loop.py",
    "scripts/build_nft_meta.mjs",
    "scripts/write_version.py",
    "tv/version.json",
}
SKIP_PARTS = {".git", "node_modules", "_site"}
ALLOW_NAME = {
    "worker/src/site-repo.js",
    "worker/wrangler.toml",
}


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def runtime(path: Path) -> bool:
    name = rel(path)
    if name in ALLOW_NAME:
        return False
    if name in RUNTIME_FILES:
        return True
    return any(name.startswith(prefix + "/") for prefix in RUNTIME_DIRS)


def main() -> int:
    problems = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or any(part in SKIP_PARTS for part in path.parts):
            continue
        if path.suffix.lower() not in {".js", ".mjs", ".py", ".yml", ".yaml", ".html", ".json", ".toml", ".md", ".gradle", ".txt"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        name = rel(path)
        if RETIRED in text:
            problems.append(name + " still names the retired project path")
        if runtime(path):
            for marker in RUNTIME_MARKERS:
                if marker in text:
                    problems.append(name + " hardcodes a repository path (" + marker + ")")
    if problems:
        print("repo path guard failed:")
        for line in problems:
            print("  " + line)
        return 1
    print("repo path guard ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
