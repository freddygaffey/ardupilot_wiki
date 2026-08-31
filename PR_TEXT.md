# Paste-ready PR text for the single draft PR (edit freely)

Open from the compare URL, paste title and body, pick **Create draft pull
request** from the split button. The branch carries ten commits, one per
layer, so it can be read in order on the Commits tab.

URL: https://github.com/ArduPilot/ardupilot_wiki/compare/master...freddygaffey:ardupilot_wiki:offline

**Title:** Offline reading: archives built by the build server, opt-in service worker, offline page and single-file export

**Body:**

Draft for review, as discussed with @Hwurzburg and @tridge on Discord. Demo: https://offline-wiki.pebnum.com (Offline in the top menu, then *Enable offline mode*, or save a wiki).

**Everything reader-facing is opt-in.** `pwa.js` is loaded on every page but registers the service worker only after a reader presses *Enable offline mode* in the menu or saves a wiki. A reader who does neither has no worker and browses exactly as today; the footprint on an ordinary page is a manifest link, one script tag and the Offline menu entry. Pinned by a browser test in Chromium, Firefox and WebKit: a fresh profile ends the page load with no registration.

The branch is ten commits, best read in order on the Commits tab:

1. `build_parameters.py` fetches every ref (release commits are on branches and tags, not master) and takes an optional `ARDUPILOT_PARAM_MIN_VERSION`.
2. **Build the offline archives.** After Sphinx, `scripts/build_offline_artifacts.py` packs each wiki's `build/html` into `offline/<wiki>-offline.tar.gz` with a path -> hash table for differential updates, shared images once into `common-offline.tar.gz`, and writes `offline-manifest.json` last. Pages are rewritten to work offline (YouTube embeds become linked stills, the donate image a link). About 700 MB per build under `<destdir>/offline/`, roughly 25 s added. Pillow is declared in `requirements.txt`.
3. Tests for the archives: archive against built tree, built tree against source.
4. **Lossless PNG recompression**: 133 MB (9.8%) off what is served, every image verified pixel-identical, cached by content hash. Reaches every reader.
5. **Lazy-loaded YouTube embeds.** Reaches every reader.
6. **Template hooks**: the Offline menu entry with its opt-in switch, a manifest link and the `pwa.js` tag in `<head>`. Inert until a reader opts in.
7. **Service worker and PWA shell, opt-in.** Visited pages from cache and refreshed behind, images and fingerprinted assets cache-first, saved wikis from their own caches. `sw-kill.js` is the recovery path. Worker suite under node; browser suite in three real engines.
8. **The offline page.** Save a wiki from one archive into Cache Storage under the real URLs, historical parameter pages offered separately, differential updates that fetch only changed files (each verified), remove what was saved. 144 panel checks.
9. **Single-file export.** A self-contained `.html` with the wiki's navigation and full-text search, streamed to disk through the worker.
10. Developer documentation and the npm test manifest.

Commits 4 and 5 are the only ones that change output for readers who do not opt in; drop them if you would rather take those separately.

**Rollout:** merge on a call with a server snapshot first, as Tridge suggested. Because the worker is opt-in, only people who opt in during the test carry one. If a worker ever needs pulling back, deploying `frontend/sw-kill.js` in place of `sw.js` unregisters every client on its next visit.

**Ops prerequisites** (not in this PR):
1. `/sw.js`, `/js/pwa.js`, `/manifest.json` and `/offline/` must be served from the site root. On ardupilot.org that is the `mainweb` side, so `update.py`'s `frontend/` output needs to land in its document root.
2. `Cache-Control: no-cache` on `/sw.js`, `/js/pwa.js`, the `common_offline*` scripts and `offline-manifest.json`; `gzip_static on` for `/offline/`. The dev doc (`dev/docs/wiki-offline-copies`) has the exact nginx blocks.

**Tests:** `npm install && npm test` (panel, worker, exporter, archives, image passes), `npm run test:browsers` (the same pages read offline in three real browsers). Design and file-by-file notes are in the dev doc this PR adds.

**Known open items:** a rare, unreproduced blank page during a worker swap, seen twice on the demo; the differential-update thresholds (300 files / 20%) are unmeasured guesses.

---

## Discord reply after opening

> The PR is up as a draft: <link>. Ten commits in build order: the build-server side first, then the two image passes, then everything reader-facing. Everything reader-facing is opt-in; a fresh visitor gets no service worker. Saturday still works for me.
