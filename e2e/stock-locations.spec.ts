import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag } from './support/vendors';

const place = (page: Page, code: string) => page.getByRole('listitem').filter({ hasText: code });

async function openLocations(page: Page): Promise<void> {
  await open(page, '/admin/inventory/locations', /Stock locations/);
}

test.describe('the places stock is held', () => {
  test('are listed with what they are, made, changed, made the default and stopped, and the screen fits every width', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry).toUpperCase();
    const code = `E2E${tag}`.slice(0, 20);
    await openLocations(page);

    // The default place is always there, and cannot be stopped.
    const main = place(page, 'MAIN').first();
    await expect(main).toBeVisible({ timeout: 60_000 });
    await expect(main).toContainText('Default');
    await expect(main).toContainText(/Cannot be stopped: This is the default location/);
    await expect(main.getByRole('button', { name: /^Stop/ })).toHaveCount(0);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // A form with a problem says so in words and saves nothing.
    await page.getByRole('button', { name: 'New location' }).click();
    const form = page.getByRole('form', { name: 'New stock location' });
    await expect(form).toBeVisible();
    await form.getByLabel('Name').fill('Nameless code');
    await form.getByRole('button', { name: 'Add location' }).click();
    await expect(form.locator('p[role="alert"]')).toContainText(/code is 1 to 20/i, { timeout: 30_000 });

    // A good one is added and shows what was chosen.
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Name').fill('Westlands shop');
    await pick(page, form.getByRole('combobox', { name: 'Kind of place' }), 'Shop', /Shop or store/);
    await form.getByLabel('Address').fill('Mpaka Road, Westlands');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Add location' }).click();
    await expect(page.getByText(`${code} added.`)).toBeVisible({ timeout: 30_000 });
    const made = place(page, code);
    await expect(made).toBeVisible({ timeout: 30_000 });
    await expect(made).toContainText('Westlands shop');
    await expect(made).toContainText('Shop or store');
    await expect(made).toContainText('Mpaka Road, Westlands');
    await expect(made).toContainText('No stock');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The same code twice is refused.
    await page.getByRole('button', { name: 'New location' }).click();
    const again = page.getByRole('form', { name: 'New stock location' });
    await again.getByLabel('Code').fill(code.toLowerCase());
    await again.getByLabel('Name').fill('Copy');
    await again.getByRole('button', { name: 'Add location' }).click();
    await expect(again.locator('p[role="alert"]')).toContainText(/already exists/, { timeout: 30_000 });
    await again.getByRole('button', { name: 'Cancel' }).click();

    // Change it.
    await made.getByRole('button', { name: `Edit ${code}` }).click();
    const edit = page.getByRole('form', { name: `Edit ${code}` });
    await edit.getByLabel('Name').fill('Westlands branch');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(`${code} saved.`)).toBeVisible({ timeout: 30_000 });
    await expect(place(page, code)).toContainText('Westlands branch');

    // Make it the default, and give the default back.
    await place(page, code).getByRole('button', { name: `Make ${code} the default` }).click();
    await expect(page.getByText(`${code} is now the default location.`)).toBeVisible({ timeout: 30_000 });
    await expect(place(page, code)).toContainText('Default');
    await place(page, 'MAIN').first().getByRole('button', { name: 'Make MAIN the default' }).click();
    await expect(page.getByText('MAIN is now the default location.')).toBeVisible({ timeout: 30_000 });

    // Stop it after being asked once, and see it again only when stopped places are shown.
    await place(page, code).getByRole('button', { name: `Stop ${code}` }).click();
    await place(page, code).getByRole('button', { name: `Confirm: Stop ${code}` }).click();
    await expect(page.getByText(`${code} stopped.`)).toBeVisible({ timeout: 30_000 });
    await expect(place(page, code)).toHaveCount(0);
    await page.getByLabel('Show stopped locations').check();
    await expect(place(page, code)).toContainText('Stopped', { timeout: 30_000 });
    await place(page, code).getByRole('button', { name: `Restart ${code}` }).click();
    await expect(page.getByText(`${code} is in use again.`)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('can be searched by code or name', async ({ page }) => {
    await openLocations(page);
    await page.getByLabel('Search locations').fill('main stock');
    await expect(place(page, 'MAIN').first()).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search locations').fill('zzzz-nothing-like-this');
    await expect(page.getByText('No location matches that search.')).toBeVisible({ timeout: 30_000 });
  });
});
