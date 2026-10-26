import { expect, test } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, makePo, makeRfq, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

test.describe('staff write an order', () => {
  test('an order is written, sent for approval, and cannot be approved by its writer', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makeRfq(tag, [vendor.vendorId], 'category');
    await open(page, '/admin/vendors/orders', 'Purchase orders');
    await noNativeSelect(page);
    await page.getByRole('link', { name: 'New order' }).click();
    await expect(page.getByRole('heading', { name: 'New purchase order', level: 2 })).toBeVisible({ timeout: 60_000 });
    await pick(page, page.getByRole('combobox', { name: 'Vendor' }), vendor.legalName.slice(-10), new RegExp(vendor.legalName));
    await pick(page, page.getByRole('combobox', { name: 'Category' }), cat.categoryName.slice(-10), new RegExp(cat.categoryName));
    await pick(page, page.getByRole('combobox', { name: 'Currency' }), 'KES', /KES/);
    await page.getByLabel('Why this order is not from a request for quotation').fill('Urgent repair');
    await page.getByLabel('Description').first().fill('Inverter 5kW');
    await page.getByLabel('Unit price').first().fill('1000');
    await page.getByLabel('Tax (%)').first().fill('16');
    await expect(page.getByText(/Total: 1,?160\.00/)).toBeVisible();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('heading', { name: 'Draft order', level: 2 })).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Save and send for approval' }).click();
    await expect(page.getByText('Sent for approval.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/You wrote this order, so someone else must approve it/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  });
});

test.describe('approving, sending and confirming', () => {
  test('another person approves, the order is sent, the vendor confirms, and staff see it confirmed', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'pending');
    await open(page, `/admin/vendors/orders/${po.poId ?? ''}`, 'Draft order');
    await expect(page.getByText('Waiting for approval').first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Approved. The order has its number.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: /PO-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Description').first()).toBeDisabled();
    await page.getByRole('button', { name: 'Send to the vendor' }).click();
    await expect(page.getByText('Sent to the vendor.')).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);

    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.getByRole('link', { name: 'Open my orders' }).click();
      await expect(v.getByRole('heading', { name: 'Purchase orders', level: 2 })).toBeVisible({ timeout: 60_000 });
      await expect(v.getByText('Please confirm')).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(v);
      await v.getByRole('link', { name: /PO-\d{4}-\d{5}/ }).click();
      await expect(v.getByRole('heading', { name: /Order PO-/, level: 2 })).toBeVisible({ timeout: 60_000 });
      await expect(v.getByText('Inverter 5kW').first()).toBeVisible();
      await expect(v.getByText(/^Total: 4,?890\.00 KES/)).toBeVisible();
      await v.getByRole('button', { name: 'Confirm this order' }).click();
      await expect(v.getByText('Thank you. The order is confirmed.')).toBeVisible({ timeout: 30_000 });
      await expect(v.getByRole('button', { name: 'Confirm this order' })).toHaveCount(0);
    } finally {
      await w.close();
    }
    await page.reload();
    await expect(page.getByText('Confirmed by the vendor').first()).toBeVisible({ timeout: 60_000 });
  });

  test('a price change waits for approval, then the vendor sees what changed and confirms again', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'amendment');
    await open(page, `/admin/vendors/orders/${po.poId ?? ''}`, /PO-/);
    await expect(page.getByText('Change waiting for approval').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/A change is waiting for approval: Price agreed down/)).toBeVisible();
    await page.getByRole('button', { name: 'Approve the change' }).click();
    await expect(page.getByText(/The change is applied/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Version 2').first()).toBeVisible({ timeout: 30_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.goto(`/vendor/orders/${po.poId ?? ''}`);
      await expect(v.getByText(/What changed in version 2/)).toBeVisible({ timeout: 60_000 });
      await expect(v.getByText(/Inverter 5kW: price 1000.00 to 950/)).toBeVisible();
      await v.getByRole('button', { name: 'Confirm the changed order' }).click();
      await expect(v.getByText('Thank you. The order is confirmed.')).toBeVisible({ timeout: 30_000 });
    } finally {
      await w.close();
    }
  });
});

