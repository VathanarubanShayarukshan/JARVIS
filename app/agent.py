"""Agent loop: LLM <-> tools, streamed to clients as events.

Event shapes (each yielded as a dict with a "type" key):
    {"type": "status", "message": str}        thinking / running indicators
    {"type": "text", "text": str}             one text delta
    {"type": "tool_call", "id", "name", "arguments"}
    {"type": "tool_result", "id", "name", "result"}
    {"type": "done", "content": str}          final assistant text
    {"type": "error", "message": str}
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, AsyncIterator

from .config import settings
from .database import append_message, list_messages
from .llm import DEFAULT_SYSTEM_PROMPT, LLMClient, LLMError
from .tools import registry

MAX_TOOL_RESULT_CHARS = 12000
RATE_LIMIT_RETRIES = 4


def _retry_after(message: str) -> int:
    m = re.search(r"retry\s+in\s+([\d.]+)\s*s", message, re.I)
    if not m:
        m = re.search(r"([\d.]+)\s*seconds?", message, re.I)
    if m:
        return max(5, min(int(float(m.group(1))), 60))
    return 15


def _tool_call_index(tc: dict[str, Any], drafts: dict[int, dict[str, Any]]) -> int:
    """OpenAI sends an explicit 'index' per tool call; Gemini often omits it."""
    if tc.get("index") is not None:
        return int(tc["index"])
    call_id = tc.get("id")
    if call_id:
        for i, d in drafts.items():
            if d.get("id") == call_id:
                return i
        return max(drafts, default=-1) + 1
    if drafts:
        return max(drafts)  # fragment continuation (split argument without id)
    return 0


async def run_agent(
    provider,
    model: str,
    session_id: str,
    user_text: str,
) -> AsyncIterator[dict[str, Any]]:
    append_message(session_id, "user", user_text)

    history = list_messages(session_id, limit=settings.max_messages)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": DEFAULT_SYSTEM_PROMPT}
    ] + [
        {"role": m["role"], "content": m["content"] or ""}
        for m in history
        if m["role"] in ("user", "assistant")
    ]

    client = LLMClient(provider, model)
    accumulated_text = ""
    tool_configs = registry.tool_configs()

    try:
        for _ in range(min(settings.max_tool_iterations, 48)):
            yield {"type": "status", "message": "Thinking..."}

            tool_calls: list[dict[str, Any]] = []
            drafts: dict[int, dict[str, Any]] = {}

            base_text_len = len(accumulated_text)
            rate_retries = RATE_LIMIT_RETRIES
            while True:
                try:
                    async for delta, chunk in client.stream_chat(messages, tools=tool_configs):
                        if delta:
                            accumulated_text += delta
                            yield {"type": "text", "text": delta}
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        for tc in (choices[0].get("delta") or {}).get("tool_calls") or []:
                            idx = _tool_call_index(tc, drafts)
                            acc = drafts.setdefault(
                                idx, {"id": "", "name": "", "arguments": "", "extra_content": None}
                            )
                            acc["id"] += tc.get("id") or ""
                            acc["name"] += (tc.get("function") or {}).get("name") or ""
                            acc["arguments"] += (tc.get("function") or {}).get("arguments") or ""
                            if acc["extra_content"] is None:
                                acc["extra_content"] = tc.get("extra_content")
                    break
                except LLMError as e:
                    msg = str(e)
                    is_retryable = "429" in msg or "rate" in msg.lower() or "quota" in msg.lower()
                    if not is_retryable or rate_retries <= 0 or len(accumulated_text) != base_text_len:
                        raise
                    wait = _retry_after(msg)
                    rate_retries -= 1
                    yield {"type": "status", "message": f"Provider rate-limited; retrying in {wait}s..."}
                    await asyncio.sleep(wait)

            if not drafts:
                break

            tool_calls = [drafts[i] for i in sorted(drafts)]
            # feed the tool round trip back into the conversation
            assistant_msg: dict[str, Any] = {"role": "assistant", "content": None}
            tool_msgs: list[dict[str, Any]] = []
            for pos, tc in enumerate(tool_calls):
                call_id = tc["id"] or f"call_{len(tool_msgs)}"
                fn = {"name": tc["name"], "arguments": tc["arguments"] or "{}"}
                tc_entry: dict[str, Any] = {"id": call_id, "type": "function", "function": fn}
                # Gemini 3.x requires the model's thought_signature to be echoed
                # back on the first tool call of the turn (extra_content on the
                # OpenAI-compatible stream). Validation only covers the current turn.
                if pos == 0 and tc.get("extra_content"):
                    tc_entry["extra_content"] = tc["extra_content"]
                assistant_msg.setdefault("tool_calls", []).append(tc_entry)
                try:
                    args = json.loads(tc["arguments"] or "{}")
                    if not isinstance(args, dict):
                        args = {}
                except json.JSONDecodeError:
                    args = {}
                yield {"type": "tool_call", "id": call_id, "name": tc["name"], "arguments": args}
                result = registry.call(tc["name"], args)
                if len(result) > MAX_TOOL_RESULT_CHARS:
                    result = result[:MAX_TOOL_RESULT_CHARS] + "\n...[truncated]"
                yield {"type": "tool_result", "id": call_id, "name": tc["name"], "result": result}
                tool_msgs.append({"role": "tool", "tool_call_id": call_id, "content": result})

            messages.append(assistant_msg)
            messages.extend(tool_msgs)

        if not accumulated_text.strip():
            accumulated_text = "(no text output from the model)"
            yield {"type": "text", "text": accumulated_text}

        append_message(session_id, "assistant", accumulated_text)
        yield {"type": "done", "content": accumulated_text}
    except LLMError as e:
        yield {"type": "error", "message": str(e)}
    except Exception as e:  # noqa: BLE001
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}