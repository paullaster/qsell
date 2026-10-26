import { expect, test } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

test.describe('an M-Pesa destination for a vendor', () => {
  test('is asked for like any change of where the vendor is paid: the form takes a phone, and the request waits for confirmation', async ({ browser }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'approved');
    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.goto('/vendor/profile/financial');
      await expect(v.getByRole('heading', { name: 'Where you are paid', level: 3 })).toBeVisible({ timeout: 60_000 });
      await v.getByRole('button', { name: 'Change my bank details…' }).click();
      const form = v.getByRole('form', { name: 'Request a change of bank details' });
      await pick(v, form.getByRole('combobox', { name: 'Where we pay' }), 'phone', /M-Pesa phone number/);
      await expect(form.getByLabel('Bank', { exact: true })).toHaveCount(0);
      await form.getByLabel('Name registered with M-Pesa').fill(vendor.legalName);
      await form.getByLabel('M-Pesa phone number').fill('0712 345 678');
      await form.getByLabel('Is an additional account').check();
      await form.getByRole('radio', { name: /\.pdf$/ }).first().check();
      await noHorizontalScroll(v);
      await form.getByRole('button', { name: 'Send the request' }).click();
      await expect(v.getByText(/Your request was sent/)).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('Waiting', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('254712345678')).toHaveCount(0);
      await expect(v.getByText('0712 345 678')).toHaveCount(0);
      await noHorizontalScroll(v);
    } finally {
      await w.close();
    }
  });
});
