import { expect, test, type APIRequestContext } from '@playwright/test';

/** Search engines and chat apps read the HTML as the server sends it, so these tests read it the same way, without a browser page. */
const patient = { timeout: 180_000 };

async function html(request: APIRequestContext, path: string): Promise<string> {
  const response = await request.get(path, { ...patient, headers: { 'user-agent': 'WhatsApp/2.23.20' } });
  expect(response.status(), path).toBe(200);
  return await response.text();
}

const meta = (page: string, attribute: 'name' | 'property', key: string): string | null =>
  new RegExp(`<meta ${attribute}="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`).exec(page)?.[1] ?? null;

const jsonLd = (page: string): Record<string, unknown>[] =>
  [...page.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((match) => JSON.parse(match[1] ?? '{}') as Record<string, unknown>);

const typesOf = (page: string): unknown[] => jsonLd(page).map((item) => item['@type']);

test.describe('search engines and shared links', () => {
  test('the front page names the business, says where it is, and describes the site', async ({ request }) => {
    const page = await html(request, '/');
    expect(page).toMatch(/<html lang="en-KE"/);
    expect(page).toMatch(/<title>[^<]{10,}<\/title>/);
    expect(meta(page, 'name', 'description')?.length ?? 0).toBeGreaterThan(40);
    expect(meta(page, 'name', 'robots')).toContain('index');
    expect(page).toMatch(/<link rel="canonical" href="https?:\/\/[^"]+"/);
    expect(meta(page, 'property', 'og:site_name')).toBeTruthy();
    expect(meta(page, 'property', 'og:locale')).toBe('en_KE');
    expect(meta(page, 'name', 'twitter:title')).toBe(meta(page, 'property', 'og:title'));
    expect(typesOf(page)).toEqual(expect.arrayContaining(['Store', 'WebSite']));
    const store = jsonLd(page).find((item) => item['@type'] === 'Store');
    expect(store?.name).toBeTruthy();
    expect(JSON.stringify(store)).not.toMatch(/kraPin|bank/i);
    expect(page).toContain('id="about-shop"');
  });

  test('a filtered or sorted shop page is kept out of search results', async ({ request }) => {
    const page = await html(request, '/?q=fish&sort=newest');
    expect(meta(page, 'name', 'robots')).toContain('noindex');
  });

  test('a product link carries its picture, price and stock for WhatsApp, Facebook, X and the rest', async ({ request }) => {
    const home = await html(request, '/');
    const href = /href="(\/product\/[^"]+)"/.exec(home)?.[1];
    expect(href, 'the shop has a product').toBeTruthy();
    const page = await html(request, href ?? '/');
    expect(meta(page, 'property', 'og:type')).toBe('product');
    expect(meta(page, 'property', 'og:title')).toBe(/<title>([^<]*)<\/title>/.exec(page)?.[1]?.replaceAll('&amp;', '&'));
    expect(meta(page, 'property', 'og:url')).toMatch(/^https?:\/\/.+\/product\//);
    expect(meta(page, 'property', 'product:price:currency')).toMatch(/^[A-Z]{3}$/);
    expect(meta(page, 'property', 'product:price:amount')).toMatch(/^\d+\.\d{2}$/);
    expect(['in stock', 'out of stock']).toContain(meta(page, 'property', 'product:availability'));
    expect(meta(page, 'name', 'twitter:card')).toMatch(/^summary/);
    expect(typesOf(page)).toEqual(expect.arrayContaining(['Product', 'BreadcrumbList']));
    const product = jsonLd(page).find((item) => item['@type'] === 'Product');
    expect(JSON.stringify(product)).toContain('NewCondition');
    // When the product has a picture, the card uses a right-sized copy of it that really loads.
    const image = meta(page, 'property', 'og:image')?.replaceAll('&amp;', '&');
    if (image !== undefined) {
      expect(image).toMatch(/^https?:\/\//);
      expect(meta(page, 'name', 'twitter:image')?.replaceAll('&amp;', '&')).toBe(image);
      const picture = await request.get(new URL(image).pathname + new URL(image).search, patient);
      expect(picture.status()).toBe(200);
      expect(picture.headers()['content-type']).toMatch(/^image\//);
      expect((await picture.body()).byteLength).toBeLessThan(600 * 1024);
    }
  });

  test('the help page is readable text with its own title and question data when questions exist', async ({ request }) => {
    const page = await html(request, '/help');
    expect(page).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    expect(page).toContain('Contact us');
    expect(typesOf(page)).toEqual(expect.arrayContaining(['ContactPage', 'BreadcrumbList']));
    expect(meta(page, 'name', 'twitter:title')).toBe(meta(page, 'property', 'og:title'));
    const questions = page.includes('<dt ');
    expect(typesOf(page).includes('FAQPage')).toBe(questions);
  });

  test('the platform page describes every module in words people search for', async ({ request }) => {
    const page = await html(request, '/platform');
    expect(page).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    for (const phrase of ['point of sale', 'inventory', 'M-Pesa', 'invoicing']) expect(page.toLowerCase()).toContain(phrase.toLowerCase());
    const software = jsonLd(page).find((item) => item['@type'] === 'SoftwareApplication');
    expect(Array.isArray(software?.featureList) ? software.featureList.length : 0).toBeGreaterThan(20);
    expect(meta(page, 'name', 'keywords')).toContain('point of sale');
  });

  test('the sitemap lists the pages and pictures, and the robots file keeps private areas out', async ({ request }) => {
    const sitemap = await (await request.get('/sitemap.xml', patient)).text();
    expect(sitemap).toContain('/help</loc>');
    expect(sitemap).toContain('/platform</loc>');
    expect(sitemap).toMatch(/\/product\/[^<]+<\/loc>/);
    const robots = await (await request.get('/robots.txt', patient)).text();
    expect(robots).toMatch(/Disallow: \/admin/);
    expect(robots).toMatch(/Disallow: \/api\//);
    expect(robots).toMatch(/Allow: \/api\/media\/file\//);
    expect(robots).toMatch(/Sitemap: https?:\/\//);
  });

  test('the console is never offered to search engines', async ({ request }) => {
    const response = await request.get('/admin', { ...patient, maxRedirects: 0 });
    expect([200, 307, 308]).toContain(response.status());
    if (response.status() === 200) expect(meta(await response.text(), 'name', 'robots')).toContain('noindex');
  });
});
