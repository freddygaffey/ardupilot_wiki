"""
DEMO ONLY. Delete this file once the wiki is served from ardupilot.org.

Pages cross-reference each other by absolute URL: the About wiki's sidebar
links to every other wiki as https://ardupilot.org/<wiki>/, and body text does
the same for cross-wiki references. Served from ardupilot.org that is correct
and costs nothing, because the links are same-origin and the service worker
answers them from the cache.

Served from anywhere else, which is what a demo is, every one of those links
walks the reader off the demo and onto the live site mid-browse. A service
worker cannot intercept it either: a top-level navigation to another origin is
never handed to one.

So this rewrites them to root-relative in a built copy of the site, which
resolves correctly wherever that copy is served from, including ardupilot.org
itself. It runs over the deploy directory rather than the build output, so
nothing in the wiki sources or the normal build is affected.

    python3 scripts/demo_localise_links.py <deploy-dir>

Only paths belonging to a wiki that is present are touched. ardupilot.org/shop,
the Discord invite, the forum and the firmware server are all left alone, as is
anything on a subdomain.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_offline_artifacts import SITE_LINK_RE  # noqa: E402


def localise(root: Path):
    wikis = {p.name for p in root.iterdir()
             if p.is_dir() and (p / "index.html").is_file()}
    if not wikis:
        print("no built wikis found in " + str(root))
        return 0, 0

    def swap(m):
        attr, path = m.group(1), m.group(2)
        if path.lstrip("/").split("/")[0] not in wikis:
            return m.group(0)
        return f'{attr}="{path}"'

    changed = links = 0
    for page in root.rglob("*.html"):
        html = page.read_text(encoding="utf-8", errors="replace")
        out, n = SITE_LINK_RE.subn(swap, html)
        if n and out != html:
            page.write_text(out, encoding="utf-8")
            changed += 1
            links += n
    return changed, links


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    target = Path(sys.argv[1])
    if not target.is_dir():
        sys.exit(f"not a directory: {target}")
    pages, links = localise(target)
    print(f"[demo_localise_links]: rewrote {links} links across {pages} pages")
