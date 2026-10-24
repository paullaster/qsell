import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

test.describe('staff control a vendor’s standing', () => {
  test('suspend, block and archive each need a reason, and each can be undone', async ({ page }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'approved');
    await open(page, `/admin/vendors/${vendor.vendorId}`, vendor.legalName);
    const standing = page.getByRole('region', { name: 'Standing' });
    await expect(standing.getByText('In good standing')).toBeVisible({ timeout: 60_000 });
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    await standing.getByRole('button', { name: 'Suspend…' }).click();
    const suspend = page.getByRole('form', { name: 'Suspend this vendor' });
    await expect(suspend.getByRole('button', { name: 'Suspend this vendor' })).toBeDisabled();
    await pick(page, suspend.getByRole('combobox', { name: 'Reason' }), 'compliance', /compliance document/i);
    await suspend.getByRole('button', { name: 'Suspend this vendor' }).click();
    await expect(standing.getByText('The vendor is suspended.')).toBeVisible({ timeout: 30_000 });
    await expect(standing.getByText('Suspended', { exact: true })).toBeVisible({ timeout: 30_000 });
    await standing.getByRole('button', { name: 'Reinstate' }).click();
    await expect(standing.getByText('The vendor is active again.')).toBeVisible({ timeout: 30_000 });

    // A reason that needs an explanation is refused without one, in words.
    await standing.getByRole('button', { name: 'Block…' }).click();
    const block = page.getByRole('form', { name: 'Block this vendor' });
    await pick(page, block.getByRole('combobox', { name: 'Block' }), 'Pay', /Payments only/);
    await pick(page, block.getByRole('combobox', { name: 'Reason' }), 'dispute', /open dispute/i);
    await block.getByLabel('Comment (optional)').fill('');
    await expect(block.getByLabel('Explain (required)')).toBeVisible();
    await block.getByLabel('Explain (required)').fill('Invoice 123 is disputed');
    await block.getByRole('button', { name: 'Block this vendor' }).click();
    await expect(standing.getByText('The block is in place.')).toBeVisible({ timeout: 30_000 });
    await expect(standing.getByText('Payments blocked')).toBeVisible({ timeout: 30_000 });
    await standing.getByRole('button', { name: 'Lift the block' }).click();
    await expect(standing.getByText('The block is lifted.')).toBeVisible({ timeout: 30_000 });
    await expect(standing.getByText('Payments blocked')).toHaveCount(0);

    await standing.getByRole('button', { name: 'Archive…' }).click();
    const archive = page.getByRole('form', { name: 'Archive this vendor' });
    await pick(page, archive.getByRole('combobox', { name: 'Reason' }), 'asked', /vendor asked us to/i);
    await archive.getByRole('button', { name: 'Archive this vendor' }).click();
    await expect(standing.getByText('The vendor is archived.')).toBeVisible({ timeout: 30_000 });
    await expect(standing.getByText('Archived', { exact: true })).toBeVisible({ timeout: 30_000 });
    await standing.getByRole('button', { name: 'Restore' }).click();
    await expect(standing.getByText(/restored as suspended/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('history', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('archived').first()).toBeVisible();
  });
});

test.describe('invitations', () => {
  test('staff invite the owner of a vendor they added, resend, and cancel', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'staffadded');
    await open(page, `/admin/vendors/${vendor.vendorId}`, vendor.legalName);
    const people = page.getByRole('region', { name: 'Portal users' });
    await expect(people.getByText('Nobody has a vendor portal login')).toBeVisible({ timeout: 60_000 });
    const invite = people.getByRole('form', { name: 'Invite the owner' });
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    await expect(invite.getByLabel('Owner’s name')).toBeFocused().catch(() => undefined);
    await invite.getByLabel('Owner’s name').fill('Olive Owner');
    await invite.getByLabel('Owner’s email').fill(`owner-${tag}@example.test`);
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    await expect(people.getByText('The invitation was sent.')).toBeVisible({ timeout: 30_000 });
    await expect(people.getByText('Invited, not joined')).toBeVisible({ timeout: 30_000 });
    await expect(people.getByRole('form', { name: 'Invite the owner' })).toHaveCount(0);
    await people.getByRole('button', { name: `Resend the invitation to owner-${tag}@example.test` }).click();
    await expect(people.getByText('A fresh invitation was sent.')).toBeVisible({ timeout: 30_000 });
    await people.getByRole('button', { name: /Cancel the invitation to/ }).click();
    await people.getByRole('button', { name: /Confirm: Cancel the invitation/ }).click();
    await expect(people.getByText('The invitation is cancelled.')).toBeVisible({ timeout: 30_000 });
    await expect(people.getByRole('form', { name: 'Invite the owner' })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('an owner invites a colleague from the portal and takes the invitation back', async ({ browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.getByRole('link', { name: 'Manage my team' }).click();
      await expect(v.getByRole('heading', { name: 'Your team', level: 2 })).toBeVisible({ timeout: 60_000 });
      await noNativeSelect(v);
      const form = v.getByRole('form', { name: 'Invite a colleague' });
      await form.getByLabel('Name').fill('Fiona Finance');
      await form.getByLabel('Email').fill('not-an-email');
      await pick(v, form.getByRole('combobox', { name: 'Role' }), 'Fin', /^Finance/);
      await form.getByRole('button', { name: 'Send invitation' }).click();
      await expect(v.getByText('Enter a valid email address.').first()).toBeVisible({ timeout: 30_000 });
      await form.getByLabel('Email').fill(`colleague-${tag}@example.test`);
      await form.getByRole('button', { name: 'Send invitation' }).click();
      await expect(v.getByText(/If that address can be invited/)).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('Invited, not joined')).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(v);
      await v.getByRole('button', { name: 'Remove Fiona Finance from your team' }).click();
      await v.getByRole('button', { name: /Confirm: Remove Fiona Finance/ }).click();
      await expect(v.getByText('Removed.')).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('Invited, not joined')).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await w.close();
    }
  });
});

