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


def valid_id(skill_id: str) -> bool:
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", skill_id or ""))


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:60]
    return s or "skill"


def get_skill_content(skill_id: str) -> str | None:
    if not valid_id(skill_id):
        return None
    f = SKILLS_DIR / f"{skill_id}.md"
    if not f.is_file():
        return None
    return f.read_text(encoding="utf-8", errors="replace")


def save_skill(skill_id: str, content: str) -> None:
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    (SKILLS_DIR / f"{skill_id}.md").write_text(content, encoding="utf-8")


def delete_skill(skill_id: str) -> bool:
    if not valid_id(skill_id):
        return False
    f = SKILLS_DIR / f"{skill_id}.md"
    if not f.is_file():
        return False
    f.unlink()
    return True