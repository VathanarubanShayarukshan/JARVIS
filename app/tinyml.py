"""TinyAI: a light built-in local model.

No install, no network, no key. Answers normal everyday inputs (greetings,
how-are-you, who-are-you, help, thanks, bye, time/date) and does simple
arithmetic. Falls back to a short honest reply for anything else.

Selected in the UI as provider "TinyAI (built-in, instant)" / model
"tiny-answer-bot". It is intentionally simple: for real work pick a cloud
free-tier provider (Gemini, Groq, OpenCode Zen) or Ollama locally.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

TAMIL_RE = re.compile(r"[\u0B80-\u0BFF]")

_INTRO = (
    "I am TinyAI — the built-in, no-install mini model of this AgenticAI server. "
    "No network, no key, no GPU needed: I run right here."
)
_CAPS = (
    "I can do: greetings and small talk (English or Tamil), simple math like "
    "'12 * 8' or '(45 + 15) / 3', and tell you the time/date. "
    "For bigger tasks (coding, files, internet tools), pick a cloud free-tier "
    "provider (Gemini, Groq, OpenCode Zen) or run Ollama locally."
)
_FALLBACK = (
    "That is beyond my tiny brain — I only answer everyday phrases and simple "
    "math. For a real answer, pick a cloud provider (Gemini / Groq / OpenCode "
    "Zen) or a local Ollama model in the provider list."
)

_GREETINGS_RE = re.compile(
    r"\b(hi|hello|hey|hai|yo)\b|good (morning|afternoon|evening|night)|வணக்கம்|ஹலோ|வணக்கம்$", re.I
)
_HOWARE = ("how are you", "how r u", "how are u", "whats up", "what's up", "sugama", "epadi", "epdi")
_WHO = ("who are you", "what are you", "about you", "tell me about yourself", "யார் நீ", "நீ யார்", "உன்னை")
_HELP = ("help", "what can you do", "what do you do", "commands", "abilities", "can you help")
_THANKS = ("thanks", "thank you", "thx", "ty", "nandri", "nandrigal")
_BYE = ("bye", "goodbye", "see you", "see u", "good night", "kudpai")

_TAMIL = {
    "greet": (
        "வணக்கம்! நான் TinyAI — இந்த சர்வரின் உள்ளமைந்த லைட் மாடல். "
        "என்ன உதவி வேண்டும்?"
    ),
    "howare": "நான் நன்றாக இருக்கிறேன்! நீங்கள் எப்படி இருக்கிறீர்கள்?",
    "who": "நான் TinyAI — இந்த AgenticAI சர்வரின் உள்ளமைந்த சிறிய மாடல். இணையம், கீ, இல்லாமல் இங்கேயே இயங்குகிறேன்.",
    "help": "என்னால் இவற்றை செய்ய முடியும்: வணக்கங்கள், எளிய கணிதம் (எ.கா. '12 * 8'), நேரம்/தேதி. பெரிய வேலைகளுக்கு கிளவுட் புரொவைடர் (Gemini / Groq / OpenCode Zen) தேர்ந்தெடுக்கவும்.",
    "thanks": "நன்றி! உங்களுக்கு வேறு உதவி தேவையா?",
    "bye": "நன்றி! மீண்டும் பேசுவோம். 👋",
    "fallback": "இது என்னால் முடியாது — நான் எளிய பதில்களுக்கும் கணிதத்திற்கும் மட்டுமே. பெரிய பதிலுக்கு புரொவைடர் பட்டியலில் இருந்து Gemini / Groq / OpenCode Zen தேர்ந்தெடுக்கவும்.",
}

_MATH_RE = re.compile(r"^[\d\s+\-*/().,%]+$")


def _tamil_reply(key: str) -> str:
    return _TAMIL.get(key, _TAMIL["fallback"])


def _simple_math(expr: str) -> str | None:
    if "%" in expr:
        expr = expr.replace("%", " % ")
    if "(" in expr and ")" not in expr:
        return None
    if not _MATH_RE.match(expr) or not re.search(r"[+\-*/%]", expr):
        return None
    try:
        val = eval(expr, {"__builtins__": {}}, {})  # noqa: S307 - regex-whitelisted digits/operators only
    except Exception:
        return None
    if not isinstance(val, (int, float)):
        return None
    return f"{val:g}"


def tiny_answer(messages: list[dict[str, Any]]) -> str:
    """Return TinyAI's answer for the conversation (uses the last user turn)."""
    text = ""
    for m in reversed(messages):
        if m.get("role") == "user" and m.get("content"):
            text = str(m["content"]).strip()
            break
    if not text:
        return _CAPS

    marker = "Task:"
    if marker in text:
        text = text.split(marker, 1)[1].strip()

    tamil = bool(TAMIL_RE.search(text))
    lower = text.lower().strip(" .!?")

    math_ans = _simple_math(lower)
    if math_ans is not None:
        return f"{lower} = {math_ans}" + (" 😊" if not tamil else "")

    if _GREETINGS_RE.search(lower):
        return _tamil_reply("greet") if tamil else _INTRO + " How can I help?"
    if any(k in lower for k in _HOWARE):
        return _tamil_reply("howare") if tamil else "I am doing great! How about you?"
    if any(k in lower for k in _WHO):
        return _tamil_reply("who") if tamil else _INTRO
    if any(k in lower for k in _HELP):
        return _tamil_reply("help") if tamil else _CAPS
    if any(k in lower for k in _THANKS):
        return _tamil_reply("thanks") if tamil else "You are welcome!"
    if any(k in lower for k in _BYE):
        return _tamil_reply("bye") if tamil else "Bye! Talk again soon."
    if re.search(r"\btime\b|\bdate\b|நேரம்|தேதி", lower):
        now = datetime.now()
        return (
            now.strftime("It is %I:%M %p on %A, %d %B %Y.")
            if not tamil
            else now.strftime("இப்போது நேரம் %I:%M %p, %A, %d %B %Y.")
        )

    return _tamil_reply("fallback") if tamil else _FALLBACK
