"""
Assemble one self-contained HTML file for a wiki from its built HTML output.

The file has no external dependencies: stylesheets and images are inlined, so
it can be downloaded once, opened from disk over file:// and bookmarked. It
needs no network and no service worker.

It is built from the output of the normal html builder rather than by running
Sphinx's singlehtml builder. Running Sphinx a second time would reparse every
.rst and roughly double the build, whereas post-processing finished output
takes a fraction of that.

Output is written page by page rather than assembled in memory. A wiki with
several hundred megabytes of images produces a file large enough that holding
it as a single Python string, or in a parse tree, is the difference between
working and exhausting the build machine.

    python3 -m scripts.build_offline_html rover
"""

import base64
import mimetypes
import re
import sys
import time
from pathlib import Path

from bs4 import BeautifulSoup

CONTENT_SELECTORS = ["div[itemprop=articleBody]", "div.document"]

# Stylesheets worth inlining. The theme ships a handful of small files; fonts
# referenced from inside them are inlined too.
CSS_URL_RE = re.compile(r"""url\(\s*['"]?(?!data:|https?:|//)([^'")]+)['"]?\s*\)""")


def log(msg):
    print(f"[build_offline_html]: {msg}", flush=True)


def data_uri(path: Path):
    if not path.is_file():
        return None
    mime, _ = mimetypes.guess_type(path.name)
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime or 'application/octet-stream'};base64,{encoded}"


def anchor_for(rel_path: str) -> str:
    """Stable in-document id for a page, derived from its path."""
    slug = rel_path.replace("\\", "/").rsplit(".", 1)[0]
    return "ap-" + re.sub(r"[^A-Za-z0-9]+", "-", slug).strip("-").lower()


def collect_pages(html_root: Path):
    """index first, then every docs/ page in a stable order."""
    pages = []
    index = html_root / "index.html"
    if index.is_file():
        pages.append(index)
    docs = html_root / "docs"
    if docs.is_dir():
        pages.extend(sorted(docs.glob("*.html")))
    return pages


def inline_css(html_root: Path) -> str:
    """Concatenate the theme stylesheets with their url() references inlined."""
    parts = []
    css_dir = html_root / "_static"
    for css_path in sorted(css_dir.rglob("*.css")):
        text = css_path.read_text(encoding="utf-8", errors="replace")

        def replace(match):
            ref = match.group(1).split("?")[0].split("#")[0]
            uri = data_uri((css_path.parent / ref).resolve())
            return f"url({uri})" if uri else match.group(0)

        parts.append(CSS_URL_RE.sub(replace, text))
    return "\n".join(parts)


def page_title(soup) -> str:
    heading = soup.find(["h1", "h2"])
    if heading:
        # Sphinx appends a headerlink anchor to every heading; it is
        # meaningless in a table of contents.
        return heading.get_text(strip=True).replace("\u00b6", "").strip()
    if soup.title:
        return soup.title.get_text(strip=True)
    return "Untitled"


def process_page(path: Path, html_root: Path, known_anchors):
    """Return (title, content_html) for one page, with links and images fixed."""
    soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="replace"), "html.parser")

    content = None
    for selector in CONTENT_SELECTORS:
        found = soup.select(selector)
        if found:
            content = found[0]
            break
    if content is None:
        return None, None

    title = page_title(content) or path.stem

    # Images -> data URIs, resolved relative to the page.
    for img in content.find_all("img"):
        src = img.get("src")
        if not src or src.startswith(("data:", "http://", "https://", "//")):
            continue
        uri = data_uri((path.parent / src.split("?")[0]).resolve())
        if uri:
            img["src"] = uri
        if img.has_attr("srcset"):
            del img["srcset"]

    # Internal links -> in-document anchors. Links to pages that are not part of
    # this file are left alone so they still work when there is a connection.
    for a in content.find_all("a", href=True):
        href = a["href"]
        if href.startswith(("http://", "https://", "//", "mailto:", "#")):
            continue
        target = href.split("#")[0]
        if not target:
            continue
        try:
            resolved = (path.parent / target).resolve().relative_to(html_root.resolve())
        except ValueError:
            continue
        anchor = anchor_for(str(resolved))
        if anchor in known_anchors:
            a["href"] = "#" + anchor

    return title, str(content)


