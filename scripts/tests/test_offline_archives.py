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

    check("archives were present to test", checked > 0,
          f"{checked} wikis" if checked else "run update.py --offline first")

    print("\n" + (f"{failures} CHECK(S) FAILED\n" if failures else "all checks passed\n"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
