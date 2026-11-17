import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { riderTool } from './support/rider-fixtures';

test.describe('the business time zone', () => {
  test('it is chosen from the autocomplete, with a reason and a confirmation, and every time on screen follows it', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}Z`;
    const orderNumber = riderTool('paid-order', tag).orderNumber ?? '';
    deliveryTool('book-visit', orderNumber);
    try {
      // The visit is at 06:00 UTC: 09:00 in Nairobi, where the business starts.
      await open(page, '/admin/delivery/visits', 'Visits');
      const card = () => page.getByRole('list', { name: 'Visit list' }).getByRole('listitem').filter({ hasText: `Order ${orderNumber}` }).first();
      await expect(card()).toContainText('09:00', { timeout: 60_000 });
      await expect(card()).toContainText('12:00');

      await open(page, '/admin/settings/business-time', 'Business time zone');
      const now = page.getByRole('region', { name: 'The business time zone now' });
      await expect(now).toContainText('Africa/Nairobi');
      await expect(now).toContainText('UTC+03:00');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      // Nothing can be changed without choosing a different zone and a reason.
      const form = page.getByRole('form', { name: 'Change the business time zone' });
      const change = form.getByRole('button', { name: 'Change the business time zone' });
      await expect(change).toBeDisabled();
      await expect(form).toContainText('Choose a different time zone to change it.');

      // The zone is picked from a list searched as it is typed.
      await pick(page, form.getByRole('combobox', { name: 'Business time zone' }), 'Tokyo', /Asia\/Tokyo/);
      await expect(form).toContainText('Choose a reason to change it.');
      await expect(change).toBeDisabled();
      await form.getByRole('combobox', { name: /Reason/ }).click();
      await page.getByRole('option').first().click();
      await expect(change).toBeEnabled();
      await change.click();
      await form.getByRole('button', { name: 'Confirm: Change the business time zone' }).click();
      await expect(page.getByText('The business time zone is now Asia/Tokyo.')).toBeVisible({ timeout: 30_000 });
      await expect(now).toContainText('Asia/Tokyo');
      await expect(now).toContainText('UTC+09:00');
      await noHorizontalScroll(page);

      // The same visit is now written in Tokyo's clock: 15:00 to 18:00.
      await open(page, '/admin/delivery/visits', 'Visits');
      await expect(card()).toContainText('15:00', { timeout: 60_000 });
      await expect(card()).toContainText('18:00');
      await expect(card()).not.toContainText('09:00');
    } finally {
      deliveryTool('set-time-zone', 'x', 'Africa/Nairobi');
    }
  });

  test('a visit is booked on the business\'s own clock: 09:00 typed in the booking form is 09:00 where the business is', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}V`;
    const orderNumber = riderTool('paid-order', tag).orderNumber ?? '';
    deliveryTool('set-time-zone', 'x', 'Asia/Tokyo');
    try {
      await open(page, '/admin/delivery/visits', 'Visits');
      const form = page.getByRole('form', { name: 'Book a visit' });
      await expect(form).toContainText('Written in Asia/Tokyo.');
      await pick(page, form.getByRole('combobox', { name: 'Order' }), orderNumber, new RegExp(orderNumber));
      const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await form.getByLabel('Starts (business time)').fill(`${day}T09:00`);
      await form.getByLabel('Ends (business time)').fill(`${day}T12:00`);
      await form.getByLabel('Address the crew goes to').fill('Shibuya, Tokyo');
      await form.getByLabel('Checklist, one item to a line').fill('Measure up');
      await form.getByRole('button', { name: 'Book the visit' }).click();
      const card = page.getByRole('list', { name: 'Visit list' }).getByRole('listitem').filter({ hasText: `Order ${orderNumber}` }).first();
      await expect(card).toContainText('09:00', { timeout: 30_000 });
      await expect(card).toContainText('12:00');
      // Stored as the instant 09:00 in Tokyo is: 00:00 UTC, not 06:00 UTC as it would be if it were read as Nairobi time.
      const stored = deliveryTool('visit-instant', orderNumber);
      expect(stored.startsAt).toBe(`${day}T00:00:00.000Z`);
      expect(stored.endsAt).toBe(`${day}T03:00:00.000Z`);
    } finally {
      deliveryTool('set-time-zone', 'x', 'Africa/Nairobi');
    }
  });

  test.describe('a browser in another zone', () => {
    test.use({ timezoneId: 'America/New_York' });

    test('a pricing form starts at the time it is where the business is, not where the browser is', async ({ page }) => {
      deliveryTool('set-time-zone', 'x', 'Asia/Tokyo');
      try {
        await open(page, '/admin/pricing/discounts/new', 'New discount');
        const starts = await page.getByLabel('Starts (business time)').inputValue();
        const tokyo = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'short' }).format(new Date()).replace(' ', 'T');
        const minutesApart = Math.abs(new Date(`${starts}:00Z`).getTime() - new Date(`${tokyo}:00Z`).getTime()) / 60_000;
        expect(minutesApart).toBeLessThanOrEqual(5);
        // The browser's own clock (New York) is 13 or 14 hours behind Tokyo, so a form that used it would be far off.
        const browser = await page.evaluate(() => new Date().getTimezoneOffset());
        expect([240, 300]).toContain(browser);
      } finally {
        deliveryTool('set-time-zone', 'x', 'Africa/Nairobi');
      }
    });
  });

  test.describe('without the permission', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('a manager who was not given it cannot see the screen or the link to it', async ({ page }, testInfo) => {
      test.slow();
      const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}M`;
      const manager = deliveryTool('manager-staff', tag);
      await page.goto('/login?callbackUrl=%2Fadmin%2Fsettings%2Fbusiness-time');
      await expect(page.getByLabel('Email')).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => page.getByLabel('Email').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 90_000 }).toBe(true);
      await page.getByLabel('Email').fill(manager.email ?? '');
      await page.getByLabel('Password', { exact: true }).fill(manager.password ?? '');
      await page.getByRole('button', { name: /^Sign in/ }).click();
      await expect(page).toHaveURL(/\/admin/, { timeout: 90_000 });
      await page.goto('/admin/settings/business-time');
      // The screen says so in words and offers nothing to change.
      await expect(page.getByText('You do not have permission to do that.').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('form', { name: 'Change the business time zone' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Business Time Zone' })).toHaveCount(0);
      await noHorizontalScroll(page);
    });
  });
});
