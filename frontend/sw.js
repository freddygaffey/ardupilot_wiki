/*
 * Service worker for the ArduPilot wiki. Pages: stale-while-revalidate, telling
 * the page when the refreshed copy differs. Images and fingerprinted static
 * assets: cache first. Saved wikis (ardupilot-offline-*) are served from their
 * own caches. One request per resource per navigation; nothing crawls.
 */

// Bump when cached CONTENT can no longer be trusted, not on every edit: activate
// deletes caches by name, so a poisoned entry in a current cache lives until
// this changes. Saved wikis are unversioned and unaffected.
const CACHE_VERSION = 'v11';
const PAGE_CACHE = `ardupilot-pages-${CACHE_VERSION}`;
const IMAGE_CACHE = `ardupilot-images-${CACHE_VERSION}`;
const STATIC_CACHE = `ardupilot-static-${CACHE_VERSION}`;
// Cross-origin assets that never change.
const THIRD_PARTY_CACHE = `ardupilot-thirdparty-${CACHE_VERSION}`;
const THIRD_PARTY_STATIC =
  /^https:\/\/(i\.creativecommons\.org\/|licensebuttons\.net\/|www\.paypalobjects\.com\/)/;
// The offline page and its scripts: network-only, because a cached script
// against fresh markup renders as garbage. pwa.js pairs with nothing and is
// stale-while-revalidate below.
const APP_ASSET =
  /(^\/sw\.js$|common_offline(\.css|_page\.js|_export\.js|_document_builder\.js|_unpack\.js|_update\.js)$|common-offline(\.html)?$)/;
// Marks a differential-update request, which must not be answered from cache.
const UPDATE_PARAM = 'ap-update';
const THIRD_PARTY_FRESH = /^https:\/\/firmware\.ardupilot\.org\/useralerts\//;
const CURRENT_CACHES = [PAGE_CACHE, IMAGE_CACHE, STATIC_CACHE, THIRD_PARTY_CACHE];
// Saved wikis, unversioned so they outlive worker updates.
const OFFLINE_CACHE_PREFIX = 'ardupilot-offline-';

// Deliberately short; everything else is cached as it is visited.
const SHELL = [
  '/',
  '/offline-fallback.html',
  '/manifest.json',
  '/android-icon-192x192.png',
  '/icon-512x512.png',
  '/js/pwa.js',
];

// Network wait for a page that is not cached yet.
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener('install', (event) => {
  // Static documents, so swapping workers immediately is harmless and keeps a
  // bad worker easy to displace.
  self.skipWaiting();

  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // One at a time: addAll() rejects the batch on a single 404.
    await Promise.all(SHELL.map((url) =>
      cache.add(url).catch((err) => console.warn('[sw] shell precache failed', url, err))
    ));
  })());
});

// Theme assets every page loads, warmed once after activation.
const WARM_PER_WIKI = [
  '_static/css/theme.css',
  '_static/js/theme.js',
  '_static/jquery.js',
  '_static/doctools.js',
  '_static/sphinx_highlight.js',
  '_static/common_theme_override.css',
];

// Third-party decoration on every page; the donate button alone was 138 ms.
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
    // A saved wiki is a source of bytes, not a trusted one.
    if (held && plausibleBody(new Request(url), held)) {
      await cache.put(url, held.clone());
    }
  })));
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Only the versioned caches are disposable; saved wikis survive a bump.
    await Promise.all(
      names
        .filter((name) => name.startsWith('ardupilot-') &&
                          !name.startsWith(OFFLINE_CACHE_PREFIX) &&
                          !CURRENT_CACHES.includes(name))
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
    await warmTheme().catch(() => undefined);
    await warmThirdParty().catch(() => undefined);
  })());
});

// Streaming exports: the page hands over a ReadableStream, we answer
// /__export__/<id> with it, and the browser writes the file as it is generated
// instead of holding hundreds of megabytes in a Blob.
const EXPORTS = new Map();

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
    // EXPORTS is in-memory, and an idle worker is terminated within
    // milliseconds, so hold this instance alive until the download is
    // collected, with a cap for a cancelled save.
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

// Named extensions: page names like common-msp-osd-overview-4.2 end in ".2".
const ASSET_EXT_RE =
  /\.(html?|css|m?js|json|xml|txt|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|tar|mp4|webm)$/i;

