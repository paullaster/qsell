import { expect, test, type Page } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

/** The first product in the list, by its link (the card's name). */
const productNames = (page: Page) => page.getByRole('list', { name: 'Products' }).getByRole('heading', { level: 3 }).allInnerTexts();

test.describe('the shop is a real website', () => {
  test('its pages come with a heading and product links, and search engines get a sitemap, rules and a manifest', async ({ request }) => {
    const home = await request.get('/');
    expect(home.status()).toBe(200);
    const html = await home.text();
    expect(html).toContain('<h1');
    expect(html).toMatch(/href="\/product\/[^"]+"/);

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toMatch(/<loc>[^<]*\/product\/[^<]+<\/loc>/);

    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Disallow: /checkout');
    expect(robots).toMatch(/Sitemap: .*\/sitemap\.xml/);

    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    expect(await manifest.json()).toMatchObject({ start_url: '/', display: 'standalone' });
  });

  test('a product page has its own title, a shareable address, structured data and a way back', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('list', { name: 'Products' }).getByRole('link', { name: 'Rice 5kg' }).first();
    await expect(link).toBeVisible({ timeout: 30_000 });
    const href = await link.getAttribute('href');
    // The address says what the product is, not an internal number.
    expect(href).toMatch(/^\/product\/[a-z0-9-]+$/);
    expect(href).not.toContain('prod_');
    await page.goto(href ?? '/');
    await expect(page.getByRole('heading', { name: 'Rice 5kg', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveTitle(/Rice 5kg/);
    // The canonical address is absolute, built from the shop's own address.
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`^https?://[^/]+${(href ?? '').replaceAll('/', '\\/')}$`));
    // A shared link leads with the product, then the price, the town and the shop's name.
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /^Rice 5kg – .*600/);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'product');
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    const product = ld.map((text) => JSON.parse(text) as { '@type': string; offers?: { price: string; availability: string } }).find((item) => item['@type'] === 'Product');
    expect(product?.offers).toMatchObject({ price: '600.00', availability: 'https://schema.org/InStock' });
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
  });

  test('a page that is not there is a shop page with a way to search, not a blank error', async ({ page }) => {
    await page.goto('/product/there-is-no-such-product');
    await expect(page.getByRole('heading', { name: 'We could not find that page' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('searchbox').or(page.getByRole('textbox', { name: 'Search the shop' }))).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the shop' })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]').first()).toBeAttached();
  });
});

