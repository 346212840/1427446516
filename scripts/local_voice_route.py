"""Pick a local speech engine for one line of text.

The same rules live in local-voice-route.js. Sources for the language lists
are written in docs/local-voice.md.
"""

from __future__ import annotations

import re

OWNER = ("en", "es", "sv", "ca", "ru")
# Qwen3-TTS 0.6B Base lists these of the owner's languages. Swedish and
# Catalan are not in the ten-language card.
QWEN = frozenset({"en", "es", "ru"})
# Fish-Speech 1.5 lists the same three of the owner's languages, and not
# Swedish or Catalan. Auto never selects it.
FISH = frozenset({"en", "es", "ru"})
# OmniVoice's card includes every language the owner asked for.
OMNI = frozenset({"en", "es", "sv", "ca", "ru"})
NAMES = {"qwen": "Qwen3-TTS", "omnivoice": "OmniVoice", "fish": "Fish-Speech 1.5"}

def _hits(text: str, words: tuple[str, ...]) -> int:
    padded = " " + re.sub(r"\s+", " ", re.sub(r'[.,!?¿¡;:()"“”]+', " ", text.lower())) + " "
    return sum(padded.count(" " + word + " ") for word in words)


def supports(engine: str, language: str) -> bool:
    table = {"qwen": QWEN, "omnivoice": OMNI, "fish": FISH}
    return language in table.get(engine, ())


def detect(text: str) -> str:
    raw = text or ""
    if not raw.strip():
        return "en"
    letters = 0
    cyr = 0
    for ch in raw:
        code = ord(ch)
        if 0x0400 <= code <= 0x04FF:
            cyr += 1
        if ch.isalpha() or ch in "·":
            letters += 1
    if cyr >= 2 and cyr / (letters or 1) > 0.2:
        return "ru"
    low = raw.lower()
    if any(ch in low for ch in "åäö"):
        return "sv"
    scores = {
        "sv": 2 * _hits(low, ("och", "att", "inte", "jag", "också", "hej", "svenska", "för")),
        "ca": (3 if ("ç" in low or "·" in low) else 0) + 2 * _hits(low, ("és", "amb", "però", "això", "també", "català", "doncs", "després", "vosaltres", "aquesta", "aquest", "molt")),
        "es": (3 if ("ñ" in low or "¿" in raw or "¡" in raw) else 0) + _hits(low, ("también", "pero", "porque", "está", "hola", "gracias", "usted", "qué", "español", "los", "las", "del", "por", "con", "para")),
        "en": _hits(low, ("the", "and", "you", "this", "that", "with", "from", "have", "hello", "english")),
    }
    rank = {"en": 3, "es": 2, "ca": 1, "sv": 0}
    best = max(scores, key=lambda code: (scores[code], rank[code]))
    if scores[best] <= 0:
        return "en"
    return best


def choose(text: str, language: str = "auto", engine: str = "auto") -> dict:
    lang = language if language in OWNER else detect(text)
    auto_engine = "qwen" if lang in QWEN else "omnivoice"
    forced = engine if engine in ("qwen", "omnivoice", "fish") else "auto"
    rerouted = False
    picked = auto_engine
    if forced != "auto":
        if supports(forced, lang):
            picked = forced
        else:
            rerouted = True
    return {
        "language": lang,
        "engine": picked,
        "engineName": NAMES[picked],
        "rerouted": rerouted,
    }
