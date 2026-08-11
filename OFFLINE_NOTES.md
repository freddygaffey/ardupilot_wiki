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
| `scripts/tests/test_offline_page.js` | 83 assertions over the panel |
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

---

# Handover, 11 August 2026

Stop-work note. One bug is diagnosed but not fixed, and the diagnosis is the
valuable part: it cost most of a session to find and is easy to re-lose.

## The bug that was open, and is now fixed

Differential updates replaced non-HTML files and silently failed on HTML.

**It was never the diff, the worker routing, or Cache Storage.** It was a stale
copy of `common_offline_page.js` in the browser's HTTP cache: a build that had
`updateStored` but not yet the request tagging. Untagged requests took the
cache-first route, so HTML was answered from the very cache being refreshed and
written back over itself. `.js` and `.inv` reach the network regardless, which
is the only reason they appeared to work and why the failure looked selective.

Instrumenting `window.fetch` showed it in one field, `tagged:false` on every
request, while the served file plainly contained the tagging code.

**Two lessons worth keeping.** Do not use a function name to check which build
is running; check for the specific change under test. And our own scripts are
not fingerprinted the way Sphinx's are, so a stale copy is always possible
until the headers say otherwise.

**The fix** is in `deploy/nginx-wiki.conf`: `/js/pwa.js` and
`*/\_static/common_offline*.{js,css}` are served `Cache-Control: no-cache`, as
`/sw.js` already was. The update code itself needed no change; it had simply
never once run.

### Verified end to end, worker controlling the page

Seeded a saved dev wiki with placeholders and nine wrong hashes, then pressed
Check for updates:

```
every request tagged      true          requests made       9
archive fetched           false         all nine replaced   true
untouched files intact    true          table now matches   true

editing-prs.html   18,084     intel-edison.html            47,401
nsh.html           27,214     ros2.html                    33,501
rover-sitl.html    32,204     sitl-with-airsim.html        74,885
mavexplorer.html   36,122     objects.inv                  68,182
searchindex.js  1,152,920
```

Nine files fetched and written, nothing else touched, no archive downloaded.

## What is finished and verified

* **The build side.** `scripts/build_offline_artifacts.py` writes a
  `<wiki>-files.json` per archive, path to blake2b-64 of contents. Hashing all
  3,316 Copter files (628 MB) takes 1.1 s inside a walk that already reads those
  bytes. Tables are 69 KB gzipped for Copter.
* **Determinism and granularity**, both measured: two builds of unchanged
  content produce identical tables, and editing one page moves exactly one of
  297 entries.
* **The real-world saving**, measured on a genuine 12-source-file commit
  (`9dcead75d`) by building its parent and itself: **9 of 1,057 files change,
  1,436 KB against 490 MB, a 350x reduction.** A changed page does not rewrite
  every other page's sidebar, which was the main risk to this design.
* **Worker routing for updates**, `UPDATE_PARAM` in `sw.js`, verified by hand: a
  tagged HTML request returns the real 33,486-byte page. It deliberately omits
  the cache fallback, because answering an update from storage hands back the
  stale copy being replaced.
* **The parameter version selector** is live on the mirror, 15 versions for
  Copter, Plane and Rover, 10 for Sub.
* **Both wiki pages** rewritten against `common-wiki-editing-style-guide`.

## Corrections made to earlier claims

* The 33,512 ms figure for `parameters.html` **does not reproduce** and has been
  removed. Measured against the live site as a control: ardupilot.org 8,289 ms,
  this branch 2,344 ms. Six of those eight seconds are spent building the page,
  and that part drops from 6,208 ms to 1,968 ms, so `content-visibility` is
  doing about 3x. The notes previously said it "did not make the page usable",
  which was wrong.
* Storage of 1.2 GB against a 700 MB download is **not** double-storing. 724 MB
  is the compressed download; the same content unpacked is 1,212 MB. The panel
  should show both numbers and currently shows one.

## The update path is now under test

Written after the handover above, so the browser proof no longer has to be
repeated by hand. Both halves of the bug that shipped are covered.

**The client**, in `test_offline_page.js`, 25 assertions against bytes in the
cache rather than against what the panel says it did. A seeded wiki with a
stored table meets a published table that has moved: exactly the changed files
are fetched, a dropped file is deleted, an unchanged page still holds its own
bytes rather than a refetched copy, the table and marker advance, and every
request carries the tag. An unchanged wiki costs one request, its table. A file
that cannot be fetched anywhere leaves the stored table and the build marker
untouched and falls back to the archive, so a half-applied update can never
claim a build it does not hold. The shared-file walk is covered too: the wiki
being read is tried first and the walk stops at the first hit.

**The worker**, in `test_offline_worker.js`, 8 assertions. The whole worker is
evaluated against a scope that keeps the listeners it registers, and synthetic
events are dispatched at the real fetch handler. A tagged request reaches the
network and reads nothing from storage; the same URL untagged does read storage,
which is the contrast that shows the tag is what does the work; and a tagged
request whose network fails rejects rather than being answered from the copy it
was sent to replace.

Both sets were mutation-tested rather than assumed to bite. Dropping the tag,
skipping the deletions, computing an empty diff, and truncating the shared-file
walk each fail the client tests; restoring the cache fallback on the update
route, and removing the route altogether, each fail the worker tests.

Two harness gaps had to be closed first, and both had been hiding real coverage:
response bodies were stringified rather than kept as bytes, so nothing written
by an update could be read back, and the sandbox had no global `location`, which
made the shared-file path throw a `ReferenceError` that the update's own error
handling turned into a silent fall back to downloading the whole archive.

## Still to do

1. Make the count report completed writes. "Updated 9 files" still comes from
   the size of the diff, so it would claim success even if every write failed.
   It is truthful today only because any failed fetch rejects the whole update,
   which is not the same as being correct. The new tests pin the number to what
   the cache actually holds, so a change here has something to answer to.
2. Test the sidebar. Never got to it.
3. The panel's storage figures: show download size and unpacked size.
4. Bound the promotion in `sw.js:508`. Pages read from a saved wiki are copied
   into the runtime cache, roughly 2% overhead, buying 1 ms against 84 ms.
5. Guard the build order so an archive can never be packed before the static
   files it contains are up to date. This bit us once and is invisible when it
   does.

## Known upstream issue found today, left alone at the user's request

The top menu collapses to `height: 0` below 767 px, or below 1024 px on a
Retina display, and the mobile styling expects a `#menu-button` that
`z_top_menu.html` never renders. Proven on ardupilot.org itself: at 673 px,
height 0, all 36 links invisible. Not ours, and not recorded in
`KNOWN_UPSTREAM_ISSUES.md` because the user said to leave it.

## Operational

The user's twelve saved wikis were deleted at their request via the Remove all
button, 1.2 GB down to 100 MB. **They need to re-save before demoing.**

Earlier in the session an update test was run in the user's own browser profile
and re-downloaded their saved wikis via the fallback path. Use a clean profile
for storage tests.
