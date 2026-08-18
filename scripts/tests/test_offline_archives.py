#!/usr/bin/env python3
"""
Check what a reader actually receives, by reading the archives themselves.

    python3 scripts/tests/test_offline_archives.py [wiki ...]

Everything else tests the code that builds the archives. This tests the bytes
that come out, which is the only thing a reader ever sees. Run it after
`update.py --offline`.

It exists because of the donate button. The sidebar's donate control is an
<input type="image"> sourced from paypalobjects.com, and it is on every page.
Offline that image cannot load, and a broken input renders as a small grey box
with its alt text never shown, so the control reads as nothing at all.

That markup comes from sphinx_rtd_theme, a different repository. We rewrite it
on the way into the archive, which works but is a regular expression over
someone else's HTML: if the theme changes that markup, the rewrite silently
stops matching and the reader gets the grey box back. This turns that into a
failed build instead.
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
    """
    Wherever the offline page went, its assets must have gone too.

    The page carries a copywiki marker naming all eleven wikis. Its stylesheet
    is copied to every wiki unconditionally; its scripts are routed by a marker
    of their own and, without one, reach DEFAULT_COPY_WIKIS - four of the
    eleven. So the panel would have been scriptless on seven wikis while
    looking perfectly correct on the four anyone would think to check.

    Rather than assert a hardcoded list, which would be the same mistake in a
    different file, derive it: find every wiki that has the page, then require
    the assets beside it. If the page moves, this moves with it.
    """
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
    """
    Every archive must hold the CURRENT panel scripts, not last build's.

    This is B7, and it has bitten twice. The panel's JavaScript lives in
    common/source/_static and reaches an archive by a three-step journey:
    copy_common_source_files() puts it in <wiki>/source/_static, Sphinx copies
    that to <wiki>/build/html/_static, and only then does the archive writer
    pack it. Break the chain anywhere and the archives ship a stale panel while
    the live site serves the current one.

    Nothing reported it either time. The site worked, because the live site
    reads from disk. Only a reader who had SAVED a wiki got the old panel, and
    only offline, which is the one place nobody was looking. The first
    occurrence had the compressing unpacker not running at all: 0 of 119
    entries compressed, found by accident.

    Two distinct failures, so two checks:

      1. archive vs built tree - the archive was packed before the build
         finished, or was not repacked at all. Exact byte comparison.
      2. built tree vs source - the source was edited and no build was run, so
         BOTH the site and the archives are stale. The marker has to be
         normalised here because copy_common_source_files strips the
         [copywiki ...] shortcode on the way through (update.py:731).
    """
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
        # A sample rather than every page: the donate control is in the sidebar
        # of all of them, so a few hundred is conclusive and stays quick.
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

    check("archives were present to test", checked > 0,
          f"{checked} wikis" if checked else "run update.py --offline first")

    print("\n" + (f"{failures} CHECK(S) FAILED\n" if failures else "all checks passed\n"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
