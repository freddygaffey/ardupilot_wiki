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
 * Exports are built from what is already in Cache Storage - a single HTML file
 * or a runnable .pyz - and those run to hundreds of megabytes. Assembling one
 * in a Blob would need it all in memory at once, which is exactly the thing to
 * avoid. Instead the page hands us a ReadableStream, we answer a request for
 * /__export__/<id> with it, and the browser writes it to disk as an ordinary
 * download while the page is still generating it.
 */
const EXPORTS = new Map();

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
    EXPORTS.set(data.id, { stream: data.stream, filename: data.filename });
    // Expire an export that is never collected, so a cancelled save does not
    // pin its stream here for the lifetime of the worker.
    setTimeout(() => EXPORTS.delete(data.id), 60000);
  }
});

function isImage(url) {
  return /\/(_images|images)\//.test(url.pathname) ||
         /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(url.pathname);
}

function isStatic(url) {
  return /\/(_static|css|js|fonts)\//.test(url.pathname);
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
  const cached = await cache.match(request);

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
    return response;
  }

  // Only once the network has failed do we fall back to a downloaded archive.
  // Checking it earlier would let a wiki downloaded weeks ago permanently
  // shadow the live site: the reader would be served stale pages online, with
  // no indication why, and no amount of redeploying would reach them.
  const downloaded = await caches.match(request, { ignoreSearch: true });
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
 * Images shared between wikis are stored once, under /_common/_images/, rather
 * than copied into every wiki that references them - the shared set is around
 * 433 MB and every vehicle uses most of it, so per-wiki copies would multiply
 * that several times over. Pages still ask for /rover/_images/x.png, so a miss
 * on the per-wiki path falls back to the canonical one.
 */
async function matchSharedImage(url) {
  const shared = url.pathname.replace(/^\/[^/]+\/_images\//, '/_common/_images/');
  if (shared === url.pathname) {
    return undefined;
  }
  return caches.match(shared);
}

/** Always ask the network; use a cached copy only if there is no network. */
async function networkOnly(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) {
      const cache = await caches.open(PAGE_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return (await caches.match(request, { ignoreSearch: true })) ||
           (await caches.match('/offline-fallback.html')) ||
           new Response('Offline.', { status: 503 });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  const shared = await matchSharedImage(new URL(request.url));
  if (shared) {
    return shared;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const shared = await matchSharedImage(new URL(request.url));
    return shared || new Response('', { status: 504 });
  }
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
  if (/common-offline(\.html)?$/.test(url.pathname)) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(staleWhileRevalidate(request, PAGE_CACHE, true));
    return;
  }

  if (isImage(url)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE, false));
  }
});
