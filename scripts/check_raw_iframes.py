#!/usr/bin/env python3
"""Check that video embeds use the youtube or vimeo directive, not a raw <iframe>.

The lazy_youtube extension makes every ``.. youtube::`` and ``.. vimeo::``
embed load lazily. A video iframe pasted into a ``.. raw:: html`` block
bypasses it::

    .. Bad:
       .. raw:: html

          <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>

    .. Good:
       .. youtube:: dQw4w9WgXcQ

Iframes of anything else are allowed, and so is a raw block shown as an
example inside a literal or code block.
"""

import argparse
import pathlib
import re
import sys

RAW_HTML_RE = re.compile(r"^(\s*)\.\.\s+raw::\s+html\s*$")
CODE_RE = re.compile(r"^\.\.\s+(?:code|code-block|parsed-literal)::")
VIDEO_RE = re.compile(
    r"<iframe[^>]*\b(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com|peertube)", re.IGNORECASE)


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())


def opens_literal(line: str) -> bool:
    """A paragraph ending in :: or a code directive: its body is shown, not built."""
    text = line.strip()
    if text.startswith(".. "):
        return bool(CODE_RE.match(text))
    return text.endswith("::")


def raw_iframes(path: pathlib.Path):
    """Yield (line number, line) for every video <iframe> in a built raw html block."""
    skip = None   # indent of the literal or code block being skipped
    raw = None    # indent of the raw html block being scanned
    for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        blank = not line.strip()
        if skip is not None:
            if blank or indent_of(line) > skip:
                continue
            skip = None
        if raw is not None:
            if blank or indent_of(line) > raw:
                if VIDEO_RE.search(line):
                    yield number, line.strip()
                continue
            raw = None
        match = RAW_HTML_RE.match(line)
        if match:
            raw = len(match.group(1))
        elif opens_literal(line):
            skip = indent_of(line)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", type=pathlib.Path)
    args = parser.parse_args()

    failures = 0
    for path in args.files:
        for number, line in raw_iframes(path):
            failures += 1
            print(f"{path}:{number}: video <iframe> in a raw html block; "
                  "use the youtube or vimeo directive")
            print(f"    {line[:100]}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