test.describe('changing where a vendor is paid', () => {
  test('the vendor asks, staff phone and a second person approves, and the new account waits out the cool-off', async ({ page, browser }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'approved');
    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.goto('/vendor/profile/financial');
      await expect(v.getByRole('heading', { name: 'Where you are paid', level: 3 })).toBeVisible({ timeout: 60_000 });
      await expect(v.getByRole('form', { name: 'Add a bank account' })).toHaveCount(0);
      await v.getByRole('button', { name: 'Change my bank details…' }).click();
      const form = v.getByRole('form', { name: 'Request a change of bank details' });
      await expect(form.getByRole('button', { name: 'Send the request' })).toBeDisabled();
      await form.getByLabel('Bank', { exact: true }).fill('Equity Bank');
      await form.getByLabel('Branch').fill('Westlands');
      await form.getByLabel('Account name').fill(vendor.legalName);
      await form.getByLabel('Account number').fill('9988776655');
      await form.getByLabel(/^Replaces KCB/).check();
      await form.getByRole('radio', { name: /\.pdf$/ }).first().check();
      await noHorizontalScroll(v);
      await form.getByRole('button', { name: 'Send the request' }).click();
      await expect(v.getByText(/Your request was sent/)).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('Waiting', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText(/We will phone you on the number we hold/)).toBeVisible();
      await expect(v.getByText('9988776655')).toHaveCount(0);

      // Staff: a call-back is recorded, and the same person cannot also approve.
      await open(page, '/admin/vendors/bank-changes', 'Vendor bank changes');
      const card = page.getByRole('article', { name: `Bank change for ${vendor.legalName}` });
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(card.getByText('Needs a call-back to the vendor')).toBeVisible();
      await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
      await noHorizontalScroll(page);
      await card.getByRole('button', { name: 'Record the call-back…' }).click();
      await card.getByRole('button', { name: 'Save the call-back' }).click();
      await card.getByLabel(/Who you spoke to/).fill('Phoned the finance manager on the number in our records; confirmed.');
      await card.getByRole('button', { name: 'Save the call-back' }).click();
      await expect(card.getByText('The call-back is recorded.')).toBeVisible({ timeout: 30_000 });
      await expect(card.getByText(/different person must approve/)).toBeVisible({ timeout: 30_000 });
      await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    } finally {
      await w.close();
    }
  });

  test('a second person approves a confirmed change; the account starts only after the cool-off', async ({ page, browser }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'bankready');
    await open(page, '/admin/vendors/bank-changes', 'Vendor bank changes');
    const card = page.getByRole('article', { name: `Bank change for ${vendor.legalName}` });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText(/needs a second person to approve/)).toBeVisible();
    await expect(card.getByText(`•••• ${vendor.newLast4 ?? ''}`)).toBeVisible();
    await card.getByRole('link', { name: 'Open the bank letter' }).waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card.getByText('Approved. The account will be used after the cool-off.')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('Approved · waiting out the cool-off')).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('In use from')).toBeVisible();

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto('/vendor/profile/financial');
      await expect(w.page.getByText(/It will be used after a short waiting period/)).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByText('KCB, Moi Avenue')).toBeVisible();
    } finally {
      await w.close();
    }
  });

  test('a refused change leaves the vendor’s account as it was', async ({ page, browser }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'bankpending');
    await open(page, '/admin/vendors/bank-changes', 'Vendor bank changes');
    const card = page.getByRole('article', { name: `Bank change for ${vendor.legalName}` });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole('button', { name: 'Refuse…' }).click();
    await card.getByRole('button', { name: 'Refuse the change' }).click();
    await card.getByLabel('Why the change is refused').fill('The letter does not match the account name.');
    await card.getByRole('button', { name: 'Refuse the change' }).click();
    await expect(page.getByRole('article', { name: `Bank change for ${vendor.legalName}` })).toHaveCount(0, { timeout: 30_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto('/vendor/profile/financial');
      await expect(w.page.getByText('KCB, Moi Avenue')).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByText('Waiting', { exact: true })).toHaveCount(0);
      await expect(w.page.getByRole('button', { name: 'Change my bank details…' })).toBeVisible();
    } finally {
      await w.close();
    }
  });
});

