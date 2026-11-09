import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { step } from './support/delivery-shop';

const KEY = 'e2e-secret-key-8841';

/** Adds a courier connected to its own system and returns the address and secret that were shown once. */
async function addConnected(page: Page, name: string): Promise<{ path: string; secret: string }> {
  const form = page.getByRole('form', { name: 'Add a courier' });
  await form.getByLabel('Name').fill(name);
  await pick(page, form.getByRole('combobox', { name: 'How it is connected' }), 'Courier', /system/);
  await form.getByLabel(/web address/).fill('https://api.e2e-courier.co.ke');
  await form.getByLabel('Key the courier gave you').fill(KEY);
  await form.getByRole('button', { name: 'Add the courier' }).click();
  const shown = page.getByRole('status', { name: 'Secret for the courier' });
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const path = (await shown.locator('code').first().innerText()).trim();
  const secret = (await shown.locator('code').last().innerText()).trim();
  expect(path).toMatch(/^\/api\/couriers\/[0-9a-f]{48}$/);
  expect(secret).toMatch(/^[0-9a-f]{48}$/);
  return { path, secret };
}

test.describe('couriers', () => {
  test('a courier is connected with its key kept secret, its news secret shown once, and it can be stopped, started and given a new secret', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/delivery/couriers', 'Couriers');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // One typed in by hand needs nothing more than a name.
    const form = page.getByRole('form', { name: 'Add a courier' });
    await form.getByLabel('Name').fill(`Boda ${tag}`);
    await form.getByRole('button', { name: 'Add the courier' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The courier is added.' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('status', { name: 'Secret for the courier' })).toHaveCount(0);

    // An address that is not https is refused in words, and nothing is saved.
    await form.getByLabel('Name').fill(`Swift ${tag}`);
    await pick(page, form.getByRole('combobox', { name: 'How it is connected' }), 'Courier', /system/);
    await form.getByLabel(/web address/).fill('http://api.e2e-courier.co.ke');
    await form.getByLabel('Key the courier gave you').fill(KEY);
    await form.getByRole('button', { name: 'Add the courier' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'https' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('list', { name: 'Courier list' })).not.toContainText(`Swift ${tag}`);
    await form.getByLabel(/web address/).fill('https://api.e2e-courier.co.ke');
    await form.getByRole('button', { name: 'Add the courier' }).click();
    const shown = page.getByRole('status', { name: 'Secret for the courier' });
    await expect(shown).toBeVisible({ timeout: 30_000 });
    await expect(shown).toContainText('will not be shown again');
    await noInnerHorizontalScroll(page);
    await noHorizontalScroll(page);
    await shown.getByRole('button', { name: 'I have copied it' }).click();
    await expect(shown).toHaveCount(0);

    // The key is never put back on the screen, even when the courier is opened to change it.
    const list = page.getByRole('list', { name: 'Courier list' });
    const row = list.getByRole('listitem').filter({ hasText: `Swift ${tag}` });
    await expect(row).toContainText('In use');
    await row.getByRole('button', { name: `Change Swift ${tag}` }).click();
    await expect(row.getByLabel(/New key/)).toHaveValue('');
    expect(await page.content()).not.toContain(KEY);
    await row.getByLabel(/web address/).fill('https://api2.e2e-courier.co.ke');
    await row.getByRole('button', { name: 'Save the courier' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The courier is saved.' })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('listitem').filter({ hasText: `Swift ${tag}` })).toContainText('api2.e2e-courier.co.ke');

    // Stopped, it is not offered; a new secret is shown once and the old one is gone.
    const again = list.getByRole('listitem').filter({ hasText: `Swift ${tag}` });
    await again.getByRole('button', { name: `Stop using Swift ${tag}` }).click();
    await again.getByRole('button', { name: `Confirm: Stop using Swift ${tag}` }).click();
    await expect(list.getByRole('listitem').filter({ hasText: `Swift ${tag}` })).toContainText('Stopped', { timeout: 30_000 });
    await list.getByRole('listitem').filter({ hasText: `Swift ${tag}` }).getByRole('button', { name: 'Use it again' }).click();
    await expect(list.getByRole('listitem').filter({ hasText: `Swift ${tag}` })).toContainText('In use', { timeout: 30_000 });
    await list.getByRole('listitem').filter({ hasText: `Swift ${tag}` }).getByRole('button', { name: `Make a new secret for Swift ${tag}` }).click();
    await list.getByRole('listitem').filter({ hasText: `Swift ${tag}` }).getByRole('button', { name: `Confirm: Make a new secret for Swift ${tag}` }).click();
    await expect(page.getByRole('status', { name: 'Secret for the courier' })).toBeVisible({ timeout: 30_000 });
  });

  test('a parcel is sent with a connected courier, and the courier\'s signed news completes the delivery once, with proof; a wrong signature does nothing', async ({ page, request }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    deliveryTool('open', tag);
    try {
      await open(page, '/admin/delivery/couriers', 'Couriers');
      const name = `Swift ${tag}`;
      const { path, secret } = await addConnected(page, name);

      const made = deliveryTool('ready', deliveryTool('courier-order', tag).orderNumber ?? '');
      const number = made.number ?? '';
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${number}`));
      await pick(page, page.getByRole('combobox', { name: 'Courier from your list' }), 'Swift', new RegExp(name));
      await expect(page.getByLabel('Courier', { exact: true })).toBeDisabled();
      await page.getByLabel(/tracking number/i).fill(`E2E${tag}`);
      await step(page, 'Send out', 'Sent out.');
      const courier = page.getByRole('region', { name: 'Courier' });
      await expect(courier).toContainText(name);
      await expect(courier).toContainText(`tracking number E2E${tag}`);

      // The courier's news, signed with the secret it was given: delivered, with who signed and a proof link.
      const body = JSON.stringify({ tracking_number: `E2E${tag}`, status: 'delivered', event_id: `ev-${tag}`, received_by: 'Mama Wanjiku', proof_url: 'https://pod.e2e-courier.co.ke/p/1.jpg' });
      const sign = (text: string): string => createHmac('sha256', secret).update(text).digest('hex');
      const wrong = await request.post(path, { data: body, headers: { 'content-type': 'application/json', 'x-signature': 'f'.repeat(64) } });
      expect(wrong.status()).toBe(401);
      const nobody = await request.post(`/api/couriers/${'a'.repeat(48)}`, { data: body, headers: { 'content-type': 'application/json', 'x-signature': sign(body) } });
      expect(nobody.status()).toBe(404);
      await page.reload();
      await expect(page.getByRole('region', { name: 'Courier' })).not.toContainText('Courier says delivered');
      const ok = await request.post(path, { data: body, headers: { 'content-type': 'application/json', 'x-signature': sign(body) } });
      expect(ok.status()).toBe(200);
      expect(await ok.json()).toMatchObject({ message: 'Applied.' });
      const again = await request.post(path, { data: body, headers: { 'content-type': 'application/json', 'x-signature': sign(body) } });
      expect(await again.json()).toMatchObject({ message: 'Already had this news.' });

      await page.reload();
      await expect(page.getByRole('region', { name: 'Courier' })).toContainText('Courier says delivered', { timeout: 30_000 });
      await expect(page.getByRole('link', { name: /Proof of delivery \(Mama Wanjiku\)/ })).toHaveAttribute('href', 'https://pod.e2e-courier.co.ke/p/1.jpg');
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });
});
