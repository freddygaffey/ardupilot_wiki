/*
 * Service worker for the ArduPilot wiki. Caching policy:
 *
 *   pages   stale-while-revalidate - render the cached copy at once, refresh
 *           behind, and tell the page if the refreshed copy differs so an editor
 *           sees the change without every reader paying a round trip first.
 *   images  cache first - large and effectively immutable.
 *   static  stale-while-revalidate - few, small, must track the theme.
 *
 * At most one request per resource per navigation, as an ordinary browser does;
 * nothing here crawls or polls. The bulk download is a separate opt-in action.
 */

/*
 * Bump when the CONTENT of a cache can no longer be trusted, NOT on every edit.
 * The activate handler only deletes caches whose NAME is stale, so a bad entry
 * in a still-current cache lives until this changes - but a bump also empties
 * every runtime cache, making the next load slow. Change a strategy or find
 * poisoned entries: bump. Fix how a response is stored: usually not.
 *
 * Not hypothetical: a debugging session once wrote 17-byte placeholders over the
 * theme's cache-first (never-revalidated) stylesheets under their current
 * fingerprints, so no later build could replace them and every page rendered
 * unstyled for weeks. One bump here would have cleared it. Downloaded wikis are
 * unaffected: ardupilot-offline-* is unversioned and activate skips it.
 */
const CACHE_VERSION = 'v11';
const PAGE_CACHE = `ardupilot-pages-${CACHE_VERSION}`;
const IMAGE_CACHE = `ardupilot-images-${CACHE_VERSION}`;
const STATIC_CACHE = `ardupilot-static-${CACHE_VERSION}`;
// Cross-origin assets that never change and so can be served from cache after
// the first visit. Anything whose freshness matters stays off this list.
const THIRD_PARTY_CACHE = `ardupilot-thirdparty-${CACHE_VERSION}`;
const THIRD_PARTY_STATIC =
  /^https:\/\/(i\.creativecommons\.org\/|licensebuttons\.net\/|www\.paypalobjects\.com\/)/;
// User alerts warn about a bad release, so they must not go stale silently;
// they get the same contract as a page - serve what we have, refresh behind,
// next navigation shows the newer copy.
// The offline page and the assets that drive it. Network-only because the
// markup and its panel script are one unit - a cached script against fresh
// markup renders as garbage. pwa.js is deliberately excluded: it pairs with
// nothing and is on every page, and network-only cost 15ms/navigation for a
// file that rarely changes, so it gets stale-while-revalidate below instead.
const APP_ASSET =
  /(^\/sw\.js$|common_offline(\.css|_page\.js|_export\.js|_document_builder\.js|_unpack\.js|_update\.js)$|common-offline(\.html)?$)/;
// Marks a request as part of a differential update, which must not be served
// from the very cache it is refreshing.
const UPDATE_PARAM = 'ap-update';
const THIRD_PARTY_FRESH = /^https:\/\/firmware\.ardupilot\.org\/useralerts\//;
const CURRENT_CACHES = [PAGE_CACHE, IMAGE_CACHE, STATIC_CACHE, THIRD_PARTY_CACHE];
// Downloaded wikis, deliberately unversioned so they outlive worker updates.
const OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';

// Kept deliberately short. Anything else is cached as it is visited, so a fresh
// install does not pull down a pile of files somebody may never look at.
const SHELL = [
  '/',
  '/offline-fallback.html',
  '/manifest.json',
  '/android-icon-192x192.png',
  '/icon-512x512.png',
  // pwa.js only: layout.html loads it on every page, so it is genuinely
  // site-wide rather than part of any one wiki. The offline panel's own
  // script and stylesheet are static assets under each wiki's _static, so
  // they travel in that wiki's archive and need no special case here.
  '/js/pwa.js',
];

// How long a navigation waits for the network before falling back to cache,
// for pages that are not cached yet.
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready rather than waiting for every
  // tab to close. A stuck old worker is the main reason a bad service worker
  // becomes hard to displace, and this site serves documents, not a stateful
  // app, so an immediate swap is harmless.
  self.skipWaiting();

  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Added one at a time: cache.addAll() rejects the whole batch if a single
    // entry 404s, which would leave the worker permanently uninstallable.
    await Promise.all(SHELL.map((url) =>
      cache.add(url).catch((err) => console.warn('[sw] shell precache failed', url, err))
    ));
  })());
});

/*
 * Warm the theme's shared assets after activation. Every page loads the same
 * dozen files (jQuery, theme script and stylesheet, fonts); fetched lazily, the
 * first page paid for all of them. They are small, shared, and content-hashed,
 * so fetching them once up front is cheap and never wrong. 404s are ignored.
 */
