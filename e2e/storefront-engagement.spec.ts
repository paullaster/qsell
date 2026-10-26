import { expect, test, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, open } from './support/page';
import { makeProduct, makeReviewer, storefrontTool } from './support/storefront-fixtures';
import { attemptTag, signedOutPage } from './support/vendors';

/** Signs a shopper in through the sign-in page and returns to where they were. */
async function signIn(page: Page, shopper: { email: string; password: string }, then: string): Promise<void> {
  await page.goto(`/login?callbackUrl=${encodeURIComponent(then)}`);
  await expect(page.getByLabel('Email')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.getByLabel('Email').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 90_000 }).toBe(true);
  await page.getByLabel('Email').fill(shopper.email);
  await page.getByLabel('Password', { exact: true }).fill(shopper.password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(new RegExp(then.replace(/[/?]/g, '\\$&').replace('\\?', '\\?')), { timeout: 90_000 });
}

// The development server compiles a route the first time it is asked for it, which can take longer than a test is willing to wait.
// Asking once up front, with patience, keeps that out of the tests themselves.
test.beforeAll(async ({ request }) => {
  const patient = { timeout: 180_000 };
  const home = await (await request.get('/', patient)).text();
  const product = /href="(\/product\/[^"]+)"/.exec(home)?.[1];
  const paths = ['/login', '/wishlist', '/newsletter/confirm?token=warm-up', '/admin/reviews', '/admin/newsletter', '/admin/company/banners', ...(product === undefined ? [] : [product])];
  for (const path of paths) await request.get(path, patient).catch(() => undefined);
});

