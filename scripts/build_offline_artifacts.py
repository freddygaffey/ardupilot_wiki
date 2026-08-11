"""
Generate the offline artefacts and their manifest after a wiki build.

Called from update.py once Sphinx has produced html output, so a maintainer runs
nothing extra: an ordinary build publishes the offline copies as a side effect.

What it writes, into <destdir>/offline/:

    offline-manifest.json    sizes, page counts and build id; the /offline/ page
                             renders itself from this, so the numbers track the
                             wiki automatically instead of being hardcoded
    common-offline.tar.gz    images and pages shared by two or more wikis
    <wiki>-offline.tar.gz    everything unique to one wiki

Splitting common from per-wiki matters at this scale: the shared images are
around 455 MB and every wiki references most of them. Bundling them per wiki
would store and serve that repeatedly, where splitting means it is downloaded
once however many vehicles somebody keeps.
"""

import gzip
import hashlib
import io
import json
import os
import re
import tarfile
import time
import urllib.error
import urllib.request
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

# gzip level 1: the payload is mostly PNG and JPEG, which are already
# compressed. Higher levels cost significant build time for a percent or two.
GZIP_LEVEL = 1

# Public base URL the archives are served from, written into the manifest so the
# /offline/ page does not have to hardcode it. Set this in the build environment
# rather than editing the page:
#
#     ARDUPILOT_OFFLINE_BASE=https://offline.ardupilot.org python3 update.py --offline
#
# Left unset, the page falls back to its built-in default.
ARTIFACT_BASE_ENV = "ARDUPILOT_OFFLINE_BASE"

# Downsize large images in the archives (only), to attack the first-download
# barrier: the shared-image set is ~440 MB and is required before any wiki is
# readable. Set ARDUPILOT_OFFLINE_MAX_IMAGE_DIM to a pixel size (1600 is a good
# retina-friendly default) to resize anything larger and re-encode it. Measured
# on a real sample: 174 MB of large images fell to 34 MB, an 80% cut (JPEG 94%,
# PNG 62%). Off by default (0), because it changes what a reader sees online
# too - saved images are served cache-first - so it is a quality call, not a
# silent default. The LIVE site is never touched; only the archive copies.
IMAGE_MAX_DIM = int(os.environ.get("ARDUPILOT_OFFLINE_MAX_IMAGE_DIM", "0"))

# The manifest overrides the names the offline page falls back to, so these
# have to be the real ones. Capitalising the directory gave "Dev", "Planner2"
# and "Ardupilot", which read as though they were not proper platforms.
DISPLAY_NAMES = {
    "copter": "Copter",
    "plane": "Plane",
    "rover": "Rover",
    "sub": "Sub",
    "blimp": "Blimp",
    "dev": "Developer",
    "antennatracker": "Antenna Tracker",
    "planner": "Mission Planner",
    "planner2": "APM Planner 2",
    "ardupilot": "About",
    "mavproxy": "MAVProxy",
}