const WARM_PER_WIKI = [
  '_static/css/theme.css',
  '_static/js/theme.js',
  '_static/jquery.js',
  '_static/doctools.js',
  '_static/sphinx_highlight.js',
  '_static/common_theme_override.css',
];

/*
 * Third-party furniture on every page that never changes: the donate button
 * (paypalobjects.com) and licence badge (creativecommons.org). Cache-first
 * makes them cost the same as our own images (the donate button alone was
 * 138 ms on the first page). Fetched no-cors - a cross-origin image is opaque,
 * fine for an <img>. Failures ignored; this is decoration.
 */
const WARM_THIRD_PARTY = [
  'https://www.paypalobjects.com/en_US/i/btn/btn_donate_LG.gif',
  'https://i.creativecommons.org/l/by-sa/3.0/88x31.png',
];

async function warmThirdParty() {
  const cache = await caches.open(THIRD_PARTY_CACHE);
  await Promise.all(WARM_THIRD_PARTY.map(async (url) => {
    try {
      if (await cache.match(url)) { return; }
      const response = await fetch(url, { mode: 'no-cors' });
      if (response) { await cache.put(url, response.clone()); }
    } catch (err) { /* decoration; never worth failing activation for */ }
  }));
}

async function warmTheme() {
  const wikis = (await caches.keys())
    .filter((n) => n.startsWith(OFFLINE_CACHE_PREFIX))
    .map((n) => n.slice(OFFLINE_CACHE_PREFIX.length))
    .filter((n) => n !== 'common');
  if (!wikis.length) {
    return;
  }
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all(wikis.flatMap((wiki) => WARM_PER_WIKI.map(async (rel) => {
    const url = `/${wiki}/${rel}`;
    if (await cache.match(url)) {
      return;
    }
    const held = await heldOffline(new Request(url));
    // Guarded like every other write into the versioned cache: a saved wiki is
    // a source of bytes, not a trusted one, and a bad body here outlives the
    // wiki it came from until CACHE_VERSION bumps. This is the same path that
    // once poisoned the stylesheets.
    if (held && plausibleBody(new Request(url), held)) {
      await cache.put(url, held.clone());
    }
  })));
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Only the versioned shell caches are disposable. Downloaded wikis live in
    // ardupilot-offline-* and must survive a version bump: those are hundreds
    // of megabytes the reader chose to store, and deleting them because the
    // service worker changed would be indefensible.
    await Promise.all(
      names
        .filter((name) => name.startsWith('ardupilot-') &&
                          !name.startsWith(OFFLINE_CACHE_PREFIX) &&
                          !CURRENT_CACHES.includes(name))
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
    // After claiming, so it never delays taking control.
    await warmTheme().catch(() => undefined);
    await warmThirdParty().catch(() => undefined);
  })());
});

/*
 * Streaming downloads.
 *
 * The export is built from what is already in Cache Storage into one
 * self-contained HTML file, which runs to hundreds of megabytes. Assembling
 * that in a Blob would need it all in memory at once, which is exactly the
 * thing to avoid. Instead the page hands us a ReadableStream, we answer a
 * request for /__export__/<id> with it, and the browser writes it to disk as an ordinary
 * download while the page is still generating it.
 */
const EXPORTS = new Map();

// How long an export may sit uncollected before its stream is dropped and
// the worker is released.
const EXPORT_TIMEOUT_MS = 60000;

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) {
    return;
  }
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'CACHES_CHANGED') {
    knownCacheNames = null;
    openedCaches.clear();
    markerChecked.clear();
    return;
  }
  if (data.type === 'EXPORT_START') {
    // Hold this worker alive until the download is collected.
    //
    // EXPORTS lives in the worker's memory, and a worker with nothing left to
    // do is terminated within milliseconds. The page posts the stream here and
    // then builds an iframe to fetch it, and that gap was enough: the worker
    // died, a fresh instance answered the fetch with an empty map, and the
    // reply was 410. Nobody then read the stream, so the page's first write
    // blocked once the queue filled and the export hung with no error at all.
    // Measured: fetching in the same tick returned 200, fetching 300ms later
    // returned 410.
    //
    // waitUntil keeps the instance that holds the stream alive until the
    // download starts, with a cap so a save that is cancelled before it is
    // collected cannot pin a worker indefinitely.
    let collected;
    const untilCollected = new Promise((resolve) => { collected = resolve; });
    EXPORTS.set(data.id, {
      stream: data.stream, filename: data.filename, collected: collected,
    });
    event.waitUntil(Promise.race([
      untilCollected,
      new Promise((resolve) => setTimeout(resolve, EXPORT_TIMEOUT_MS)),
    ]));
    setTimeout(() => EXPORTS.delete(data.id), EXPORT_TIMEOUT_MS);
  }
});

