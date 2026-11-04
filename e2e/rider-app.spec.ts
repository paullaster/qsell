import { expect, test, type Browser, type Page } from '@playwright/test';
import { clickUntilVisible, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';
import { deliveryTool } from './support/delivery-fixtures';
import { placeDeliveredOrder } from './support/delivery-shop';
import { riderTool } from './support/rider-fixtures';

// The choice of rider kinds is company-wide, so the steps run one after another and put it back at the end.
test.describe.configure({ mode: 'serial' });
test.afterAll(() => {
  riderTool('reset', 'x');
});

const today = (): string => new Date().toISOString().slice(0, 10);

/** Signs in on the sign-in page; the first password is replaced at once, as the account requires. */
async function signInAndChoosePassword(page: Page, email: string, first: string, own: string, lands: RegExp): Promise<void> {
  await page.goto('/login?callbackUrl=%2Frider');
  await expect(page.getByLabel('Email')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.getByLabel('Email').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 90_000 }).toBe(true);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(first);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(/change-password/, { timeout: 90_000 });
  await page.getByLabel('Temporary password').fill(first);
  await page.getByLabel('New password', { exact: true }).fill(own);
  await page.getByLabel('Confirm new password').fill(own);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page).toHaveURL(lands, { timeout: 90_000 });
}

/** A run from the fixture's branch, given to the named rider, with a ready delivery on it; returns the run's and the delivery's numbers. */
async function planRunFor(page: Page, tag: string, riderName: string): Promise<{ run: string; delivery: string }> {
  const orderNumber = await placeDeliveredOrder(page);
  const delivery = deliveryTool('ready', orderNumber).number ?? '';
  await open(page, '/admin/delivery/dispatch', 'Dispatch board');
  const ready = page.getByRole('region', { name: 'Ready to go' });
  await expect(ready).toContainText(delivery, { timeout: 30_000 });
  const plan = page.getByRole('region', { name: 'Plan a run' });
  await pick(page, plan.getByRole('combobox', { name: 'Leaves from' }), `Delivery ${tag}`, new RegExp(`Delivery ${tag}`));
  await plan.getByLabel('Day').fill(today());
  await pick(page, plan.getByRole('combobox', { name: 'Rider' }), riderName, new RegExp(riderName));
  await plan.getByRole('button', { name: 'Plan the run' }).click();
  const planned = page.getByText(/^Run RUN-.* is planned/);
  await expect(planned).toBeVisible({ timeout: 30_000 });
  const run = /(RUN-[\w-]+)/.exec(await planned.innerText())?.[1] ?? '';
  await pick(page, ready.getByRole('combobox', { name: 'Put deliveries on this run' }), run, new RegExp(run));
  await ready.getByRole('button', { name: `Put ${delivery} on the run` }).click();
  await expect(page.getByText(`${delivery} is on the run.`)).toBeVisible({ timeout: 30_000 });
  return { run, delivery };
}

async function otherBrowserPage(browser: Browser, page: Page): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: page.viewportSize() ?? undefined, storageState: { cookies: [], origins: [] } });
  return await context.newPage();
}

