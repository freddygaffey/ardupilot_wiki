/*
 * KILL SWITCH.
 *
 * This is not deployed under this name. It is the file you copy over sw.js
 * when the service worker has to be removed from every device that has one.
 *
 *     cp frontend/sw-kill.js frontend/sw.js     (then deploy)
 *
 * It unregisters itself and deletes every cache the wiki created. Browsers
 * re-check sw.js on navigation, so installed clients pick this up on their next
 * visit and clean themselves up without the reader doing anything.
 *
 * For it to act quickly, sw.js MUST be served with `Cache-Control: no-cache`
 * (see frontend/_headers). If sw.js is sitting in an HTTP cache somewhere, the
 * kill switch is stuck behind that cache and so is your recovery.
 *
 * Once every client has been cleaned up, restore the real sw.js.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));

    await self.registration.unregister();

    // Reload open tabs so they are served by the network from here on.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => {
      if ('navigate' in client) {
        client.navigate(client.url);
      }
    });
  })());
});

// Pass everything straight through while the cleanup happens.
self.addEventListener('fetch', () => {});
