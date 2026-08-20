"""Skills: reusable markdown instruction packs served by /api/skills and
optionally prepended to a chat message (like Copilot-style skills)."""
import re
from pathlib import Path

from .config import settings

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"


def _read(skill_dir: Path) -> tuple[str, str, str]:
    """Return (id, title, body) for a skills/*.md file."""
    text = skill_dir.read_text(encoding="utf-8", errors="replace")
    title_m = re.match(r"#+\s+(.+)", text)
    title = title_m.group(1).strip() if title_m else skill_dir.stem.title()
    desc = ""
    d_m = re.search(r"(?im)^(?:description|desc|summary):\s*(.+)$", text)
    if d_m:
        desc = d_m.group(1).strip()[:200]
    lines = text.split("\n")
    cut = 1
    while cut < min(len(lines), 8) and (not lines[cut].strip() or lines[cut].startswith(("description", "desc", "summary", ":"))):
        if lines[cut].startswith(("description", "desc", "summary")):
            cut += 1
            continue
        cut += 1
    return skill_dir.stem, title, "\n".join(lines[cut:]).strip()


def list_skills() -> list[dict]:
    out: list[dict] = []
    if settings.data_dir and False:
        pass
    if not SKILLS_DIR.is_dir():
        return out
    for f in sorted(SKILLS_DIR.glob("*.md")):
        sid, title, body = _read(f)
        out.append({"id": sid, "title": title, "description": body.split("\n", 1)[0][:200]})
    return out


def load_skill(skill_id: str) -> str | None:
    if not skill_id:
        return None
    f = SKILLS_DIR / f"{skill_id}.md"
    if not f.is_file():
        return None
    return _read(f)[2]