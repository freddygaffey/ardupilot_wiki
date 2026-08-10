/*
 * Service worker for the ArduPilot wiki.
 *
 * Caching policy, and the reasoning behind it:
 *
 *   pages   stale-while-revalidate. The cached copy renders immediately, and a
 *           background fetch refreshes it. If what comes back differs from what
 *           was shown, the page is told so it can offer a reload - that is what
 *           lets someone who just edited a page see the change straight away
 *           without every reader paying a network round trip first.
 *
 *   images  cache first. They are large and effectively immutable; re-fetching
 *           them on every visit is the single biggest waste we can avoid.
 *
 *   static  stale-while-revalidate. Few files, small, and they must track the
 *           theme when it changes.
 *
 * Every strategy here issues at most one request per resource per navigation,
 * which is what an ordinary browser does anyway. Nothing in this file crawls,
 * prefetches or polls. The bulk offline download is a separate, opt-in action
 * driven from the page, and it costs exactly one request for one archive.
 *
 * Bumping CACHE_VERSION discards every cache and starts clean.
 */

const CACHE_VERSION = 'v3';
const PAGE_CACHE = `ardupilot-pages-${CACHE_VERSION}`;
const IMAGE_CACHE = `ardupilot-images-${CACHE_VERSION}`;
const STATIC_CACHE = `ardupilot-static-${CACHE_VERSION}`;
const CURRENT_CACHES = [PAGE_CACHE, IMAGE_CACHE, STATIC_CACHE];
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
 * The one answer to "is this held offline", for every kind of resource.
 *
 * Pages and images having their own lookups is what let 123 of rover's 123
 * images be missing offline while every page resolved: the image path checked
 * the runtime cache and the shared-image remap, and never the cache the
 * download unpacks into. The shared images resolved through the remap, so most
 * pictures appeared and it read as scattered breakage rather than a lookup
 * that did not exist.
 *
 * Pass a cache to look only there; pass none to search every cache, which is
 * what finds a downloaded wiki.
 */
async function heldOffline(request, cache) {
  for (const path of storedShapes(new URL(request.url))) {
    const hit = cache
      ? await cache.match(path, { ignoreSearch: true })
      : await caches.match(path, { ignoreSearch: true });
    if (hit) {
      return hit;
    }
  }
  return undefined;
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
 * Serve the cached copy at once, refresh it in the background, and speak up
 * only if the refreshed copy actually differs from what was served.
 */
async function staleWhileRevalidate(request, cacheName, announceChanges) {
  const cache = await caches.open(cacheName);
  const cached = await heldOffline(request, cache);

  const network = fetch(request).then(async (response) => {
    if (!response || !response.ok) {
      return response;
    }
    if (announceChanges && cached) {
      // Compare before either body is consumed.
      const [oldText, newText] = await Promise.all([
        cached.clone().text(),
        response.clone().text(),
      ]);
      if (oldText !== newText) {
        notifyClients({ type: 'PAGE_UPDATED', url: request.url });
      }
    }
    await cache.put(request, response.clone());
    return response;
  }).catch(() => undefined);

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

  // Only once the network has failed do we fall back to a downloaded archive.
  // Checking it earlier would let a wiki downloaded weeks ago permanently
  // shadow the live site: the reader would be served stale pages online, with
  // no indication why, and no amount of redeploying would reach them.
  const downloaded = await heldOffline(request);
  if (downloaded) {
    return downloaded;
  }

  return (await caches.match('/offline-fallback.html')) ||
         new Response('Offline and this page has not been saved.', {
           status: 503,
           headers: { 'Content-Type': 'text/plain' },
         });
}

/*
 * Returning a redirected response for a navigation is rejected by the browser
 * ("a redirected response was used for a request whose redirect mode is not
 * follow"). It fails the same silent way as everything else here: the page
 * still loads via the browser's own fallback, but that client is left with no
 * controlling worker.
 *
 * This site redirects - Pages 308s /x.html to /x - so any navigation we
 * intercept can come back redirected. Rebuilding the response drops the flag
 * while keeping the body, status and headers.
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
    if (response && response.ok) {
      const cache = await caches.open(PAGE_CACHE);
      await cache.put(request, response.clone());
    }
    return unredirect(response);
  } catch (err) {
    return (await heldOffline(request)) ||
           (await caches.match('/offline-fallback.html')) ||
           new Response('Offline.', { status: 503 });
  }
}

async function cacheFirst(request, cacheName) {
  // One lookup, every cache, every shape: the runtime image cache and a
  // downloaded wiki are both just places this might already be.
  const held = await heldOffline(request);
  if (held) {
    return held;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
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
    return;
  }

  // The offline manager is an application screen: its markup and its script
  // have to match, and a cached copy of one paired with a fresh copy of the
  // other renders as garbage. Never serve it from cache while there is a
  // network - fall back only when genuinely offline.
  // All JavaScript and CSS, and the offline page itself, take the network
  // first and fall back to cache only when there is none.
  //
  // Script and markup are one unit: a cached copy of either paired with a fresh
  // copy of the other renders as nonsense, and that failure is silent and
  // confusing. Scripts are small - a few tens of kilobytes against images
  // measured in hundreds of megabytes - so serving them fresh costs almost
  // nothing, while serving them stale costs correctness.
  if (/\.(js|css)$/.test(url.pathname) || /common-offline(\.html)?$/.test(url.pathname)) {
    event.respondWith(safely(networkOnly(request), request));
    return;
  }

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(safely(staleWhileRevalidate(request, PAGE_CACHE, true), request));
    return;
  }

  if (isImage(url)) {
    event.respondWith(safely(cacheFirst(request, IMAGE_CACHE), request));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(safely(staleWhileRevalidate(request, STATIC_CACHE, false), request));
  }
});
