/* Keeps the offline till (page and files) so it opens with no connection. It only ever answers requests for the counter's own pages and
   this site's built files; everything else (the server's answers, sales) is left alone so nothing sensitive is stored here. */
const CACHE = 'qsell-offline-till-v1';
const TILL = '/admin/cash-sales/offline';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('qsell-offline-till-') && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

const isStatic = (url) => url.origin === self.location.origin && (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/fonts/') || /\.(?:woff2?|css|js|png|svg|ico)$/.test(url.pathname));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // The till's own page: the network when there is one (so it is always current), the kept copy when there is not.
  if (url.origin === self.location.origin && url.pathname === TILL && (request.mode === 'navigate' || request.destination === 'document' || request.headers.get('accept')?.includes('text/html') === true)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(request);
          if (fresh.ok) await cache.put(TILL, fresh.clone());
          return fresh;
        } catch {
          const kept = await cache.match(TILL);
          return kept ?? new Response('The till is not kept on this device yet: open Cash Sales while online with a shift open.', { status: 503, headers: { 'content-type': 'text/plain' } });
        }
      })(),
    );
    return;
  }
  // The files the page is built from: kept as they are fetched, used when there is no connection.
  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const kept = await cache.match(request);
        const fetched = fetch(request).then(async (fresh) => {
          if (fresh.ok) await cache.put(request, fresh.clone());
          return fresh;
        });
        if (kept !== undefined) {
          void fetched.catch(() => undefined);
          return kept;
        }
        return await fetched;
      })(),
    );
  }
});
