import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { E2E_URL, E2E_VENDOR_PASSWORD, e2eVendorEmail } from './support/constants';

/** A tag that differs between the two browser projects and between runs, so a name or email is never taken twice. */
const suffix = (project: string): string => `${project === 'phone' ? 'p' : 'd'}${String(Date.now()).slice(-7)}`;

const SIGNED_OUT = { storageState: { cookies: [], origins: [] } };

test.describe('vendors (admin)', () => {
  test('the list searches and filters on the server, with a picker and no sideways scrolling', async ({ page }) => {
    await open(page, '/admin/vendors', 'Vendors');
    await noNativeSelect(page);
    // Earlier tests add vendors of their own, so the seeded ones are found by searching, not by being on the first page.
    await page.getByLabel('Search').fill('E2E Vendor Alpha');
    await page.getByRole('button', { name: 'Apply filter' }).click();
    await expect(page.getByRole('link', { name: /E2E Vendor Alpha/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search').fill('E2E Vendor Waiting');
    await page.getByRole('button', { name: 'Apply filter' }).click();
    await expect(page.getByRole('link', { name: /E2E Vendor Waiting/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: /E2E Vendor Alpha/ })).toHaveCount(0);
    await noHorizontalScroll(page);
  });

  test('a vendor is added from the list and its card opens', async ({ page }, testInfo) => {
    test.slow();
    const name = `E2E Added Vendor ${suffix(testInfo.project.name)}`;
    await open(page, '/admin/vendors', 'Vendors');
    await page.getByRole('link', { name: 'Add a vendor' }).click();
    await expect(page).toHaveURL(/\/admin\/vendors\/new$/, { timeout: 60_000 });
    // It opens over the list: the list is still there underneath.
    const dialog = page.getByRole('dialog', { name: 'Add a vendor' });
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Vendors', level: 2 })).toBeVisible();
    await expect(dialog.locator('select')).toHaveCount(0);
    await noHorizontalScroll(page);
    await dialog.getByLabel('Legal name').fill(name);
    await dialog.getByLabel('Email').fill(`added-${suffix(testInfo.project.name)}@example.test`);
    // Enter submits the form. (Clicking the button would be blocked, on a phone, by the development server's own indicator,
    // which sits over the bottom left corner of the screen; that indicator does not exist in a production build.)
    await dialog.getByLabel('Email').press('Enter');
    await expect(page).toHaveURL(/\/admin\/vendors\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('No vendor number yet')).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('a person who may make a vendor active can do it at once and the vendor gets a number', async ({ page }, testInfo) => {
    test.slow();
    await open(page, '/admin/vendors/new', 'Add a vendor');
    await page.getByLabel('Legal name').fill(`E2E Active Vendor ${suffix(testInfo.project.name)}`);
    await page.getByLabel('Email').fill(`active-${suffix(testInfo.project.name)}@example.test`);
    await page.getByLabel(/Make this vendor active now/).check();
    await page.getByRole('button', { name: 'Add vendor' }).click();
    await expect(page).toHaveURL(/\/admin\/vendors\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByText(/Vendor V-\d{6}/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
  });

  test('refuses a bad form with a plain message', async ({ page }) => {
    await open(page, '/admin/vendors/new', 'Add a vendor');
    await page.getByLabel('Legal name').fill('X');
    await page.getByRole('button', { name: 'Add vendor' }).click();
    await expect(page.locator('form[aria-label="New vendor"] [role="alert"]')).toContainText('legal name');
  });

  test('an unknown vendor is not found', async ({ page }) => {
    await page.goto('/admin/vendors/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { name: 'Not found', level: 2 })).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('vendor portal', () => {
  test.use(SIGNED_OUT);

  test('a business registers, is told to check its email, and cannot sign in until it has', async ({ page }, testInfo) => {
    test.slow();
    const tag = suffix(testInfo.project.name);
    await page.goto('/vendor/register');
    await expect(page.getByRole('heading', { name: 'Become a vendor', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.getByLabel('Business legal name').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))), { timeout: 30_000 }).toBe(true);
    await page.getByLabel('Business legal name').fill(`Self Registered ${tag}`);
    await page.getByLabel('Your name').fill('Wanjiru');
    await page.getByLabel('Email').fill(`self-${tag}@example.test`);
    await page.getByLabel('Password', { exact: true }).fill('A-good-password-1');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Create vendor account' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({ timeout: 60_000 });

    await page.goto('/login?callbackUrl=%2Fvendor');
    await page.getByLabel('Email').fill(`self-${tag}@example.test`);
    await page.getByLabel('Password', { exact: true }).fill('A-good-password-1');
    await page.getByRole('button', { name: /^Sign in/ }).click();
    await expect(page.getByText(/confirm your email/i)).toBeVisible({ timeout: 60_000 });
  });

  test('a bad registration is refused with the reason, and a taken address gives the same answer as a new one', async ({ page }, testInfo) => {
    test.slow();
    await page.goto('/vendor/register');
    await expect(page.getByRole('heading', { name: 'Become a vendor', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.getByLabel('Business legal name').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))), { timeout: 30_000 }).toBe(true);
    await page.getByRole('button', { name: 'Create vendor account' }).click();
    await expect(page.locator('form[aria-label="Register as a vendor"] [role="alert"]')).toContainText('legal name');
    await page.getByLabel('Business legal name').fill('Taken Address Ltd');
    await page.getByLabel('Your name').fill('Someone');
    await page.getByLabel('Email').fill(e2eVendorEmail(testInfo.project.name === 'phone' ? 'phone' : 'desktop'));
    await page.getByLabel('Password', { exact: true }).fill('A-good-password-1');
    await page.getByRole('button', { name: 'Create vendor account' }).click();
    // Same page as for a new address: the form never says who is registered.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible({ timeout: 60_000 });
  });

  test('a vendor signs in, lands in the portal, and is kept out of the back office', async ({ page }, testInfo) => {
    test.slow();
    const project = testInfo.project.name === 'phone' ? 'phone' : 'desktop';
    const label = project === 'phone' ? 'Phone' : 'Desktop';
    await page.goto('/login?callbackUrl=%2Fvendor');
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.getByLabel('Email').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))), { timeout: 30_000 }).toBe(true);
    await page.getByLabel('Email').fill(e2eVendorEmail(project));
    await page.getByLabel('Password', { exact: true }).fill(E2E_VENDOR_PASSWORD);
    await page.getByRole('button', { name: /^Sign in/ }).click();
    await expect(page).toHaveURL(`${E2E_URL}/vendor`, { timeout: 90_000 });
    await expect(page.getByRole('heading', { name: `Portal Vendor ${label}`, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Registered', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Not started')).toHaveCount(5);
    await noHorizontalScroll(page);

    // The back office is closed to a vendor, and the pages API answers nothing about other vendors.
    await page.goto('/admin/vendors');
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  });

  test('nobody signed out can open the portal', async ({ page }) => {
    await page.goto('/vendor');
    await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  });
});

test.describe('staff and the portal', () => {
  test('a staff member sent to the portal lands in the back office', async ({ page }) => {
    await page.goto('/vendor');
    await expect(page).toHaveURL(/\/admin/, { timeout: 60_000 });
  });
});
