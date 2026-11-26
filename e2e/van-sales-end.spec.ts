import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { makePlace, setLedger, stockedProduct } from './support/stock-fixtures';
import { vanTool } from './support/van-fixtures';

test.beforeAll(() => {
  setLedger('on');
  vanTool('reset-rep', 'start');
});
test.afterAll(() => {
  vanTool('reset-rep', 'end');
  setLedger('off');
});

/** The first Monday after today, or a week later: both are inside the fortnight the rep's phone shows, and each project takes one (the rep has one day a date). */
function mondayAhead(weeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

test.describe('van sales: the end of the day', () => {
  test('the rep skips what is left and says they are back, unloads the van, the warehouse receives it and the day starts to be settled', async ({ page }, testInfo) => {
    test.slow();
    const phone = testInfo.project.name === 'phone';
    const tag = `en${String(Date.now()).slice(-6)}${phone ? 'p' : 'd'}`;
    const fixture = vanTool('day-route', tag, 'admin');
    const routeName = fixture.route ?? '';
    const shops = (fixture.shops ?? '').split('|');
    const place = `VEW${tag}`.toUpperCase();
    makePlace(place, `End warehouse ${tag}`);
    const soda = stockedProduct(tag, 40, place);
    vanTool('par', routeName, soda.id, '20');
    const dayFix = vanTool('out-day', routeName, place, mondayAhead(phone ? 1 : 0));
    await page.goto(`/admin/van-sales/days/${dayFix.dayId ?? ''}`);
    const end = page.getByRole('region', { name: 'End of the day', exact: true });
    await expect(end).toBeVisible({ timeout: 90_000 });

    // Not back while visits are still to be made.
    await expect(end.getByTestId('back-problem')).toContainText('have not been finished');
    await expect(end.getByRole('button', { name: 'I am back at the depot' })).toBeDisabled();
    const visits = page.getByRole('list', { name: 'Visits in order' }).getByRole('listitem');
    for (const shop of shops) {
      await expect(async () => {
        await page.getByRole('button', { name: `Skip ${shop}` }).click();
        await expect(page.getByRole('form', { name: `Skip ${shop}` })).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 60_000 });
      const skip = page.getByRole('form', { name: `Skip ${shop}` });
      await skip.getByLabel('Why?').fill('Not visited today');
      await skip.getByRole('button', { name: 'Skip this customer' }).click();
      await expect(visits.nth(shops.indexOf(shop))).toContainText('Skipped', { timeout: 30_000 });
    }
    await expect(end.getByTestId('back-problem')).toHaveCount(0);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Back: selling stops and the van is to be unloaded.
    await end.getByRole('button', { name: 'I am back at the depot' }).click();
    const day = page.getByRole('region', { name: 'The day', exact: true });
    await expect(day).toContainText('Back at the depot', { timeout: 30_000 });
    await expect(end).toContainText('product is still on the van');
    await expect(end.getByTestId('reconcile-problem')).toContainText('Unload it first');
    await expect(end.getByRole('button', { name: 'Start settling the day' })).toBeDisabled();
    await end.getByRole('button', { name: 'Unload the van' }).click();
    const cards = page.getByRole('list', { name: 'Loads of the day' }).locator(':scope > li');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    const unload = cards.filter({ hasText: 'Unload' });
    await expect(unload).toContainText('On its way to the warehouse', { timeout: 30_000 });
    await expect(end.getByTestId('reconcile-problem')).toContainText('not been received');

    // The warehouse counts it in: everything that was sent.
    await expect(async () => {
      await unload.getByRole('button', { name: 'Receive at the warehouse' }).click();
      await expect(page.getByRole('form', { name: /^Receive / })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.getByRole('form', { name: /^Receive / }).getByRole('button', { name: 'Receive it' }).click();
    await expect(unload).toContainText('Received at the warehouse', { timeout: 30_000 });
    await expect(end.getByTestId('reconcile-problem')).toHaveCount(0);
    await end.getByRole('button', { name: 'Start settling the day' }).click();
    await expect(day).toContainText('Being counted', { timeout: 30_000 });
    const history = page.getByRole('list', { name: 'History' });
    for (const words of ['The rep came back to the depot', 'The van was unloaded', 'The unload was received at the warehouse', 'The day started to be settled']) await expect(history).toContainText(words);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });
});
