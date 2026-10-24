import { expect, type Locator, type Page } from '@playwright/test';

/** Opens an admin screen and waits for its heading, trying again if the development server was still compiling it. */
export async function open(page: Page, url: string, heading: string | RegExp): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // A first visit that makes the development server compile can reload the page under us; that is another try, not a failure.
      await page.goto(url);
      const title = page.getByRole('heading', { name: heading, level: 2 }).first();
      await expect(title).toBeVisible({ timeout: 30_000 });
      // A streamed page is drawn before it is wired up; clicks and typing in that moment are lost.
      await expect.poll(() => title.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 30_000 }).toBe(true);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

/** The page never needs sideways scrolling, at any width. */
export const noHorizontalScroll = async (page: Page): Promise<void> => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
};

/** Every choice on the screen is a picker: there is no native dropdown. */
export const noNativeSelect = async (page: Page): Promise<void> => {
  await expect(page.locator('select')).toHaveCount(0);
};

/**
 * Clicks until what the click opens appears. A page streamed from the server can be drawn before
 * its buttons are wired up, and a click in that moment does nothing; trying again is what a person does.
 */
export async function clickUntilVisible(trigger: Locator, target: Locator): Promise<void> {
  await expect(async () => {
    await trigger.click();
    await expect(target).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

/** No box on the page scrolls sideways: nothing is hidden off-screen behind a scroll bar a person would have to find. */
export const noInnerHorizontalScroll = async (page: Page): Promise<void> => {
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main *, section *')]
      .filter((el) => {
        const { overflowX } = getComputedStyle(el);
        return (overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0;
      })
      .map((el) => `${el.tagName}.${el.className.slice(0, 60)}`),
  );
  expect(wide).toEqual([]);
};
