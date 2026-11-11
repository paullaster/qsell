import { expect, test } from '@playwright/test';

// Signing out must end on the rider sign-in screen even when the session has already lapsed; it used to fail with
// "an unexpected response was received from the server" because the form was a server action behind the sign-in gate.
test.use({ storageState: { cookies: [], origins: [] } });

test('rider sign-out with no session still lands on the rider sign-in screen', async ({ request }) => {
  const response = await request.post('/api/rider/sign-out', { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toMatch(/\/rider\/sign-in$/);
});

test('rider sign-out refuses a form posted from another site', async ({ request }) => {
  const response = await request.post('/api/rider/sign-out', { maxRedirects: 0, headers: { origin: 'https://example.invalid' } });
  expect(response.status()).toBe(403);
});
