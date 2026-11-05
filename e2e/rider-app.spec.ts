import { expect, test, type Browser, type Page } from '@playwright/test';
import { clickUntilVisible, followLink, noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
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
async function signInAndChoosePassword(page: Page, email: string, first: string, own: string, lands: RegExp, callback = '%2Frider'): Promise<void> {
  await page.goto(`/login?callbackUrl=${callback}`);
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
async function planRunFor(page: Page, tag: string, riderName: string): Promise<{ run: string; delivery: string; deliveryId: string; orderNumber: string }> {
  const orderNumber = await placeDeliveredOrder(page);
  const made = deliveryTool('ready', orderNumber);
  const delivery = made.number ?? '';
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
  return { run, delivery, deliveryId: made.id ?? '', orderNumber };
}

/** The staff member is made a rider on the Riders screen; the page is left there. */
async function makeStaffRider(page: Page, name: string): Promise<void> {
  await open(page, '/admin/delivery/riders', 'Riders');
  const add = page.getByRole('region', { name: 'Add a member of staff' });
  await pick(page, add.getByRole('combobox', { name: 'Staff member' }), name, new RegExp(name));
  await add.getByRole('button', { name: 'Make a rider' }).click();
  await expect(page.getByText(/can now be given runs/)).toBeVisible({ timeout: 30_000 });
}

/** Opens a run from the rider's list. This is a page change the development server may still be compiling, so tap once and wait for it; tapping again would hit a link that is no longer there. */
async function openRun(phone: Page, run: string): Promise<void> {
  await phone.getByRole('region', { name: 'To do' }).getByRole('link', { name: new RegExp(run) }).click();
  await expect(phone).toHaveURL(/\/rider\/runs\//, { timeout: 90_000 });
  await expect(phone.getByRole('heading', { name: run, level: 1 })).toBeVisible({ timeout: 60_000 });
}

/** The office sends the run out, from the run's own screen. */
async function startRun(page: Page, run: string): Promise<void> {
  await open(page, '/admin/delivery/dispatch', 'Dispatch board');
  const link = page.getByRole('region', { name: 'Runs to do' }).getByRole('link', { name: run });
  await followLink(link, page, /\/admin\/delivery\/runs\//, page.getByRole('heading', { name: /^Run RUN-/ }).first());
  await page.getByRole('button', { name: 'Start the run' }).click();
  await expect(page.getByText(/^The run is on the road/)).toBeVisible({ timeout: 30_000 });
}

/** Plans a run for the named rider and puts the (already ready) delivery on it; returns the run's number. */
async function planRunForReady(page: Page, tag: string, riderName: string, delivery: string): Promise<string> {
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
  return run;
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
      await openRun(phone, run);
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

  test('at the door: the rider needs the customer\'s code to mark a stop delivered, then finishes the run, and the office sees it', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const staff = riderTool('staff', tag);
    const name = staff.name ?? '';
    deliveryTool('open', tag);
    try {
      // The company asks for the customer's code.
      await open(page, '/admin/delivery/riders', 'Riders');
      const proof = page.getByRole('region', { name: 'Proof at the door' });
      await proof.getByRole('radio', { name: /^The customer's code The customer is sent/ }).check();
      await proof.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Riders are asked for this from now on/)).toBeVisible({ timeout: 30_000 });
      await noNativeSelect(page);
      await makeStaffRider(page, name);
      const { run, delivery, deliveryId } = await planRunFor(page, tag, name);
      await startRun(page, run);

      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, staff.email ?? '', staff.password ?? '', 'E2eStaffDoor-Pass4', /\/rider$/);
      await openRun(phone, run);
      const stops = phone.getByRole('list', { name: 'Stops' });
      await expect(stops).toContainText('Out for delivery');
      await clickUntilVisible(stops.getByRole('button', { name: 'Delivered' }), phone.getByRole('form', { name: 'Mark delivered' }));
      await noHorizontalScroll(phone);
      const form = phone.getByRole('form', { name: 'Mark delivered' });
      await expect(form.getByLabel('Who received it')).toHaveValue('Wanjiru Documents');

      // No code: refused. A wrong code: refused, with the tries left. The customer's code: delivered.
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(phone.getByRole('alert').filter({ hasText: /six-digit code/ })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel("The customer's code").fill('000000');
      const real = riderTool('code', delivery).code ?? '';
      expect(real).toMatch(/^\d{6}$/);
      if (real === '000000') await form.getByLabel("The customer's code").fill('000001');
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(phone.getByRole('alert').filter({ hasText: /not the customer's code/ })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel("The customer's code").fill(real);
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(stops).toContainText('Delivered', { timeout: 30_000 });
      await expect(stops.getByRole('button', { name: 'Delivered' })).toHaveCount(0);

      // Every stop is done, so the rider can hand the run back.
      const finish = phone.getByRole('region', { name: 'Finish the run' });
      await expect(finish).toBeVisible({ timeout: 30_000 });
      await finish.getByRole('button', { name: 'Finish this run' }).click();
      await finish.getByRole('button', { name: 'Confirm: Finish this run' }).click();
      await expect(phone.getByText('Completed')).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(phone);
      await phone.context().close();

      // The office sees the try, who made it and the proof.
      await open(page, `/admin/delivery/deliveries/${deliveryId}`, new RegExp(`^Delivery ${delivery}`));
      const door = page.getByRole('region', { name: 'At the door' });
      await expect(door).toContainText('Try 1: Delivered');
      await expect(door).toContainText(name);
      await expect(door).toContainText("Customer's code matched");
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('at the door: a stop that could not be delivered needs a reason, is recorded with it, and the office sees it', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const staff = riderTool('staff', tag);
    const name = staff.name ?? '';
    riderTool('proof', 'none');
    deliveryTool('open', tag);
    try {
      await makeStaffRider(page, name);
      const { run, delivery, deliveryId, orderNumber } = await planRunFor(page, tag, name);
      await startRun(page, run);

      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, staff.email ?? '', staff.password ?? '', 'E2eStaffDoor-Pass5', /\/rider$/);
      await openRun(phone, run);
      const stops = phone.getByRole('list', { name: 'Stops' });
      await clickUntilVisible(stops.getByRole('button', { name: 'Could not deliver' }), phone.getByRole('form', { name: 'Could not deliver' }));
      const form = phone.getByRole('form', { name: 'Could not deliver' });
      await noHorizontalScroll(phone);
      await noNativeSelect(phone);
      await form.getByRole('radio', { name: 'Another reason (say which)' }).check();
      await form.getByLabel('What happened').fill('The gate was locked and nobody answered the bell');
      await form.getByRole('button', { name: 'Record that it was not delivered' }).click();
      await expect(stops).toContainText('Attempt failed', { timeout: 30_000 });
      await expect(stops.getByRole('button', { name: 'Could not deliver' })).toHaveCount(0);
      await phone.getByRole('region', { name: 'Finish the run' }).getByRole('button', { name: 'Finish this run' }).click();
      await phone.getByRole('button', { name: 'Confirm: Finish this run' }).click();
      await expect(phone.getByText('Completed')).toBeVisible({ timeout: 30_000 });
      await phone.context().close();

      await open(page, `/admin/delivery/deliveries/${deliveryId}`, new RegExp(`^Delivery ${delivery}`));
      const door = page.getByRole('region', { name: 'At the door' });
      await expect(door).toContainText('Try 1: Another reason (say which)');
      await expect(door).toContainText('Not delivered');
      await expect(door).toContainText('The gate was locked');
      await expect(page.getByText('Attempt failed').first()).toBeVisible();

      // The customer chooses another day on their own tracking page; the office then sees it wanted that day.
      const customer = await otherBrowserPage(browser, page);
      const token = riderTool('token', orderNumber).token ?? '';
      expect(token.length).toBeGreaterThan(20);
      await customer.goto(`/track/${token}`);
      const reschedule = customer.getByRole('form', { name: `Choose another day for ${delivery}` });
      await expect(reschedule).toBeVisible({ timeout: 60_000 });
      await noHorizontalScroll(customer);
      await expect.poll(() => reschedule.getByLabel('Choose a day for us to try again').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 60_000 }).toBe(true);
      await reschedule.getByLabel('Choose a day for us to try again').fill(today());
      await reschedule.getByRole('button', { name: 'Try again on this day' }).click();
      await expect(reschedule.getByRole('alert')).toContainText(/after today/, { timeout: 30_000 });
      const later = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await reschedule.getByLabel('Choose a day for us to try again').fill(later);
      await reschedule.getByRole('button', { name: 'Try again on this day' }).click();
      await expect(customer.getByText(`We will try again on ${later}`)).toBeVisible({ timeout: 30_000 });
      await expect(reschedule).toHaveCount(0);
      await customer.context().close();
      await open(page, `/admin/delivery/deliveries/${deliveryId}`, new RegExp(`^Delivery ${delivery}`));
      await expect(page.getByText(/Wanted on /).first()).toBeVisible({ timeout: 30_000 });
      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      await expect(page.getByRole('region', { name: 'Ready to go' })).toContainText(`Wanted ${later}`, { timeout: 30_000 });
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('at the door: the customer takes only part of it, the rider says why, and the office sees what comes back', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const staff = riderTool('staff', tag);
    const name = staff.name ?? '';
    riderTool('proof', 'none');
    deliveryTool('open', tag);
    try {
      await makeStaffRider(page, name);
      const { run, delivery, deliveryId } = await planRunFor(page, tag, name);
      await startRun(page, run);

      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, staff.email ?? '', staff.password ?? '', 'E2eStaffDoor-Pass6', /\/rider$/);
      await openRun(phone, run);
      const stops = phone.getByRole('list', { name: 'Stops' });
      await clickUntilVisible(stops.getByRole('button', { name: 'Delivered' }), phone.getByRole('form', { name: 'Mark delivered' }));
      const form = phone.getByRole('form', { name: 'Mark delivered' });
      await form.getByLabel('The customer took only part of it').check();
      await noHorizontalScroll(phone);
      const took = form.getByLabel(/Salt 500g: how many did they take/);
      await took.fill('1');
      // The reason is needed for what was not taken.
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(phone.getByRole('alert').filter({ hasText: /Say why some of it was not taken/ })).toBeVisible({ timeout: 30_000 });
      await form.getByRole('radio', { name: 'It was damaged' }).check();
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(stops).toContainText('Delivered', { timeout: 30_000 });
      await phone.context().close();

      await open(page, `/admin/delivery/deliveries/${deliveryId}`, new RegExp(`^Delivery ${delivery}`));
      const door = page.getByRole('region', { name: 'At the door' });
      await expect(door).toContainText('Part accepted');
      await expect(door).toContainText('Salt 500g: took 1 of 2 (It was damaged)');
      await expect(page.getByRole('region', { name: 'Goods that came back' })).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('without signal: a run opened before is still there, what is done at the door is saved on the phone and sent once, when the signal returns', async ({ page, browser }, testInfo) => {
    // The development server does not serve the app the way a phone gets it (its pages cannot start without the server), so this runs
    // against a production build: `next build`, `next start -p 3100` with the e2e environment, then E2E_REUSE_SERVER=1 E2E_PRODUCTION_SERVER=1.
    test.skip(process.env.E2E_PRODUCTION_SERVER !== '1', 'needs a production build of the app');
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const staff = riderTool('staff', tag);
    const name = staff.name ?? '';
    deliveryTool('open', tag);
    try {
      await makeStaffRider(page, name);
      const { run, delivery, deliveryId } = await planRunFor(page, tag, name);
      await startRun(page, run);

      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, staff.email ?? '', staff.password ?? '', 'E2eStaffDoor-Pass7', /\/rider$/);
      const runs = phone.getByRole('region', { name: 'To do' });
      await expect(runs).toContainText(run, { timeout: 60_000 });
      // The app's worker takes over, and the run's screen is kept for later.
      await phone.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await phone.reload();
      await expect.poll(() => phone.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 60_000 }).toBe(true);
      await expect(phone.getByRole('region', { name: 'To do' })).toContainText(run, { timeout: 60_000 });
      await openRun(phone, run);
      await expect(phone.getByRole('list', { name: 'Stops' })).toContainText('Wanjiru Documents');
      await phone.reload();
      await expect(phone.getByRole('heading', { name: run, level: 1 })).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => phone.evaluate(async () => (await (await caches.open('rider-app-pages-v1')).keys()).length), { timeout: 30_000 }).toBeGreaterThan(0);

      // The signal goes. The run opens again from the phone's copy.
      await phone.context().setOffline(true);
      await phone.reload();
      await expect(phone.getByRole('heading', { name: run, level: 1 })).toBeVisible({ timeout: 60_000 });
      await expect(phone.getByText(/You have no signal/)).toBeVisible({ timeout: 30_000 });
      const stops = phone.getByRole('list', { name: 'Stops' });
      await expect(stops).toContainText('Wanjiru Documents');
      await noHorizontalScroll(phone);

      // At the door, with no signal: saved on the phone, the stop says so, and the run can be finished from what the phone knows.
      await clickUntilVisible(stops.getByRole('button', { name: 'Delivered' }), phone.getByRole('form', { name: 'Mark delivered' }));
      const form = phone.getByRole('form', { name: 'Mark delivered' });
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(stops).toContainText('Saved on this phone, waiting to be sent', { timeout: 30_000 });
      await expect(phone.getByText(/1 thing is saved on this phone/)).toBeVisible();
      const finish = phone.getByRole('region', { name: 'Finish the run' });
      await expect(finish).toBeVisible({ timeout: 30_000 });
      await finish.getByRole('button', { name: 'Finish this run' }).click();
      await phone.getByRole('button', { name: 'Confirm: Finish this run' }).click();
      await expect(phone.getByText(/Finishing this run is saved on this phone/)).toBeVisible({ timeout: 30_000 });
      await noHorizontalScroll(phone);

      // The shop has heard nothing yet.
      await open(page, `/admin/delivery/deliveries/${deliveryId}`, new RegExp(`^Delivery ${delivery}`));
      await expect(page.getByRole('region', { name: 'At the door' })).toHaveCount(0);

      // The signal returns: the stop is sent, then the finish, each once.
      await phone.context().setOffline(false);
      await expect(phone.getByText('Completed')).toBeVisible({ timeout: 90_000 });
      await expect(phone.getByText(/saved on this phone/)).toHaveCount(0);
      await phone.context().close();

      await open(page, `/admin/delivery/deliveries/${deliveryId}`, new RegExp(`^Delivery ${delivery}`));
      const door = page.getByRole('region', { name: 'At the door' });
      await expect(door).toContainText('Try 1: Delivered');
      await expect(door.getByRole('listitem')).toHaveCount(1);
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('cash at the door: the office chooses how it is received and marks a delivery, the rider collects exactly what is due, and it is in their custody', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const staff = riderTool('staff', tag);
    const name = staff.name ?? '';
    riderTool('proof', 'none');
    const setup = riderTool('door-setup', 'x');
    const cash = setup.name ?? '';
    deliveryTool('open', tag);
    try {
      // Until the office chooses how cash is received, nothing can be marked. It chooses on its screen.
      await open(page, '/admin/delivery/door-payments', 'Door payments');
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      const how = page.getByRole('region', { name: 'How cash is received' });
      await expect(how.getByRole('button', { name: 'Save' })).toBeDisabled();
      await pick(page, how.getByRole('combobox', { name: 'Payment method' }), cash, new RegExp(cash));
      await how.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Cash taken at doors is received through this method/)).toBeVisible({ timeout: 30_000 });

      await makeStaffRider(page, name);
      // An order nobody has paid for yet, with a delivery made for it.
      const orderNumber = await placeDeliveredOrder(page, { pay: false });
      const made = deliveryTool('ready', orderNumber, 'draft');
      const delivery = made.number ?? '';
      await open(page, `/admin/delivery/deliveries/${made.id ?? ''}`, new RegExp(`^Delivery ${delivery}`));
      const doorPanel = page.getByRole('region', { name: 'Paid at the door' });
      await expect(doorPanel).toContainText('Not marked');
      await doorPanel.getByRole('button', { name: 'Mark to be paid at the door' }).click();
      await expect(page.getByRole('alert').or(page.getByText(/Say why this order may be paid at the door/))).toBeVisible({ timeout: 30_000 });
      await doorPanel.getByLabel('Why it may be paid at the door').fill('Customer asked to pay when it arrives');
      await doorPanel.getByRole('button', { name: 'Mark to be paid at the door' }).click();
      await expect(page.getByText('This delivery will be paid in cash at the door.')).toBeVisible({ timeout: 30_000 });
      await expect(doorPanel).toContainText(/The rider will collect KSh [\d.]+ in cash/);
      const amount = /KSh ([\d.]+) in cash/.exec(await doorPanel.innerText())?.[1] ?? '';
      expect(amount).toMatch(/^\d+\.\d{2}$/);
      deliveryTool('advance', made.id ?? '', delivery);

      // On a run, started by the office.
      await open(page, '/admin/delivery/dispatch', 'Dispatch board');
      const plan = page.getByRole('region', { name: 'Plan a run' });
      await pick(page, plan.getByRole('combobox', { name: 'Leaves from' }), `Delivery ${tag}`, new RegExp(`Delivery ${tag}`));
      await plan.getByLabel('Day').fill(today());
      await pick(page, plan.getByRole('combobox', { name: 'Rider' }), name, new RegExp(name));
      await plan.getByRole('button', { name: 'Plan the run' }).click();
      const planned = page.getByText(/^Run RUN-.* is planned/);
      await expect(planned).toBeVisible({ timeout: 30_000 });
      const run = /(RUN-[\w-]+)/.exec(await planned.innerText())?.[1] ?? '';
      const ready = page.getByRole('region', { name: 'Ready to go' });
      await expect(ready).toContainText(delivery, { timeout: 30_000 });
      await pick(page, ready.getByRole('combobox', { name: 'Put deliveries on this run' }), run, new RegExp(run));
      await ready.getByRole('button', { name: `Put ${delivery} on the run` }).click();
      await expect(page.getByText(`${delivery} is on the run.`)).toBeVisible({ timeout: 30_000 });
      await startRun(page, run);

      // The rider is told to collect, and must collect exactly that.
      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, staff.email ?? '', staff.password ?? '', 'E2eStaffDoor-Pass8', /\/rider$/);
      await openRun(phone, run);
      const stops = phone.getByRole('list', { name: 'Stops' });
      await clickUntilVisible(stops.getByRole('button', { name: 'Delivered' }), phone.getByRole('form', { name: 'Mark delivered' }));
      const form = phone.getByRole('form', { name: 'Mark delivered' });
      await expect(form).toContainText(`KSh ${amount} is to be paid at this door`);
      await expect(form.getByLabel('The customer took only part of it')).toHaveCount(0);
      await noHorizontalScroll(phone);
      await form.getByLabel('Cash collected (KSh)').fill('1');
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(phone.getByRole('alert').filter({ hasText: new RegExp(`amount due is KSh ${amount}`) })).toBeVisible({ timeout: 30_000 });
      await form.getByLabel('Cash collected (KSh)').fill(amount);
      await form.getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(stops).toContainText('Delivered', { timeout: 30_000 });
      await phone.getByRole('link', { name: '← My runs' }).click();
      await expect(phone.getByText(new RegExp(`You are holding KSh ${amount}`))).toBeVisible({ timeout: 60_000 });
      await phone.context().close();

      // The books: the order is paid through the cash method, the cash is in custody, the sale is queued.
      const state = riderTool('door', delivery);
      expect(state).toMatchObject({ status: 'delivered', paymentStatus: 'paid', paymentMethod: 'cash_at_door', custody: '1', custodyAmount: amount, queued: '1' });

      // The office sees what the rider holds.
      await open(page, '/admin/delivery/door-payments', 'Door payments');
      const holds = page.getByRole('region', { name: 'What riders hold' });
      await expect(holds).toContainText(name, { timeout: 30_000 });
      await expect(holds).toContainText(`KSh ${amount}`);
      const ledger = page.getByRole('list', { name: 'Custody entries' });
      await expect(ledger).toContainText(delivery, { timeout: 30_000 });
      await expect(ledger).toContainText(`KES ${amount}`);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      // The hand-in. The office says how big a difference may be without approval (nothing) and where one is written.
      const differences = page.getByRole('region', { name: 'Differences' });
      await differences.getByLabel('Largest difference allowed without approval (KSh)').fill('0');
      await pick(page, differences.getByRole('combobox', { name: 'Account a difference is written to' }), setup.variance ?? '', new RegExp(setup.variance ?? ''));
      await differences.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/A hand-in that is out by more than this waits/)).toBeVisible({ timeout: 30_000 });

      // Counted short: it needs words, a till, and a witness who is neither the recorder nor the rider; then it waits.
      const witnessTag = `${tag}W`;
      const witness = riderTool('staff', witnessTag);
      const card = holds.getByRole('listitem').filter({ hasText: name });
      await card.getByRole('button', { name: `Record a hand-in from ${name}` }).click();
      const handIn = page.getByRole('form', { name: `Hand-in from ${name}` });
      await expect(handIn).toContainText(`expected to hand in KSh ${amount}`);
      const short = (Number(amount) - 1).toFixed(2);
      await handIn.getByLabel('Cash counted (KSh)').fill(short);
      await expect(handIn.getByText(/short by KSh 1\.00/)).toBeVisible();
      await pick(page, handIn.getByRole('combobox', { name: 'Cash goes into' }), setup.till ?? '', new RegExp(setup.till ?? ''));
      await pick(page, handIn.getByRole('combobox', { name: 'Witness' }), witness.name ?? '', new RegExp(witness.name ?? ''));
      await handIn.getByLabel('Why it is out').fill('A torn note was not accepted at the door');
      await noHorizontalScroll(page);
      await handIn.getByRole('button', { name: 'Record the hand-in' }).click();
      await expect(page.getByText(/is waiting for approval: the count is out by KSh 1\.00/)).toBeVisible({ timeout: 30_000 });
      const row = page.getByRole('list', { name: 'Hand-in list' }).getByRole('listitem').first();
      await expect(row).toContainText('Waiting for approval');
      await expect(row).toContainText(`Counted KES ${short} of ${amount}`);
      expect(riderTool('door', delivery)).toMatchObject({ held: amount, handIns: '1', handInStatus: 'pending_approval' });

      // The person who recorded it cannot approve it.
      const approve = row.getByRole('button', { name: /^Approve HND-/ });
      await approve.click();
      await expect(page.getByRole('alert').filter({ hasText: /someone other than the person who recorded it/ })).toBeVisible({ timeout: 30_000 });
      expect(riderTool('door', delivery).held).toBe(amount);

      // Another administrator approves it: the cash is out of the rider's custody, with the difference.
      const boss = riderTool('staff', `${tag}B`);
      const second = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(second, boss.email ?? '', boss.password ?? '', 'E2eBoss-Pass9', /door-payments/, '%2Fadmin%2Fdelivery%2Fdoor-payments');
      const pending = second.getByRole('list', { name: 'Hand-in list' }).getByRole('listitem').first();
      await expect(pending).toContainText('Waiting for approval', { timeout: 60_000 });
      await pending.getByRole('button', { name: /^Approve HND-/ }).click();
      await expect(second.getByText(/is approved and posted/)).toBeVisible({ timeout: 30_000 });
      await expect(second.getByRole('list', { name: 'Hand-in list' }).getByRole('listitem').first()).toContainText('Handed in');
      await second.context().close();
      expect(riderTool('door', delivery)).toMatchObject({ held: '0.00', handInStatus: 'posted' });
    } finally {
      deliveryTool('close', tag);
    }
  });

  test('M-Pesa at the door: the rider asks for a prompt, waits for the platform, and when the order is paid takes no cash', async ({ page, browser }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const staff = riderTool('staff', tag);
    const name = staff.name ?? '';
    riderTool('proof', 'none');
    const setup = riderTool('door-setup', 'x');
    deliveryTool('open', tag);
    try {
      await open(page, '/admin/delivery/door-payments', 'Door payments');
      const how = page.getByRole('region', { name: 'How cash is received' });
      await pick(page, how.getByRole('combobox', { name: 'Payment method' }), setup.name ?? '', new RegExp(setup.name ?? ''));
      await how.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(/Cash taken at doors is received through this method/)).toBeVisible({ timeout: 30_000 });
      await makeStaffRider(page, name);
      const orderNumber = await placeDeliveredOrder(page, { pay: false });
      const made = deliveryTool('ready', orderNumber, 'door');
      const delivery = made.number ?? '';
      const planned = await planRunForReady(page, tag, name, delivery);
      await startRun(page, planned);

      const phone = await otherBrowserPage(browser, page);
      await signInAndChoosePassword(phone, staff.email ?? '', staff.password ?? '', 'E2eStaffMpesa-Pass1', /\/rider$/);
      await clickUntilVisible(phone.getByRole('region', { name: 'To do' }).getByRole('link', { name: new RegExp(planned) }), phone.getByRole('heading', { name: planned, level: 1 }));
      const stops = phone.getByRole('list', { name: 'Stops' });
      await clickUntilVisible(stops.getByRole('button', { name: 'Delivered' }), phone.getByRole('form', { name: 'Mark delivered' }));
      const form = phone.getByRole('form', { name: 'Mark delivered' });
      await expect(form).toContainText(/is to be paid at this door/);
      await noHorizontalScroll(phone);
      await form.getByLabel('M-Pesa').check();
      await expect(form.getByLabel('Cash collected (KSh)')).toHaveCount(0);
      await expect(form.getByRole('button', { name: 'Confirm delivered' })).toBeDisabled();
      await expect(form.getByLabel('The number the customer pays from')).toHaveValue(/^0711\s?000\s?666$/);

      // The test shop has no M-Pesa connection, so a prompt cannot be sent: the rider is told, and can take cash instead.
      await form.getByRole('button', { name: 'Send the M-Pesa prompt' }).click();
      await expect(phone.getByRole('alert').filter({ hasText: /prompt could not be sent|could not be started|Take the cash instead/ })).toBeVisible({ timeout: 60_000 });

      // A prompt is out (as if it had gone): the form picks it up when it is opened again, and says it is waiting.
      riderTool('mpesa-sent', delivery);
      await phone.reload();
      await clickUntilVisible(stops.getByRole('button', { name: 'Delivered' }), phone.getByRole('form', { name: 'Mark delivered' }));
      await expect(phone.getByText(/Waiting for the customer to enter their PIN on the phone ending 678/)).toBeVisible({ timeout: 60_000 });
      await expect(phone.getByRole('form', { name: 'Mark delivered' }).getByRole('button', { name: 'Confirm delivered' })).toBeDisabled();

      // The platform confirms it: the order is paid, the rider's screen finds out, and no cash is asked for.
      deliveryTool('pay', orderNumber);
      await expect(phone.getByText(/is paid\. Hand over the goods; no cash is to be taken/)).toBeVisible({ timeout: 60_000 });
      await phone.getByRole('form', { name: 'Mark delivered' }).getByRole('button', { name: 'Confirm delivered' }).click();
      await expect(stops).toContainText('Delivered', { timeout: 30_000 });
      await phone.context().close();

      expect(riderTool('door', delivery)).toMatchObject({ status: 'delivered', paymentStatus: 'paid', paymentMethod: 'mpesa_daraja', custody: '0' });
    } finally {
      deliveryTool('close', tag);
    }
  });
});
