import { expect, type Page, test } from '@playwright/test';
import { followLink, noHorizontalScroll, noNativeSelect, open } from './support/page';

/**
 * The implementor guide is pre-rendered at build time, so the portal must appear at once with the
 * version stamp of the running build, the PDF it offers must be the immutable version-tagged file,
 * and every admin screen must carry a help button that opens the manual chapter for that screen.
 */

/**
 * A manual's body is pasted in as one piece of HTML, so its inner headings are never wired up by
 * React and `open` would wait on them forever. Arrival is awaited on the chapter's own title
 * heading instead (drawn by React), and that one is polled for wiring before anything is clicked.
 */
async function openChapter(page: Page, slug: string, title: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await page.goto(`/admin/docs/${slug}`).catch(() => undefined);
      const heading = page.getByRole('heading', { name: title, level: 1 }).first();
      await expect(heading).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(
          () =>
            heading
              .evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps')))
              .catch(() => false),
          { timeout: 60_000 },
        )
        .toBe(true);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
}

const CHAPTER_04 = '04-pricing-engine-promotions-and-margins';
const CHAPTER_05 = '05-products-catalog-and-inventory-control';
const PDF_HREF = /\/downloads\/omnicommerce-implementor-guide-v\d+\.\d+\.\d+-[0-9a-f]+\.pdf$/;
const VERSION_STAMP = /^v\d+\.\d+\.\d+-[0-9a-f]{7}$/;

test.describe('implementor guide', () => {
  test('the manual index opens at once with its version stamp, its PDF pack and its chapter cards', async ({
    page,
  }) => {
    await open(page, '/admin/docs', 'Search Documentation');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    await expect(
      page.getByRole('heading', { name: 'Implementor Blueprint & Commercial Sales Manual' }),
    ).toBeVisible();

    // The stamp of the build that is running: a semantic version pinned to a git commit.
    await expect(page.getByText(VERSION_STAMP).first()).toBeVisible();
    await expect(page.getByText(/^SHA:/).first()).toBeVisible();

    // The PDF offered is the immutable version-tagged file for this build.
    const pdfPack = page.getByRole('link', { name: /Download Master PDF Pack/ });
    await expect(pdfPack).toHaveAttribute('href', PDF_HREF);

    // Every manual is reachable from a card of its own.
    const cards = page.getByRole('link', { name: /Read Manual/ });
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(14);
  });

  test('a search word opens the matching section of its manual', async ({ page }) => {
    await open(page, '/admin/docs', 'Search Documentation');
    await page.getByPlaceholder(/Search all \d+ manuals/).fill('promotion');
    await expect(page.getByText(/Search Results \(\d+\)/)).toBeVisible();
    await expect(page.getByText(/No documentation matches/)).toHaveCount(0);

    const firstMatch = page.locator('a[href^="/admin/docs/"][href*="#"]').first();
    await followLink(
      firstMatch,
      page,
      /\/admin\/docs\/[a-z0-9-]+#/,
      page.getByRole('link', { name: 'All Manuals' }),
    );
  });

  test('a manual chapter carries its version stamp and walks the curriculum in order', async ({
    page,
  }) => {
    await openChapter(page, CHAPTER_04, /Pricing Engine, Promotions & Margins/);
    await expect(page.getByText(VERSION_STAMP).first()).toBeVisible();

    // Pagination follows the chapter order, not the address bar.
    await followLink(
      page.getByRole('link', { name: /Next Chapter/ }),
      page,
      new RegExp(`/admin/docs/${CHAPTER_05}$`),
      page.getByRole('heading', { name: /Products Catalog & Inventory Control/, level: 1 }).first(),
    );
    await followLink(
      page.getByRole('link', { name: /Previous Chapter/ }),
      page,
      new RegExp(`/admin/docs/${CHAPTER_04}$`),
      page.getByRole('heading', { name: /Pricing Engine, Promotions & Margins/, level: 1 }).first(),
    );
    await noHorizontalScroll(page);
  });

  test('the outline and the chapter column of a manual work on the desktop layout', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'The outline column shows on the desktop layout only.',
    );
    await openChapter(page, CHAPTER_04, /Pricing Engine, Promotions & Margins/);

    // The page outline jumps inside the chapter.
    const outline = page.getByRole('navigation', { name: 'Table of contents' });
    await expect(outline).toBeVisible();
    await outline
      .getByRole('link', { name: '1. Executive Overview & Commercial Value Proposition' })
      .click();
    await expect(page).toHaveURL(/#1-executive-overview-commercial-value-proposition$/);

    // The chapter column lists every manual and the offline PDF is offered again.
    const chaptersNav = page.getByRole('complementary', { name: 'Chapters navigation' });
    await expect(chaptersNav.getByRole('link', { name: /Products Catalog/ }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download Master PDF' })).toHaveAttribute(
      'href',
      PDF_HREF,
    );
  });

  test('the help button on an admin screen opens the manual chapter for that screen', async ({
    page,
  }) => {
    await open(page, '/admin/pricing/gift-cards', 'Gift cards');
    await followLink(
      page.getByRole('link', {
        name: /Open implementation guide: Pricing Engine, Promotions & Margins/,
      }),
      page,
      new RegExp(`/admin/docs/${CHAPTER_04}$`),
      page.getByRole('heading', { name: /Pricing Engine, Promotions & Margins/, level: 1 }).first(),
    );
  });

  test('a manual address that is not a manual gets the not-found page', async ({ page }) => {
    await page.goto('/admin/docs/not-a-chapter');
    await expect(page.getByRole('heading', { name: 'Not found', level: 2 })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to the dashboard' })).toBeVisible();
  });
});
