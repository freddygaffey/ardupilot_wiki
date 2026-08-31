#!/usr/bin/env python3
"""Check what a reader receives, by reading the built archives themselves.

    python3 scripts/tests/test_offline_archives.py [wiki ...]

Run after a full update.py. The rewrites are regular expressions over the
theme's HTML, so a theme change would silently stop them matching.
"""

import re
import sys
import tarfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OFFLINE = REPO / "offline"

WIKIS = ["copter", "plane", "rover", "sub", "blimp", "dev",
         "antennatracker", "planner", "planner2", "ardupilot", "mavproxy"]

failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  PASS  " if ok else "  FAIL  ") + name + ("   " + detail if detail else ""))
    if not ok:
        failures += 1


def html_members(archive: Path, limit=None):
    """Yield (name, text) for HTML members, without unpacking to disk."""
    with tarfile.open(archive) as tar:
        seen = 0
        for member in tar:
            if not member.isfile() or not member.name.endswith(".html"):
                continue
            f = tar.extractfile(member)
            if f is None:
                continue
            yield member.name, f.read().decode("utf-8", "replace")
            seen += 1
            if limit and seen >= limit:
                return


def check_assets_follow_pages():
    """Wherever the offline page went, its assets must have gone too."""
    ASSETS = ["common_offline.css", "common_offline_page.js",
              "common_offline_export.js", "common_offline_document_builder.js",
              "common_offline_unpack.js",
              "common_offline_update.js"]
    have_page, missing = [], []

    for wiki in WIKIS:
        page = REPO / wiki / "build" / "html" / "docs" / "common-offline.html"
        if not page.is_file():
            continue
        have_page.append(wiki)
        for asset in ASSETS:
            if not (REPO / wiki / "build" / "html" / "_static" / asset).is_file():
                missing.append(f"{wiki}/{asset}")

    check("every wiki with the offline page has its assets",
          have_page and not missing,
          f"{len(missing)} missing, e.g. {missing[0]}" if missing
          else f"{len(have_page)} wikis, {len(ASSETS)} assets each")


def check_archives_carry_current_static():
    """Archives hold the current panel scripts: archive vs built tree, built
    tree vs source."""
    sys.path.insert(0, str(REPO / "scripts"))
    from build_offline_artifacts import content_hash
    import json

    source_dir = REPO / "common" / "source" / "_static"
    shared = sorted(source_dir.glob("common_offline*.js")) + \
             sorted(source_dir.glob("common_offline*.css"))
    if not shared:
        check("archives carry the current panel scripts", False,
              "no common_offline* assets in common/source/_static")
        return

    # 1. archive vs built tree
    stale_archive, checked = [], 0
    for wiki in WIKIS:
        table = OFFLINE / f"{wiki}-files.json"
        built_dir = REPO / wiki / "build" / "html" / "_static"
        if not table.is_file():
            continue          # folded into common, or not built
        entries = json.loads(table.read_text())
        for f in shared:
            key = f"{wiki}/_static/{f.name}"
            built = built_dir / f.name
            if key not in entries or not built.is_file():
                continue
            checked += 1
            if entries[key] != content_hash(built.read_bytes()):
                stale_archive.append(key)

    check("archives hold the same bytes as the built tree",
          not stale_archive,
          f"{len(stale_archive)} stale, e.g. {stale_archive[0]}"
          if stale_archive else f"{checked} asset copies match")

    # 2. built tree vs source, with the copywiki marker normalised out
    marker = re.compile(rb"\[copywiki.*?\]", re.MULTILINE)
    stale_build = []
    for wiki in WIKIS:
        built_dir = REPO / wiki / "build" / "html" / "_static"
        if not built_dir.is_dir():
            continue
        for f in shared:
            built = built_dir / f.name
            if not built.is_file():
                continue
            if marker.sub(b"", f.read_bytes()).strip() != \
               marker.sub(b"", built.read_bytes()).strip():
                stale_build.append(f"{wiki}/_static/{f.name}")

    check("the built tree holds the current source, so a build was not skipped",
          not stale_build,
          f"{len(stale_build)} stale, e.g. {stale_build[0]}"
          if stale_build else f"{len(shared)} assets across the built wikis")


def check_no_dangling_assets():
    """No built page references a local script or stylesheet that is not there."""
    ref = re.compile(rb'(?:src|href)="([^"]+\.(?:js|css))"')
    # No browser loads the theme's IE conditional comments.
    ie_only = re.compile(rb"<!--\[if[^>]*>.*?<!\[endif\]-->", re.S)
    missing, checked = {}, 0
    for wiki in WIKIS:
        root = REPO / wiki / "build" / "html"
        if not root.is_dir():
            continue
        seen = set()
        for page in root.rglob("*.html"):
            for m in ref.finditer(ie_only.sub(b"", page.read_bytes())):
                url = m.group(1).decode("utf-8", "replace")
                # Local references only.
                if url.startswith(("http://", "https://", "//", "data:")):
                    continue
                seen.add((url.split("?")[0], page))
        for url, page in seen:
            # Root-relative URLs resolve against frontend/, the deployed webroot.
            base = (REPO / "frontend") if url.startswith("/") else page.parent
            target = base / url.lstrip("/")
            checked += 1
            if not target.exists():
                missing.setdefault(url, page.relative_to(REPO).as_posix())

    # Known upstream faults (KNOWN_UPSTREAM_ISSUES.md), allowed but reported.
    known = {u for u in missing if u.endswith("useralerts.js")}   # issue 9
    ours = {u: p for u, p in missing.items() if u not in known}

    check("no built page references a script or stylesheet that is missing",
          not ours,
          "; ".join(f"{u} (e.g. {p})" for u, p in list(ours.items())[:3])
          or f"{checked} references resolve"
             + (f", plus {len(known)} known upstream "
                f"(KNOWN_UPSTREAM_ISSUES.md)" if known else ""))


def main():
    wikis = [w for w in (sys.argv[1:] or WIKIS)]
    print("\noffline archives: what the reader receives\n")

    checked = 0
    for wiki in wikis:
        archive = OFFLINE / f"{wiki}-offline.tar.gz"
        if not archive.is_file():
            continue

        remote_donate = []
        local_donate = 0
        pages = 0
        # A sample: the control is in every sidebar.
        for name, html in html_members(archive, limit=200):
            pages += 1
            if "paypalobjects" in html:
                remote_donate.append(name)
            if 'href="https://ardupilot.org/donate"' in html and ">Donate</a>" in html:
                local_donate += 1

        if not pages:
            continue
        checked += 1

        check(f"{wiki}: no page ships a remote donate image",
              not remote_donate,
              f"{len(remote_donate)} of {pages} still reference paypalobjects"
              if remote_donate else f"{pages} pages sampled")

        check(f"{wiki}: the donate control survives as a link",
              local_donate > 0,
              f"{local_donate} of {pages} pages")

    check_assets_follow_pages()
    check_archives_carry_current_static()
    check_no_dangling_assets()

    check("archives were present to test", checked > 0,
          f"{checked} wikis" if checked else "run a full update.py first")

    print("\n" + (f"{failures} CHECK(S) FAILED\n" if failures else "all checks passed\n"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
