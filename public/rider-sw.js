/* The rider app's service worker: it keeps the last copy of the rider screens and the app's own files, so a run that was opened while
 * there was signal can still be opened without it. The network always goes first, so a rider with signal sees what the shop has now;
 * the copy is used only when the network does not answer. Nothing outside the rider app (and the app's own files) is kept, and
 * nothing is kept for an answer that is not a plain success. What is done at a door while offline is kept by the app itself, not here. */
const PAGES = 'rider-app-pages-v1';
const FILES = 'rider-app-files-v1';
const KEEP = [PAGES, FILES];
const WAIT_MS = 6000;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('rider-app-') && !KEEP.includes(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

/** The same address asked for as a page and as the app's own data are two different things, so they are kept apart. */
function keyFor(request) {
  const url = new URL(request.url);
  url.hash = '';
  if (request.headers.get('rsc') !== null) url.searchParams.set('__rsc', '1');
  return new Request(url.toString());
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('slow')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function networkFirst(request, cacheName, wait) {
  const cache = await caches.open(cacheName);
  try {
    const response = await (wait ? withTimeout(fetch(request), WAIT_MS) : fetch(request));
    // Only a plain success is kept: not a redirect to the sign-in page, not an error.
    if (response.status === 200 && response.type === 'basic' && !response.redirected) await cache.put(keyFor(request), response.clone());
    return response;
  } catch (error) {
    const kept = (await cache.match(keyFor(request))) ?? (cacheName === FILES ? await cache.match(keyFor(request), { ignoreSearch: true }) : undefined);
    if (kept !== undefined) return kept;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/rider-sw.js' || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/rider' || url.pathname.startsWith('/rider/')) {
    if (url.pathname === '/rider/manifest.webmanifest') return;
    event.respondWith(
      networkFirst(request, PAGES, request.mode === 'navigate').catch(
        () => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="font-family:sans-serif;padding:1.5rem"><h1>You are offline</h1><p>This screen was not opened while you had signal, so it is not on this phone yet. Open your runs when you have signal, and they will be here next time.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      ),
    );
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) event.respondWith(networkFirst(request, FILES, false));
});

/* The app asks for a screen to be kept ahead of time (the runs on the home screen), so it can be opened later without signal. */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === null || typeof data !== 'object' || data.type !== 'keep' || typeof data.url !== 'string') return;
  const url = new URL(data.url, self.location.origin);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/rider/runs/')) return;
  event.waitUntil(fetch(new Request(url.toString(), { credentials: 'same-origin', headers: { Accept: 'text/html' } })).then(async (response) => {
    if (response.status === 200 && response.type === 'basic' && !response.redirected) await (await caches.open(PAGES)).put(keyFor(new Request(url.toString())), response);
  }).catch(() => undefined));
});
