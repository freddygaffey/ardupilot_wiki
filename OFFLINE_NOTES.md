# Offline wiki — handover notes

Working notes for the `offline-wiki` branch. Not wiki content; delete or fold
into the PR description before merging.

Branch: 23 commits, 18 files, +3,621 lines.
Demo: <https://ardupilot-wiki-demo.pages.dev/rover/docs/common-offline.html>

## What it does

Makes the wiki readable with no connection, three ways:

1. **Pages cache as you read them.** A service worker stores every page you
   visit, so going offline keeps what you have already seen.
2. **Save whole wikis.** One request per wiki for a pre-built archive, unpacked
   in the browser into Cache Storage under the real page URLs. Not a crawl —
   crawling Copter would be ~3,400 requests per reader.
3. **Export a file.** A runnable `.pyz` or a single self-contained `.html`,
   both built **in the browser** from what is already cached, so the server
   hosts neither.

## Where things live

| Path | Role |
| --- | --- |
| `common/source/docs/common-offline.rst` | The page. Markup only; prose is normal rST |
| `frontend/css/offline.css` | All styling for the panel |
| `frontend/js/offline-page.js` | The panel: selection, download, update check |
| `frontend/js/offline-export.js` | Builds the `.pyz` and `.html` files |
| `frontend/sw.js` | Service worker: caching, streaming-download route |
| `frontend/sw-kill.js` | Kill switch (see below) |
| `frontend/js/pwa.js` | Install button, worker registration |
| `common/_templates/z_top_menu.html` | Theme override adding the Offline menu item |
| `common/_templates/layout.html` | Injects manifest + `pwa.js` into every page |
| `scripts/build_offline_artifacts.py` | Build side: archives + manifest |
| `scripts/tests/test_offline_export.js` | Verification harness for the exporters |

## Running it

```sh
# Build a wiki (fast, incremental)
python3 update.py --site rover --fast --cached-parameter-files

# Build the offline archives too (opt-in)
python3 update.py --offline

# Verify the exporters (13 checks, ~30s)
node scripts/tests/test_offline_export.js rover

# Same against every wiki with no page cap — slow, needs ~8GB heap
node --max-old-space-size=8192 scripts/tests/test_offline_export.js --full
```

Template changes need a clean build — Sphinx does not reliably invalidate on
them. `.rst` and asset changes are fine with `--fast`.

## Numbers, measured

Full 11-wiki export:

```
3,958 pages · 3,202 unique images serving 12,133 references
.html   970 MB
.pyz    890 MB
```

Build-side archives: 700 MB total (`common` 433 MB, then 74 MB Copter down to
3 MB ArduPilot). `--offline` adds about 11 seconds to a 3-minute clean build.

Splitting `common` out is what keeps this affordable: every wiki references
most of the same images, so self-contained per-wiki archives would be ~2.7 GB
instead of 700 MB.

## Verified

- `.pyz` runs and serves: root, pages, shared images, `searchindex.js`; search
  returns results. Validated by Python's `zipfile` (CRCs check out) and by
  running it.
- `.html` opens and works: navigation, internal links, images at full
  resolution, `#/rover` shorthand anchors, theme fonts.
- Download, unpack and cache at ~574 MB across three wikis.
- Archives are reproducible — 12/12 byte-identical across builds, so rsync
  skips unchanged wikis instead of moving 700 MB every deploy.
- `--offline` on a clean full build.

## Not done / known gaps

- **`offline-page.js` has no tests.** The exporters have a harness; the panel
  itself does not. Every bug in it was caught by a person looking at it.
- **Downloads write straight into their final cache**, not a staging one. An
  interrupted download leaves stray entries. Harmless — the `__ap_complete__`
  marker is written last, so a partial cache is never counted as complete — but
  the entries linger.
- **Panel header buttons wrap** to two lines at the wiki's content width.
- **PDF** was requested and not built. Best routes are Sphinx's `latexpdf` at
  build time, or Print → Save as PDF from the exported `.html`.
- **R2 upload is manual.** `wrangler r2 object put` caps at 300 MiB, so the
  433 MB common archive needs rclone against the S3 endpoint with an R2 token.
- **`ARTIFACT_BASE`** in `offline-export.js` points at a throwaway `r2.dev`
  bucket. Set `ARDUPILOT_OFFLINE_BASE` at build time instead — it lands in the
  manifest and overrides the constant.

## Traps

**Do not reconnect Pages to git.** It silently 404s the whole site. Pages
builds from the repo, which holds wiki *source*; `update.py` produces the HTML
and cannot run in Pages CI (~10 min, 2.7 GB, ~17k files, against the build
timeout and the 20k-file limit). Deploy by direct upload. Splitting `frontend/`
into its own git-connected project does not work either — the offline page and
the wiki must share an origin or the service worker cannot cache the wiki.

**Stale assets masked real bugs repeatedly.** Markup, script and stylesheet are
one unit for this page: a fresh one paired with a cached other renders as
nonsense, and it looks like a logic fault. `.js` and `.css` are now served
network-first for that reason. `window.ArduPilotOfflineVersion` reports which
build the page is actually running — check it before debugging behaviour.

**Shared images are aliased in three places.** They are stored once under
`/_common/_images/` while pages request `/<wiki>/_images/…`. That mapping is
implemented separately in `sw.js`, in the Python server embedded in the `.pyz`,
and in the HTML exporter. A fourth consumer should share a helper rather than
add a fourth copy.

**Service worker recovery.** `cp frontend/sw-kill.js frontend/sw.js` and deploy
to unregister the worker and drop its caches everywhere. This depends on
`/sw.js` being served `Cache-Control: no-cache` — set in `frontend/_headers`
for Cloudflare; nginx needs the same directive or recovery is stuck behind a
cache.

## Decisions worth knowing

- **Archives are `tar.gz`, exports are `zip`.** Browsers have native gzip
  decompression (`DecompressionStream`) but no unzip, and Python runs a zip;
  neither format serves both, so it is two formats rather than one renamed.
- **Exports stream to disk** through the service worker, so peak memory is one
  file rather than one archive. Falls back to `showSaveFilePicker`, then Blob.
- **Images are stored once per export.** Inlining per page encoded the same
  picture once for every page using it, which is what produced multi-gigabyte
  files.
- **Nothing polls.** Every network action is behind a click or an explicit
  auto-update check, throttled. Downloaded files never phone home — they cannot
  be recalled once distributed.
- **The offline page is a wiki page**, built by Sphinx, so it inherits the real
  theme, sidebar and fonts. An earlier standalone version hand-copied the theme
  and diverged immediately.
