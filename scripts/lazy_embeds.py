"""Add loading="lazy" to the YouTube iframes in the built HTML.

An embed is a cross-origin connection and about a megabyte of YouTube's code,
started during initial load (511 ms against 4 ms for the page). The extension
that emits them is third-party, so this is a pass over the output. Idempotent.
"""

import os
import re
from pathlib import Path

# An iframe whose src is YouTube and which has no loading= attribute yet.
EMBED = re.compile(
    r'<iframe(?![^>]*\bloading=)([^>]*\bsrc="https://(?:www\.)?youtube(?:-nocookie)?\.com/[^"]*"[^>]*)>',
    re.IGNORECASE,
)


def make_embeds_lazy(html: str) -> str:
    """Add loading="lazy" to any YouTube iframe that does not set it."""
    return EMBED.sub(r'<iframe loading="lazy"\1>', html)


def run(wikis, root: Path = Path(".")) -> int:
    """Rewrite every built page in place. Returns the number of pages changed."""
    changed = 0
    for wiki in wikis:
        html_root = Path(root) / wiki / "build" / "html"
        if not html_root.is_dir():
            continue
        for page in html_root.rglob("*.html"):
            try:
                before = page.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            after = make_embeds_lazy(before)
            if after != before:
                _write_atomic(page, after)
                changed += 1
    return changed


def _write_atomic(page: Path, text: str) -> None:
    """Write a sibling temp file and rename it over the page, so an interrupted
    build never leaves a truncated page to be packed and served."""
    tmp = page.with_name(page.name + ".lazytmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, page)
