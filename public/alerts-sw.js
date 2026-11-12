/* The staff browser's alerts worker: it only shows the shop's alerts (late deliveries). It keeps no pages and handles no requests. */
importScripts('/push-handlers.js');
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
