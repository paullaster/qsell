import { expect, test } from '@playwright/test';
import { attemptTag, makeShopper, signInAsShopper } from './support/vendors';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { makeCategoryLunch } from './support/storefront-fixtures';

test.describe('a package with a category slot, a note and order again', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the vegetables come from a category, the note goes with the line, and a signed-in shopper can order the same again', async ({ page }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
    const shopper = makeShopper(`pc${tag}`, 0);
    const made = makeCategoryLunch(`pc${tag}`, shopper.email);

    await page.goto(`/product/${made.slug}`);
    await expect(page.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });
    // Every product of the category is on offer, each adding its difference; the fish is the only one of its slot.
    for (const name of [made.sukuma, made.cabbage, made.spinach]) await expect(page.getByRole('checkbox', { name: new RegExp(name) })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: new RegExp(made.sukuma) })).toContainText('+ KSh 15');
    await expect(page.getByTestId('package-total')).toBeVisible();
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The first vegetable is chosen to start with (the slot needs one); swap it for two others, then write a note: the base plus 15 for each.
    const first = page.getByRole('checkbox', { name: new RegExp(made.cabbage) });
    await expect(first).toBeChecked();
    await first.click();
    await expect(first).not.toBeChecked();
    for (const name of [made.sukuma, made.spinach]) {
      const box = page.getByRole('checkbox', { name: new RegExp(name) });
      await expect(async () => {
        if (!(await box.isChecked())) await box.click();
        await expect(box).toBeChecked({ timeout: 2000 });
      }).toPass({ timeout: 60_000 });
    }
    await expect(page.getByTestId('package-total')).toContainText('630');
    await page.getByLabel('Note for each serving (optional)').fill('no pepper please');
    await page.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByText('Added to your cart').first()).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await page.getByRole('button', { name: 'Shopping Cart' }).click();
      await expect(page.getByTestId('package-line')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByTestId('package-line-note')).toContainText('no pepper please');
    await noHorizontalScroll(page);

    // Signed in, the shopper's own earlier selection is offered again, in one tap.
    await signInAsShopper(page, shopper);
    await page.goto(`/product/${made.slug}`);
    const again = page.getByTestId('order-again');
    await expect(again).toBeVisible({ timeout: 60_000 });
    const option = again.getByTestId('order-again-option');
    await expect(option).toHaveCount(1);
    await expect(option).toContainText(`2 × ${made.fish}, ${made.cabbage} and ${made.sukuma}`);
    await expect(option).toContainText('Note: no pepper');
    await option.getByRole('button', { name: 'Add again' }).click();
    await expect(page.getByText('Added to your cart').first()).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