// Every shape one URL can have been stored under: with and without .html or
// index.html, and shared images once under /_common/.
function storedShapes(url) {
  const path = url.pathname;
  const out = [path];

  if (path.endsWith('/')) {
    out.push(path + 'index.html', path.slice(0, -1) + '.html');
  } else if (!ASSET_EXT_RE.test(path)) {
    out.push(path + '.html', path + '/index.html');
  }

  const shared = path.replace(/^\/[^/]+\/_images\//, '/_common/_images/');
  if (shared !== path) {
    out.push(shared);
  }
  return out;
}


// The one cache that can hold a path: caches.match() across fourteen saved
// wikis was 692 ms against 89 ms asking the right cache directly.
// Kept in step with FOLD_INTO_COMMON in scripts/build_offline_artifacts.py;
// drift costs speed, not correctness.
const FOLDED_INTO_COMMON = new Set(['ardupilot']);

function likelyCacheName(path) {
  if (path.startsWith('/_common/')) {
    return OFFLINE_CACHE_PREFIX + 'common';
  }
  const first = path.split('/')[1];
  if (!first) {
    return null;
  }
  return OFFLINE_CACHE_PREFIX + (FOLDED_INTO_COMMON.has(first) ? 'common' : first);
}

// caches.open() creates a missing cache, so real names are checked first. A
// stale memo costs a slower lookup, never a wrong one.
let knownCacheNames = null;
const openedCaches = new Map();

// A saved wiki is consulted only once its /__ap_complete__ marker exists;
// without it the cache is an aborted download. Reset by CACHES_CHANGED.
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

// The unpacker stores text gzipped (455 MB -> 57 MB, inside WebKit's 1 GB
// quota). Inflated here: no engine honours Content-Encoding on a body a worker
// hands back. Under 1 ms for an ordinary page.
const AP_ENCODED = 'x-ap-encoding';

function inflate(response) {
  if (!response || !response.headers ||
      response.headers.get(AP_ENCODED) !== 'gzip') {
    return response;
  }
  if (typeof DecompressionStream !== 'function') {
    console.warn('[sw] stored compressed but this browser cannot inflate');
    return undefined;
  }
  const headers = new Headers(response.headers);
  headers.delete(AP_ENCODED);
  return new Response(
    response.body.pipeThrough(new DecompressionStream('gzip')),
    { status: 200, statusText: 'OK', headers }
  );
}

// The one answer to "is this held offline". Pass a cache to look only there,
// none to search every complete saved wiki. Exact matches: ignoreSearch walks
// the whole cache (0.2 ms vs 300 ms with twelve wikis saved).
async function heldOffline(request, cache) {
  const shapes = storedShapes(new URL(request.url));

  if (cache) {
    for (const path of shapes) {
      const hit = await cache.match(path);
      if (hit) {
        return inflate(hit);
      }
    }
    return undefined;
  }

  for (const path of shapes) {
    const only = await offlineCacheFor(path);
    if (only) {
      const hit = await only.match(path);
      if (hit) {
        return inflate(hit);
      }
    }
  }

  // Cache by cache, not caches.match(): that would answer from a half-written
  // download the check above refused.
  const names = await caches.keys();
  for (const name of names) {
    if (name.startsWith(OFFLINE_CACHE_PREFIX) && !(await isComplete(name))) {
      continue;
    }
    const candidate = await caches.open(name);
    for (const path of shapes) {
      const hit = await candidate.match(path);
      if (hit) {
        return inflate(hit);
      }
    }
  }
  return undefined;
}

function isPage(url) {
  return /\.html?$/.test(url.pathname) || url.pathname.endsWith('/');
}

// The version index behind the dropdown on every parameters page.
const PARAM_INDEX = /^\/([^/]+)\/_static\/parameters-[A-Za-z0-9_]+\.json$/;

// Offline, answer the version index with only the versions held: historical
// parameter pages are opt-in, and 66 of the pages are frozen HTML no template
// can reach, so the filter lives here. Network first; nothing filtered is stored.
async function paramIndex(request, url) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      await keep(STATIC_CACHE, request, fresh.clone());
      return fresh;
    }
  } catch (err) {
    // Offline; fall through to the stored index.
  }

  const held = await heldOffline(request);
  if (!held) {
    return undefined;
  }

  let index;
  try {
    index = await held.clone().json();
  } catch (err) {
    return held;               // not the shape we expected; do not mangle it
  }

  const wiki = url.pathname.split('/')[1];
  const out = {};
  for (const label of Object.keys(index)) {
    // Values are bare filenames relative to docs/.
    const target = new URL('/' + wiki + '/docs/' + index[label], url.origin);
    if (await heldOffline(new Request(target.href))) {
      out[label] = index[label];
    }
  }

  // An empty dropdown is worse than an over-full one.
  if (!Object.keys(out).length) {
    return held;
  }

  return new Response(JSON.stringify(out), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' }
  });
}

function isStatic(url) {
  return /\/(_static|fonts)\//.test(url.pathname);
}

/** Tell every open page under this scope that a resource changed. */
async function notifyClients(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.postMessage(message));
}

/**
 * Serve the cached copy at once, refresh behind, and announce a difference.
 * `event` is required: without waitUntil the browser kills the worker before
 * the refresh lands and the page cache never fills.
 */
async function staleWhileRevalidate(request, cacheName, announceChanges, event) {
  const cache = await caches.open(cacheName);
  // Only a PAGE_CACHE copy is comparable to the network: a saved wiki's page is
  // the archive's rewritten version and would always read as "changed".
  const fromPageCache = await heldOffline(request, cache);
  const cached = fromPageCache || (await heldOffline(request));

  // Clone now: by the time the refresh settles the browser has consumed the
  // body that was handed back.
  const cachedForCompare = (announceChanges && fromPageCache) ? fromPageCache.clone() : null;

  // 'no-cache' so the refresh revalidates with the server instead of the HTTP
  // cache (the wiki's HTML has no Cache-Control). Navigations with nothing
  // stored pass through untouched, see networkOnly.
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
    console.warn('[sw] revalidate failed for', request.url, err && err.message);
    return undefined;
  });

  keepAlive(event, network, request.url);

  if (cached) {
    return cached;
  }

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

