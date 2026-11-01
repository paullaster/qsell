import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('branches', () => {
  test('a branch is added, found by search, marked independent, and made the default and back', async ({ page }, testInfo) => {
    const code = `B${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/settings/branches', 'Branches');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const list = page.getByRole('list', { name: 'Branches' });
    await expect(list.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
    const original = list.getByRole('listitem').filter({ hasText: 'Default' }).first();
    const originalName = (await original.locator('p').first().innerText()).split('·')[1]?.replace('Default', '').trim() ?? '';

    const form = page.getByRole('form', { name: 'Add branch' });
    await form.getByLabel('Code').fill('bad code!');
    await form.getByLabel('Name').fill(`E2E ${code}`);
    await form.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: /code is up to 20/i })).toBeVisible();
    await form.getByLabel('Code').fill(code.toLowerCase());
    await form.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByText(`E2E ${code} added.`)).toBeVisible({ timeout: 30_000 });

    // The same code again is refused with words.
    await expect(form.getByRole('button', { name: 'Create branch' })).toBeEnabled();
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name').fill('again');
    await form.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByText('A branch with that code already exists.')).toBeVisible({ timeout: 30_000 });

    await page.getByLabel('Search branches').fill(code);
    const row = list.getByRole('listitem').filter({ hasText: `E2E ${code}` });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByLabel(`E2E ${code} acts independently`).click();
    await expect(page.getByText(`E2E ${code} updated.`)).toBeVisible({ timeout: 30_000 });
    await expect(row.getByLabel(`E2E ${code} acts independently`)).toBeChecked();

    await row.getByRole('button', { name: `Make E2E ${code} the default` }).click();
    await expect(page.getByText(`E2E ${code} is now the default.`)).toBeVisible({ timeout: 30_000 });
    // Put the default back where it was, so nothing else is disturbed.
    await page.getByLabel('Search branches').fill(originalName);
    const back = list.getByRole('listitem').filter({ hasText: originalName }).first();
    await back.getByRole('button', { name: /Make .* the default/ }).click();
    await expect(page.getByText(/is now the default\./).first()).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('a branch is put on the map by typing the place or using the device location, refused when it is not a place, and taken off again', async ({ page, context }, testInfo) => {
    const code = `M${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: -0.091702, longitude: 34.767956, accuracy: 25 });
    await open(page, '/admin/settings/branches', 'Branches');
    const list = page.getByRole('list', { name: 'Branches' });
    const form = page.getByRole('form', { name: 'Add branch' });
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name').fill(`Pin ${code}`);
    await form.getByRole('button', { name: 'Create branch' }).click();
    await expect(page.getByText(`Pin ${code} added.`)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search branches').fill(code);
    const row = list.getByRole('listitem').filter({ hasText: `Pin ${code}` });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // A new branch has no pin, and says what that means for delivery.
    await expect(row).toContainText('No pin yet');
    await expect(row).toContainText('left out when the nearest branch is chosen');

    // Not a place: refused in words, nothing saved.
    await row.getByRole('button', { name: `Set the map pin for Pin ${code}` }).click();
    const pin = page.getByRole('form', { name: `Map pin for Pin ${code}` });
    await pin.getByLabel('Latitude').fill('95');
    await pin.getByLabel('Longitude').fill('36.8');
    await pin.getByRole('button', { name: 'Save pin' }).click();
    await expect(page.getByText('A latitude is between -90 and 90.')).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('No pin yet');

    // The device location fills the numbers; the person checks them and saves.
    await pin.getByRole('button', { name: 'Use my current location' }).click();
    await expect(pin.getByRole('status')).toContainText('Found it', { timeout: 30_000 });
    await expect(pin.getByLabel('Latitude')).toHaveValue('-0.091702');
    await expect(pin.getByLabel('Longitude')).toHaveValue('34.767956');
    await pin.getByLabel('What to call the place (optional)').fill('Kisumu shop front');
    await pin.getByRole('button', { name: 'Save pin' }).click();
    await expect(page.getByText(`Pin ${code} is now on the map.`)).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('-0.09170, 34.76796');
    await expect(row).toContainText('Kisumu shop front');
    await expect(row).not.toContainText('No pin yet');

    // It can be changed by typing, and the screen still fits.
    await row.getByRole('button', { name: `Change the map pin for Pin ${code}` }).click();
    const change = page.getByRole('form', { name: `Map pin for Pin ${code}` });
    await change.getByLabel('Latitude').fill('-1.286389');
    await change.getByLabel('Longitude').fill('36.817223');
    await noHorizontalScroll(page);
    await change.getByRole('button', { name: 'Save pin' }).click();
    await expect(row).toContainText('-1.28639, 36.81722', { timeout: 30_000 });

    // And taken off again.
    await row.getByRole('button', { name: `Change the map pin for Pin ${code}` }).click();
    await page.getByRole('form', { name: `Map pin for Pin ${code}` }).getByRole('button', { name: 'Remove pin' }).click();
    await expect(page.getByText(`Pin ${code} is no longer on the map.`)).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('No pin yet');
    await noHorizontalScroll(page);
  });
});