test.describe('reviews', () => {
  test('only a buyer can review, it waits for the company, and the product shows the rating once it is published', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    // A product of its own, so what other runs published cannot change what this one sees.
    const productName = makeProduct(tag);
    const shopper = makeReviewer(tag, productName);
    const buyer = await signedOutPage(browser, testInfo);
    try {
      // A visitor is invited to sign in; nothing is shown yet.
      await buyer.page.goto(`/?q=${productName}`);
      const link = buyer.page.getByRole('list', { name: 'Products' }).getByRole('link', { name: productName }).first();
      await expect(link).toBeVisible({ timeout: 30_000 });
      const href = (await link.getAttribute('href')) ?? '/';
      await buyer.page.goto(href);
      await expect(buyer.page.getByRole('heading', { name: 'Reviews', level: 2 })).toBeVisible({ timeout: 30_000 });
      await expect(buyer.page.getByText('There are no reviews yet.')).toBeVisible();
      await expect(buyer.page.getByRole('link', { name: 'Sign in' }).last()).toBeVisible({ timeout: 30_000 });

      // Signed in as someone whose order was delivered: the form is there, and a link is refused.
      await signIn(buyer.page, shopper, href);
      const form = buyer.page.getByRole('form', { name: 'Write a review' });
      await expect(form).toBeVisible({ timeout: 60_000 });
      await form.locator('label', { hasText: '5 stars' }).click();
      await form.getByLabel('Your review').fill('Buy cheaper at www.example.com today');
      await form.getByRole('button', { name: 'Send review' }).click();
      await expect(form.getByRole('alert')).toContainText('web links');
      await form.getByLabel('Title (optional)').fill('Lovely rice');
      const words = `Cooks well and tastes great. Arrived in good time. ${tag}`;
      await form.getByLabel('Your review').fill(words);
      await form.getByRole('button', { name: 'Send review' }).click();
      await expect(buyer.page.getByText('Your review will appear once it has been checked.')).toBeVisible({ timeout: 30_000 });
      // Waiting for approval: nothing is public, and the product has no stars yet.
      await buyer.page.reload();
      await expect(buyer.page.getByText('Your review is waiting to be checked.')).toBeVisible({ timeout: 30_000 });
      await expect(buyer.page.getByText(words)).toHaveCount(0);

      // The company sees it in the queue, with the buyer shown as a first name and an initial, and publishes it.
      await open(page, '/admin/reviews', 'Product reviews');
      await page.getByRole('searchbox', { name: 'Search reviews' }).fill(tag);
      const card = page.getByRole('list', { name: 'Reviews' }).getByRole('listitem').filter({ hasText: tag });
      await expect(card).toBeVisible({ timeout: 30_000 });
      // First name and the initial of the last word of the name (here the test's tag), never the whole name or the email.
      await expect(card).toContainText(/Wanjiru \w\./);
      await expect(card).not.toContainText('Reviewer');
      await expect(card).toContainText('Verified purchase');
      await expect(card).not.toContainText('@');
      await card.getByRole('button', { name: 'Publish' }).click();
      await expect(page.getByText('The review is published.')).toBeVisible({ timeout: 30_000 });

      // Now it is public, with the rating, and search engines are told.
      await buyer.page.goto(href);
      await expect(buyer.page.getByText(words)).toBeVisible({ timeout: 30_000 });
      await expect(buyer.page.getByText('Verified purchase').first()).toBeVisible();
      await expect(buyer.page.getByText('1 review', { exact: true })).toBeVisible();
      const ld = (await buyer.page.locator('script[type="application/ld+json"]').allTextContents()).map((text) => JSON.parse(text) as { '@type': string; aggregateRating?: { ratingValue: string; reviewCount: number } });
      expect(ld.find((item) => item['@type'] === 'Product')?.aggregateRating).toEqual(expect.objectContaining({ ratingValue: '5.0', reviewCount: 1 }));
      await noHorizontalScroll(buyer.page);
      await noInnerHorizontalScroll(buyer.page);

      // Someone who has not received the product is told so, not shown a form.
      await buyer.page.goto('/?q=Flour 2kg');
      const other = (await buyer.page.getByRole('list', { name: 'Products' }).getByRole('link', { name: 'Flour 2kg' }).first().getAttribute('href')) ?? '/';
      await buyer.page.goto(other);
      await expect(buyer.page.getByText('Reviews come from people who have received this product.')).toBeVisible({ timeout: 30_000 });
    } finally {
      await buyer.close();
    }
  });

  test('a review that is turned down needs a reason, and the reviewer is shown it', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const shopper = makeReviewer(tag, 'Sugar 1kg');
    const buyer = await signedOutPage(browser, testInfo);
    try {
      await buyer.page.goto('/?q=Sugar 1kg');
      const href = (await buyer.page.getByRole('list', { name: 'Products' }).getByRole('link', { name: 'Sugar 1kg' }).first().getAttribute('href')) ?? '/';
      await signIn(buyer.page, shopper, href);
      const form = buyer.page.getByRole('form', { name: 'Write a review' });
      await expect(form).toBeVisible({ timeout: 60_000 });
      await form.locator('label', { hasText: '1 star' }).click();
      const words = `Terrible, a total waste of money honestly. ${tag}`;
      await form.getByLabel('Your review').fill(words);
      await form.getByRole('button', { name: 'Send review' }).click();
      await expect(buyer.page.getByText('Your review will appear once it has been checked.')).toBeVisible({ timeout: 30_000 });

      await open(page, '/admin/reviews', 'Product reviews');
      await page.getByRole('searchbox', { name: 'Search reviews' }).fill(tag);
      const card = page.getByRole('list', { name: 'Reviews' }).getByRole('listitem').filter({ hasText: tag });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.getByRole('button', { name: 'Turn down' }).click();
      await expect(card.getByRole('button', { name: 'Turn it down' })).toBeDisabled();
      await card.getByLabel(/Why is this review being turned down/).fill('This is about the courier, not the product.');
      await card.getByRole('button', { name: 'Turn it down' }).click();
      await expect(page.getByText('The review was turned down.')).toBeVisible({ timeout: 30_000 });

      await buyer.page.goto(href);
      await expect(buyer.page.getByText(/Your review was not published\. The reason given: This is about the courier/)).toBeVisible({ timeout: 30_000 });
      await expect(buyer.page.getByText(words)).toHaveCount(0);
      await expect(buyer.page.getByRole('button', { name: 'Write it again' })).toBeVisible();
    } finally {
      await buyer.close();
    }
  });
});

