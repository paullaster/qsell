import { expect, test } from '@playwright/test';

// The rider app's service worker sends saved door work through this route when the phone has signal again. It must never act for
// someone who is not signed in, never take a request from another site, and never read a malformed item.
test.use({ storageState: { cookies: [], origins: [] } });

const item = { id: 'k'.repeat(32), riderId: '00000000-0000-4000-8000-000000000001', kind: 'finish', runId: '00000000-0000-4000-8000-000000000002', deliveryId: null, payload: {}, photoId: null };

test('with no session the item is not sent and the answer says to sign in', async ({ request }) => {
  const response = await request.post('/api/rider/door-sync', { data: item });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ ok: false, forbidden: true });
});

test('a request from another site is refused', async ({ request }) => {
  const response = await request.post('/api/rider/door-sync', { data: item, headers: { origin: 'https://example.invalid' } });
  expect(response.status()).toBe(403);
});

test('it takes only JSON, and only a well-formed item', async ({ request }) => {
  expect((await request.post('/api/rider/door-sync', { form: { id: 'x' } })).status()).toBe(415);
  expect((await request.post('/api/rider/door-sync', { data: { ...item, kind: 'steal' } })).status()).toBe(400);
  expect((await request.post('/api/rider/door-sync', { data: { ...item, id: '' } })).status()).toBe(400);
  expect((await request.post('/api/rider/door-sync', { data: { ...item, kind: 'deliver', deliveryId: null } })).status()).toBe(400);
  expect((await request.post('/api/rider/door-sync', { data: 'not an item', headers: { 'content-type': 'application/json' } })).status()).toBe(400);
});

test('the worker script and its sending rules are served to the rider app', async ({ request }) => {
  const worker = await request.get('/rider-sw.js');
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain("importScripts('/rider-sync.js')");
  const rules = await request.get('/rider-sync.js');
  expect(rules.status()).toBe(200);
  expect(await rules.text()).toContain('sendWaiting');
});
