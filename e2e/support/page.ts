import { expect, type Page } from '@playwright/test';

/** Opens an admin screen and waits for its heading, trying again if the development server was still compiling it. */
export async function open(page: Page, url: string, heading: string | RegExp): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(url);
    try {
      await expect(page.getByRole('heading', { name: heading, level: 2 }).first()).toBeVisible({ timeout: 30_000 });
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
