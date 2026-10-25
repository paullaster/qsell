import { expect, test } from '@playwright/test';
import { noHorizontalScroll } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';
import { E2E_URL } from './support/constants';

const PDF = { name: 'certificate.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') };

test.describe('a vendor completes its profile', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('every section is filled in the portal, the profile is sent, and then it is locked', async ({ page }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'new');
    await signInAsVendor(page, vendor);
    await expect(page.getByRole('heading', { name: vendor.legalName, level: 2 })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: 'Open my profile' }).click();
    await expect(page.getByRole('heading', { name: 'Your profile', level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Not started')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Send my profile for review' })).toHaveCount(0);
    await noHorizontalScroll(page);

    // Vendor profile.
    await page.getByRole('link', { name: 'Vendor profile', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vendor profile', level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('select')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /country|sentence|street|town|phone/i })).toBeVisible();
    await page.getByLabel('Country').fill('Kenya');
    await page.getByLabel('What you supply').fill('We supply solar panels and inverters to businesses.');
    await page.getByLabel('Street or building').fill('1 Mombasa Road');
    await page.getByLabel('Town or city').fill('Nairobi');
    await page.getByLabel('Business phone').fill('+254 700 000 000');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);

    // Business information, with a director whose ID stays sealed.
    await page.goto('/vendor/profile/business');
    await expect(page.getByRole('heading', { name: 'Business information', level: 2 })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Registration number').fill(`CPR/${vendor.vendorId.slice(0, 6)}`);
    await page.getByLabel('Registered on').fill('2012-03-04');
    await page.getByLabel('Tax ID (KRA PIN)').fill(`T${vendor.vendorId.replace(/-/g, '').slice(0, 9).toUpperCase()}`);
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
    const person = page.getByRole('form', { name: 'Add an owner or director' });
    await person.getByLabel('Name').fill('Wanjiru Kamau');
    await person.getByLabel('ID number').fill('12345678');
    await person.getByLabel('Share of the business (%)').fill('100');
    await person.getByRole('button', { name: 'Add person' }).click();
    await expect(page.getByText('ending 5678')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('12345678')).toHaveCount(0);

    // Financial information: the account number is shown only by its last four digits.
    await page.goto('/vendor/profile/financial');
    await expect(page.getByRole('heading', { name: 'Financial information', level: 2 })).toBeVisible({ timeout: 60_000 });
    const bank = page.getByRole('form', { name: 'Add a bank account' });
    await bank.getByLabel('Bank', { exact: true }).fill('KCB');
    await bank.getByLabel('Branch').fill('Moi Avenue');
    await bank.getByLabel('Account name').fill(vendor.legalName);
    await bank.getByLabel('Account number').fill('0123 4567 89');
    await bank.getByRole('button', { name: 'Add bank account' }).click();
    await expect(page.getByText('•••• 6789')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('0123456789')).toHaveCount(0);

    // Contact persons.
    await page.goto('/vendor/profile/contacts');
    await expect(page.getByRole('heading', { name: 'Contact persons', level: 2 })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Name').first().fill('Wanjiru Kamau');
    await page.getByLabel('Email').first().fill(vendor.email);
    await page.getByLabel('Phone').first().fill('0700000000');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });

    // Attachments: every required document, one of them without an expiry date first.
    await page.goto('/vendor/profile/attachments');
    await expect(page.getByRole('heading', { name: 'Attachments', level: 2 })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Choose a file').first().setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a document') });
    await expect(page.getByText(/accept PDF files and JPEG/)).toBeVisible({ timeout: 30_000 });
    const required = page.getByRole('listitem').filter({ hasNot: page.getByText('(optional)') }).filter({ has: page.getByText('Not uploaded') });
    const count = await required.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i += 1) {
      const row = required.first();
      const expiry = row.getByLabel('Expiry date');
      if ((await expiry.count()) > 0) await expiry.fill(new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10));
      await row.getByLabel('Choose a file').setInputFiles(PDF);
      await expect(page.getByText('Uploaded. We will check it.')).toBeVisible({ timeout: 30_000 });
      await expect(required).toHaveCount(count - i - 1, { timeout: 30_000 });
    }

    // Send it.
    await page.goto('/vendor/profile');
    await expect(page.getByText('Complete')).toHaveCount(5, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Send my profile for review' }).click();
    await expect(page.getByText('Your profile has been sent for review.')).toBeVisible({ timeout: 30_000 });
    await page.goto('/vendor/profile/business');
    await expect(page.getByText(/with the reviewer/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await page.goto('/vendor');
    await expect(page.getByText('Profile submitted')).toBeVisible({ timeout: 60_000 });
  });

  test('a vendor can open its own files and nobody else’s', async ({ page, request }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const mine = makeVendor(`${tag}a`, 'submitted');
    const other = makeVendor(`${tag}b`, 'submitted');
    await signInAsVendor(page, mine);
    const ownFile = mine.fileIds?.[0] ?? '';
    const theirFile = other.fileIds?.[0] ?? '';
    const own = await page.request.get(`/api/vendor/files/${ownFile}`);
    expect(own.status()).toBe(200);
    expect(own.headers()['content-type']).toBe('application/pdf');
    expect(own.headers()['cache-control']).toContain('no-store');
    expect((await own.body()).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await page.request.get(`/api/vendor/files/${theirFile}`)).status()).toBe(404);
    expect((await page.request.get('/api/vendor/files/not-an-id')).status()).toBe(404);
    // Signed out, the same address says the same thing.
    expect((await request.get(`${E2E_URL}/api/vendor/files/${ownFile}`)).status()).toBe(404);
    expect((await request.post(`${E2E_URL}/api/vendor/documents`, { multipart: { file: PDF, documentTypeId: '00000000-0000-4000-8000-000000000000' } })).status()).toBe(401);
  });
});

