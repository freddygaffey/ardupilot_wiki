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
import json
import zipfile
import os
import tarfile
import time
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


def dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def build_id() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_common_archive(wikis, common_names, out_dir: Path) -> int:
    """One archive of the shared images, taken from whichever wiki has them."""
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
                    tar.add(path, arcname=f"_images/{name}", filter=_normalise)
                    seen.add(name)
    return archive.stat().st_size


def write_wiki_archive(wiki: str, exclusive: set, out_dir: Path) -> int:
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
            tar.add(path, arcname=f"{wiki}/{rel.as_posix()}", filter=_normalise)
    return archive.stat().st_size


# Images and other already-compressed payloads gain nothing from deflate and
# cost real time, so only text is compressed.
ALREADY_COMPRESSED = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2",
                      ".gz", ".zip", ".mp4", ".ico"}


def build_pyz(wiki: str, out_dir: Path) -> Path:
    """
    Package one wiki as a runnable zipapp: `python3 <wiki>-wiki.pyz`.

    The site is stored under site/ inside the archive and served from there on
    demand, so running it extracts nothing to disk. Serving over localhost -
    rather than telling people to open index.html - is what keeps Sphinx search
    working, since browsers refuse the fetch() it relies on from file:// URLs.
    """
    html_root = Path(wiki) / "build" / "html"
    if not html_root.is_dir():
        raise SystemExit(f"{wiki}: no build output at {html_root}")

    entry = Path(__file__).with_name("wiki_pyz_main.py")
    out = out_dir / f"{wiki}-wiki.pyz"

    with zipfile.ZipFile(out, "w") as z:
        z.writestr("__main__.py", entry.read_text(encoding="utf-8"),
                   zipfile.ZIP_DEFLATED)
        for path in sorted(html_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(html_root)
            if rel.parts and rel.parts[0] == "offline":
                continue       # never fold the artefacts back into themselves
            mode = (zipfile.ZIP_STORED if path.suffix.lower() in ALREADY_COMPRESSED
                    else zipfile.ZIP_DEFLATED)
            z.write(path, arcname="site/" + rel.as_posix(), compress_type=mode)

    # A zipapp is expected to be executable and to carry a shebang; Python can
    # run it either way, but this lets ./rover-wiki.pyz work directly.
    out.chmod(0o755)
    log(f"{wiki}: wrote {out.name} ({out.stat().st_size / 1048576:.0f} MB)")
    return out


def build(wikis, destdir: Path) -> Path:
    out_dir = Path(destdir) / "offline"
    out_dir.mkdir(parents=True, exist_ok=True)

    built = [w for w in wikis if (Path(w) / "build" / "html" / "index.html").is_file()]
    if not built:
        log("no built wikis found; nothing to do")
        return out_dir

    log(f"classifying images across {len(built)} wikis")
    common_names, per_wiki = classify_images(built)

    log(f"writing common archive ({len(common_names)} shared images)")
    common_bytes = write_common_archive(built, common_names, out_dir)

    entries = []
    for wiki in built:
        html_root = Path(wiki) / "build" / "html"
        size = write_wiki_archive(wiki, per_wiki.get(wiki, set()), out_dir)
        pages = sum(1 for _ in html_root.rglob("*.html"))
        entries.append({
            "id": wiki,
            "name": wiki.capitalize(),
            "mb": round(size / 1048576),
            "pages": pages,
            "archive": f"{wiki}-offline.tar.gz",
        })
        log(f"  {wiki}: {size / 1048576:.0f} MB, {pages} pages")

    entries.sort(key=lambda e: -e["mb"])

    manifest = {
        "generated": build_id(),
        "artifact_base": os.environ.get(ARTIFACT_BASE_ENV, ""),
        "common": {
            "id": "common",
            "name": "Common (required)",
            "mb": round(common_bytes / 1048576),
            "pages": 0,
            "required": True,
            "archive": "common-offline.tar.gz",
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
