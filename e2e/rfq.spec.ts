import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, makeRfq, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

const localIn = (hours: number): string => {
  const d = new Date(Date.now() + hours * 3_600_000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

test.describe('staff write and issue a request', () => {
  test('a draft is written, qualified vendors are invited, and it is issued with a number', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makeRfq(tag, [vendor.vendorId], 'category');
    await open(page, '/admin/vendors/rfqs', 'Requests for quotation');
    await noNativeSelect(page);
    await page.getByRole('link', { name: 'New request' }).click();
    await expect(page.getByRole('heading', { name: 'New request for quotation', level: 2 })).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Title').fill(`Solar kit ${tag}`);
    await pick(page, page.getByRole('combobox', { name: 'Category' }), cat.categoryName.slice(-10), new RegExp(cat.categoryName));
    await pick(page, page.getByRole('combobox', { name: 'Currency' }), 'KES', /KES/);
    await page.getByLabel('Quotes are due').fill(localIn(72));
    await page.getByLabel('Description').first().fill('Inverter 5kW');
    await page.getByLabel('Quantity', { exact: true }).first().fill('4');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByRole('heading', { name: 'Draft request', level: 2 })).toBeVisible({ timeout: 60_000 });
    await noHorizontalScroll(page);

    // Only vendors qualified in the category can be invited.
    await expect(page.getByRole('checkbox', { name: new RegExp(vendor.legalName) })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Save and issue to the invited vendors' }).click();
    await expect(page.getByText('Invite at least one qualified vendor before issuing.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('checkbox', { name: new RegExp(vendor.legalName) }).check();
    await page.getByRole('button', { name: 'Save and issue to the invited vendors' }).click();
    await expect(page.getByText('Issued. The invited vendors have been told.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /RFQ-\d{4}-\d{5}/, level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Title')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  });
});

test.describe('a vendor quotes', () => {
  test('the request is opened, a question asked, a quote saved, sent, withdrawn and sent again', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const rfq = makeRfq(tag, [vendor.vendorId], 'issued');
    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.getByRole('link', { name: 'Open my requests' }).click();
      await expect(v.getByRole('heading', { name: 'Requests for quotation', level: 2 })).toBeVisible({ timeout: 60_000 });
      const row = v.getByRole('link', { name: new RegExp(rfq.title ?? '') });
      await expect(row.getByText('New')).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(v);
      await row.click();
      await expect(v.getByRole('heading', { name: new RegExp(rfq.title ?? ''), level: 2 })).toBeVisible({ timeout: 60_000 });
      await noNativeSelect(v);

      // A question goes to the buyer, who answers every vendor without naming the asker.
      await v.getByLabel('Ask the buyer').fill('Is the cable single core?');
      await v.getByRole('button', { name: 'Send the question' }).click();
      await expect(v.getByText(/Your question was sent/)).toBeVisible({ timeout: 30_000 });

      // Sending an unfinished quote is refused in words against the line.
      await v.getByRole('button', { name: 'Send my quote' }).click();
      await expect(v.getByText(/Answer “Inverter 5kW”|Give the price for one unit/).first()).toBeVisible({ timeout: 30_000 });
      const form = v.getByRole('form', { name: 'Quote' });
      const prices = form.getByLabel('Price for one unit');
      await prices.nth(0).fill('free');
      await prices.nth(1).fill('2.25');
      await form.getByRole('button', { name: 'Save draft' }).click();
      await expect(v.getByText('Give the price for one unit, like 1250.50.').first()).toBeVisible({ timeout: 30_000 });
      await prices.nth(0).fill('1250.50');
      await form.getByLabel('Tax (%)').nth(0).fill('16');
      await form.getByLabel('Tax (%)').nth(1).fill('16');
      await expect(v.getByText(/Total: .*6,?063\.32 KES/)).toBeVisible();
      await form.getByLabel('Your quote holds until').fill(new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10));
      await form.getByRole('button', { name: 'Save draft' }).click();
      await expect(v.getByText('Saved. It has not been sent yet.')).toBeVisible({ timeout: 30_000 });
      await v.getByRole('button', { name: 'Send my quote' }).click();
      await expect(v.getByText('Your quote was sent.')).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('Submitted').first()).toBeVisible({ timeout: 30_000 });
      await expect(v.getByRole('button', { name: 'Send my quote' })).toHaveCount(0);
      await expect(v.getByText(/You sent version 1/)).toBeVisible();
      await noHorizontalScroll(v);

      // Withdrawing makes it editable again.
      await v.getByRole('button', { name: 'Withdraw your sent quote' }).click();
      await v.getByRole('button', { name: /Confirm: Withdraw your sent quote/ }).click();
      await expect(v.getByText(/Your quote is withdrawn/)).toBeVisible({ timeout: 30_000 });
      await expect(v.getByRole('button', { name: 'Send my quote' })).toBeVisible({ timeout: 30_000 });

      // Staff see the question and answer it to everyone.
      await open(page, `/admin/vendors/rfqs/${rfq.rfqId ?? ''}`, /RFQ-/);
      await expect(page.getByText('Is the cable single core?')).toBeVisible({ timeout: 60_000 });
      await page.getByLabel(/Answer for/).fill('Yes, single core.');
      await page.getByRole('button', { name: 'Answer all vendors' }).click();
      await expect(page.getByText(/Answered, and sent to every invited vendor/)).toBeVisible({ timeout: 30_000 });
    } finally {
      await w.close();
    }
  });

  test('a vendor can decline to bid with a reason', async ({ browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const rfq = makeRfq(tag, [vendor.vendorId], 'issued');
    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.goto(`/vendor/rfqs/${rfq.rfqId ?? ''}`);
      await v.getByRole('button', { name: 'I am not bidding…' }).click();
      await v.getByLabel('Why are you not bidding?').fill('We do not stock this brand');
      await v.getByRole('button', { name: 'Decline to bid' }).click();
      await expect(v.getByText('You declined this request.')).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('You declined').first()).toBeVisible({ timeout: 30_000 });
      await expect(v.getByRole('form', { name: 'Quote' })).toHaveCount(0);
    } finally {
      await w.close();
    }
  });
});

