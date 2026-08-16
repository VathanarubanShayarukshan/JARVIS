import asyncio
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import httpx

from .config import settings


@dataclass
class Provider:
    id: str
    name: str
    base_url: str
    api_key: str | None = None
    models: list[str] = field(default_factory=list)

    @property
    def chat_url(self) -> str:
        return self.base_url.rstrip("/") + "/chat/completions"


async def probe(base_url: str, key: str | None = None) -> list[str] | None:
    url = base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url, headers=headers)
            if r.status_code != 200:
                return None
            data = r.json()
            ids = [m.get("id", "") for m in data.get("data", [])]
            ids = [i for i in ids if i and not i.startswith("_")]
            return ids or None
    except Exception:
        return None


async def detect_free_providers() -> list[Provider]:
    """Probe common loginless local endpoints. No API key required."""
    results = await asyncio.gather(
        probe("http://localhost:11434/v1"),  # Ollama
        probe("http://127.0.0.1:11434/v1"),
        probe("http://localhost:1234/v1"),   # LM Studio
        probe("http://127.0.0.1:1234/v1"),
    )
    urls = [
        ("ollama-local", "Ollama (local, no key)", "http://localhost:11434/v1", None),
        ("ollama-local-127", "Ollama (local, no key)", "http://127.0.0.1:11434/v1", None),
        ("lmstudio-local", "LM Studio (local, no key)", "http://localhost:1234/v1", None),
        ("lmstudio-local-127", "LM Studio (local, no key)", "http://127.0.0.1:1234/v1", None),
    ]
    providers: list[Provider] = []
    seen: set[str] = set()
    for (pid, name, url, key), models in zip(urls, results):
        if models and url not in seen:
            seen.add(url)
            providers.append(Provider(id=pid, name=name, base_url=url, api_key=key, models=models))
    return providers


def configured_providers() -> list[Provider]:
    from .database import list_providers

    providers: list[Provider] = []
    for p in list_providers():
        providers.append(
            Provider(
                id=f"custom-{p['id']}",
                name=p["name"],
                base_url=p["base_url"],
                api_key=p["api_key"],
                models=p["models"] or [],
            )
        )
    return providers


async def all_providers() -> list[Provider]:
    providers = await detect_free_providers()
    providers += configured_providers()
    return providers


def from_env_provider() -> list[Provider]:
    if settings.provider_base_url:
        models = [m.strip() for m in settings.provider_models.split(",") if m.strip()]
        return [
            Provider(
                id="env",
                name="Env provider",
                base_url=settings.provider_base_url,
                api_key=settings.provider_api_key or None,
                models=models,
            )
        ]
    return []


class LLMError(Exception):
    pass


class LLMClient:
    """Minimal OpenAI-compatible chat client with streaming + function calling."""

    def __init__(self, provider: Provider, model: str):
        if not provider.base_url:
            raise LLMError("No provider configured")
        self.provider = provider
        self.model = model or (provider.models[0] if provider.models else "")

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.provider.api_key:
            headers["Authorization"] = f"Bearer {self.provider.api_key}"
        return headers

    async def stream_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[tuple[str, dict[str, Any]]]:
        """Yield (delta_text, accumulated_dict) per stream fragment."""
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0)) as client:
            try:
                async with client.stream(
                    "POST", self.provider.chat_url, json=body, headers=self._headers()
                ) as resp:
                    if resp.status_code != 200:
                        text = (await resp.aread()).decode(errors="replace")
                        raise LLMError(f"Provider error {resp.status_code}: {text[:500]}")
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload or payload == "[DONE]":
                            continue
                        import json

                        try:
                            chunk = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        delta = choices[0].get("delta") or {}
                        yield delta.get("content") or "", chunk
            except httpx.HTTPError as e:
                raise LLMError(f"Cannot reach provider at {self.provider.base_url}: {e}") from e


DEFAULT_SYSTEM_PROMPT = """You are AgenticAI, an autonomous coding and general-purpose agent running in a self-hosted sandbox.

You have tools available. Decide step-by-step:
1. Read / inspect the target first when the user asks about existing code or files.
2. Use tools to accomplish the task. Do not guess file contents or command output.
3. When the task involves code, verify your work by running or reading back what you changed.
4. Keep answers concise unless the user asks for detail.

Rules:
- All file access is restricted to the workspace folder. File tool paths are
  relative to the workspace. Never try to escape it.
- Shell commands can take a while; use them for builds, tests, git, etc.
- On Windows, commands run in PowerShell: do NOT use bash-only syntax such as
  `||`, `&&`, `uname`, `ls -la`, `/dev/null`, or `which`. Use PowerShell
  equivalents (e.g. `Get-ChildItem`, `Get-ComputerInfo`, `$LASTEXITCODE`).
  When you need environment details like CPU/RAM/disk or could not parse a
  platform-specific error, prefer the `run_script` tool with language
  "powershell" and Windows cmdlets.
- If you cannot complete the task, say exactly what blocked you.
- After the user's request is fully handled, give a short final summary.
"""