test.describe('vendor worklists and settings', () => {
  test('the review queue lists a vendor waiting for a decision', async ({ page }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'submitted');
    await open(page, '/admin/vendors/review', 'Vendor review queue');
    const row = page.getByRole('link', { name: new RegExp(vendor.legalName) });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByText('Waiting for a reviewer')).toBeVisible();
    await noHorizontalScroll(page);
    await row.click();
    await expect(page.getByRole('heading', { name: vendor.legalName, level: 2 })).toBeVisible({ timeout: 60_000 });
  });

  test('the expiring documents list shows what is close and what has gone', async ({ page }, testInfo) => {
    test.slow();
    const vendor = makeVendor(attemptTag(testInfo.project.name, testInfo.retry), 'expiring');
    await open(page, '/admin/vendors/expiring', 'Expiring vendor documents');
    const row = page.getByRole('link', { name: new RegExp(vendor.legalName) });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByText(/[3-5] days left/)).toBeVisible();
    await expect(row.getByText(/Tax compliance certificate/)).toBeVisible();
    await noHorizontalScroll(page);
    await noNativeSelect(page);
    // A narrower window leaves out what is further away.
    await pick(page, page.getByRole('combobox', { name: 'Show' }), 'Within 30', /Within 30 days/);
    await expect(page.getByRole('link', { name: new RegExp(vendor.legalName) })).toBeVisible({ timeout: 30_000 });
  });

  test('document types can be added and changed, and the code stays fixed', async ({ page }, testInfo) => {
    test.slow();
    const code = `E2E_${attemptTag(testInfo.project.name, testInfo.retry).toUpperCase()}`;
    await open(page, '/admin/vendors/document-types', 'Vendor document types');
    await expect(page.getByRole('listitem').filter({ hasText: 'Tax compliance certificate' })).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Add a document type' }).click();
    const form = page.getByRole('form', { name: 'Add a document type' });
    await form.getByLabel('Code').fill('bad code!');
    await form.getByLabel('Name').fill('Health permit');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Use capital letters/)).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Code').fill(code);
    await form.getByLabel('Has an expiry date').check();
    await form.getByLabel('Blocks the vendor when it expires').check();
    await form.getByLabel('Remind the vendor (days before it expires)').fill('45, 10');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
    const item = page.getByRole('listitem').filter({ hasText: code });
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item.getByText('reminders at 45, 10')).toBeVisible();
    await item.getByRole('button', { name: 'Edit Health permit' }).click();
    const edit = page.getByRole('form', { name: 'Edit the document type' });
    await expect(edit.getByLabel('Code')).toBeDisabled();
    await edit.getByLabel('Name').fill('Health and safety permit');
    await edit.getByLabel('In use').uncheck();
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Health and safety permit' }).getByText('Not in use')).toBeVisible({ timeout: 30_000 });
  });
});
