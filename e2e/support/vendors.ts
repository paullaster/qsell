import { execFileSync } from 'node:child_process';
import { expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { E2E_URL } from './constants';
import { e2eEnvironment } from './env';

export interface VendorFixture {
  email: string;
  password: string;
  vendorId: string;
  legalName: string;
  fileIds?: string[];
  number?: string;
  changeId?: string;
  newLast4?: string;
}

/** A vendor made for this test alone (see vendor-fixture.ts). A new tag each time makes a retried test start clean. */
export function makeVendor(tag: string, mode: 'new' | 'submitted' | 'approved' | 'expiring' | 'bankpending' | 'bankready' | 'staffadded'): VendorFixture {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/vendor-fixture.ts', tag, mode], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the vendor fixture printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as VendorFixture;
}

/** A tag that is different for each browser project and each attempt, short enough for a name or an email. */
export const attemptTag = (project: string, retry: number): string => `${project === 'phone' ? 'p' : 'd'}${String(retry)}${String(Date.now()).slice(-8)}`;

/** Signs in through the sign-in page and lands in the vendor portal. */
export async function signInAsVendor(page: Page, vendor: Pick<VendorFixture, 'email' | 'password'>): Promise<void> {
  await page.goto('/login?callbackUrl=%2Fvendor');
  await expect(page.getByLabel('Email')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.getByLabel('Email').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 90_000 }).toBe(true);
  await page.getByLabel('Email').fill(vendor.email);
  await page.getByLabel('Password', { exact: true }).fill(vendor.password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(/\/vendor$/, { timeout: 90_000 });
}

/** A second browser window with nobody signed in, sized like the project's own (for a vendor while staff are signed in elsewhere). */
export async function signedOutPage(browser: Browser, testInfo: TestInfo): Promise<{ page: Page; close: () => Promise<void> }> {
  const use = testInfo.project.use;
  const context = await browser.newContext({ baseURL: E2E_URL, viewport: use.viewport ?? { width: 1280, height: 900 }, isMobile: use.isMobile, hasTouch: use.hasTouch, storageState: { cookies: [], origins: [] } });
  return { page: await context.newPage(), close: async () => { await context.close(); } };
}

export interface PrequalFixture {
  categoryId: string;
  categoryName: string;
  entryId?: string;
}

/** An open category for one test, and (for `submitted` / `evaluated`) the approved vendor's application in it (see prequal-fixture.ts). */
export function makePrequal(tag: string, vendorId: string | null, mode: 'category' | 'submitted' | 'evaluated'): PrequalFixture {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/prequal-fixture.ts', tag, vendorId ?? '-', mode], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the prequalification fixture printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as PrequalFixture;
}

export interface RfqFixture {
  categoryId: string;
  categoryName: string;
  rfqId?: string;
  number?: string;
  title?: string;
  lineA?: string;
  lineB?: string;
}

/** A category with these approved vendors qualified in it, and (by mode) a request, sent quotes, or a closed request (see rfq-fixture.ts). */
export function makeRfq(tag: string, vendorIds: string[], mode: 'category' | 'issued' | 'quoted' | 'closed'): RfqFixture {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/rfq-fixture.ts', tag, vendorIds.join(','), mode], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the request fixture printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as RfqFixture;
}

export interface PoFixture {
  categoryId: string;
  categoryName: string;
  poId?: string;
  number?: string;
  rfqId?: string;
  advanceId?: string;
  productId?: string;
  productName?: string;
  rgnId?: string;
  rgnNumber?: string;
  deliveryNote?: string;
}

/** A purchase order (or an awarded request) for one test, written by another person so the signed-in test user may approve it (see po-fixture.ts). */
export function makePo(tag: string, vendorId: string, mode: 'pending' | 'sent' | 'sent_flagged' | 'amendment' | 'advance_pending' | 'awarded' | 'stocked' | 'received'): PoFixture {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/po-fixture.ts', tag, vendorId, mode], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the purchase order fixture printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as PoFixture;
}

export interface ShopperFixture {
  email: string;
  password: string;
  numbers: string[];
  otherNumber: string;
  otherId: string;
}

/** A shopper made for this test alone, with `orders` orders of their own and one order of somebody else (see shopper-fixture.ts). */
export function makeShopper(tag: string, orders: number): ShopperFixture {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'e2e/support/shopper-fixture.ts', tag, String(orders)], { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the shopper fixture printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as ShopperFixture;
}

/** Signs in through the sign-in page and lands on the account page. */
export async function signInAsShopper(page: Page, shopper: Pick<ShopperFixture, 'email' | 'password'>): Promise<void> {
  await page.goto('/login?callbackUrl=%2Fprofile');
  await expect(page.getByLabel('Email')).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.getByLabel('Email').evaluate((el) => Object.keys(el).some((k) => k.startsWith('__reactProps'))).catch(() => false), { timeout: 90_000 }).toBe(true);
  await page.getByLabel('Email').fill(shopper.email);
  await page.getByLabel('Password', { exact: true }).fill(shopper.password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await expect(page).toHaveURL(/\/profile$/, { timeout: 90_000 });
}

/** Steps of the invoice and payment tests that need a second staff member or the books set up (see invoice-fixture.ts). Returns the fixture's answer. */
export function invoiceTool(action: 'prepare' | 'approve' | 'payments-prepare' | 'book' | 'approve-voucher', arg?: string): Record<string, string> {
  const args = ['exec', 'tsx', 'e2e/support/invoice-fixture.ts', action, ...(arg === undefined ? [] : [arg])];
  const output = execFileSync('pnpm', args, { env: { ...process.env, ...e2eEnvironment() }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const line = output.split('\n').find((l) => l.startsWith('FIXTURE '));
  if (line === undefined) throw new Error(`the invoice tool printed nothing usable: ${output.slice(-500)}`);
  return JSON.parse(line.slice('FIXTURE '.length)) as Record<string, string>;
}
