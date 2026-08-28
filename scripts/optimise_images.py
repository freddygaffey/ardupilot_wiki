"""
Re-deflate the wiki's PNGs losslessly, as a pass over the built output.

The wiki's images arrive from whatever tool each contributor happened to use,
and nothing in the build has ever re-deflated them. Redoing the deflate stream
at maximum effort recovers a useful amount for nothing: the pixels, dimensions,
colour mode and transparency are all unchanged, and only the compression of
those pixels is redone.

LOSSLESS, AND CHECKED RATHER THAN ASSUMED. Every recompressed image is decoded
again and compared with the original pixel for pixel before it is accepted. A
mismatch keeps the original. This is not a formality: the pass rewrites what
every reader receives, including pinout diagrams and wiring drawings where a
single altered pixel is a real defect, so the property is verified per image on
every build rather than argued for once in a review.

WHY LOSSLESS RATHER THAN SOMETHING WITH A BETTER RATIO. JPEG or WebP would save
considerably more, and both were measured: JPEG at q85 gives about 69% on these
files. But the saving is worst exactly where the risk is highest.
AEROFOX-H7_pinout.png is a 9,449px pinout diagram, deliberately large so its pin
labels stay readable when zoomed, and it gives back only 28% to JPEG while
gaining ringing along every hard edge. Resizing fails the same way, and Sphinx
links each thumbnail to the full-size file, so shrinking an original also
removes the zoomed view a reader gets by clicking. Re-encoding, resizing or a
format change is a different proposal with different trade-offs, and mixing it
in here would attach a contentious decision to an easy one.

WHY OVER THE BUILD OUTPUT RATHER THAN THE REPOSITORY. Committing recompressed
images churns the repository, has to be redone whenever anyone adds one, asks
contributors to remember something, and lands reviewers with a commit touching
thousands of binary files they can only take on trust. Git also keeps the old
blobs forever, so the repository grows rather than shrinks. Doing it here costs
nothing ongoing, covers every future image without anyone acting, and keeps the
originals exactly as their authors supplied them.

IT FAILS SAFE, ALWAYS RETURNING THE ORIGINAL BYTES. If Pillow is missing, if
anything raises, if the result is not actually smaller, or if the result is not
pixel-identical, the image is left exactly as the build produced it. A build
must never break, and no image must ever degrade, because a file could not be
recompressed.
"""

import hashlib
import io
import os
from pathlib import Path

# Where results are remembered between builds, relative to the repository root.
#
# The work is identical every time: the same image compresses to the same bytes,
# and a cold run over the wiki's distinct PNGs takes minutes. Sphinx re-copies
# images into _images/ on every build, so without a cache that cost is paid on
# every build forever. Keyed on the content of the input, so an edited or added
# image is recompressed and an untouched one is not, and no invalidation logic
# is needed. Safe to delete at any time; the next build simply refills it.
CACHE_DIR = ".image-cache"

# Sphinx copies content images here. Deliberately not _static/, which holds the
# theme's own assets: those are fingerprinted, already small, and belong to a
# separate package rather than to this repository.
IMAGE_DIR = "_images"


def _cache_path(root: Path, data: bytes) -> Path:
    return Path(root) / CACHE_DIR / (hashlib.sha256(data).hexdigest()[:32] + ".png")


def shrink_png(data: bytes) -> bytes:
    """
    Re-deflate a PNG at maximum effort.

    Returns the original bytes unless the result is both smaller and verified
    pixel-identical.
    """
    try:
        from PIL import Image
    except ImportError:
        return data

    try:
        with Image.open(io.BytesIO(data)) as im:
            im.load()
            mode, size = im.mode, im.size
            pixels = im.tobytes()
            out = io.BytesIO()
            im.save(out, format="PNG", optimize=True, compress_level=9)
        shrunk = out.getvalue()

        # Not smaller is a real outcome, not a failure: some contributors
        # already ran an optimiser, and some tools beat Pillow.
        if len(shrunk) >= len(data):
            return data

        # The check that makes this safe to run on every reader's images.
        with Image.open(io.BytesIO(shrunk)) as check:
            check.load()
            if (check.mode, check.size) != (mode, size):
                return data
            if check.tobytes() != pixels:
                return data

        return shrunk
    except Exception:
        # Truncated files, formats Pillow cannot open, images beyond its
        # decompression-bomb limit. None of them should stop a build.
        return data


def run(wikis, root: Path = Path(".")) -> tuple:
    """
    Recompress every built PNG in place.

    Returns (images_changed, bytes_saved).
    """
    root = Path(root)
    cache = root / CACHE_DIR
    try:
        cache.mkdir(parents=True, exist_ok=True)
    except OSError:
        cache = None

    changed = 0
    saved = 0
    for wiki in wikis:
        image_root = root / wiki / "build" / "html" / IMAGE_DIR
        if not image_root.is_dir():
            continue
        for image in sorted(image_root.rglob("*.png")):
            try:
                data = image.read_bytes()
            except OSError:
                continue

            best = None
            cached = _cache_path(root, data) if cache is not None else None
            if cached is not None and cached.is_file():
                try:
                    best = cached.read_bytes()
                except OSError:
                    best = None

            if best is None:
                best = shrink_png(data)
                if cached is not None:
                    try:
                        _write_atomic(cached, best)
                    except OSError:
                        pass

            if len(best) < len(data):
                _write_atomic(image, best)
                changed += 1
                saved += len(data) - len(best)

    return changed, saved


def _write_atomic(path: Path, data: bytes) -> None:
    """
    Replace a file's contents without ever leaving it half-written.

    A plain write truncates and then writes; an interruption in between (a full
    disk, a killed build) leaves a truncated image that is still served. Writing
    a sibling temp file and renaming it over the original means a reader sees
    either the whole old file or the whole new one, never a fragment: rename is
    atomic within a filesystem, and os.replace overwrites on every platform.
    """
    tmp = path.with_name(path.name + ".pngtmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