test.describe('browsing', () => {
  test('sorting, stock and price live in the address, so a result can be shared and Back undoes it', async ({ page }) => {
    await page.goto('/?sort=price_desc&stock=1');
    await expect(page.getByRole('heading', { name: 'All products', level: 1 })).toBeVisible({ timeout: 30_000 });
    const names = await productNames(page);
    expect(names[0]).toBe('Rice 10kg');
    await expect(page.getByRole('list', { name: 'Products' }).getByText('Sold out')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('In stock only');

    await page.goto('/?q=rice&min=700');
    expect(await productNames(page)).toEqual(['Rice 10kg']);
    await expect(page.getByRole('heading', { name: 'Results for “rice”', level: 1 })).toBeVisible();

    await page.goto('/?q=zz-nothing-like-this');
    await expect(page.getByRole('heading', { name: 'No products found' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Clear search and filters' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'All products', level: 1 })).toBeVisible();
  });

  test('the sort picker is an Autocomplete, changes the order and the address, and there is no native select', async ({ page }) => {
    await page.goto('/');
    const sort = page.getByRole('combobox', { name: 'Sort by' });
    await expect(sort).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await sort.click();
      await expect(page.getByRole('option', { name: 'Price: low to high' })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.getByRole('option', { name: 'Price: low to high' }).click();
    await expect(page).toHaveURL(/sort=price_asc/);
    await expect.poll(async () => (await productNames(page))[0], { timeout: 30_000 }).toBe('Salt 500g');
    await noNativeSelect(page);
  });

  test('typing in the header search narrows the shop and puts the words in the address', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('textbox', { name: 'Search products, brands, or SKU' });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await search.fill('sugar');
      await expect(page).toHaveURL(/q=sugar/, { timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect.poll(() => productNames(page), { timeout: 30_000 }).toEqual(['Sugar 1kg']);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page).not.toHaveURL(/q=/, { timeout: 15_000 });
  });

  test('a category is a link, includes what is under it, and the categories menu lists it', async ({ page }) => {
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Categories' });
    await expect(menu).toBeVisible({ timeout: 30_000 });
    await clickUntilVisible(menu, page.getByRole('navigation', { name: 'Shop by category' }));
    await page.getByRole('navigation', { name: 'Shop by category' }).getByRole('link', { name: /E2E Pantry/ }).click();
    await expect(page).toHaveURL(/category=/);
    await expect(page.getByRole('heading', { name: 'E2E Pantry', level: 1 })).toBeVisible({ timeout: 30_000 });
    expect((await productNames(page)).length).toBeGreaterThan(3);
  });

  test('cards fit every width', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('list', { name: 'Products' })).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a')].filter((el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 32).map((el) => el.innerText.trim().slice(0, 30)));
    // Links inside a line of text may be short; the buttons a thumb presses are not.
    expect(small.filter((text) => /^(Add|Buy now|Show more products)$/.test(text))).toEqual([]);
  });
});

test.describe('the cart and checkout', () => {
  test('what is in the cart survives a reload, shows on the badge, and checkout is a page with the order beside it', async ({ page }) => {
    await page.goto('/?q=Salt 500g');
    const add = page.getByRole('button', { name: 'Add Salt 500g to cart' });
    await expect(add).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await add.click();
      await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await expect(page.getByText('Salt 500g is in your cart.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 30_000 });

    await page.getByRole('button', { name: 'Shopping Cart' }).click();
    const drawer = page.getByRole('dialog', { name: 'Your Cart' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await page.goto('/checkout');
    await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('complementary', { name: 'Order summary' })).toContainText('Salt 500g');
    await expect(page.getByLabel('Email (optional)')).toBeVisible();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The browser keeps ids and quantities only, never a price.
    const saved = await page.evaluate(() => window.localStorage.getItem('qsell_cart_v2'));
    expect(JSON.parse(saved ?? '[]')).toEqual([expect.objectContaining({ quantity: 1 })]);
    expect(saved).not.toContain('costPrice');
    expect(saved).not.toContain('name');
  });

  test('a missing name, phone or address is said in words and nothing is placed', async ({ page }) => {
    await page.goto('/?q=Salt 500g');
    const add = page.getByRole('button', { name: 'Add Salt 500g to cart' });
    await expect(add).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await add.click();
      await expect(page.getByRole('button', { name: 'Shopping Cart' })).toContainText('1', { timeout: 3000 });
    }).toPass({ timeout: 60_000 });
    await page.goto('/checkout');
    const pay = page.getByRole('button', { name: /^Pay / });
    await expect(pay).toBeEnabled({ timeout: 30_000 });
    await pay.click();
    await expect(page.locator('form').getByRole('alert')).toContainText('Please fill in your name, phone number and delivery address.');
    await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  });

  test('an empty cart says so and points back to the shop', async ({ page }) => {
    await page.goto('/checkout');
    await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Continue shopping' })).toBeVisible();
  });

  test('a cart saved by the first shop is read, checked against the shop and cleaned of what is gone', async ({ page }) => {
    // Saved before the page's own scripts run, as it would be in a browser that last visited the first shop.
    await page.addInitScript(() => {
      if (window.localStorage.getItem('qsell_cart_v2') === null) {
        // The first shop kept a whole copy of the product, with a price that has since moved.
        window.localStorage.setItem('omnicommerce_cart', JSON.stringify([{ product: { id: 'unknown-product', price: 1 }, quantity: 2 }]));
      }
    });
    await page.goto('/');
    await expect(page.getByText('An item in your cart is no longer for sale and was removed.').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Shopping Cart' })).not.toContainText('2');
    // The old copy is gone and the new one holds ids and quantities only.
    await expect.poll(() => page.evaluate(() => [window.localStorage.getItem('omnicommerce_cart'), window.localStorage.getItem('qsell_cart_v2')])).toEqual([null, '[]']);
  });
});

test.describe('policy pages', () => {
  test('a page written in the admin console appears in the footer and is shown as plain text', async ({ page }) => {
    const title = `Returns ${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/company/policies', 'Policy pages');
    await page.getByRole('button', { name: 'Add a page' }).click();
    await page.getByLabel('Title of page 1').fill(title);
    await page.getByLabel('Text of page 1').fill('# Our promise\n\nReturn it within 14 days.\n\n- Unused\n- In the box\n\n<script>window.__policyRan = true</script>');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Policy pages saved.')).toBeVisible({ timeout: 30_000 });

    await page.goto('/');
    const link = page.getByRole('navigation', { name: 'Account and policies' }).getByRole('link', { name: title });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Our promise', level: 2 })).toBeVisible();
    await expect(page.getByText('Return it within 14 days.')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'In the box' })).toBeVisible();
    // The script is text on the page, never run.
    await expect(page.getByText('<script>window.__policyRan = true</script>')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __policyRan?: boolean }).__policyRan)).toBeUndefined();
    await noHorizontalScroll(page);

    const sitemap = await (await page.request.get('/sitemap.xml')).text();
    expect(sitemap).toContain('/policies/');
  });
});
