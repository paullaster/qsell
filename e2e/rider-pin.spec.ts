import { expect, test, type Browser, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { riderTool } from './support/rider-fixtures';

async function freshPhone(browser: Browser, page: Page): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: page.viewportSize() ?? undefined, storageState: { cookies: [], origins: [] } });
  return await context.newPage();
}

/** The message under the sign-in form (the page also has an empty alert of its own that announces new pages). */
const failure = (p: Page) => p.getByRole('form', { name: 'Sign in with your phone number' }).getByRole('alert');

/** Types into the rider sign-in once the page has been wired up (a streamed page is drawn before it can be typed into). */
async function signIn(phone: Page, number: string, pin: string): Promise<void> {
  await phone.goto('/rider/sign-in');
  const form = phone.getByRole('form', { name: 'Sign in with your phone number' });
  await expect(form).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => form.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 90_000 }).toBe(true);
  await form.getByLabel('Phone number').fill(number);
  await form.getByLabel('PIN').fill(pin);
  await form.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('rider sign-in with a phone number and PIN', () => {
  test('the office gives a PIN, the rider signs in with it, chooses their own, is shut out after wrong tries and let back in by the office', async ({ page, browser }, testInfo) => {
    test.slow();
    test.setTimeout(600_000);
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const rider = riderTool('own', tag);
    const name = rider.name ?? '';
    const number = rider.phone ?? '';

    // The office gives the rider a PIN, which is shown once.
    await open(page, '/admin/delivery/riders', 'Riders');
    await noNativeSelect(page);
    const card = page.getByRole('list').getByRole('listitem').filter({ hasText: name }).first();
    const panel = card.getByRole('region', { name: `PIN for ${name}` });
    await expect(panel).toContainText('No PIN', { timeout: 30_000 });
    await panel.getByRole('button', { name: 'Give a PIN' }).click();
    const shown = panel.getByRole('status', { name: `New PIN for ${name}` });
    await expect(shown).toBeVisible({ timeout: 30_000 });
    const temporary = (await shown.locator('p.font-mono').innerText()).trim();
    expect(temporary).toMatch(/^\d{6}$/);
    await expect(panel).toContainText('Waiting for the rider to choose their own');
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // A rider who opens the app is taken to the phone-number sign-in; a wrong PIN is refused in plain words, a right one leads to choosing their own.
    const phone = await freshPhone(browser, page);
    await phone.goto('/rider');
    await expect(phone).toHaveURL(/\/rider\/sign-in/, { timeout: 60_000 });
    await noHorizontalScroll(phone);
    const wrong = temporary === '482915' ? '907351' : '482915';
    await signIn(phone, number, wrong);
    await expect(failure(phone)).toContainText('The phone number or PIN is not right.', { timeout: 30_000 });
    await signIn(phone, number, temporary);
    await expect(phone).toHaveURL(/\/rider\/pin/, { timeout: 60_000 });
    await expect(phone.getByRole('heading', { name: 'Choose your own PIN' })).toBeVisible();
    // Until they have chosen, the rider app's other pages send them back here.
    await phone.goto('/rider');
    await expect(phone).toHaveURL(/\/rider\/pin/, { timeout: 60_000 });

    const choose = phone.getByRole('form', { name: 'Choose your PIN' });
    await expect.poll(() => choose.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 90_000 }).toBe(true);
    await choose.getByLabel('The PIN the office gave you').fill(temporary);
    await choose.getByLabel('Your new PIN', { exact: true }).fill('123456');
    await choose.getByLabel('Your new PIN again').fill('123456');
    await expect(choose.getByText(/digits in a row/)).toBeVisible();
    await expect(choose.getByRole('button', { name: 'Save my PIN' })).toBeDisabled();
    await choose.getByLabel('Your new PIN', { exact: true }).fill('907351');
    await choose.getByLabel('Your new PIN again').fill('907351');
    await choose.getByRole('button', { name: 'Save my PIN' }).click();
    await expect(phone).toHaveURL(/\/rider$/, { timeout: 60_000 });
    await expect(phone.getByRole('heading', { name: `Hello, ${name}` })).toBeVisible({ timeout: 60_000 });
    await expect(phone.getByRole('link', { name: /^My pay/ })).toBeVisible();
    await noHorizontalScroll(phone);

    // Signed out, the old PIN no longer works and the new one does.
    await phone.getByRole('button', { name: 'Sign out' }).click();
    await expect(phone).toHaveURL(/\/rider\/sign-in|\/login/, { timeout: 60_000 });
    await signIn(phone, number, temporary);
    await expect(failure(phone)).toContainText('not right', { timeout: 30_000 });
    await signIn(phone, number, '907351');
    await expect(phone).toHaveURL(/\/rider$/, { timeout: 60_000 });
    await phone.getByRole('button', { name: 'Sign out' }).click();
    await expect(phone).toHaveURL(/\/rider\/sign-in|\/login/, { timeout: 60_000 });

    // Five wrong tries shut the rider out, even for the right PIN; the office sees it and lets them try again.
    for (let i = 0; i < 5; i += 1) {
      await signIn(phone, number, wrong === '907351' ? '135790' : wrong);
      await expect(failure(phone)).toBeVisible({ timeout: 30_000 });
    }
    await expect(failure(phone)).toContainText('Too many wrong tries', { timeout: 30_000 });
    await signIn(phone, number, '907351');
    await expect(failure(phone)).toContainText('Too many wrong tries', { timeout: 30_000 });
    await open(page, '/admin/delivery/riders', 'Riders');
    const again = page.getByRole('list').getByRole('listitem').filter({ hasText: name }).first().getByRole('region', { name: `PIN for ${name}` });
    await expect(again).toContainText('Shut out for', { timeout: 30_000 });
    await again.getByRole('button', { name: 'Let them try again' }).click();
    await expect(again).toContainText(`${name} can try again now.`, { timeout: 30_000 });
    await signIn(phone, number, '907351');
    await expect(phone).toHaveURL(/\/rider$/, { timeout: 60_000 });
    await phone.context().close();

    // Turned off by the office, the PIN no longer signs in.
    await again.getByRole('button', { name: 'Turn off the PIN' }).click();
    await again.getByRole('button', { name: /^Confirm: Turn off the PIN/ }).click();
    await expect(again).toContainText('No PIN', { timeout: 30_000 });
    const last = await freshPhone(browser, page);
    await signIn(last, number, '907351');
    await expect(failure(last)).toContainText('not right', { timeout: 30_000 });
    await last.context().close();
  });
});
