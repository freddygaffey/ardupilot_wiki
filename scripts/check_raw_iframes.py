#!/usr/bin/env python3
"""Check that video embeds use the youtube directive, not a raw <iframe>.

The lazy_youtube extension makes every ``.. youtube::`` embed load lazily. A
raw iframe pasted into a ``.. raw:: html`` block bypasses it::

    .. Bad:
       .. raw:: html

          <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>

    .. Good:
       .. youtube:: dQw4w9WgXcQ
"""

import argparse
import pathlib
import re
import sys

RAW_HTML_RE = re.compile(r"^(\s*)\.\.\s+raw::\s+html\s*$")


def raw_iframes(path: pathlib.Path):
    """Yield (line number, line) for every <iframe> inside a raw html block."""
    indent = None
    for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if indent is None:
            match = RAW_HTML_RE.match(line)
            if match:
                indent = len(match.group(1))
            continue
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            indent = None  # the block ended; this line may open another
            if RAW_HTML_RE.match(line):
                indent = len(RAW_HTML_RE.match(line).group(1))
            continue
        if "<iframe" in line.lower():
            yield number, line.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", type=pathlib.Path)
    args = parser.parse_args()

    failures = 0
    for path in args.files:
        for number, line in raw_iframes(path):
            failures += 1
            print(f"{path}:{number}: raw <iframe> in a raw html block; use the youtube directive")
            print(f"    {line[:100]}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