function isImage(url) {
  return /\/(_images|images)\//.test(url.pathname) ||
         /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(url.pathname);
}

// Named extensions rather than "looks like it has one": pages here are called
// things like common-msp-osd-overview-4.2, and treating that trailing .2 as an
// extension is how the first attempt at this still missed them.
const ASSET_EXT_RE =
  /\.(html?|css|m?js|json|xml|txt|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|tar|mp4|webm)$/i;

/*
 * Every shape one URL can have been stored under.
 *
 * Two separate things used to be true at once. A page could be addressed
 * without its extension, because a host that canonicalises URLs leaves the
 * reader on /rover/docs/foo while the archive stored /rover/docs/foo.html.
 * And an image shared by several wikis is stored once, under /_common/, while
 * every page still asks for it by that page's own wiki.
 *
 * Both are the same question: where else might this be? Answering it in one
 * place is the point. When they were separate lookups they drifted, and the
 * image path never consulted the download at all.
 */
function storedShapes(url) {
  const path = url.pathname;
  const out = [path];

  if (path.endsWith('/')) {
    out.push(path + 'index.html', path.slice(0, -1) + '.html');
  } else if (!ASSET_EXT_RE.test(path)) {
    out.push(path + '.html', path + '/index.html');
  }

  // Shared images live once under /_common/_images/, however many wikis use
  // them; the shared set is hundreds of megabytes and nearly every wiki
  // references most of it.
  const shared = path.replace(/^\/[^/]+\/_images\//, '/_common/_images/');
  if (shared !== path) {
    out.push(shared);
  }
  return out;
}


/*
 * The one cache that can hold a given path. caches.match() with no name walks
 * every cache (692ms across fourteen downloads vs 89ms asking the single cache
 * that can hold it). The path says which - /sub/docs/x.html is only in the sub
 * download - so ask it directly, exhaustive search as fallback.
 */
function likelyCacheName(path) {
  if (path.startsWith('/_common/')) {
    return OFFLINE_CACHE_PREFIX + 'common';
  }
  const first = path.split('/')[1];
  return first ? OFFLINE_CACHE_PREFIX + first : null;
}

// Memoised for this worker's lifetime. caches.open() CREATES a cache that does
// not exist, which would litter storage with empty ones, so the real names are
// checked first. A wiki downloaded after this was filled is simply missed here
// and found by the exhaustive fallback, so the memo can never cause a wrong
// answer, only a slower one.
let knownCacheNames = null;
const openedCaches = new Map();

/*
 * The panel writes /__ap_complete__ only after every file of a download is in
 * place, and its whole accounting is built on it: entries without the marker
 * are an aborted or quota-killed download, not a copy anyone can rely on.
 *
 * This worker used to ignore the marker entirely and go by cache NAME alone,
 * which split the feature into two halves that disagreed about what "saved"
 * means. Observed directly: a half-written cache served its fragment of a page
 * in preference to the network, while the panel - which does check - read
 * "no wikis saved" and offered no way to see or remove what was being served.
 *
 * So an offline cache is consulted only once its marker has been seen. The
 * check runs once per cache name and the verdict is remembered; a download
 * completing in the meantime is picked up when the panel's COMPLETE message
 * resets this state, as it already resets knownCacheNames.
 */
const markerChecked = new Map();

async function isComplete(name) {
  if (!markerChecked.has(name)) {
    markerChecked.set(name, (async () => {
      const cache = await caches.open(name);
      return !!(await cache.match('/__ap_complete__'));
    })());
  }
  return markerChecked.get(name);
}

async function offlineCacheFor(path) {
  const name = likelyCacheName(path);
  if (!name) {
    return undefined;
  }
  if (!knownCacheNames) {
    knownCacheNames = new Set(await caches.keys());
  }
  if (!knownCacheNames.has(name)) {
    return undefined;
  }
  if (!(await isComplete(name))) {
    return undefined;
  }
  if (!openedCaches.has(name)) {
    openedCaches.set(name, caches.open(name));
  }
  return openedCaches.get(name);
}

/*
 * The one answer to "is this held offline", for every resource. Pages and images
 * having separate lookups once left 123 of rover's 123 images missing offline
 * while every page resolved. Pass a cache to look only there; pass none to search
 * every cache, which finds a downloaded wiki.
 *
 * Exact matches only: ignoring the query string was redundant (no stored key has
 * one: 0 of 1,059) and expensive - it disables the key hash and walks the whole
 * cache. Measured on twelve saved wikis, exact vs ignore-query:
 *   cache.match(path)    0.1-0.3 ms  vs   63-79 ms
 *   caches.match(path)   0.1-0.3 ms  vs  307-325 ms   (the fallback below)
 * The cost grows with wikis saved - instant with one, sluggish with twelve.
 */
async function heldOffline(request, cache) {
  const shapes = storedShapes(new URL(request.url));

  if (cache) {
    for (const path of shapes) {
      const hit = await cache.match(path);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  // Ask the one cache that can hold each shape before searching them all.
  for (const path of shapes) {
    const only = await offlineCacheFor(path);
    if (only) {
      const hit = await only.match(path);
      if (hit) {
        return hit;
      }
    }
  }

  // Fallback: a wiki downloaded since this worker started, or anything stored
  // somewhere the path does not predict. Searched cache by cache rather than
  // with the global caches.match, because that would happily answer from a
  // half-written download the named path above just refused.
  const names = await caches.keys();
  for (const name of names) {
    if (name.startsWith(OFFLINE_CACHE_PREFIX) && !(await isComplete(name))) {
      continue;
    }
    const candidate = await caches.open(name);
    for (const path of shapes) {
      const hit = await candidate.match(path);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
}

function isPage(url) {
  return /\.html?$/.test(url.pathname) || url.pathname.endsWith('/');
}

function isStatic(url) {
  // .js and .css are handled earlier, network-first. This covers fonts and the
  // rest of _static, which are large, change rarely, and are safe from cache.
  return /\/(_static|fonts)\//.test(url.pathname);
}

/** Tell every open page under this scope that a resource changed. */
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.postMessage(message));
}

/**
 * Serve the cached copy at once, refresh in the background, and speak up only if
 * the refreshed copy differs. `event` is required, not optional: the browser
 * kills a worker once its last respondWith settles, so without event.waitUntil
 * the unawaited revalidation was abandoned every time and the page cache never
 * filled (measured: one entry, /sw.js, after a whole session - every page came
 * from the saved wiki, so content stayed hours stale and PAGE_UPDATED never fired).
 */
async function staleWhileRevalidate(request, cacheName, announceChanges, event) {
  const cache = await caches.open(cacheName);
  // Serve what this page cached while reading, else what a downloaded wiki holds.
  // The two sources are split on purpose: a PAGE_CACHE copy came from the
  // network, so comparing it to a fresh fetch tells you if the page changed. The
  // OFFLINE copy is the archive's REWRITTEN page (donate button a link, videos
  // stills), so it never matches the original and would report "changed" on
  // every page a saved wiki holds - the false toast. Only page-cache is announceable.
  const fromPageCache = await heldOffline(request, cache);
  const cached = fromPageCache || (await heldOffline(request));

  // Clone NOW, while the body is certainly untouched.
  //
  // The comparison below runs inside the background fetch, which settles long
  // after this function has handed `cached` back to the browser. By then the
  // browser has read it to render the page, so cloning it there threw
  // "Response body is already used", the whole revalidation rejected, and the
  // put that follows never ran. The page cache therefore never filled: on the
  // mirror it held one entry after a session of browsing, and it was /sw.js.
  //
  // The effect was that a saved wiki shadowed the live site permanently. Pages
  // stayed hours stale against a server rebuilt repeatedly, video stills never
  // gave way to real embeds, and PAGE_UPDATED never fired once. The old comment
  // here claimed the comparison happened "before either body is consumed",
  // which was the intent and not what the code did.
  const cachedForCompare = (announceChanges && fromPageCache) ? fromPageCache.clone() : null;

  /*
   * The refresh has to reach the server.
   *
   * A fetch made inside the worker does not re-enter this handler, but it does
   * go through the browser's HTTP cache, and the wiki's HTML carries no
   * Cache-Control at all: only an ETag and a Last-Modified. So the browser
   * caches it heuristically and answered the refresh from its own stale copy,
   * which was then written into the page cache. The revalidation ran, stored
   * something, and left the reader exactly as behind as before.
   *
   * 'no-cache' means revalidate, not bypass: the ETag still goes up and an
   * unchanged page still comes back as a 304, so this costs a conditional
   * request rather than a download.
   *
   * Only when there is a cached copy to refresh. With nothing stored, the
   * response below is what the reader gets, and a navigation request is passed
   * through untouched for the reasons networkOnly explains.
   */
  const refresh = cached
    ? new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : request;

  const network = fetch(refresh).then(async (response) => {
    if (!response || !response.ok) {
      return response;
    }
    if (cachedForCompare) {
      const [oldText, newText] = await Promise.all([
        cachedForCompare.text(),
        response.clone().text(),
      ]);
      if (oldText !== newText) {
        notifyClients({ type: 'PAGE_UPDATED', url: request.url });
      }
    }
    if (plausibleBody(request, response)) {
      await keep(cacheName, request, response);
    }
    return response;
  }).catch((err) => {
    // Swallowing this silently is how a broken revalidation stayed invisible:
    // the page still rendered, from the copy we already had, so nothing looked
    // wrong while the cache quietly never filled.
    console.warn('[sw] revalidate failed for', request.url, err && err.message);
    return undefined;
  });

  // Without this the browser may terminate the worker the moment the cached
  // copy is handed back, and the fetch above is dropped on the floor.
  keepAlive(event, network, request.url);

  if (cached) {
    return cached;
  }

  // Nothing in the page cache, so try the network - but not forever on a bad
  // link.
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  const response = await Promise.race([network, timeout]);
  if (response) {
    return unredirect(response);
  }

  return (await caches.match('/offline-fallback.html')) ||
         new Response('Offline and this page has not been saved.', {
           status: 503,
           headers: { 'Content-Type': 'text/plain' },
         });
}

/*
 * The browser rejects a redirected response for a navigation ("a redirected
 * response was used..."), leaving the client with no controlling worker. This
 * site redirects (308 /x.html to /x), so rebuild the response to drop the
 * redirected flag while keeping the body, status and headers.
 */
function unredirect(response) {
  if (!response || !response.redirected) {
    return response;
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/** Always ask the network; use a cached copy only if there is no network. */
async function networkOnly(request) {
  try {
    // fetch(request, init) builds a *new* Request from this one, and
    // constructing a Request whose mode is 'navigate' throws a TypeError. The
    // handler then rejects, the browser quietly falls back to its own network
    // load, and - the part that actually bites - the page ends up with no
    // controlling service worker at all. Pass the request through untouched.
    const response = await fetch(request);
    if (response && response.ok && plausibleBody(request, response)) {
      await keep(PAGE_CACHE, request, response);
    }
    return unredirect(response);
  } catch (err) {
    return (await heldOffline(request)) ||
           (await caches.match('/offline-fallback.html')) ||
           new Response('Offline.', { status: 503 });
  }
}

/*
 * Serve the previous copy at once and fetch a new one behind it.
 *
 * For cross-origin resources whose URL carries a cache-busting query: matching
 * has to ignore the query or every request is a miss by construction, and the
 * copy stored has to be keyed the same way or the cache grows without bound,
 * one entry per page view.
 */
async function freshBehind(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const key = new URL(request.url);
  key.search = '';
  const stored = await cache.match(key.href);

  const network = fetch(request)
    .then(async (response) => {
      if (response && (response.ok || response.type === 'opaque') &&
          plausibleBody(request, response)) {
        await keep(cacheName, key.href, response);
      }
      return response;
    })
    .catch(() => undefined);

  // As in staleWhileRevalidate: answered from storage, so nothing awaits the
  // refresh, so the worker has to be told to stay alive for it.
  keepAlive(event, network, request.url);

  if (stored) {
    return stored;
  }
  return (await network) || new Response('', { status: 504 });
}

async function cacheFirst(request, cacheName) {
  // Exact match first, by the whole URL.
  //
  // heldOffline answers by path shape and deliberately ignores the origin,
  // because that is what lets /rover/_images/x.png find the shared copy under
  // /_common/. A cross-origin asset is stored under its full URL, so that
  // lookup can never match one: the analytics script was re-fetched on every
  // page, 1.2 to 2.5 seconds each time, while appearing to be cached.
  const named = await caches.open(cacheName);
  const exact = await named.match(request);
  if (exact) {
    return exact;
  }

  // One lookup, every cache, every shape: the runtime image cache and a
  // downloaded wiki are both just places this might already be.
  const held = await heldOffline(request);
  if (held) {
    // Promote it. Answering from a downloaded wiki means a shape lookup across
    // caches on EVERY request, because nothing else ever fills this one:
    // measured 84ms for jquery.js served that way against 2ms for a stylesheet
    // already here. Under stale-while-revalidate the background fetch used to
    // populate it, so switching to cache-first quietly removed the only thing
    // that did.
    //
    // Guarded like every network write, and this one especially: it copies
    // into the VERSIONED cache, where a wrong body outlives the wiki it came
    // from and survives until CACHE_VERSION changes. This exact path was used
    // to poison ardupilot-static with a text/html "stylesheet" while the
    // guard on the fetch paths stood intact - a saved wiki is one more source
    // of bytes, not a trusted one. Served either way: a bad decoration
    // renders wrong once, which is strictly better than permanently.
    if (plausibleBody(request, held)) {
      await named.put(request, held.clone());
    }
    return held;
  }
  try {
    const response = await fetch(request);
    // An opaque cross-origin response reports ok === false and status 0. It is
    // still perfectly usable by an <img> or <script>, and storing it is the
    // whole point here, so accept that shape as well as a real 200.
    if (response && (response.ok || response.type === 'opaque') &&
        plausibleBody(request, response)) {
      await named.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return (await heldOffline(request)) || new Response('', { status: 504 });
  }
}

/*
 * Any handler that throws makes respondWith reject. The browser then falls back
 * to its own network load, which looks harmless - the page still appears - but
 * that client ends up with NO controlling service worker, so offline support
 * and streaming downloads silently stop working for it.
 *
 * That is exactly what a single bad fetch() call did here. So every strategy is
 * wrapped: whatever goes wrong, we always resolve to a Response, and a mistake
 * in a caching strategy can never cost us control of the page.
 */
/*
 * Does this response look like the thing that was asked for?
 *
 * A request for a stylesheet that comes back as text/html is never legitimate,
 * whatever produced it, and storing one is how a cache poisons itself. Because
 * static assets are served cache-first, a single bad answer is kept and served
 * for as long as the cache name stays the same, which is indefinitely.
 *
 * The case this is really aimed at is captive wifi: hotels, airports and
 * conference networks answer every request with their own login page, at 200.
 * A reader who opens the wiki behind one of those would otherwise have their
 * stylesheets and scripts permanently replaced by a login page, and would see
 * an unstyled site long after leaving the building.
 *
 * Deliberately narrow. It rejects only on a positive contradiction: no content
 * type at all proves nothing, an unrecognised extension proves nothing, and an
 * opaque cross-origin response exposes no headers and is stored on purpose.
 */
const CONTENT_EXPECTATIONS = [
  [/\.css$/i, /^text\/css/],
  [/\.m?js$/i, /^(?:application|text)\/(?:x-)?(?:java|ecma)script/],
  [/\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/i, /^image\//],
  [/\.json$/i, /^application\/json/],
];

function plausibleBody(request, response) {
  if (!response || response.type === 'opaque') { return true; }
  const ct = (response.headers && response.headers.get('Content-Type') || '')
    .toLowerCase();
  if (!ct) { return true; }
  let path;
  try {
    path = new URL(typeof request === 'string' ? request : request.url).pathname;
  } catch (err) {
    return true;
  }
  for (const [pattern, expected] of CONTENT_EXPECTATIONS) {
    if (pattern.test(path)) {
      if (expected.test(ct)) { return true; }
      console.warn('[sw] refusing to cache', path, 'served as', ct);
      return false;
    }
  }
  return true;
}

/*
 * Ask the browser to keep this worker alive for a background refresh, and treat
 * a refusal as the non-event it is.
 *
 * Both callers reach this from inside an async function, so the fetch handler
 * has already returned by the time it runs. The spec permits that while
 * respondWith is still pending, and all three engines accept it today. The
 * guard is here because the cost of being wrong is out of proportion to the
 * benefit: waitUntil is an optimisation, and if one ever threw, the exception
 * would reject the handler, safely() would catch it and go to the network, and
 * stale-while-revalidate would quietly become fetch-twice. Caught, the worst
 * case is the behaviour without waitUntil at all - the refresh may be cut short
 * if the browser stops the worker.
 *
 * Not swallowed silently, so that if it ever does fire it is findable.
 */
function keepAlive(event, promise, url) {
  if (!event || typeof event.waitUntil !== 'function') {
    return;
  }
  try {
    event.waitUntil(promise);
  } catch (err) {
    console.warn('[sw] waitUntil refused for', url, err && err.name);
  }
}

/*
 * Store a copy, and never let failing to store change what the reader gets.
 *
 * Every route here fetches, stores, and returns, with the store inside the same
 * try as the fetch. That reads harmlessly and is not: cache.put() throws
 * QuotaExceededError when storage is full, and the throw lands in the catch
 * written for a *network* failure. A request that succeeded on the network is
 * then answered from the offline path - 504, or the offline page - while the
 * reader is online and the response is sitting right there.
 *
 * Whose problem this is, concretely: WebKit reports a 1.0 GB quota against the
 * 697 MB of archives this feature invites people to save. A reader near that
 * line would find search breaking online, and the site telling them they were
 * offline when they were not, on exactly the browser least able to spare the
 * space. Chromium and Firefox report 6.5 GB and 10.7 GB on the same machine,
 * which is why it would never have shown up here.
 *
 * Caching is an optimisation. It fails open.
 */
async function keep(cacheName, key, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, response.clone());
  } catch (err) {
    console.warn('[sw] could not store', String(key && key.url ? key.url : key),
                 err && err.name);
  }
}

/*
 * Whether the catch-all route may keep a copy.
 *
 * Two things must never be stored here. The archives under /offline/ are the
 * downloads themselves - 439 MB for common alone - and keeping a second copy
 * beside the cache it was unpacked into would double what a reader pays for
 * every wiki they save. And offline-manifest.json is how staleness is
 * detected, which is why it is fetched no-cache; the download code compares
 * the build it names against what is stored, so a copy of it stored here is a
 * copy that can disagree.
 *
 * The size cap is for everything unforeseen. searchindex.js, the file this
 * route exists to keep, is about 1.1 MB per wiki; anything an order of
 * magnitude past that is not a document and should not land here by accident.
 */
const NEVER_STORE = /^\/offline\//;
const STORE_LIMIT_BYTES = 12 * 1024 * 1024;

function storable(url, response) {
  if (NEVER_STORE.test(url.pathname)) {
    return false;
  }
  const len = Number(response.headers.get('Content-Length'));
  return !(len > STORE_LIMIT_BYTES);
}

function safely(handler, request) {
  return handler.catch(async (err) => {
    console.warn('[sw] handler failed, passing through', err);
    try {
      return await fetch(request);
    } catch (netErr) {
      return (await heldOffline(request)) ||
             (await caches.match('/offline-fallback.html')) ||
             new Response('Offline.', { status: 503 });
    }
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.pathname.startsWith('/__export__/')) {
    const id = url.pathname.slice('/__export__/'.length);
    const entry = EXPORTS.get(id);
    if (entry) {
      EXPORTS.delete(id);
      // The stream is being read now, so the waitUntil above can settle; the
      // response itself keeps the worker alive for as long as it streams.
      if (entry.collected) { entry.collected(); }
      event.respondWith(new Response(entry.stream, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition':
            'attachment; filename="' + entry.filename.replace(/"/g, '') + '"'
        }
      }));
    } else {
      event.respondWith(new Response('Export expired.', { status: 410 }));
    }
    return;
  }
  if (url.origin !== self.location.origin) {
    // Third-party assets are the slowest thing on a page. Measured on a real
    // rover page: the licence badge from creativecommons.org took 509ms and
    // the analytics script 435ms, on every navigation, because a cross-origin
    // request was handed straight back to the network.
    //
    // Static ones can be served from cache after the first visit. The response
    // is opaque - status 0, body unreadable - which is fine for an <img> or a
    // <script>, and is why they are only ever stored, never inspected.
    //
    // Deliberately NOT cached: firmware.ardupilot.org/useralerts, which is
    // fetched with a cache-busting query precisely because an alert has to be
    // current. Making that stale would be a safety problem, not a speed win.
    if (THIRD_PARTY_STATIC.test(url.href)) {
      event.respondWith(safely(cacheFirst(request, THIRD_PARTY_CACHE), request));
    } else if (THIRD_PARTY_FRESH.test(url.href)) {
      event.respondWith(safely(freshBehind(request, THIRD_PARTY_CACHE, event), request));
    }
    return;
  }

  // The offline manager is an application screen: its markup and its script
  // have to match, and a cached copy of one paired with a fresh copy of the
  // other renders as garbage. Those, and the worker itself, take the network
  // first and fall back to cache only when there is none.
  //
  // Scoped to exactly those files, and no longer to every .js and .css on the
  // site. Applying it site-wide meant about ten network requests per page for
  // jQuery and the theme, which is most of what made navigation feel slow: one
  // page measured 1,501ms with no third-party requests at all. Sphinx stamps
  // its static assets with a content hash (?v=5d32c60e), so a cached copy is
  // only ever the copy that hash asked for, and serving it from cache cannot
  // pair the wrong script with the wrong markup.
  // A differential update has to reach the server. Its whole purpose is to
  // replace the copy held locally, so answering it from that copy makes the
  // update a silent no-op: it fetches, stores what it already had, and reports
  // success while changing nothing. Found exactly that way, by an update that
  // said "Updated 9 files" and left all nine untouched.
  if (url.searchParams.has(UPDATE_PARAM)) {
    // Deliberately WITHOUT the cache fallback every other route gets. safely()
    // answers a failed network request from storage, which is right everywhere
    // else and exactly wrong here: it hands back the stale copy the update is
    // replacing, the caller stores it over itself, and the update reports
    // success having changed nothing. Seen intermittently, one file in nine.
    // Letting it fail is what allows the caller to retry or fall back to the
    // archive.
    event.respondWith(fetch(request));
    return;
  }

  /*
   * An asset the theme asks for and does not ship.
   *
   * sphinx_rtd_theme's ardupilot.css sets
   *   background: url(../images/mainnav-sep-2.gif) repeat-y right
   * and the installed package has no static/images directory at all, so the
   * file does not exist and never has. It is a decorative separator in the top
   * menu, and its absence is invisible.
   *
   * What is not invisible is the cost. It is requested on every page of every
   * wiki, and on a page otherwise served entirely from storage it was the only
   * thing left going to the network: one round trip, measured at 28 ms, to be
   * told 404. Offline it fails instead, which puts an error in the console that
   * reads like a fault in the offline feature.
   *
   * So answer it here, instantly, with a transparent pixel. Narrow on purpose:
   * one exact filename, and it goes the moment the theme ships the file.
   * Recorded in scripts/tests/KNOWN_UPSTREAM_ISSUES.md.
   */
  if (url.pathname.endsWith('/_static/images/mainnav-sep-2.gif')) {
    event.respondWith(new Response(
      Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
                      (c) => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/gif',
                   'Cache-Control': 'public, max-age=31536000' } }));
    return;
  }

  // Site-wide, on every page, and not paired with any markup. Served from
  // storage at once and refreshed behind, which took it from 28 ms to the few
  // milliseconds every other stored asset costs.
  if (url.pathname === '/js/pwa.js') {
    event.respondWith(safely(staleWhileRevalidate(request, STATIC_CACHE, false, event), request));
    return;
  }

  if (APP_ASSET.test(url.pathname)) {
    event.respondWith(safely(networkOnly(request), request));
    return;
  }

  // Routed on what the URL is, not only on how it was asked for. A fetch()
  // from a page presents mode "cors" and an empty destination, so prefetching
  // matched none of this and was stored nowhere: the whole point of fetching
  // early is that the click afterwards finds it already here.
  if (request.mode === 'navigate' || request.destination === 'document' ||
      isPage(url)) {
    event.respondWith(safely(staleWhileRevalidate(request, PAGE_CACHE, true, event), request));
    return;
  }

  if (isImage(url)) {
    event.respondWith(safely(cacheFirst(request, IMAGE_CACHE), request));
    return;
  }

  if (isStatic(url)) {
    // Cache-first, not stale-while-revalidate. Sphinx stamps these with a
    // content hash (?v=5d32c60e), so the URL changes whenever the bytes do and
    // a stored copy can never be the wrong one. Revalidating anyway meant a
    // background request for every stylesheet, script and font on every page,
    // roughly twenty per navigation, that could not by construction find
    // anything new.
    event.respondWith(safely(cacheFirst(request, STATIC_CACHE), request));
    return;
  }

  /*
   * Anything else a saved wiki holds.
   *
   * searchindex.js and objects.inv sit at a wiki's root, so they match none of
   * the routes above: not a page, not an image, not under _static. They were
   * therefore never served from storage, and with no network the browser's own
   * load simply failed. Offline search was broken the whole time, silently, by
   * a file that was sitting in the archive the entire time.
   *
   * Network first, so nothing about the online path changes: this only decides
   * what happens when the fetch fails.
   */
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      /*
       * Store what came back, or this route can only ever answer from a
       * downloaded archive.
       *
       * search.html calls Search.loadIndex("searchindex.js") and nothing else
       * on the site requests that file, so it reached this route, went to the
       * network, and was put nowhere. A reader who searched while online and
       * then lost the connection lost search with it - the pages were all in
       * the page cache, and the index that makes them findable was not.
       * Caching as you read is supposed to mean everything you read.
       */
      if (response && response.ok && storable(url, response) &&
          plausibleBody(request, response)) {
        await keep(STATIC_CACHE, request, response);
      }
      return response;
    } catch (err) {
      return (await heldOffline(request)) || new Response('', { status: 504 });
    }
  })());
});
