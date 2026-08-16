"""Built-in free-tier cloud providers.

End users never need an API key: the self-hosting server holds one key from a
free tier (Google Gemini, Groq, OpenRouter all offer free keys / free models).
No local LLM (Ollama etc.) or GPU is required anywhere.
"""

from __future__ import annotations

from typing import Any


def default_presets() -> list[dict[str, Any]]:
    return [
        {
            "name": "Google Gemini (free)",
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
            "hint": "Free API key: https://aistudio.google.com/apikey (no card required)",
            "models": ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"],
            "is_custom": 0,
        },
        {
            "name": "Groq (free)",
            "base_url": "https://api.groq.com/openai/v1",
            "hint": "Free API key: https://console.groq.com/keys (no card required)",
            "models": ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
            "is_custom": 0,
        },
        {
            "name": "OpenRouter (free models)",
            "base_url": "https://openrouter.ai/api/v1",
            "hint": "Free key: https://openrouter.ai/settings/keys — models ending in :free cost $0",
            "models": ["meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-chat-v3-0324:free"],
            "is_custom": 0,
        },
    ]


def preset_hint(name: str) -> str:
    for p in default_presets():
        if p["name"] == name:
            return p["hint"]
    return ""