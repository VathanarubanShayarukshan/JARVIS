import html
import re
from urllib.parse import quote_plus

import httpx

TIMEOUT = httpx.Timeout(30.0, connect=8.0)


def _tool(fn):
    fn._tool = _describe(fn)
    return fn


def _describe(fn):
    import inspect

    sig = inspect.signature(fn)
    props: dict[str, object] = {}
    required: list[str] = []
    for pname, param in sig.parameters.items():
        if pname == "return":
            continue
        props[pname] = {"type": "string", "description": ""}
        if param.default is inspect.Parameter.empty:
            required.append(pname)
    return {
        "type": "function",
        "function": {
            "name": fn.__name__,
            "description": (fn.__doc__ or "").strip() or "...",
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


def _strip_html(raw: str, max_chars: int = 60000) -> str:
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", raw, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_chars]


@_tool
def fetch_url(url: str, max_chars: int = 60000) -> dict:
    """Fetch a web page or raw endpoint and return its text content
    (HTML is stripped to readable text). Use to read public docs, pages, APIs."""
    try:
        with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
            r = client.get(url, headers={"User-Agent": "Mozilla/5.0 jarvis"})
            if r.status_code >= 400:
                return {"url": url, "status": r.status_code, "error": r.text[:500]}
            ctype = r.headers.get("content-type", "")
            if "html" in ctype or "<html" in r.text[:500].lower():
                return {"url": url, "status": r.status_code, "text": _strip_html(r.text, max_chars)}
            return {
                "url": url,
                "status": r.status_code,
                "content_type": ctype,
                "text": r.text[:max_chars],
            }
    except Exception as e:  # noqa: BLE001
        return {"url": url, "error": f"{type(e).__name__}: {e}"}


@_tool
def web_search(query: str, max_results: int = 5) -> dict:
    """Search the web (DuckDuckGo HTML, loginless) and return result titles,
    URLs and snippets."""
    try:
        with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
            r = client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
                headers={"User-Agent": "Mozilla/5.0 jarvis"},
            )
            if r.status_code != 200:
                return {"query": query, "error": f"search failed: HTTP {r.status_code}"}
            results = _parse_ddg(r.text)
            return {"query": query, "results": results[: max(1, min(max_results, 10))]}
    except Exception as e:  # noqa: BLE001
        return {"query": query, "error": f"{type(e).__name__}: {e}"}


def _parse_ddg(html_text: str) -> list[dict]:
    blocks = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>',
        html_text,
        flags=re.S,
    )
    results = []
    for href, title, snippet in blocks[:12]:
        if href.startswith("//duckduckgo.com/l/?uddg="):
            href = _unquote_redirect(href)
        results.append(
            {
                "title": _strip_html(title, 300),
                "url": href,
                "snippet": _strip_html(snippet, 600),
            }
        )
    if not results:
        titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', html_text, flags=re.S)
        snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html_text, flags=re.S)
        for i, t in enumerate(titles[:12]):
            results.append(
                {
                    "title": _strip_html(t, 300),
                    "url": "",
                    "snippet": _strip_html(snips[i], 600) if i < len(snips) else "",
                }
            )
    return results


def _unquote_redirect(href: str) -> str:
    m = re.search(r"uddg=([^&]+)", href)
    if m:
        try:
            from urllib.parse import unquote

            return unquote(m.group(1))
        except Exception:
            return href
    return href