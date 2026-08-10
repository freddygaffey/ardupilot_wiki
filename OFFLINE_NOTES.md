# Offline wiki: handover

Working notes for the `offline-wiki` branch. Not wiki content. Delete this file,
or fold it into a PR description, before anything here is proposed upstream.

Branch: 46 commits, 22 files, +4,796 lines. Pushed to `freddygaffey/ardupilot_wiki`.
Nothing merged, `master` untouched.

- Demo: <https://offline-wiki-demo.pages.dev>
- Archives: <https://cdn.ardupilot-wiki-offline.pebnum.com>

This is a prototype. The intent is to rewrite it on a fresh branch with other
people, so treat the code as a demonstration that the approach works rather than
as something to polish.

## What it does

Makes the wiki readable with no connection, three ways.

1. **Pages cache as you read them.** A service worker stores every page visited,
   so going offline keeps whatever has already been seen.
2. **Save whole wikis.** One request per wiki for a pre-built archive, unpacked
   in the browser into Cache Storage under the real page URLs. Not a crawl:
   crawling Copter would be roughly 3,400 requests per reader.
3. **Export a single file.** A self-contained `.html` built in the browser from
   what is already cached, so the server hosts nothing extra. It carries full
   text search, the wiki's own navigation, and every image inline.

## Where things live

| Path | Role |
| --- | --- |
| `common/source/docs/common-offline.rst` | The page. Markup only, prose is normal rST |
| `common/_templates/layout.html` | Injects the manifest, icons and `pwa.js` into every page |
| `common/_templates/z_top_menu.html` | Theme override adding the Offline menu item |
| `frontend/css/offline.css` | Styling for the panel |
| `frontend/js/offline-page.js` | The panel: selection, download, update check |
| `frontend/js/offline-export.js` | Builds the `.html`, including its search |
| `frontend/js/pwa.js` | Install button, service worker registration |
| `frontend/sw.js` | Service worker: caching, streaming download route |
| `frontend/sw-kill.js` | Kill switch, see Recovery below |
| `frontend/_headers` | Cloudflare Pages cache rules |
| `scripts/build_offline_artifacts.py` | Build side: archives, manifest, video cards |
| `scripts/demo_localise_links.py` | Demo only, see Demo-only below |
| `scripts/tests/test_offline_page.js` | 58 assertions over the panel |
| `scripts/tests/test_offline_export.js` | 15 checks over the exporter |
| `scripts/tests/KNOWN_MARKUP_ISSUES.md` | Two wiki content bugs, not ours |

## Running it

```sh
# Build one wiki (incremental)
python3 update.py --site rover --fast --cached-parameter-files

# Build everything and the offline archives
ARDUPILOT_OFFLINE_BASE=https://cdn.ardupilot-wiki-offline.pebnum.com \
  python3 update.py --fast --cached-parameter-files --offline

# Tests
npm install && npm test
```

Template changes need a clean build. Sphinx does not reliably invalidate on
them. `.rst` and asset changes are fine with `--fast`.

Deploying the demo: assemble a directory with `frontend/*` at the root, each
`<wiki>/build/html` under its own name, and `offline/offline-manifest.json`.
Run `scripts/demo_localise_links.py` over it. Then
`wrangler pages deploy <dir> --project-name offline-wiki-demo --branch offline-wiki`.
Copy rather than using `update.py --destdir`, which moves `build/html` out of
the tree and leaves the tests with nothing to run against.

## Numbers, measured

```
3,958 pages, 11 wikis
archives     700 MB total (common 439 MB, then Copter 74 MB down to About 3 MB)
.html export 970 MB for all eleven
search index 5 MB of that, parsed on first search rather than on load
```

`--offline` adds about 22 seconds to a build, plus roughly a minute the first
time it fetches video stills. A `--fast` rebuild of all eleven wikis is 8 to 22
minutes, almost none of it rendering: Sphinx rebuilds only changed pages (1 or 2
per wiki) but still reads every source and re-copies about 2,400 images per
wiki. The cost scales with the size of the wiki, not with the size of the edit.

## Traps

**Backslashes in the exported shell.** `offline-export.js` assembles the
exported page's JavaScript from single-quoted string literals, so a regex
written `/\s+/` loses its backslash and becomes `/s+/`. That silently stripped
every letter s from search snippets. Backslashes in that block must be doubled.
`test_offline_export.js` asserts one survives into the built file.