test.describe('saved products', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a guest saves with the heart, it survives a reload, shows on the saved page and can be removed', async ({ page }) => {
    await page.goto('/?q=Salt 500g');
    const heart = page.getByRole('button', { name: 'Save Salt 500g for later' });
    await expect(heart).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await heart.click();
      await expect(page.getByRole('link', { name: /Saved products, 1/ })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Remove Salt 500g from saved products' })).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await page.getByRole('link', { name: /Saved products, 1/ }).click();
    await expect(page.getByRole('heading', { name: 'Saved products', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('list', { name: 'Saved products' }).getByRole('heading', { name: 'Salt 500g' })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Remove Salt 500g from saved products' }).click();
    await expect(page.getByRole('heading', { name: 'Nothing saved yet' })).toBeVisible({ timeout: 30_000 });
  });

  test('a signed-in shopper\'s list is on their account, and a guest list joins it at sign-in', async ({ browser }, testInfo) => {
    test.slow();
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const shopper = makeReviewer(tag, 'Rice 10kg');
    const first = await signedOutPage(browser, testInfo);
    const second = await signedOutPage(browser, testInfo);
    try {
      // Saved as a guest, before signing in.
      await first.page.goto('/?q=Flour 2kg');
      const guestHeart = first.page.getByRole('button', { name: 'Save Flour 2kg for later' });
      await expect(guestHeart).toBeVisible({ timeout: 30_000 });
      await expect(async () => {
        await guestHeart.click();
        await expect(first.page.getByRole('link', { name: /Saved products, 1/ })).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 60_000 });
      await signIn(first.page, shopper, '/profile');
      await first.page.goto('/wishlist');
      await expect(first.page.getByRole('list', { name: 'Saved products' }).getByRole('heading', { name: 'Flour 2kg' })).toBeVisible({ timeout: 60_000 });

      // Another device: signed in, the same list is there.
      await signIn(second.page, shopper, '/wishlist');
      await expect(second.page.getByRole('list', { name: 'Saved products' }).getByRole('heading', { name: 'Flour 2kg' })).toBeVisible({ timeout: 60_000 });
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test.describe('the newsletter', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asking, confirming from the link, and unsubscribing; the answer never says who is on the list', async ({ page, browser }, testInfo) => {
    test.slow();
    const email = `news-${attemptTag(testInfo.project.name, testInfo.retry)}@example.test`;
    await page.goto('/');
    const form = page.getByRole('form', { name: 'Get our news by email' });
    await expect(form).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => form.getByLabel('Get our news').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 60_000 }).toBe(true);
    await form.getByLabel('Get our news').fill('not an address');
    await form.getByRole('button', { name: 'Subscribe' }).click();
    await expect(form.getByRole('alert')).toContainText('valid email');
    await form.getByLabel('Get our news').fill(email);
    await form.getByRole('button', { name: 'Subscribe' }).click();
    await expect(form.getByRole('status')).toContainText('If that address can receive mail', { timeout: 30_000 });

    // Opening the link changes nothing; pressing the button does.
    const token = storefrontTool('newsletter-token', email).token ?? '';
    await page.goto(`/newsletter/confirm?token=${token}`);
    await expect(page.getByRole('heading', { name: 'Confirm your subscription' })).toBeVisible({ timeout: 30_000 });
    await page.goto('/newsletter/confirm?token=bad');
    await expect(page.getByRole('heading', { name: 'We could not find that page' })).toBeVisible({ timeout: 30_000 });
    await page.goto(`/newsletter/confirm?token=${token}`);
    const confirm = page.getByRole('button', { name: 'Confirm subscription' });
    await expect(async () => {
      await confirm.click();
      await expect(page.getByText('You are subscribed. Thank you.')).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });

    // The company sees only confirmed people in the list that can be exported.
    const staff = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: 'e2e/.auth/admin.json'.replace('admin.json', `admin${process.env.E2E_PORT === '3100' || process.env.E2E_PORT === undefined ? '' : `-${process.env.E2E_PORT}`}.json`) });
    try {
      const admin = await staff.newPage();
      await open(admin, '/admin/newsletter', 'Newsletter');
      await admin.getByRole('searchbox', { name: 'Search addresses' }).fill(email);
      await expect(admin.getByRole('list', { name: 'Subscribers' })).toContainText(email, { timeout: 30_000 });
    } finally {
      await staff.close();
    }

    await page.goto(`/newsletter/unsubscribe?token=${token}`);
    const unsubscribe = page.getByRole('button', { name: 'Unsubscribe' });
    await expect(async () => {
      await unsubscribe.click();
      await expect(page.getByText(/You are unsubscribed/)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
  });
});

test.describe('front-page banners', () => {
  test('a banner written in the admin console shows only inside its days, with a safe link', async ({ page, browser }, testInfo) => {
    test.slow();
    const headline = `Open late ${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/company/banners', 'Front-page banners');
    await page.getByRole('button', { name: 'Add a banner' }).click();
    await page.getByLabel('Headline of banner 1', { exact: true }).fill(headline);
    await page.getByLabel('Words under the headline of banner 1').fill('Free delivery this week.');
    await page.getByLabel('Button goes to, banner 1').fill('javascript:alert(1)');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Banners saved.')).toBeVisible({ timeout: 30_000 });
    // An unsafe link is removed on save, and with it the button.
    await expect(page.getByLabel('Button goes to, banner 1')).toHaveValue('');

    const visitor = await signedOutPage(browser, testInfo);
    try {
      await visitor.page.goto('/');
      await expect(visitor.page.getByRole('region', { name: 'Notices' })).toContainText(headline, { timeout: 30_000 });
      await expect(visitor.page.getByRole('region', { name: 'Notices' }).getByRole('link')).toHaveCount(0);

      // A closing day in the past takes it down.
      await page.getByLabel('Last day shown, banner 1').fill('2020-01-01');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Banners saved.')).toBeVisible({ timeout: 30_000 });
      await visitor.page.reload();
      await expect(visitor.page.getByRole('list', { name: 'Products' })).toBeVisible({ timeout: 30_000 });
      await expect(visitor.page.getByText(headline)).toHaveCount(0);
      await noHorizontalScroll(visitor.page);
    } finally {
      await visitor.close();
    }
    // Leave nothing behind for the next test.
    await page.getByRole('button', { name: 'Remove banner 1' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Banners saved.')).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('looking at a product', () => {
  test('the price and buttons are always at hand: beside the pictures on a wide screen, in a bar at the foot on a phone', async ({ page }, testInfo) => {
    await page.goto('/?q=Rice 5kg');
    const href = (await page.getByRole('list', { name: 'Products' }).getByRole('link', { name: 'Rice 5kg' }).first().getAttribute('href')) ?? '/';
    await page.goto(href);
    await expect(page.getByRole('heading', { name: 'Rice 5kg', level: 1 })).toBeVisible({ timeout: 30_000 });
    // Make the page long enough to scroll, as a product with a long description is.
    await page.evaluate(() => {
      const filler = document.createElement('div');
      filler.style.height = '2500px';
      document.querySelector('article')?.appendChild(filler);
    });
    if (testInfo.project.name === 'phone') {
      // At the top the bar is out of the way; once the main buttons have scrolled off it appears with the price.
      await expect(page.getByRole('button', { name: 'Add to cart', exact: true })).toHaveCount(1);
      await page.evaluate(() => window.scrollTo(0, 2200));
      await expect(page.getByRole('button', { name: 'Add to cart', exact: true }).last()).toBeInViewport({ timeout: 15_000 });
    } else {
      // Beside the pictures, the buttons stay in view while the pictures are scrolled past.
      await page.evaluate(() => window.scrollTo(0, 120));
      await expect(page.getByRole('button', { name: 'Buy now' })).toBeInViewport({ timeout: 10_000 });
    }
    // Whatever the width, the whole picture box is within the screen's height, so the product is seen whole.
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await page.getByRole('img', { name: 'No picture available' }).first().boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual((page.viewportSize()?.height ?? 900) * 0.72);
    await noHorizontalScroll(page);
  });
});