def _normalise(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """
    Strip everything that varies between builds without the content changing.

    Sphinx rewrites every output file on every run, so real mtimes would make
    each archive byte-different even when nothing was edited. That would push
    the full set of archives over the wire on every deploy. Normalising means an
    unchanged wiki produces an identical archive, and rsync skips it.
    """
    info.mtime = 0
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mode = 0o644 if not info.isdir() else 0o755
    return info


@contextmanager
def reproducible_tar(path: Path):
    """tar.gz writer whose output depends only on the files' contents."""
    # gzip stores a timestamp in its header too, hence mtime=0 here as well.
    with open(path, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb",
                           compresslevel=GZIP_LEVEL, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w") as tar:
                yield tar


def log(msg):
    print(f"[build_offline_artifacts]: {msg}", flush=True)


def classify_images(wikis):
    """
    Split every built image into 'shared by 2+ wikis' and 'unique to one'.

    Returns (common_names, per_wiki_names).
    """
    owners = defaultdict(set)
    for wiki in wikis:
        images = Path(wiki) / "build" / "html" / "_images"
        if not images.is_dir():
            continue
        for path in images.iterdir():
            if path.is_file():
                owners[path.name].add(wiki)

    common = {name for name, who in owners.items() if len(who) > 1}
    per_wiki = defaultdict(set)
    for name, who in owners.items():
        if len(who) == 1:
            per_wiki[next(iter(who))].add(name)
    return common, per_wiki


EMBED_RE = re.compile(
    r'<div class="video_wrapper"[^>]*>\s*'
    r'<iframe[^>]*src="https?://(?:www\.)?youtube\.com/embed/'
    r'([A-Za-z0-9_-]+)[^"]*"[^>]*>\s*</iframe>\s*</div>',
    re.IGNORECASE)

THUMB_URL = "https://img.youtube.com/vi/{}/hqdefault.jpg"


def video_ids(wikis):
    """Every YouTube id embedded anywhere in the built output."""
    ids = set()
    for wiki in wikis:
        root = Path(wiki) / "build" / "html"
        if not root.is_dir():
            continue
        for page in root.rglob("*.html"):
            ids.update(EMBED_RE.findall(
                page.read_text(encoding="utf-8", errors="replace")))
    return ids


def fetch_thumbnails(ids, cache: Path):
    """
    Download a still for each video, once, into a build cache.

    An embedded player cannot work offline, and will not work from a file://
    document even online: YouTube rejects the request for want of an origin.
    A still and a link are what is actually usable, and at roughly 17 KB each
    they are a rounding error against the images already being shipped.

    Missing downloads are not fatal. The build has to work without a network,
    and a card with no still is still a working link.
    """
    cache.mkdir(parents=True, exist_ok=True)
    have, failed = {}, []
    for vid in sorted(ids):
        path = cache / f"{vid}.jpg"
        if not path.is_file():
            try:
                with urllib.request.urlopen(THUMB_URL.format(vid), timeout=15) as r:
                    data = r.read()
                if not data:
                    raise ValueError("empty")
                path.write_bytes(data)
            except (urllib.error.URLError, OSError, ValueError):
                failed.append(vid)
                continue
        have[vid] = path
    if failed:
        # Nearly always a video that has been deleted or made private, which
        # means the wiki is linking to something nobody can watch. Worth naming
        # rather than counting: it is the only place that shows up.
        log(f"  no still for {len(failed)} video(s), so those cards link "
            f"without one. Usually deleted or private:")
        for vid in failed:
            log(f"    https://www.youtube.com/watch?v={vid}")
    return have


def video_card(vid: str, wiki: str, has_thumb: bool) -> str:
    """
    Replacement for an embed: a still that links to the video.

    Styled inline because this markup is read with two different stylesheets,
    a cached wiki page and the single-file export, and inline is the only
    thing both are guaranteed to honour.
    """
    link = f"https://www.youtube.com/watch?v={vid}"
    label = ("&#9654; Watch on YouTube "
             '<span style="opacity:.8">(needs a connection)</span>')

    # The placeholder is always present, underneath, and the still is laid over
    # it. A card with no still shows it directly; a card whose still fails to
    # load drops the image and reveals it. The wording does not claim the video
    # is gone, because a deleted video and a build with no network produce the
    # same missing still and this cannot tell them apart.
    still = ''
    if has_thumb:
        still = (f'<img src="/{wiki}/_images/yt-{vid}.jpg" alt="" '
                 'onerror="this.remove()" '
                 'style="position:absolute;top:0;left:0;width:100%;height:100%;'
                 'object-fit:cover;border-radius:4px">')
    return (
        f'<a class="ap-video" href="{link}" data-ap-external="1" '
        'style="display:block;position:relative;max-width:640px;margin:1em 0;'
        'text-decoration:none;background:#2f2f2f;border-radius:4px">'
        '<span style="display:block;padding-bottom:56.25%"></span>'
        '<span style="position:absolute;top:0;left:0;right:0;bottom:0;'
        'display:flex;align-items:center;justify-content:center;color:#b0b0b0;'
        'font-size:.95em;text-align:center;padding:0 16px">'
        'No preview available</span>'
        f'{still}'
        '<span style="position:absolute;left:0;right:0;bottom:0;'
        'padding:8px 10px;background:rgba(0,0,0,.72);color:#fff;'
        f'font-size:.9em;border-radius:0 0 4px 4px">{label}</span></a>')


def rewrite_embeds(html: str, wiki: str, thumbs) -> str:
    """Swap every YouTube embed in a page for its card."""
    return EMBED_RE.sub(
        lambda m: video_card(m.group(1), wiki, m.group(1) in thumbs), html)


# The sidebar's donate control is an <input type="image"> whose source is a GIF
# on paypalobjects.com, and it is on all 3,958 pages. Offline that image cannot
# load, and a broken input renders as a small grey box: the alt text is not
# shown, so the control does not read as a donate button, or as anything.
#
# It is served by the theme, which is a separate repository, so this cannot be
# fixed at the source from here. It can be fixed in the copies we produce.
DONATE_RE = re.compile(
    r'<input[^>]*paypalobjects\.com[^>]*>',
    re.IGNORECASE)

DONATE_LINK = (
    '<a href="https://ardupilot.org/donate" data-ap-external="1" '
    'style="display:inline-block;padding:8px 22px;border-radius:4px;'
    'background:#ffc439;color:#111;font-weight:700;text-decoration:none;'
    'font-family:system-ui,-apple-system,sans-serif;font-size:15px">'
    'Donate</a>'
    '<div style="margin-top:6px;font-size:12px;opacity:.75">needs a connection</div>'
)


def rewrite_donate(html: str) -> str:
    """
    Replace the remote donate image with a styled link that survives offline.

    Styled inline for the same reason the video cards are: this markup is read
    under two different stylesheets, a cached wiki page and the single-file
    export, and inline is the only thing both honour. It keeps PayPal's yellow
    so it still reads as the same control, and says plainly that following it
    needs a connection rather than failing silently.
    """
    return DONATE_RE.sub(DONATE_LINK, html)


SITE_LINK_RE = re.compile(
    r'(href|src)="https?://(?:www\.)?ardupilot\.org(/[^"]*)"', re.IGNORECASE)


def rewrite_site_links(html: str, wikis) -> str:
    """
    Point absolute ardupilot.org links at this copy instead of the network.

    NOT NEEDED IN PRODUCTION. Served from ardupilot.org these links are already
    same-origin, so the service worker answers them from the cache and offline
    reading works untouched. This exists because the demo is on a different
    domain, where the same links leave the origin entirely and the worker never
    sees them: a top-level navigation to another origin is never handed to a
    service worker.

    So this can be dropped once the offline copies are served from the real
    site. It is kept because the alternative for demoing to anyone is asking
    them to edit their own DNS, which is not a reasonable thing to ask.

    Pages cross-reference each other by full URL, most visibly the About wiki,
    whose sidebar links to every other wiki that way. Rewriting to root-relative
    is harmless on the real site, where these resolve to the same pages they
    always did.

    Only paths belonging to a wiki we ship are touched. Everything else, the
    forum and firmware server included, is left as it is.
    """
    def swap(m):
        attr, path = m.group(1), m.group(2)
        first = path.lstrip('/').split('/')[0]
        if first not in wikis:
            return m.group(0)
        return f'{attr}="{path}"'

    return SITE_LINK_RE.sub(swap, html)


def downsize_image(data: bytes, name: str) -> "bytes | None":
    """
    A smaller copy of an oversized image, or None if it would not help.

    JPEG photos re-encode small; PNG stays PNG so screenshot text keeps its
    sharp edges (a JPEG of a text screenshot smears them). Only images larger
    than IMAGE_MAX_DIM on their long side are resized, and the result is used
    only if it is actually smaller. Any failure returns None: a build must never
    die over one awkward image.
    """
    if not IMAGE_MAX_DIM:
        return None
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in ("jpg", "jpeg", "png"):
        return None
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        w, h = img.size
        # Only touch genuinely oversized images. Re-compressing something that
        # already fits the cap trades a little quality for a little space AND
        # forces it to be published loose (it now differs from the live path),
        # which is a bad deal for the many already-small screenshots.
        if max(w, h) <= IMAGE_MAX_DIM:
            return None
        scale = IMAGE_MAX_DIM / max(w, h)
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
        out = io.BytesIO()
        if ext in ("jpg", "jpeg"):
            img.convert("RGB").save(out, "JPEG", quality=82, optimize=True)
        else:
            img.save(out, "PNG", optimize=True)
        result = out.getvalue()
        return result if len(result) < len(data) else None
    except Exception:
        return None


def add_image(tar, path, arcname: str, files, loose_dir):
    """
    Add an image to the archive, downsized if that is enabled and it helps.

    A downsized image differs from what the live site serves, so - exactly like
    rewritten HTML - it is published loose under loose_dir so a differential
    update fetches the archive's copy and its hash verifies. An unchanged image
    is byte-identical to the live path and needs no loose copy.
    """
    data = path.read_bytes()
    smaller = downsize_image(data, arcname)
    if smaller is not None:
        add_bytes(tar, arcname, smaller, files, loose_dir=loose_dir)
        return
    tar.add(path, arcname=arcname, filter=_normalise)
    if files is not None:
        files[arcname] = content_hash(data)


def add_bytes(tar, arcname: str, data: bytes, files=None, loose_dir=None):
    """
    Add generated or rewritten content to the archive.

    When loose_dir is given, the SAME bytes are also written to
    loose_dir/<arcname>. This is what makes differential updates work.

    The archive holds rewritten HTML (the donate button and video embeds are
    replaced so they survive offline) and generated video stills. Neither is
    served anywhere else: the live site serves the ORIGINAL page, and a still
    exists nowhere but here. A differential update fetches a changed file and
    now verifies its hash against the table, which is the hash of the REWRITTEN
    bytes, so fetching the original from the live path mismatches and the whole
    wiki falls back to a full re-download - the 400 MB-to-fix-a-typo case the
    mechanism exists to prevent. Publishing the rewritten bytes at a stable path
    gives the update the exact content the table describes. Files that are byte
    for byte identical to the live path (images, css, js) are NOT published
    here; the update fetches those from the live path and they verify fine.
    """
    info = tarfile.TarInfo(arcname)
    info.size = len(data)
    tar.addfile(_normalise(info), io.BytesIO(data))
    if files is not None:
        files[arcname] = content_hash(data)
    if loose_dir is not None:
        # Written gzipped, as <arcname>.gz. nginx gzip_static (already on for
        # /offline/) serves it for a request to <arcname> with Content-Encoding:
        # gzip, and the browser decompresses it natively before the client sees
        # a byte - universal support, no JavaScript, no DecompressionStream. So
        # the differential update fetches /offline/files/<arcname>, receives the
        # ORIGINAL uncompressed bytes, and its hash matches the table, which
        # hashes the uncompressed content (below). The loose tree drops from
        # ~450 MB to ~90 MB this way.
        #
        # No new browser-support floor: the offline feature already requires
        # gzip to download an archive (they are .tar.gz served the same way), so
        # a browser that cannot handle Content-Encoding gzip already cannot save
        # a wiki. Ordinary reading depends on none of this.
        dest = Path(loose_dir) / (arcname + ".gz")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(gzip.compress(data, compresslevel=9, mtime=0))


def content_hash(data: bytes) -> str:
    """
    Identify an entry by its content, for differential updates.

    64 bits is far more than enough to tell one build's copy of a file from
    another's: the largest wiki has around 3,300 entries, where the chance of
    any accidental collision is about one in 10^13. This is not a security
    boundary. An attacker who can choose what the server sends can simply send
    whatever they like, hash and all, so a longer digest would buy nothing.

    sha256 truncated to eight bytes, and the choice is the client's, not ours:
    the browser verifies every fetched file against this table before storing
    it, crypto.subtle has sha256 and does not have blake2b, and shipping a hash
    implementation in the page to save a second of build time would be exactly
    backwards. blake2b was measured at 1.1s for the 628MB of Copter; sha256 is
    roughly twice that, against a build measured in minutes.

    Truncation is fine here for the same reason the digest was always 8 bytes:
    this is a freshness check, not a security boundary.
    """
    return hashlib.sha256(data).hexdigest()[:16]


def raw_size(path: Path) -> int:
    """
    Uncompressed size of a .gz, taken from its trailer.

    The client needs this because the browser now does the decompressing:
    served as a content coding, Content-Length is the *compressed* length while
    the stream yields decompressed bytes, so progress measured against
    Content-Length reads over 200% on the text-heavy wikis. The manifest
    carries both numbers instead.

    The gzip ISIZE field is modulo 2^32, which is exact below 4 GiB. The
    largest archive here is around 450 MB.
    """
    with open(path, "rb") as f:
        f.seek(-4, os.SEEK_END)
        return int.from_bytes(f.read(4), "little")


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def build_id() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_common_archive(wikis, common_names, out_dir: Path, thumbs,
                         files=None) -> int:
    """One archive of the shared images, taken from whichever wiki has them.

    This is where the payload lives: 483 MB, effectively all images, against
    around 25 MB of images in a per-wiki archive.
    """
    archive = out_dir / "common-offline.tar.gz"
    seen = set()
    with reproducible_tar(archive) as tar:
        for wiki in wikis:
            images = Path(wiki) / "build" / "html" / "_images"
            if not images.is_dir():
                continue
            for name in sorted(common_names - seen):
                path = images / name
                if path.is_file():
                    add_image(tar, path, f"_images/{name}", files, out_dir / "files")
                    seen.add(name)
        # Stills go in with the shared images rather than a directory of their
        # own. The service worker and the HTML exporter both already know how
        # to find /<wiki>/_images/ here, and neither needs teaching about
        # another path.
        for vid, path in sorted(thumbs.items()):
            add_bytes(tar, f"_images/yt-{vid}.jpg", path.read_bytes(), files,
                      loose_dir=out_dir / "files")
    return archive.stat().st_size


def write_wiki_archive(wiki: str, exclusive: set, out_dir: Path, thumbs,
                       wikis, files=None) -> int:
    """Pages, static assets and images unique to this wiki."""
    html_root = Path(wiki) / "build" / "html"
    archive = out_dir / f"{wiki}-offline.tar.gz"

    with reproducible_tar(archive) as tar:
        for path in sorted(html_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(html_root)
            parts = rel.parts
            # Shared images travel in the common archive instead.
            if parts and parts[0] == "_images" and rel.name not in exclusive:
                continue
            # Never fold the offline artefacts back into themselves.
            if parts and parts[0] == "offline":
                continue
            arcname = f"{wiki}/{rel.as_posix()}"
            if path.suffix == ".html":
                html = path.read_text(encoding="utf-8", errors="replace")
                rewritten = rewrite_site_links(
                    rewrite_donate(rewrite_embeds(html, wiki, thumbs)), wikis)
                if rewritten != html:
                    add_bytes(tar, arcname, rewritten.encode("utf-8"), files,
                              loose_dir=out_dir / "files")
                    continue
            # Wiki-unique images can be downsized too; everything else (css, js,
            # fonts) is added as-is.
            if parts and parts[0] == "_images":
                add_image(tar, path, arcname, files, out_dir / "files")
                continue
            tar.add(path, arcname=arcname, filter=_normalise)
            if files is not None:
                files[arcname] = content_hash(path.read_bytes())
    return archive.stat().st_size


def write_file_table(out_dir: Path, name: str, files: dict) -> Path:
    """
    One entry per file in the archive, so an update can fetch only what moved.

    Without this the only freshness signal is the manifest's build id, which is
    site-wide: a one word fix to a single page marks every saved wiki stale and
    the only remedy is to download all of it again, 724MB compressed for the
    full set. The table is 69KB gzipped for Copter, so a client can ask what
    changed for roughly a five thousandth of the cost of assuming everything
    did.

    Keys are archive paths, which are exactly what the unpacker writes into
    Cache Storage, so a client can diff two tables and act on the difference
    without translating between naming schemes.
    """
    path = out_dir / f"{name}-files.json"
    path.write_text(json.dumps(files, separators=(",", ":"), sort_keys=True),
                    encoding="utf-8")
    return path


def build(wikis, destdir: Path) -> Path:
    out_dir = Path(destdir) / "offline"
    out_dir.mkdir(parents=True, exist_ok=True)

    built = [w for w in wikis if (Path(w) / "build" / "html" / "index.html").is_file()]
    if not built:
        log("no built wikis found; nothing to do")
        return out_dir

    log(f"classifying images across {len(built)} wikis")
    common_names, per_wiki = classify_images(built)

    ids = video_ids(built)
    log(f"fetching stills for {len(ids)} embedded videos")
    thumbs = fetch_thumbnails(ids, out_dir / ".thumbs")

    log(f"writing common archive ({len(common_names)} shared images, "
        f"{len(thumbs)} video stills)")
    common_files = {}
    common_bytes = write_common_archive(built, common_names, out_dir, thumbs,
                                        common_files)
    write_file_table(out_dir, "common", common_files)

    entries = []
    for wiki in built:
        html_root = Path(wiki) / "build" / "html"
        wiki_files = {}
        size = write_wiki_archive(wiki, per_wiki.get(wiki, set()), out_dir,
                                  thumbs, set(built), wiki_files)
        write_file_table(out_dir, wiki, wiki_files)
        pages = sum(1 for _ in html_root.rglob("*.html"))
        raw = raw_size(out_dir / f"{wiki}-offline.tar.gz")
        entries.append({
            "id": wiki,
            "name": DISPLAY_NAMES.get(wiki, wiki.capitalize()),
            "mb": round(size / 1048576),
            "pages": pages,
            # What crosses the wire, and what the stream yields after the
            # browser has decompressed it. The panel needs both.
            "bytes": size,
            "raw_bytes": raw,
            # No .gz: nginx gzip_static serves <name>.tar.gz when <name>.tar is
            # requested, setting Content-Encoding so the browser decompresses.
            "archive": f"{wiki}-offline.tar",
            "files": f"{wiki}-files.json",
        })
        log(f"  {wiki}: {size / 1048576:.0f} MB, {pages} pages")

    entries.sort(key=lambda e: -e["mb"])

    # Unset is now the ordinary case: the archives are static files in the
    # tree this build just wrote, served from the same origin as the pages, and
    # the page defaults to /offline. Only say something when it IS set, which
    # means somebody is deliberately serving them from elsewhere.
    artifact_base = os.environ.get(ARTIFACT_BASE_ENV, "")
    if artifact_base:
        log(f"archives will be served from {artifact_base}")
    else:
        log("archives will be served from this site's own /offline/")

    manifest = {
        "generated": build_id(),
        "artifact_base": artifact_base,
        "common": {
            "id": "common",
            "name": "Common (required)",
            "mb": round(common_bytes / 1048576),
            "pages": 0,
            "required": True,
            "bytes": common_bytes,
            "raw_bytes": raw_size(out_dir / "common-offline.tar.gz"),
            "archive": "common-offline.tar",
            "files": "common-files.json",
        },
        "wikis": entries,
    }

    manifest_path = out_dir / "offline-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(f"wrote {manifest_path}")
    return out_dir


if __name__ == "__main__":
    import sys
    wiki_list = sys.argv[1:] or [
        "copter", "plane", "rover", "sub", "blimp", "dev",
        "antennatracker", "planner", "planner2", "ardupilot", "mavproxy",
    ]
    build(wiki_list, Path("."))