def build(wiki: str, out_path: Path = None) -> Path:
    html_root = Path(wiki) / "build" / "html"
    if not html_root.is_dir():
        raise SystemExit(f"{wiki}: no build output at {html_root} - build the wiki first")

    pages = collect_pages(html_root)
    if not pages:
        raise SystemExit(f"{wiki}: no pages found under {html_root}")

    known_anchors = {
        anchor_for(str(p.relative_to(html_root))) for p in pages
    }

    if out_path is None:
        out_dir = html_root / "offline"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{wiki}-wiki-offline.html"

    built = time.strftime("%Y-%m-%d")
    log(f"{wiki}: assembling {len(pages)} pages")

    css = inline_css(html_root)

    with out_path.open("w", encoding="utf-8") as out:
        out.write(
            "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n"
            "<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            f"<title>ArduPilot {wiki} wiki (offline)</title>\n"
            "<style>\n" + css + "\n"
            ".ap-page{border-top:1px solid #e1e4e5;padding-top:24px;margin-top:40px}"
            ".wy-nav-content{max-width:900px}"
            "img{max-width:100%;height:auto}"
            "</style>\n</head>\n"
            # The theme's stylesheet targets this wrapper structure. Emitting the
            # bare article body instead leaves nearly all of the inlined CSS
            # matching nothing, which is why the page renders unstyled.
            "<body class=\"wy-body-for-nav\">\n"
            "<div class=\"wy-grid-for-nav\">\n"
            "<section class=\"wy-nav-content-wrap\">\n"
            "<div class=\"wy-nav-content\">\n"
            "<div class=\"rst-content\">\n"
        )

        # An inert header. This file cannot update itself and never contacts a
        # server, so it states what it is and leaves checking to the reader.
        out.write(
            "<div style=\"background:#2980b9;color:#fff;padding:10px 16px;font-size:14px\">"
            f"Offline copy of the ArduPilot <strong>{wiki}</strong> wiki &mdash; built "
            f"<strong>{built}</strong>. Self-contained; it does not update itself. "
            "<a href=\"https://ardupilot.org/\" style=\"color:#fff\">Check online for a "
            "newer version</a>.</div>\n"
        )

        out.write("<h1>Contents</h1>\n<ul>\n")
        titles = []
        for page in pages:
            rel = str(page.relative_to(html_root))
            soup = BeautifulSoup(page.read_text(encoding="utf-8", errors="replace"), "html.parser")
            content = None
            for selector in CONTENT_SELECTORS:
                found = soup.select(selector)
                if found:
                    content = found[0]
                    break
            title = page_title(content) if content else page.stem
            titles.append(title)
            out.write(f"<li><a href=\"#{anchor_for(rel)}\">{title}</a></li>\n")
        out.write("</ul>\n")

        for index, page in enumerate(pages):
            rel = str(page.relative_to(html_root))
            title, html = process_page(page, html_root, known_anchors)
            if html is None:
                log(f"  skipped (no content container): {rel}")
                continue
            out.write(f"<div class=\"ap-page\" id=\"{anchor_for(rel)}\">\n")
            out.write(html)
            out.write("\n</div>\n")
            if (index + 1) % 100 == 0:
                log(f"  {index + 1}/{len(pages)} pages")

        out.write("</div>\n</div>\n</section>\n</div>\n</body>\n</html>\n")

    size_mb = out_path.stat().st_size / 1048576
    log(f"{wiki}: wrote {out_path} ({size_mb:.0f} MB)")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    build(sys.argv[1])
