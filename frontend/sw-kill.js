/*
 * Kill switch. Deployed in place of sw.js it unregisters itself and clears the
 * wiki's caches on every client's next visit. Needs sw.js served no-cache.
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
