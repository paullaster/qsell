import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect } from './support/page';
import { gotoAdmin } from './support/quotes';
import { makeProduct, makeTradeCustomer, setManualDiscount } from './support/storefront-fixtures';

async function pick(page: Page, field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.click();
    await field.fill(text);
    await page.getByRole('option', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click({ timeout: 4000 });
  }).toPass({ timeout: 60_000 });
}

/** "KES 1,250.00" as a number. */
const amount = (text: string | null): number => Number((text ?? '').replace(/[^0-9.]/g, ''));

const DOCUMENTS = [
  { type: 'sales_order', path: '/admin/sales-orders', heading: 'Sales orders', open: 'New sales order', place: 'Place order' },
  { type: 'credit_sale', path: '/admin/credit-sales', heading: 'Credit sales', open: 'New credit sale', place: 'Place credit sale' },
  { type: 'sales_invoice', path: '/admin/sales-invoices', heading: 'Sales invoices', open: 'New sales invoice', place: 'Issue invoice' },
] as const;

test.describe('the lines of a sales order, credit sale and sales invoice', () => {
  for (const doc of DOCUMENTS) {
    test(`${doc.open}: item, quantity, unit price and line total are named and priced by the server; a price can be changed and a discount given only where the company allows it`, async ({ page }, testInfo) => {
      test.setTimeout(300_000);
      const tag = `ln${doc.type.slice(0, 2)}${String(Date.now()).slice(-6)}${testInfo.project.name === 'phone' ? 'p' : 'd'}`;
      const customer = makeTradeCustomer(tag);
      const productName = makeProduct(tag);
      setManualDiscount(doc.type, 'off');

      const openForm = async (): Promise<Locator> => {
        await gotoAdmin(page, doc.path, doc.heading);
        await expect(async () => {
          await page.getByRole('button', { name: doc.open }).click();
          await expect(page.getByRole('form', { name: doc.open })).toBeVisible({ timeout: 3000 });
        }).toPass({ timeout: 60_000 });
        const form = page.getByRole('form', { name: doc.open });
        await pick(page, form.getByRole('combobox', { name: /Customer/ }), customer);
        await pick(page, form.getByRole('combobox', { name: 'Add a product' }), productName);
        return form;
      };

      // The line says what each number is, and the server's price for this customer and the total are shown.
      let form = await openForm();
      const line = form.getByTestId('order-line');
      await expect(line).toHaveCount(1);
      await expect(line.getByLabel(`Quantity of ${productName}`)).toHaveValue('1');
      const unitBox = line.getByLabel(`Unit price of ${productName}`);
      await expect(unitBox).toBeVisible();
      await expect(form.getByTestId('order-total')).toBeVisible({ timeout: 60_000 });
      const unit = amount(await unitBox.inputValue());
      expect(unit).toBeGreaterThan(0);
      await line.getByLabel(`Quantity of ${productName}`).fill('3');
      await expect(line.getByTestId('line-total')).toContainText(/[\d,]+\.\d\d/, { timeout: 30_000 });
      await expect(async () => { expect(amount(await line.getByTestId('line-total').textContent())).toBeCloseTo(unit * 3, 1); }).toPass({ timeout: 30_000 });
      await expect(form.getByTestId('order-total')).toContainText(/[\d,]+\.\d\d/);
      await noNativeSelect(page);
      await noHorizontalScroll(page);
      await noInnerHorizontalScroll(page);

      // On a desktop it is a table with named columns.
      if (testInfo.project.name === 'desktop') {
        for (const name of ['Item', 'Quantity', 'Unit price', 'Line total']) await expect(form.getByRole('columnheader', { name })).toBeVisible();
      }

      // No discount is offered until the company allows one, and a person who may give one is told it is switched off.
      await expect(form.getByTestId('discount-edit')).toHaveCount(0);
      await expect(form.getByTestId('discount-off-note')).toContainText('switched off');

      // However many lines there are, the lines scroll in their own box and the totals and Place order stay in view.
      for (let n = 0; n < 7; n += 1) await pick(page, form.getByRole('combobox', { name: 'Add a product' }), productName);
      await expect(form.getByTestId('order-line')).toHaveCount(8);
      await expect(form.getByRole('button', { name: doc.place })).toBeInViewport();
      await expect(form.getByTestId('order-total')).toBeInViewport();
      expect(await form.getByTestId('lines-box').evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true);
      await form.getByTestId('lines-box').evaluate((box) => { box.scrollTo(0, box.scrollHeight); });
      await expect(form.getByRole('button', { name: doc.place })).toBeInViewport();
      for (let n = 7; n >= 1; n -= 1) await form.getByRole('button', { name: /^Remove / }).last().click();
      await expect(form.getByTestId('order-line')).toHaveCount(1);

      // The price is changed in its own box; the line total follows, and the list price can be brought back.
      const higher = Math.round(unit * 1.05 * 100) / 100;
      await unitBox.fill(String(higher));
      await unitBox.press('Enter');
      await expect(async () => { expect(amount(await line.getByTestId('line-total').textContent())).toBeCloseTo(higher * 3, 1); }).toPass({ timeout: 30_000 });
      await expect(line).toContainText('price changed');
      await line.getByTestId('line-price-reset').click();
      await expect(async () => { expect(amount(await line.getByTestId('line-total').textContent())).toBeCloseTo(unit * 3, 1); }).toPass({ timeout: 30_000 });
      await expect(line).not.toContainText('price changed');
      await unitBox.fill('0');
      await unitBox.press('Enter');
      await expect(line.getByRole('alert')).toContainText('above nothing');

      // Where the company allows a discount, it is given on the line, shown beside the price it came from, and the document is placed with it.
      setManualDiscount(doc.type, 'all_branches');
      form = await openForm();
      const next = form.getByTestId('order-line');
      await expect(form.getByTestId('order-total')).toBeVisible({ timeout: 60_000 });
      await next.getByTestId('discount-edit').click();
      await next.getByTestId('discount-input').fill('10');
      await next.getByTestId('discount-apply').click();
      await expect(next.getByTestId('line-unit')).toContainText(/[\d,]+\.\d\d/, { timeout: 30_000 });
      await expect(async () => { expect(amount(await next.getByTestId('line-unit').locator('span').last().textContent())).toBeCloseTo(Math.round(unit * 0.9 * 100) / 100, 1); }).toPass({ timeout: 30_000 });
      await expect(next.getByTestId('line-unit').locator('span').first()).toHaveClass(/line-through/);
      await noHorizontalScroll(page);
      await form.getByRole('button', { name: doc.place }).click();
      await expect(page.getByText(/placed|issued/).first()).toBeVisible({ timeout: 60_000 });
      setManualDiscount(doc.type, 'off');
    });
  }
});
