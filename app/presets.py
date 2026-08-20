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
        {
            "name": "Hugging Face (free credits)",
            "base_url": "https://router.huggingface.co/v1",
            "hint": "Free: https://huggingface.co/settings/tokens — new accounts get $0.10 of serverless compute, and some models are free. The model chooser lists hundreds of models from one provider.",
            "models": [
                "meta-llama/Llama-3.3-70B-Instruct",
                "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
                "Qwen/Qwen2.5-72B-Instruct",
            ],
            "is_custom": 0,
        },
        {
            "name": "OpenCode Zen (free)",
            "base_url": "https://opencode.ai/zen/v1",
            "hint": "Free API key: https://opencode.ai/auth (no card required for free models). Probe fetches the full free list.",
            "models": [
                "deepseek-v4-flash-free",
                "nemotron-3-ultra-free",
                "mimo-v2.5-free",
                "big-pickle",
                "qwen3.6-plus-free",
                "minimax-m3-free",
                "north-mini-code-free",
            ],
            "is_custom": 0,
        },
        {
            "name": "Ollama (local, no key)",
            "base_url": "http://localhost:11434/v1",
            "hint": "Local: install Ollama from https://ollama.com then `ollama pull llama3.2` — runs on your machine with no API key, no GPU needed for small models.",
            "models": ["llama3.2:1b", "qwen2.5:0.5b", "phi3:mini"],
            "is_custom": 0,
        },
        {
            "name": "TinyAI (built-in, instant)",
            "base_url": "builtin://tiny",
            "hint": "Zero-install local model: no network, no key, no GPU. Answers everyday phrases (English/Tamil) and simple math; select model tiny-answer-bot. Great for tests and light use.",
            "models": ["tiny-answer-bot"],
            "is_custom": 0,
        },
    ]


def preset_hint(name: str) -> str:
    for p in default_presets():
        if p["name"] == name:
            return p["hint"]
    return ""