// A navigation may not be answered with a redirected response, so rebuild it
// without the flag.
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
    // Untouched: fetch(request, init) rebuilds the Request, and a rebuilt
    // 'navigate' request throws, which would leave the page uncontrolled.
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

// Stale-while-revalidate for cross-origin URLs with a cache-busting query,
// keyed without it so the cache does not grow one entry per page view.
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

  keepAlive(event, network, request.url);

  if (stored) {
    return stored;
  }
  return (await network) || new Response('', { status: 504 });
}

async function cacheFirst(request, cacheName) {
  // Exact URL first: heldOffline matches by path and cannot find a
  // cross-origin asset stored under its full URL.
  const named = await caches.open(cacheName);
  const exact = await named.match(request);
  if (exact) {
    return exact;
  }

  const held = await heldOffline(request);
  if (held) {
    // Promote into the named cache (84 ms per lookup otherwise), guarded like a
    // network write: a saved wiki is not a trusted source.
    if (plausibleBody(request, held)) {
      await named.put(request, held.clone());
    }
    return held;
  }
  try {
    const response = await fetch(request);
    // Opaque cross-origin responses report status 0 and are still usable.
    if (response && (response.ok || response.type === 'opaque') &&
        plausibleBody(request, response)) {
      await named.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return (await heldOffline(request)) || new Response('', { status: 504 });
  }
}

// Refuse to store a body that contradicts what was asked for (a stylesheet
// served as text/html): captive wifi answers everything with a login page at
// 200, and a cache-first entry would keep it indefinitely. Narrow on purpose.
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

// Keep the worker alive for a background refresh. Called after the handler
// has returned, which every engine accepts; a refusal only shortens the refresh.
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

// Store a copy without letting a failed store (QuotaExceededError, near
// WebKit's 1 GB) change what the reader gets. Caching fails open.
async function keep(cacheName, key, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, response.clone());
  } catch (err) {
    console.warn('[sw] could not store', String(key && key.url ? key.url : key),
                 err && err.name);
  }
}

// The catch-all route never stores /offline/ (the archives themselves and the
// manifest that detects staleness) or anything far larger than a search index.
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
      // Collected: the response itself keeps the worker alive while it streams.
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
    // Static third-party decoration is cached (the licence badge was 509 ms per
    // page). User alerts must stay current, so they are only refreshed behind.
    if (THIRD_PARTY_STATIC.test(url.href)) {
      event.respondWith(safely(cacheFirst(request, THIRD_PARTY_CACHE), request));
    } else if (THIRD_PARTY_FRESH.test(url.href)) {
      event.respondWith(safely(freshBehind(request, THIRD_PARTY_CACHE, event), request));
    }
    return;
  }

  // A differential update must reach the server and must not fall back to the
  // copy it is replacing, so it gets neither the cache nor safely().
  if (url.searchParams.has(UPDATE_PARAM)) {
    event.respondWith(fetch(request));
    return;
  }

  // The theme's stylesheet asks for a separator image the theme does not ship,
  // on every page. Answer with a transparent pixel; see KNOWN_UPSTREAM_ISSUES.md.
  if (url.pathname.endsWith('/_static/images/mainnav-sep-2.gif')) {
    event.respondWith(new Response(
      Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
                      (c) => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/gif',
                   'Cache-Control': 'public, max-age=31536000' } }));
    return;
  }

  if (url.pathname === '/js/pwa.js') {
    event.respondWith(safely(staleWhileRevalidate(request, STATIC_CACHE, false, event), request));
    return;
  }

  if (APP_ASSET.test(url.pathname)) {
    event.respondWith(safely(networkOnly(request), request));
    return;
  }

  // Routed on the URL too: a prefetch arrives as mode "cors" with no destination.
  if (request.mode === 'navigate' || request.destination === 'document' ||
      isPage(url)) {
    event.respondWith(safely(staleWhileRevalidate(request, PAGE_CACHE, true, event), request));
    return;
  }

  if (isImage(url)) {
    event.respondWith(safely(cacheFirst(request, IMAGE_CACHE), request));
    return;
  }

  // Before isStatic: this one must try the network every time.
  if (PARAM_INDEX.test(url.pathname)) {
    event.respondWith(safely(paramIndex(request, url), request));
    return;
  }

  if (isStatic(url)) {
    // Fingerprinted (?v=5d32c60e), so a stored copy is never the wrong one.
    event.respondWith(safely(cacheFirst(request, STATIC_CACHE), request));
    return;
  }

  // Everything else, notably searchindex.js and objects.inv at a wiki's root.
  // Network first; storage only decides what happens when the fetch fails.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
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