test.describe('staff review a vendor', () => {
  test('a profile is checked, approved, and the vendor is active with a number', async ({ page, browser }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'submitted');
    await page.goto(`/admin/vendors/${vendor.vendorId}`);
    await expect(page.getByRole('heading', { name: vendor.legalName, level: 2 })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Profile submitted').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('•••• ')).toBeVisible();
    await noHorizontalScroll(page);

    await page.getByRole('button', { name: 'Take for review' }).click();
    await expect(page.getByText('You have taken this profile for review.')).toBeVisible({ timeout: 30_000 });

    // Approving before the documents are checked is refused, in words.
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve this vendor' }).click();
    await expect(page.getByText(/Verify the vendor’s .* first/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Not yet' }).click();

    // The file opens for staff, and each document is marked valid.
    const open1 = await page.request.get(`/api/admin/vendors/files/${vendor.fileIds?.[0] ?? ''}`);
    expect(open1.status()).toBe(200);
    const valid = page.getByRole('button', { name: /^Mark (?:(?!not valid).)* valid$/ });
    const total = await valid.count();
    expect(total).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < total; i += 1) {
      await valid.first().click();
      await expect(page.getByText('The document is marked valid.')).toBeVisible({ timeout: 30_000 });
      await expect(valid).toHaveCount(total - i - 1, { timeout: 30_000 });
    }
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve this vendor' }).click();
    await expect(page.getByText('The vendor is approved and active.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Vendor V-\d{6}/)).toBeVisible({ timeout: 30_000 });

    // The vendor now sees an active business, and its own bank account is in use.
    const vendorWindow = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(vendorWindow.page, vendor);
      await expect(vendorWindow.page.getByText('Active', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(vendorWindow.page.getByText(/Vendor V-\d{6}/)).toBeVisible();
      await vendorWindow.page.goto('/vendor/profile/financial');
      await expect(vendorWindow.page.getByText('In use').first()).toBeVisible({ timeout: 60_000 });
      await expect(vendorWindow.page.getByText(/use the request below/).first()).toBeVisible();
    } finally {
      await vendorWindow.close();
    }
  });

  test('a profile is sent back with a note, the vendor fixes it and sends it again', async ({ page, browser }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'submitted');
    await page.goto(`/admin/vendors/${vendor.vendorId}`);
    await expect(page.getByRole('button', { name: 'Send back for revision' })).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Send back for revision' }).click();
    await page.getByRole('button', { name: 'Send back', exact: true }).click();
    await expect(page.getByText('Say which section needs work and what to change.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('textbox', { name: 'Financial information' }).fill('The account name must match your certificate');
    await page.getByRole('button', { name: 'Send back', exact: true }).click();
    await expect(page.getByText('Sent back to the vendor.')).toBeVisible({ timeout: 30_000 });

    const vendorWindow = await signedOutPage(browser, testInfo);
    try {
      const v = vendorWindow.page;
      await signInAsVendor(v, vendor);
      await v.goto('/vendor/profile');
      await expect(v.getByText('We asked for changes')).toBeVisible({ timeout: 60_000 });
      await expect(v.getByText('The account name must match your certificate')).toBeVisible();
      await v.getByRole('link', { name: 'Financial information' }).click();
      await expect(v.getByText('We asked you to fix:')).toBeVisible({ timeout: 60_000 });
      await v.getByLabel('Payment terms you offer (days)').fill('45');
      await v.getByRole('button', { name: 'Save', exact: true }).last().click();
      await expect(v.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
      await v.goto('/vendor/profile');
      await v.getByRole('button', { name: 'Send my profile for review' }).click();
      await expect(v.getByText('Your profile has been sent for review.')).toBeVisible({ timeout: 30_000 });
    } finally {
      await vendorWindow.close();
    }
    await page.reload();
    await expect(page.getByText('Version 2 · Waiting for a decision')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Version 1 · Sent back for revision')).toBeVisible();
  });

  test('an application is refused with a reason from the list, and the vendor sees it is not accepted', async ({ page, browser }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'submitted');
    await page.goto(`/admin/vendors/${vendor.vendorId}`);
    await expect(page.getByRole('button', { name: 'Refuse' })).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Refuse' }).click();
    await expect(page.locator('select')).toHaveCount(0);
    await pick(page, page.getByRole('combobox', { name: 'Reason' }), 'ELIGIBLE', /not one we can buy from/i);
    await page.getByRole('button', { name: 'Refuse the application' }).click();
    await expect(page.getByLabel(/^Explain/)).toBeVisible();
    await page.getByLabel(/^Explain/).fill('We do not buy from this kind of business');
    await page.getByRole('button', { name: 'Refuse the application' }).click();
    await expect(page.getByText('The application is refused.')).toBeVisible({ timeout: 30_000 });

    const vendorWindow = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(vendorWindow.page, vendor);
      await expect(vendorWindow.page.getByText('Rejected', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(vendorWindow.page.getByText(/was not accepted/)).toBeVisible();
    } finally {
      await vendorWindow.close();
    }
  });
});