test.describe('staff compare and award', () => {
  test('sealed quotes stay closed; after the deadline they are compared and awarded, and each vendor sees only its own result', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const a = makeVendor(`${tag}a`, 'approved');
    const b = makeVendor(`${tag}b`, 'approved');
    // Sealed first: made with quotes but not closed.
    const sealed = makeRfq(`${tag}s`, [a.vendorId, b.vendorId], 'quoted');
    await open(page, `/admin/vendors/rfqs/${sealed.rfqId ?? ''}/quotes`, 'Quotes');
    await expect(page.getByText('The quotes are sealed.')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/2 quotes have arrived/)).toBeVisible();
    await expect(page.getByText(a.legalName)).toHaveCount(0);
    await noHorizontalScroll(page);

    const closed = makeRfq(`${tag}c`, [a.vendorId, b.vendorId], 'closed');
    await open(page, `/admin/vendors/rfqs/${closed.rfqId ?? ''}/quotes`, 'Quotes and comparison');
    await expect(page.getByRole('table', { name: /One row for each line/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Lowest complete quote', { exact: true })).toBeVisible();
    await expect(page.getByText('lowest', { exact: true }).first()).toBeVisible();
    await noHorizontalScroll(page);
    await noNativeSelect(page);

    // Refusing needs a reason; the vendor is told it.
    await page.getByRole('button', { name: 'Refuse…' }).first().click();
    const refuse = page.getByRole('form', { name: /Refuse the quote from/ });
    await expect(refuse.getByRole('button', { name: 'Refuse the quote' })).toBeDisabled();
    await pick(page, refuse.getByRole('combobox', { name: 'Reason' }), 'price', /price is higher/);
    await refuse.getByRole('button', { name: 'Refuse the quote' }).click();
    await expect(page.getByText('Refused', { exact: true })).toBeVisible({ timeout: 30_000 });

    // The refused vendor (first by name) is not offered for award; the other gets both lines at full quantity.
    const award = page.getByRole('region', { name: 'Award' });
    const boxes = award.getByRole('checkbox');
    await expect(boxes).toHaveCount(2);
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await award.getByRole('button', { name: /^Award/ }).dispatchEvent('click');
    await expect(page.getByText('Awarded. The vendors were told the result.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Award' }).getByText(/to .*Fixture Vendor/).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Accept for award' })).toHaveCount(0);

    // Each vendor sees only its own result.
    for (const [vendor, expected, other] of [[b, 'Awarded to you', 'Rejected'], [a, 'Rejected', 'Awarded to you']] as const) {
      const w = await signedOutPage(browser, testInfo);
      try {
        await signInAsVendor(w.page, vendor);
        await w.page.goto(`/vendor/rfqs/${closed.rfqId ?? ''}`);
        await expect(w.page.getByText(expected).first()).toBeVisible({ timeout: 60_000 });
        await expect(w.page.getByText(other)).toHaveCount(0);
        await expect(w.page.getByText(new RegExp(vendor === a ? b.legalName : a.legalName))).toHaveCount(0);
      } finally {
        await w.close();
      }
    }
  });

  test('a revision can be asked for, and the vendor sends a new version', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const a = makeVendor(`${tag}a`, 'approved');
    const rfq = makeRfq(tag, [a.vendorId], 'closed');
    await open(page, `/admin/vendors/rfqs/${rfq.rfqId ?? ''}/quotes`, 'Quotes and comparison');
    await page.getByRole('button', { name: 'Ask for a revision…' }).click();
    const form = page.getByRole('form', { name: /Ask .* to revise/ });
    await form.getByLabel('What must change').fill('Please include delivery in the price');
    await form.getByLabel('Send the revision by').fill(localIn(24));
    await form.getByRole('button', { name: 'Ask for a revision' }).click();
    await expect(page.getByText('The vendor was asked to revise its quote.')).toBeVisible({ timeout: 30_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, a);
      await v.goto(`/vendor/rfqs/${rfq.rfqId ?? ''}`);
      await expect(v.getByText(/Please include delivery in the price/)).toBeVisible({ timeout: 60_000 });
      await expect(v.getByText('Revision requested').first()).toBeVisible();
      await v.getByRole('form', { name: 'Quote' }).getByLabel('Price for one unit').first().fill('990');
      await v.getByRole('button', { name: 'Send my revised quote' }).click();
      await expect(v.getByText('Your quote was sent.')).toBeVisible({ timeout: 30_000 });
    } finally {
      await w.close();
    }
  });
});