test.describe('the rider app', () => {
  test('a rider with an account of their own is made by the company, signs in to the rider app only, and sees only their run', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const name = `Achieng ${tag}`;
    const email = `e2e-rider-${tag}@example.test`.toLowerCase();
    const first = 'E2eRiderFirst-Pass1';
    const own = 'E2eRiderOwn-Pass2';
    deliveryTool('open', tag);
    try {
      // The company chooses to use riders with accounts of their own, and makes one.
      await open(page, '/admin/delivery/riders', 'Riders');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      const kinds = page.getByRole('region', { name: 'Who rides' });
      await expect(kinds.getByLabel(/Staff member/)).toBeChecked();
      await expect(page.getByRole('form', { name: 'Make an account for a rider' })).toHaveCount(0);
      await kinds.getByLabel(/Own rider account/).check();
      await kinds.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Saved\. This is who can be a rider/)).toBeVisible({ timeout: 30_000 });
      const form = page.getByRole('form', { name: 'Make an account for a rider' });
      await form.getByLabel('Name').fill(name);
      await form.getByLabel('Email to sign in with').fill(email);
      await form.getByLabel('Phone').fill('0722 333 444');
      await form.getByLabel('First password').fill('short');
      await form.getByRole('button', { name: 'Create the account' }).click();
      await expect(page.getByRole('alert').filter({ hasText: /at least 8 characters/ })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel('First password').fill(first);
      await form.getByRole('button', { name: 'Create the account' }).click();
      await expect(page.getByText(new RegExp(`${name} has an account`))).toBeVisible({ timeout: 30_000 });
      const card = page.getByRole('list', { name: 'List of riders' }).getByRole('listitem').filter({ hasText: name });
      await expect(card).toContainText('Own rider account');
      await expect(card).toContainText('Riding');
      await noInnerHorizontalScroll(page);

      // A run for them, with a delivery on it.
      const { run, delivery } = await planRunFor(page, tag, name);

      // Their own sign-in: the first password is replaced, and they land in the rider app, not the back office.
      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, email, first, own, /\/rider$/);
      await expect(phone.getByRole('heading', { name: `Hello, ${name}`, level: 1 })).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(phone);
      const runs = phone.getByRole('region', { name: 'To do' });
      await expect(runs).toContainText(run);
      await clickUntilVisible(runs.getByRole('link', { name: new RegExp(run) }), phone.getByRole('heading', { name: run, level: 1 }));
      await noHorizontalScroll(phone);
      await noInnerHorizontalScroll(phone);
      const stops = phone.getByRole('list', { name: 'Stops' });
      await expect(stops).toContainText('Wanjiru Documents');
      await expect(stops).toContainText('Westlands');
      await expect(stops).toContainText('2 × Salt 500g');
      await expect(stops.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:0711000666');
      await expect(stops.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', 'https://wa.me/254711000666');
      await expect(stops.getByRole('link', { name: 'Navigate' })).toHaveAttribute('href', /^geo:/);
      await expect(phone.getByText(delivery)).toBeVisible();

      // The account is for riding only: the back office is closed to it, and a run that is not theirs is not found.
      await phone.goto('/admin');
      await expect(phone).not.toHaveURL(/\/admin$/, { timeout: 30_000 });
      await phone.goto('/rider/runs/00000000-0000-4000-8000-000000000000');
      await expect(phone.getByText('Page not found')).toBeVisible({ timeout: 30_000 });
      await phone.context().close();

      // Pausing them closes the app to them and keeps the reason; a rider with a run to do cannot be paused.
      await open(page, '/admin/delivery/riders', 'Riders');
      await card.getByRole('button', { name: 'Pause' }).click();
      await card.getByLabel('Why are they paused?').fill('On leave');
      await card.getByRole('button', { name: 'Pause them' }).click();
      await expect(page.getByRole('alert').filter({ hasText: /1 run to do/ })).toBeVisible({ timeout: 30_000 });
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('a member of staff rides with the account they have, and the company can have both kinds at once', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const staff = riderTool('staff', tag);
    const name = staff.name ?? '';
    const own = 'E2eStaffOwn-Pass3';
    deliveryTool('open', tag);
    try {
      await open(page, '/admin/delivery/riders', 'Riders');
      // Staff riders are on by default; the picker offers staff who are not riders yet, and nobody else.
      const add = page.getByRole('region', { name: 'Add a member of staff' });
      await pick(page, add.getByRole('combobox', { name: 'Staff member' }), name, new RegExp(name));
      await add.getByRole('button', { name: 'Make a rider' }).click();
      await expect(page.getByText(/can now be given runs/)).toBeVisible({ timeout: 30_000 });
      const card = page.getByRole('list', { name: 'List of riders' }).getByRole('listitem').filter({ hasText: name });
      await expect(card).toContainText('Staff member');

      // A kind cannot be switched off while people of that kind ride.
      const kinds = page.getByRole('region', { name: 'Who rides' });
      await kinds.getByLabel(/Staff member/).uncheck();
      await kinds.getByLabel(/Own rider account/).check();
      await kinds.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('alert').filter({ hasText: /still riding/ })).toBeVisible({ timeout: 30_000 });

      const { run } = await planRunFor(page, tag, name);

      // They sign in as staff, change their password, and open the rider app from their own account.
      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, staff.email ?? '', staff.password ?? '', own, /\/rider$/);
      await expect(phone.getByRole('region', { name: 'To do' })).toContainText(run, { timeout: 60_000 });
      await noHorizontalScroll(phone);
      await phone.context().close();
    } finally {
      deliveryTool('close', tag);
    }
  });
});
