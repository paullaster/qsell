/* Shows the alerts the shop sends (a delivery at risk or late) and opens the right screen when one is tapped. Loaded by the rider app's
 * worker and by the staff alerts worker. An alert is small, carries no address, phone or payment, and its address is kept to this site. */
self.addEventListener('push', (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (e) {
    data = null;
  }
  if (data === null || typeof data !== 'object') return;
  const title = typeof data.title === 'string' && data.title !== '' ? data.title.slice(0, 80) : 'Delivery alert';
  const body = typeof data.body === 'string' ? data.body.slice(0, 200) : '';
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/';
  const tag = typeof data.tag === 'string' ? data.tag.slice(0, 100) : 'delivery-alert';
  event.waitUntil(self.registration.showNotification(title, { body, tag, renotify: true, data: { url } }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of open) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