**Replacing an object in R2 does not purge Cloudflare's edge.** A new archive
can be published, verified by checksum in the bucket, and readers still get the
previous one. Archive URLs carry `?v=<build id>` from the manifest for this
reason, and the manifest itself is fetched `no-cache`. Three things must hold
for a reader to get current content, and all three are tested: the manifest is
never cached, the URL carries the build, and the download records the build so
staleness can be detected.

**The bucket's CORS policy pins the demo hostname.** Renaming the Pages project
broke downloads until the new origin was added. Served from the same origin as
the wiki, CORS stops mattering entirely.

**`wrangler r2 object put` refuses anything over 300 MiB**, as does the
dashboard, and `common` is 439 MB. It was published with a temporary Worker with
an R2 binding doing a multipart upload, then deleted. A real build server needs
a client that handles large objects.

**Sphinx's epub builder emits XHTML and readers parse it strictly.** A bare
`<meta ...>` or `defer` in `layout.html` made every page of a generated book
unopenable, because that template is injected into every page of every wiki.
Void elements are self-closed and boolean attributes carry values for this
reason. Both forms are valid HTML5, so browsers see no difference.

**Do not reconnect Pages to git.** It silently 404s the whole site. Pages builds
from the repo, which holds wiki source; `update.py` produces the HTML and cannot
run in Pages CI. Deploy by direct upload.

**Stale assets masked real bugs repeatedly.** Markup, script and stylesheet are
one unit for this page. `window.ArduPilotOfflineVersion` reports which build is
actually running; check it before debugging behaviour.

**Recovery.** `cp frontend/sw-kill.js frontend/sw.js` and deploy to unregister
the worker and drop its caches everywhere. This depends on `/sw.js` being served
`Cache-Control: no-cache`, set in `frontend/_headers`.

## Demo-only, to be removed

| Thing | Why it exists |
| --- | --- |
| `scripts/demo_localise_links.py` | Pages link to each other by absolute `ardupilot.org` URL. Same-origin that is free; on the demo it walks readers onto the live site. Delete when served from ardupilot.org |
| `ARTIFACT_BASE` default in `offline-page.js` | Points at a rate-limited `r2.dev` bucket. Set `ARDUPILOT_OFFLINE_BASE` at build time instead; the build warns when it is unset |

Not to be confused with `rewrite_site_links` in `build_offline_artifacts.py`,
which does the same rewriting inside downloaded archives and is needed whatever
the wiki is hosted on, because a file opened from disk has no origin at all.

## Verified

- Full flow on the live demo: select, download 443 MB, pages readable from
  cache, export enabled, save button disables when nothing is left to fetch.
- Archives byte-identical to local by checksum, all 13 objects.
- Cross-wiki links stay inside the exported file. Links to wikis not in the
  export show a page offering the live version and a way back.
- Full text search finds words that appear in no title. Stopwords in the query
  no longer empty the results. Typos match within one edit.
- Video embeds replaced with linked stills, 378 of them, with a placeholder for
  the 16 whose videos are deleted.
- Archives reproducible, so unchanged wikis are skipped on upload.

## Not done

- **The first download is 443 MB** before anything is readable, because `common`
  is required whichever wiki is chosen. This is the biggest barrier for anyone
  exploring unattended.
- **EPUB and PDF are parked.** Both build. EPUB needs the `:hidden:` toctree
  worked around, or its contents lists one entry for 1,241 pages, and needs the
  image pass or Copter is 503 MB. Resizing to 800px and re-encoding measured 92%
  smaller. PDF via Calibre from the EPUB works and inherits both problems.
  `make latexpdf` is a dead end, see PR #3650.
- **Downloads write into their final cache**, not a staging one. An interrupted
  download leaves stray entries. Harmless, the completion marker is written
  last, but they linger.
- **No single-page save.** Probably the cheapest useful addition left: the
  exporter already inlines images, and one self-contained page prints to PDF
  cleanly, which the multi-page export cannot.

## Talking to upstream

There is standing demand, unanswered:

- [#3407](https://github.com/ArduPilot/ardupilot_wiki/issues/3407) Provide wiki in PDF format, open since 2021, peterbarker and Hwurzburg both in the thread
- [#337](https://github.com/ArduPilot/ardupilot_wiki/issues/337) Create epub builds, open since 2016
- [#25](https://github.com/ArduPilot/ardupilot_wiki/issues/25) Improved printing support, closed in 2015 for lack of demonstrated need, asking for exactly this

Reply on #3407 rather than opening a pull request. Large infrastructural PRs in
this repo die of neglect: #2891 sat four years before being closed, #3650 has
been open since 2021. Lead with the demo, and be straightforward that the open
question is bandwidth and who operates the hosting.
