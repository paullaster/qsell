import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import { attemptTag, makeShopper, signInAsShopper, signedOutPage } from './support/vendors';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { makeCategoryLunch } from './support/storefront-fixtures';

/** A visitor with nothing signed in opens the link and saves their own choice (the defaults, with a note when they give one). */
async function choose(browser: Browser, testInfo: TestInfo, link: string, name: string, note?: string): Promise<void> {
  const visitor = await signedOutPage(browser, testInfo);
  try {
    const { page } = visitor;
    await page.goto(link);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });
    // Each person chooses their own serving: there is no servings control, and the organiser's list is not shown.
    await expect(page.getByRole('button', { name: 'One more serving' })).toHaveCount(0);
    await expect(page.getByTestId('group-organiser')).toHaveCount(0);
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    await page.getByLabel('Your name').fill(name);
    if (note !== undefined) await page.getByLabel('Anything the kitchen should know (optional)').fill(note);
    await expect(async () => {
      await page.getByRole('button', { name: 'Save my choice' }).click();
      await expect(page.getByText('Your choice is saved.')).toBeVisible({ timeout: 4000 });
    }).toPass({ timeout: 60_000 });
    // They can change it later: the page remembers it in this browser.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your choice' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Change my choice' })).toBeVisible();
  } finally {
    await visitor.close();
  }
}

test.describe('a group order', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an organiser shares a link, each person chooses their own, and the organiser puts everyone in the cart and pays once', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
    const shopper = makeShopper(`pg${tag}`, 0);
    const made = makeCategoryLunch(`pg${tag}`);

    // A visitor who is not signed in is asked to sign in to start one.
    await page.goto(`/product/${made.slug}`);
    await expect(page.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();

    await signInAsShopper(page, shopper);
    await page.goto(`/product/${made.slug}`);
    await expect(page.getByTestId('package-builder')).toBeVisible({ timeout: 60_000 });
    await expect(async () => {
      await page.getByRole('button', { name: 'Order for a group' }).click();
      await expect(page.getByRole('form', { name: 'Start a group order' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.getByLabel('What is it for (optional)').fill('Friday team lunch');
    await page.getByRole('button', { name: 'Start the group order' }).click();

    // The organiser's page: the heading, the link to share, nobody yet.
    await expect(page.getByRole('heading', { level: 1, name: 'Friday team lunch' })).toBeVisible({ timeout: 60_000 });
    const organiser = page.getByTestId('group-organiser');
    await expect(organiser).toContainText('Nobody yet');
    const link = await organiser.getByLabel('Link to share').inputValue();
    expect(link).toMatch(/\/group\/[A-Za-z0-9_-]{32}$/);

    // Three people choose, each in their own browser.
    await choose(browser, testInfo, link, 'Amina', 'no pepper');
    await choose(browser, testInfo, link, 'Brian');
    await choose(browser, testInfo, link, 'Chao');

    // The organiser sees who chose what, and puts everyone's lunch in the cart: the two identical ones are one line of two.
    await page.reload();
    await expect(page.getByTestId('group-entry')).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByTestId('group-entry').filter({ hasText: 'Amina' })).toContainText('Note: no pepper');
    await page.getByRole('button', { name: /Put everyone.s lunch in my cart/ }).click();
    await expect(organiser).toContainText('Everyone\'s lunch is in your cart', { timeout: 60_000 });
    await expect(async () => {
      await page.getByRole('button', { name: 'Shopping Cart' }).click();
      await expect(page.getByTestId('package-line').first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByTestId('package-line')).toHaveCount(2);
    await expect(page.getByTestId('package-line').filter({ hasText: 'no pepper' })).toHaveCount(1);
    await noHorizontalScroll(page);
    await page.keyboard.press('Escape');

    // Choosing has stopped: a newcomer is told so.
    const late = await signedOutPage(browser, testInfo);
    try {
      await late.page.goto(link);
      await expect(late.page.getByText('organiser has stopped taking choices')).toBeVisible({ timeout: 60_000 });
      await expect(late.page.getByTestId('package-builder')).toHaveCount(0);
    } finally {
      await late.close();
    }

    // The organiser pays once. The order is placed first (a payment cannot finish in the test shop), and the group is tied to it.
    await page.goto('/checkout');
    await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('summary-package')).toHaveCount(2, { timeout: 60_000 });
    // The form is drawn for a guest first and then for the signed-in organiser (whose name and phone are already there).
    await expect(page.getByRole('region', { name: 'Your details' })).not.toContainText('Sign in to use your saved details', { timeout: 60_000 });
    await page.getByLabel('Street, building or office').fill('1 Moi Avenue');
    await page.getByLabel('City or town').fill('Nairobi');
    await page.getByLabel('County or region').fill('Nairobi');
    await page.getByLabel(/number to pay from$/).fill('0733 555 778');
    await page.getByRole('button', { name: /^Pay / }).click();
    await expect(page.getByRole('region', { name: 'Payment not completed' }).or(page.getByRole('region', { name: 'Waiting for payment' }))).toBeVisible({ timeout: 90_000 });

    await page.goto(link);
    await expect(page.getByTestId('group-ordered')).toContainText('You ordered this group', { timeout: 60_000 });
    await expect(page.getByRole('button', { name: /Put everyone.s lunch in my cart/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Take choices again' })).toHaveCount(0);

    // "My group orders" lists it as ordered, with the order, and the way back into the group.
    await page.goto('/profile/groups');
    await expect(page.getByRole('heading', { name: 'My group orders', level: 1 })).toBeVisible({ timeout: 60_000 });
    const row = page.getByTestId('my-group').filter({ hasText: 'Friday team lunch' });
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await expect(row).toContainText('Ordered');
    await expect(row).toContainText('3 people have chosen');
    await expect(row.getByRole('link', { name: /^Order / })).toBeVisible();
    await noHorizontalScroll(page);
    await row.getByRole('link', { name: 'Open this group' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Friday team lunch' })).toBeVisible({ timeout: 60_000 });
  });

  test('a link that is not one of ours is not found', async ({ page }) => {
    const response = await page.goto('/group/not-a-link');
    expect(response?.status()).toBe(404);
    await page.goto(`/group/${'a'.repeat(32)}`);
    await expect(page.getByRole('heading', { name: 'This group order was not found' })).toBeVisible({ timeout: 60_000 });
  });
});
