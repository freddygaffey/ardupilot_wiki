#!/usr/bin/env python3
"""
Tests for the lossless PNG pass (scripts/optimise_images).

    python3 scripts/tests/test_optimise_images.py

This pass rewrites images that every reader receives, so the checks that matter
most are the ones about what it must NOT do: never alter a pixel, never grow a
file, never touch anything that is not a PNG, and never raise no matter what it
is handed. The saving is the easy part.
"""
import io
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import scripts.optimise_images as oi  # noqa: E402

failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  PASS  " if ok else "  FAIL  ") + name + (f"   {detail}" if detail else ""))
    if not ok:
        failures += 1


def noisy_png(w=240, h=180):
    """
    A PNG that Pillow's default writer leaves room to improve on.

    Written with compress_level=1, which is what "straight out of a tool"
    effectively looks like: valid, but never re-deflated.
    """
    from PIL import Image
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256)
    out = io.BytesIO()
    im.save(out, "PNG", compress_level=1)
    return out.getvalue()


def pixels(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as im:
        im.load()
        return im.mode, im.size, im.tobytes()


def main():
    print("\nlossless PNG pass\n")

    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        print("  Pillow is not installed; this suite cannot verify anything.")
        print("  pip install Pillow\n")
        sys.exit(1)

    # --- the core property: smaller, and not one pixel different -------------
    original = noisy_png()
    shrunk = oi.shrink_png(original)

    check("a never-optimised PNG gets smaller",
          len(shrunk) < len(original),
          f"{len(original)} -> {len(shrunk)}")
    check("and decodes to exactly the same pixels",
          pixels(shrunk) == pixels(original))
    check("and is still a PNG",
          shrunk[:8] == b"\x89PNG\r\n\x1a\n")

    # --- transparency is a common way to lose data silently -----------------
    from PIL import Image
    out = io.BytesIO()
    rgba = Image.new("RGBA", (64, 64), (255, 0, 0, 0))
    for i in range(64):
        rgba.putpixel((i, i), (0, 255, 0, 128))
    rgba.save(out, "PNG", compress_level=1)
    tp = out.getvalue()
    check("an image with an alpha channel keeps every pixel",
          pixels(oi.shrink_png(tp)) == pixels(tp))

    # --- a palette image must not be silently promoted to RGB ---------------
    out = io.BytesIO()
    Image.new("P", (64, 64)).save(out, "PNG", compress_level=1)
    pal = out.getvalue()
    check("a palette image keeps its mode",
          pixels(oi.shrink_png(pal))[0] == "P")

    # --- already optimal ----------------------------------------------------
    best = oi.shrink_png(noisy_png())
    check("re-running on the result returns it unchanged",
          oi.shrink_png(best) == best)

    # --- fails safe ---------------------------------------------------------
    check("garbage bytes come back untouched, no exception",
          oi.shrink_png(b"not an image at all") == b"not an image at all")
    check("a truncated PNG comes back untouched",
          oi.shrink_png(original[:40]) == original[:40])
    check("empty input comes back untouched",
          oi.shrink_png(b"") == b"")

    # --- without Pillow it is a no-op, not a failure -------------------------
    import builtins
    real_import = builtins.__import__

    def no_pillow(name, *a, **k):
        if name.startswith("PIL"):
            raise ImportError("no Pillow")
        return real_import(name, *a, **k)

    builtins.__import__ = no_pillow
    try:
        check("with Pillow unavailable the original is returned",
              oi.shrink_png(original) == original)
    finally:
        builtins.__import__ = real_import

    # --- the pass over a built tree -----------------------------------------
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        images = root / "rover" / "build" / "html" / "_images"
        images.mkdir(parents=True)
        (images / "diagram.png").write_bytes(original)
        (images / "photo.jpg").write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")
        (images / "broken.png").write_bytes(b"\x89PNG\r\n\x1a\n truncated")
        before_jpg = (images / "photo.jpg").read_bytes()
        before_broken = (images / "broken.png").read_bytes()

        changed, saved = oi.run(["rover"], root)

        check("the built PNG was rewritten smaller",
              changed == 1 and saved > 0,
              f"{changed} changed, {saved} bytes saved")
        check("the rewritten file is pixel-identical to what it replaced",
              pixels((images / "diagram.png").read_bytes()) == pixels(original))
        check("a non-PNG is not touched",
              (images / "photo.jpg").read_bytes() == before_jpg)
        check("an unreadable PNG is left exactly as it was",
              (images / "broken.png").read_bytes() == before_broken)
        check("no temp files are left behind",
              not list(images.glob("*.pngtmp")))

        # --- idempotence and the cache --------------------------------------
        after_first = (images / "diagram.png").read_bytes()
        changed2, saved2 = oi.run(["rover"], root)
        check("a second pass changes nothing",
              changed2 == 0 and saved2 == 0,
              f"{changed2} changed")
        check("and leaves the bytes identical",
              (images / "diagram.png").read_bytes() == after_first)

        cached = list((root / oi.CACHE_DIR).glob("*.png"))
        check("results were cached for the next build",
              len(cached) >= 1, f"{len(cached)} entries")

        # Restore the unoptimised file and prove the cache answers for it.
        (images / "diagram.png").write_bytes(original)
        changed3, _ = oi.run(["rover"], root)
        check("a restored original is served from the cache",
              changed3 == 1
              and (images / "diagram.png").read_bytes() == after_first)

        # --- a wiki that was not built is simply skipped --------------------
        c, s = oi.run(["copter"], root)
        check("a wiki with no build output is skipped quietly",
              (c, s) == (0, 0))

        # --- an unwritable cache must not stop the pass ---------------------
        (images / "diagram.png").write_bytes(original)
        cache_dir = root / oi.CACHE_DIR
        mode = cache_dir.stat().st_mode
        os.chmod(cache_dir, 0o500)
        try:
            c4, _ = oi.run(["rover"], root)
            check("a read-only cache does not stop the pass",
                  c4 == 1
                  and pixels((images / "diagram.png").read_bytes())
                  == pixels(original))
        finally:
            os.chmod(cache_dir, mode)

    print()
    if failures:
        print(f"{failures} CHECK(S) FAILED\n")
        sys.exit(1)
    print("all checks passed\n")


if __name__ == "__main__":
    main()
