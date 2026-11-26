import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';

// A 1x1 PNG: the smallest real picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('company setup', () => {
  test('the profile is checked, saved and kept, and the logo is accepted only if it is a picture', async ({ page }, testInfo) => {
    const phone = testInfo.project.name === 'phone' ? '+254 722 000 222' : '+254 711 000 111';
    await open(page, '/admin/company/profile', 'Company profile');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'Company profile' });

    // Every box is tied to its label.
    for (const label of ['Legal name', 'Trading name', 'KRA PIN', 'Street address', 'City', 'Email', 'Phone (mobile)', 'Website', 'Bank name', 'Account number']) {
      await expect(form.getByLabel(label, { exact: true })).toBeVisible();
    }

    await form.getByLabel('Legal name', { exact: true }).fill('E2E Trading Ltd');
    await form.getByLabel('Trading name', { exact: true }).fill('E2E Trading');
    await form.getByLabel('Street address').fill('1 Test Road');
    await form.getByLabel('City', { exact: true }).fill('Nairobi');
    await form.getByLabel('County / state').fill('Nairobi');
    await form.getByLabel('Postal code').fill('00100');
    await form.getByLabel('Country', { exact: true }).fill('Kenya');
    await form.getByLabel('Phone (mobile)').fill(phone);

    // What is wrong is said in words, one thing at a time, and nothing is saved.
    await form.getByLabel('Email', { exact: true }).fill('admin@localhost');
    await form.getByLabel('KRA PIN').fill('P051234567Z');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(form.getByRole('alert')).toContainText(/email/i);
    await form.getByLabel('Email', { exact: true }).fill('sales@e2e-trading.test');
    await form.getByLabel('KRA PIN').fill('12345');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(form.getByRole('alert')).toContainText(/KRA PIN/);
    await form.getByLabel('KRA PIN').fill('p051234567z');
    await form.getByLabel('Website').fill('javascript:alert(1)');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(form.getByRole('alert')).toContainText(/http/);
    await form.getByLabel('Website').fill('https://e2e-trading.test');
    await form.getByLabel('Bank name').fill('E2E Bank');
    await form.getByLabel('Account number').fill('0011223344');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(form.getByRole('status')).toContainText('Company profile saved.', { timeout: 30_000 });
    await expect(form.getByLabel('KRA PIN')).toHaveValue('P051234567Z');
    await expect(form.getByLabel('Invoice prefix')).toHaveCount(0);

    // It is kept.
    await open(page, '/admin/company/profile', 'Company profile');
    await expect(page.getByRole('form', { name: 'Company profile' }).getByLabel('Trading name', { exact: true })).toHaveValue('E2E Trading');
    await expect(page.getByRole('form', { name: 'Company profile' }).getByLabel('Account number')).toHaveValue('0011223344');

    // The logo: a real picture is taken, a web page dressed as one is not.
    const upload = page.getByLabel('Company logo');
    await upload.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByText(/Logo uploaded/)).toBeVisible({ timeout: 30_000 });
    await upload.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from('<html><script>alert(1)</script></html>') });
    await expect(page.getByRole('alert').filter({ hasText: /PNG, JPEG, WebP or plain SVG/ })).toBeVisible({ timeout: 30_000 });
    await upload.setInputFiles({ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>') });
    await expect(page.getByRole('alert').filter({ hasText: /PNG, JPEG, WebP or plain SVG/ })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('the installed app is named by the company: the short name ends on a whole word, the choice reaches the manifest and the page, and clearing it brings the trading name back', async ({ page, request }) => {
    await open(page, '/admin/company/profile', 'Company profile');
    const form = page.getByRole('form', { name: 'Company profile' });
    const appName = form.getByLabel('App name', { exact: true });
    const short = form.getByLabel('Name under the icon');
    await expect(short).toHaveAttribute('maxlength', '12');

    // A long name is shown in full where there is room, and under the icon as whole words that fit.
    await appName.fill('E2E Trading Online Shop For Everyone');
    await expect(page.getByTestId('app-name-preview')).toHaveText('E2E Trading Online Shop For Everyone');
    await expect(page.getByTestId('app-short-preview')).toHaveText('E2E Trading');
    await short.fill('E2E Shop');
    await expect(page.getByTestId('app-short-preview')).toHaveText('E2E Shop');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(form.getByRole('status')).toContainText('Company profile saved.', { timeout: 30_000 });

    const manifest = (await (await request.get('/manifest.webmanifest')).json()) as { name: string; short_name: string };
    expect(manifest).toMatchObject({ name: 'E2E Trading Online Shop For Everyone', short_name: 'E2E Shop' });
    await page.goto('/');
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'E2E Shop');
    await noHorizontalScroll(page);

    // Emptied, the trading name is used again.
    await open(page, '/admin/company/profile', 'Company profile');
    await appName.fill('');
    await short.fill('');
    await form.getByRole('button', { name: 'Save profile' }).click();
    await expect(form.getByRole('status')).toContainText('Company profile saved.', { timeout: 30_000 });
    const back = (await (await request.get('/manifest.webmanifest')).json()) as { name: string; short_name: string };
    expect(back).toMatchObject({ name: 'E2E Trading', short_name: 'E2E Trading' });
  });

  test('appearance: colours and density are saved, a bad colour never is', async ({ page }) => {
    await open(page, '/admin/company/appearance', 'Appearance');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'Appearance' });
    await form.getByLabel('Primary (buttons & calls to action)').fill('#336699');
    await form.getByLabel('Accent (brand mark / invoices)').fill('#aa5500');
    await form.getByRole('button', { name: '2 columns' }).click();
    await expect(form.getByRole('button', { name: '2 columns' })).toHaveAttribute('aria-pressed', 'true');
    await form.getByRole('button', { name: 'Save appearance' }).click();
    await expect(form.getByRole('status')).toContainText('Appearance saved.', { timeout: 30_000 });

    await open(page, '/admin/company/appearance', 'Appearance');
    const again = page.getByRole('form', { name: 'Appearance' });
    await expect(again.getByLabel('Primary (buttons & calls to action)')).toHaveValue('#336699');
    await expect(again.getByRole('button', { name: '2 columns' })).toHaveAttribute('aria-pressed', 'true');
    await again.getByRole('button', { name: '4 columns' }).click();
    await again.getByLabel('Primary (buttons & calls to action)').fill('#111827');
    await again.getByLabel('Accent (brand mark / invoices)').fill('#4f46e5');
    await again.getByRole('button', { name: 'Save appearance' }).click();
    await expect(again.getByRole('status')).toContainText('Appearance saved.', { timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('module names are saved and kept, and clearing a name brings the built-in one back', async ({ page }) => {
    await open(page, '/admin/company/modules', 'Module names');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'Module names' });
    const first = form.getByLabel(/^Name for /).first();
    await expect(first).toBeVisible();
    await first.fill('  Renamed by E2E  ');
    await form.getByRole('button', { name: 'Save names' }).click();
    await expect(form.getByRole('status')).toContainText('Module names saved.', { timeout: 30_000 });
    await expect(first).toHaveValue('Renamed by E2E');

    await open(page, '/admin/company/modules', 'Module names');
    const kept = page.getByRole('form', { name: 'Module names' }).getByLabel(/^Name for /).first();
    await expect(kept).toHaveValue('Renamed by E2E');
    await kept.fill('');
    await page.getByRole('button', { name: 'Save names' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Module names saved.' })).toBeVisible({ timeout: 30_000 });
    await expect(kept).toHaveValue('');
    await noHorizontalScroll(page);
  });

  test('support: a channel is added with a picker for its type, saved and kept', async ({ page }) => {
    await open(page, '/admin/company/support', 'Customer support');
    await noNativeSelect(page);
    await clickUntilVisible(page.getByRole('button', { name: 'Add channel' }), page.getByRole('combobox', { name: 'Type' }));
    await pick(page, page.getByRole('combobox', { name: 'Type' }), 'WhatsApp', /^WhatsApp/);
    await page.getByLabel('WhatsApp number').fill('+254 700 111 222');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Support settings saved' })).toBeVisible({ timeout: 30_000 });

    await open(page, '/admin/company/support', 'Customer support');
    await expect(page.getByLabel('WhatsApp number')).toHaveValue('+254 700 111 222');
    await page.getByRole('button', { name: 'Remove channel 1' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Support settings saved' })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