test.describe('advance payment', () => {
  test('the advance document is written by one person and approved by another; the vendor sees it', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'advance_pending');
    await open(page, `/admin/vendors/orders/${po.poId ?? ''}`, /PO-/);
    const advance = page.getByRole('region', { name: 'Advance payment' });
    await expect(advance.getByText('Waiting for approval')).toBeVisible({ timeout: 60_000 });
    await advance.getByRole('button', { name: 'Approve the advance' }).click();
    await expect(page.getByText('The advance payment is approved.')).toBeVisible({ timeout: 30_000 });
    await expect(advance.getByText('Approved, to be paid')).toBeVisible({ timeout: 30_000 });
    await expect(advance.getByRole('form', { name: 'Ask for an advance payment' })).toHaveCount(0);
    await noHorizontalScroll(page);

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto(`/vendor/orders/${po.poId ?? ''}`);
      await expect(w.page.getByRole('region', { name: 'Advance payment' }).getByText(/1000\.00 KES/)).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByText('Approved, to be paid')).toBeVisible();
    } finally {
      await w.close();
    }
  });

  test('a written advance cannot exceed the order and cannot be approved by its writer', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'sent_flagged');
    await open(page, `/admin/vendors/orders/${po.poId ?? ''}`, /PO-/);
    const form = page.getByRole('form', { name: 'Ask for an advance payment' });
    await form.getByLabel('Advance amount').fill('9999');
    await form.getByLabel('Why an advance').fill('Deposit to start work');
    await form.getByRole('button', { name: 'Write the advance payment' }).click();
    await expect(page.getByText(/An advance cannot be more than 4890\.00/)).toBeVisible({ timeout: 30_000 });
    await form.getByLabel('Advance amount').fill('1000');
    await form.getByRole('button', { name: 'Write the advance payment' }).click();
    await expect(page.getByText('The advance payment document was written.')).toBeVisible({ timeout: 30_000 });
    const advance = page.getByRole('region', { name: 'Advance payment' });
    await advance.getByRole('button', { name: 'Send for approval' }).click();
    await expect(advance.getByText('Waiting for approval')).toBeVisible({ timeout: 30_000 });
    await expect(advance.getByRole('button', { name: 'Approve the advance' })).toHaveCount(0);
  });
});

test.describe('making orders from an award', () => {
  test('each awarded vendor gets a draft order with the awarded quantity and price', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const award = makePo(tag, vendor.vendorId, 'awarded');
    await open(page, `/admin/vendors/rfqs/${award.rfqId ?? ''}/quotes`, 'Quotes and comparison');
    await page.getByRole('button', { name: 'Make the purchase orders…' }).dispatchEvent('click');
    await page.getByRole('button', { name: `Make the order for ${vendor.legalName}` }).dispatchEvent('click');
    await expect(page.getByRole('heading', { name: 'Draft order', level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Made from request RFQ-/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('Description').first()).toHaveValue('Inverter 5kW');
    await expect(page.getByLabel('Unit price').first()).toHaveValue('950.00');
    await expect(page.getByLabel('Quantity').first()).toHaveValue('4.000');
    await noHorizontalScroll(page);
  });
});

test.describe('an approval workflow', () => {
  test('an order held by a workflow cannot be approved on its own screen, only from the Approvals inbox', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const po = makePo(tag, vendor.vendorId, 'workflow');
    await open(page, `/admin/vendors/orders/${po.poId ?? ''}`, 'Draft order');
    await expect(page.getByText(/Waiting in the Approvals inbox/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await noHorizontalScroll(page);

    await open(page, '/admin/approvals/inbox', 'Approvals waiting on you');
    await page.getByLabel('Search').fill(po.poId ?? '');
    const card = page.getByRole('list', { name: 'Requests waiting on you' }).getByRole('listitem').first();
    await expect(card).toContainText('Purchase orders', { timeout: 60_000 });
    await card.getByRole('button', { name: 'Review' }).click();
    await clickUntilVisible(card.getByRole('button', { name: 'Approve', exact: true }), card.getByRole('button', { name: 'Confirm approval' }));
    await card.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(page.getByText('No requests match')).toBeVisible({ timeout: 60_000 });

    await page.goto(`/admin/vendors/orders/${po.poId ?? ''}`);
    await expect(page.getByRole('button', { name: 'Send to the vendor' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Waiting in the Approvals inbox/)).toHaveCount(0);
  });
});
