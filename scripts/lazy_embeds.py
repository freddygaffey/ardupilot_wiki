"""
Make YouTube embeds load when they are needed, not on every page load.

sphinxcontrib.youtube renders `.. youtube:: <id>` as a bare <iframe>, and 646
pages across the wikis carry one. A YouTube embed is a cross-origin connection
and roughly a megabyte of YouTube's own code, and the browser starts all of that
during the initial load whether or not the reader ever plays the video.

Measured on the mirror, on a page served entirely from storage: the embed took
511 ms while the page's own document took 4 ms. It was, by a wide margin, the
slowest thing on the page.

loading="lazy" defers the whole embed until it is near the viewport. Nothing is
removed: the video is in the same place and plays the same way. The extension is
a third-party package, so this is done as a pass over the built HTML rather than
at the source.

Idempotent, and deliberately narrow: it only touches iframes that point at
YouTube and do not already say how they should load.
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
    """
    Replace a page's contents without ever leaving it half-written.

    A plain write_text truncates the file and then writes; an interruption in
    between (a full disk, a killed build) leaves a truncated or empty page that
    still gets packed into the archive and served. Writing a sibling temp file
    and renaming it over the original means a reader sees either the whole old
    page or the whole new one, never a fragment: rename is atomic within a
    filesystem, and os.replace overwrites on every platform.
    """
    tmp = page.with_name(page.name + ".lazytmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, page)
