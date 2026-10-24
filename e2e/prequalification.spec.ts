import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { attemptTag, makePrequal, makeVendor, signedOutPage, signInAsVendor } from './support/vendors';

test.describe('staff design a category', () => {
  test('a category is made, given questions, opened, and then its questions are fixed', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry).toUpperCase();
    await open(page, '/admin/vendors/categories', 'Procurement categories');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Add a category' }).click();
    const add = page.getByRole('form', { name: 'Add a category' });
    await add.getByLabel('Code').fill(`UI_${tag}`);
    await add.getByLabel('Name').fill(`Solar ${tag}`);
    await add.getByRole('button', { name: 'Create and set up' }).click();
    await expect(page.getByRole('heading', { name: `Solar ${tag}`, level: 2 })).toBeVisible({ timeout: 60_000 });

    const q = page.getByRole('form', { name: 'Add a question' });
    await q.getByLabel('Question').fill('Do you hold a manufacturer licence?');
    await q.getByLabel('Points it can earn').fill('10');
    await q.getByRole('button', { name: 'Add question' }).click();
    await expect(page.getByText('Question added.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('1. Do you hold a manufacturer licence?')).toBeVisible({ timeout: 30_000 });
    await q.getByLabel('Question').fill('Describe your biggest job');
    await pick(page, q.getByRole('combobox', { name: 'Kind of answer' }), 'written', /A written answer/);
    await q.getByRole('button', { name: 'Add question' }).click();
    await expect(page.getByText('2. Describe your biggest job')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Pass mark (% of the highest score)').fill('50');
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Open for applications' }).click();
    await expect(page.getByText('The category is open. Vendors can apply.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/so they are fixed/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('form', { name: 'Add a question' })).toHaveCount(0);
    await expect(page.getByLabel('A qualification lasts (months)')).toBeDisabled();
    await noHorizontalScroll(page);
  });
});

test.describe('a vendor applies', () => {
  test('several categories are chosen at once, the questions are answered and the application is sent', async ({ browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const one = makePrequal(`${tag}a`, null, 'category');
    const two = makePrequal(`${tag}b`, null, 'category');
    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.getByRole('link', { name: 'Open prequalification' }).click();
      await expect(v.getByRole('heading', { name: 'Prequalification', level: 2 })).toBeVisible({ timeout: 60_000 });
      await noNativeSelect(v);
      await noHorizontalScroll(v);
      await v.getByRole('checkbox', { name: new RegExp(one.categoryName) }).check();
      await v.getByRole('checkbox', { name: new RegExp(two.categoryName) }).check();
      await v.getByRole('button', { name: 'Apply for 2 categories' }).click();
      await expect(v.getByRole('link', { name: new RegExp(one.categoryName) })).toBeVisible({ timeout: 30_000 });
      await expect(v.getByRole('link', { name: new RegExp(two.categoryName) })).toBeVisible();

      await v.getByRole('link', { name: new RegExp(one.categoryName) }).click();
      await expect(v.getByRole('heading', { name: one.categoryName, level: 2 })).toBeVisible({ timeout: 60_000 });
      // Sending with a required question empty is refused in words, against the question.
      await v.getByRole('button', { name: 'Save and send' }).click();
      await expect(v.getByText('This question needs an answer.').first()).toBeVisible({ timeout: 30_000 });
      await v.getByRole('radio', { name: 'Yes' }).check();
      await v.getByLabel(/How many projects/).fill('twelve');
      await v.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(v.getByText('Enter a number.').first()).toBeVisible({ timeout: 30_000 });
      await v.getByLabel(/How many projects/).fill('12');
      await v.getByRole('button', { name: 'Save and send' }).click();
      await expect(v.getByText('Your application was sent. We will evaluate it.')).toBeVisible({ timeout: 30_000 });
      await expect(v.getByText('Sent, waiting for an evaluator').first()).toBeVisible({ timeout: 30_000 });
      await expect(v.getByRole('button', { name: 'Save and send' })).toHaveCount(0);
      await noHorizontalScroll(v);
    } finally {
      await w.close();
    }
  });
});

test.describe('staff evaluate and decide', () => {
  test('another person approves an evaluated application and the vendor sees it', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makePrequal(tag, vendor.vendorId, 'evaluated');
    await open(page, `/admin/vendors/prequalification/${cat.entryId ?? ''}`, vendor.legalName);
    await expect(page.getByText('Being evaluated').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Score so far: 30 of 30')).toBeVisible();
    await expect(page.getByText('Evidence seen')).toHaveCount(2);
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Approve…' }).click();
    const form = page.getByRole('form', { name: 'Approve this application' });
    await form.getByLabel('Largest order value (optional)').fill('2000000');
    await form.getByLabel('Conditions (optional)').fill('Up to KES 2M per order');
    await form.getByRole('button', { name: 'Approve this vendor for the category' }).click();
    await expect(page.getByText('Approved. The vendor is qualified.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Qualified', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Conditions: largest order 2000000/)).toBeVisible({ timeout: 30_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto(`/vendor/prequalification/${cat.entryId ?? ''}`);
      await expect(w.page.getByText(/Qualified until \d{4}-\d{2}-\d{2}/)).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByText(/largest order 2000000/)).toBeVisible();
      // This category shows the vendor no scores.
      await expect(w.page.getByText(/Score:/)).toHaveCount(0);
      await expect(w.page.getByText(/Your score/)).toHaveCount(0);
    } finally {
      await w.close();
    }

    // A qualified vendor can be suspended and brought back, with a reason.
    await page.reload();
    await page.getByRole('button', { name: 'Suspend…' }).click();
    const suspend = page.getByRole('form', { name: 'Suspend this qualification' });
    await pick(page, suspend.getByRole('combobox', { name: 'Reason' }), 'Poor', /Poor performance/);
    await suspend.getByLabel('Explain (required)').fill('Three late deliveries');
    await suspend.getByRole('button', { name: 'Suspend', exact: true }).click();
    await expect(page.getByText('The qualification is suspended.')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Reinstate' }).click();
    await expect(page.getByText('The qualification is back in force.')).toBeVisible({ timeout: 30_000 });
  });

  test('the person who evaluated cannot also decide; the application is refused with a reason', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makePrequal(tag, vendor.vendorId, 'submitted');
    await open(page, `/admin/vendors/prequalification/${cat.entryId ?? ''}`, vendor.legalName);
    await expect(page.getByRole('button', { name: 'Approve…' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Take for evaluation' }).click();
    await expect(page.getByText('You are now an evaluator of this application.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/You evaluated this application, so someone else must decide it/)).toBeVisible({ timeout: 30_000 });
    // Scores cannot exceed the points a question is worth.
    await page.getByLabel('Your score for question 1').fill('11');
    await page.getByRole('button', { name: 'Save my scores' }).click();
    await expect(page.getByText(/whole number from 0 to 10/)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Your score for question 1').fill('4');
    await page.getByLabel('Your score for question 2').fill('6');
    await page.getByRole('button', { name: 'Save my scores' }).click();
    await expect(page.getByText('Your scores are saved.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Score so far: 10 of 30 · pass mark 60%/)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('an application the vendor must correct is sent back and the vendor sees why', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makePrequal(tag, vendor.vendorId, 'evaluated');
    await open(page, `/admin/vendors/prequalification/${cat.entryId ?? ''}`, vendor.legalName);
    await page.getByRole('button', { name: 'Ask for changes…' }).click();
    const form = page.getByRole('form', { name: 'Ask for changes' });
    await form.getByLabel('What must change').fill('Give the number of projects as a figure');
    await form.getByRole('button', { name: 'Send back' }).click();
    await expect(page.getByText('Sent back to the vendor.')).toBeVisible({ timeout: 30_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      const v = w.page;
      await signInAsVendor(v, vendor);
      await v.goto(`/vendor/prequalification/${cat.entryId ?? ''}`);
      await expect(v.getByText(/Give the number of projects as a figure/)).toBeVisible({ timeout: 60_000 });
      await expect(v.getByText('Changes asked for').first()).toBeVisible();
      await v.getByLabel(/How many projects/).fill('15');
      await v.getByRole('button', { name: 'Save and send again' }).click();
      await expect(v.getByText('Your application was sent. We will evaluate it.')).toBeVisible({ timeout: 30_000 });
    } finally {
      await w.close();
    }
  });

  test('a refused application tells the vendor the reason; the queue filters by status', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const vendor = makeVendor(tag, 'approved');
    const cat = makePrequal(tag, vendor.vendorId, 'evaluated');
    await open(page, `/admin/vendors/prequalification/${cat.entryId ?? ''}`, vendor.legalName);
    await page.getByRole('button', { name: 'Refuse…' }).click();
    const form = page.getByRole('form', { name: 'Refuse this application' });
    await expect(form.getByRole('button', { name: 'Refuse the application' })).toBeDisabled();
    await pick(page, form.getByRole('combobox', { name: 'Reason' }), 'relevant', /does not offer what this category covers/);
    await form.getByRole('button', { name: 'Refuse the application' }).click();
    await expect(page.getByText('The application is refused.')).toBeVisible({ timeout: 30_000 });

    await open(page, '/admin/vendors/prequalification', 'Prequalification applications');
    await expect(page.getByRole('link', { name: new RegExp(vendor.legalName) })).toHaveCount(0);
    await pick(page, page.getByRole('combobox', { name: 'Show' }), 'Not acc', /Not accepted/);
    await expect(page.getByRole('link', { name: new RegExp(vendor.legalName) })).toBeVisible({ timeout: 30_000 });

    const w = await signedOutPage(browser, testInfo);
    try {
      await signInAsVendor(w.page, vendor);
      await w.page.goto(`/vendor/prequalification/${cat.entryId ?? ''}`);
      await expect(w.page.getByText(/Reason: not relevant/)).toBeVisible({ timeout: 60_000 });
      await expect(w.page.getByText('Not accepted').first()).toBeVisible();
    } finally {
      await w.close();
    }
  });
});
