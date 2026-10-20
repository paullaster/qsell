import { expect, test } from '@playwright/test';
import { openNewQuote, openQuoteOf, pick, saveQuote } from './support/quotes';
import {
  clickUntilVisible,
  noHorizontalScroll,
  noInnerHorizontalScroll,
  noNativeSelect,
  open,
} from './support/page';

const suffix = (project: string) =>
  `${project === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;

test.describe('units of measure', () => {
  test('are made with pickers, converted through a base, protected while used, and deleted after asking', async ({
    page,
  }, testInfo) => {
    const tag = suffix(testInfo.project.name);
    const base = `E2EB${tag}`;
    const multiple = `E2EM${tag}`;
    await open(page, '/admin/settings/units', 'Units of measure');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // The standard units are there, and the default one is protected because products use it.
    await page.getByLabel('Search units').fill('Piece');
    const piece = page.getByRole('listitem').filter({ hasText: 'PCS · Piece' });
    await expect(piece).toBeVisible({ timeout: 30_000 });
    await expect(piece.getByText('Default', { exact: true })).toBeVisible();
    await expect(piece.getByText(/Used by \d+ products?/)).toBeVisible();
    await expect(piece.getByRole('button', { name: 'Delete unit PCS' })).toHaveCount(0);

    // A base unit: made with the kind picker.
    await page.getByRole('button', { name: 'New unit' }).click();
    const form = page.getByRole('form', { name: 'New unit of measure' });
    await form.getByLabel('Code', { exact: true }).fill(base);
    await form.getByLabel('Name', { exact: true }).fill(`E2E base ${tag}`);
    await form.getByLabel('Decimals').fill('3');
    await pick(page, form.getByRole('combobox', { name: 'Kind' }), 'Mass', /Mass/);
    await form.getByRole('button', { name: 'Create unit' }).click();
    await expect(page.getByText(`${base} created.`)).toBeVisible({ timeout: 30_000 });

    // The same code again is refused in words.
    await page.getByRole('button', { name: 'New unit' }).click();
    await form.getByLabel('Code', { exact: true }).fill(base);
    await form.getByLabel('Name', { exact: true }).fill(`E2E again ${tag}`);
    await pick(page, form.getByRole('combobox', { name: 'Kind' }), 'Mass', /Mass/);
    await form.getByRole('button', { name: 'Create unit' }).click();
    await expect(form.getByRole('alert')).toContainText(/already exists/, { timeout: 30_000 });

    // A multiple of it: the base is picked from the server's list; a zero factor is refused before sending.
    await form.getByLabel('Code', { exact: true }).fill(multiple);
    await form.getByLabel('Name', { exact: true }).fill(`E2E multiple ${tag}`);
    await form.getByLabel('Decimals').fill('0');
    await pick(
      page,
      form.getByRole('combobox', { name: /Is a multiple of/ }),
      base,
      new RegExp(base),
    );
    await form.getByLabel(new RegExp(`How many ${base} make 1`)).fill('0');
    await form.getByRole('button', { name: 'Create unit' }).click();
    await expect(form.getByRole('alert')).toContainText(/more than zero/);
    await form.getByLabel(new RegExp(`How many ${base} make 1`)).fill('0.001');
    await form.getByRole('button', { name: 'Create unit' }).click();
    await expect(page.getByText(`${multiple} created.`)).toBeVisible({ timeout: 30_000 });

    await page.getByLabel('Search units').fill(tag);
    const multipleRow = page.getByRole('listitem').filter({ hasText: `E2E multiple ${tag}` });
    const baseRow = page.getByRole('listitem').filter({ hasText: `E2E base ${tag}` });
    await expect(multipleRow.getByText(`1 ${multiple} = 0.001 ${base}`)).toBeVisible({
      timeout: 30_000,
    });

    // The base is used by the multiple, so it cannot be deleted; it can still be switched off.
    await expect(baseRow.getByText(/Used by 1 other unit/)).toBeVisible();
    await expect(baseRow.getByRole('button', { name: `Delete unit ${base}` })).toHaveCount(0);
    await baseRow.getByRole('button', { name: `Switch off ${base}` }).click();
    await expect(page.getByText(`${base} is switched off.`)).toBeVisible({ timeout: 30_000 });
    await expect(baseRow.getByText('Switched off')).toBeVisible();
    await baseRow.getByRole('button', { name: `Switch on ${base}` }).click();
    await expect(page.getByText(`${base} is switched on.`)).toBeVisible({ timeout: 30_000 });

    // A unit in use keeps its meaning: the factor is locked.
    await baseRow.getByRole('button', { name: `Edit ${base}` }).click();
    await expect(page.getByRole('note')).toContainText(/locked/);
    await page.getByRole('button', { name: 'Cancel' }).click();

    // The multiple is unused: deleting asks first, in place, and "Keep it" changes nothing.
    await multipleRow.getByRole('button', { name: `Delete unit ${multiple}` }).click();
    await multipleRow.getByRole('button', { name: 'Keep it' }).click();
    await expect(
      multipleRow.getByRole('button', { name: `Delete unit ${multiple}` }),
    ).toBeVisible();
    await clickUntilVisible(
      multipleRow.getByRole('button', { name: `Delete unit ${multiple}` }),
      multipleRow.getByRole('button', { name: `Confirm: Delete unit ${multiple}` }),
    );
    await multipleRow.getByRole('button', { name: `Confirm: Delete unit ${multiple}` }).click();
    await expect(page.getByText(`${multiple} deleted.`)).toBeVisible({ timeout: 30_000 });

    // Now the base is free to go too.
    await expect(baseRow.getByRole('button', { name: `Delete unit ${base}` })).toBeVisible({
      timeout: 30_000,
    });
    await clickUntilVisible(
      baseRow.getByRole('button', { name: `Delete unit ${base}` }),
      baseRow.getByRole('button', { name: `Confirm: Delete unit ${base}` }),
    );
    await baseRow.getByRole('button', { name: `Confirm: Delete unit ${base}` }).click();
    await expect(page.getByText(`${base} deleted.`)).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });

  test('a product is counted in a unit and keeps alternate units beside it', async ({
    page,
  }, testInfo) => {
    const tag = suffix(testInfo.project.name);
    const crate = `E2ECR${tag}`;
    // Each project edits its own product: the two share one database, and what is saved stays saved.
    const productName = testInfo.project.name === 'phone' ? 'Sugar 1kg' : 'Salt 500g';
    await open(page, '/admin/settings/units', 'Units of measure');
    await page.getByRole('button', { name: 'New unit' }).click();
    const form = page.getByRole('form', { name: 'New unit of measure' });
    await form.getByLabel('Code', { exact: true }).fill(crate);
    await form.getByLabel('Name', { exact: true }).fill(`E2E crate ${tag}`);
    await pick(page, form.getByRole('combobox', { name: 'Kind' }), 'Packaging', /Packaging/);
    await expect(form.getByText(/set on the product/)).toBeVisible();
    await form.getByRole('button', { name: 'Create unit' }).click();
    await expect(page.getByText(`${crate} created.`)).toBeVisible({ timeout: 30_000 });

    await open(page, '/admin/products', /Products|Catalog/);
    await page.getByText(productName, { exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Stock' }).click();

    // The product is counted in the default unit, picked from the shared list.
    const unit = dialog.getByRole('combobox', { name: /Unit of measure/ });
    await expect(unit).toHaveValue(/PCS/, { timeout: 30_000 });
    await expect(dialog.getByText(/Shipping Weight per PCS/)).toBeVisible();

    // An alternate unit: 1 crate = 12 pieces.
    await dialog.getByRole('button', { name: 'Add a unit' }).click();
    const row = dialog.getByRole('group', { name: 'Alternate unit 1' });
    await pick(page, row.getByRole('combobox', { name: 'Unit' }), crate, new RegExp(crate));
    await row.getByLabel(/= how many PCS/).fill('12');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // It is there when the product is opened again.
    await page.getByText(productName, { exact: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stock' }).click();
    const again = page.getByRole('dialog').getByRole('group', { name: 'Alternate unit 1' });
    await expect(again.getByLabel(/= how many PCS/)).toHaveValue('12', { timeout: 30_000 });

    // The unit is now used by a product, so it cannot be deleted.
    await page.keyboard.press('Escape');
    await open(page, '/admin/settings/units', 'Units of measure');
    await page.getByLabel('Search units').fill(crate);
    const crateRow = page.getByRole('listitem').filter({ hasText: `E2E crate ${tag}` });
    await expect(crateRow.getByText(/Used by 1 product packaging/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(crateRow.getByRole('button', { name: `Delete unit ${crate}` })).toHaveCount(0);
  });
});

test.describe('fish sold by the kilogram', () => {
  test('stock is counted in decimals, and a quote line can be typed in crates', async ({
    page,
  }, testInfo) => {
    const tag = suffix(testInfo.project.name);
    const crate = `E2EFC${tag}`;
    const fish = testInfo.project.name === 'phone' ? 'Fish kg Phone' : 'Fish kg Desktop';

    // A crate that holds 20 kg.
    await open(page, '/admin/settings/units', 'Units of measure');
    await page.getByRole('button', { name: 'New unit' }).click();
    const form = page.getByRole('form', { name: 'New unit of measure' });
    await form.getByLabel('Code', { exact: true }).fill(crate);
    await form.getByLabel('Name', { exact: true }).fill(`E2E fish crate ${tag}`);
    await pick(page, form.getByRole('combobox', { name: 'Kind' }), 'Packaging', /Packaging/);
    await form.getByRole('button', { name: 'Create unit' }).click();
    await expect(page.getByText(`${crate} created.`)).toBeVisible({ timeout: 30_000 });

    // The fish is counted in kg, so its stock takes decimals; a product counted in pieces takes whole numbers only.
    await open(page, '/admin/products', /Products|Catalog/);
    await page.getByText('Rice 5kg', { exact: true }).first().click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Stock' }).click();
    const stockField = (d: typeof dialog) =>
      d
        .locator('label', { hasText: /^On-Hand Stock/ })
        .locator('xpath=..')
        .locator('input');
    await expect(stockField(dialog)).toHaveAttribute('step', '1', { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await page.getByText(fish, { exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Stock' }).click();
    await expect(dialog.getByRole('combobox', { name: /Unit of measure/ })).toHaveValue(/KG/, {
      timeout: 30_000,
    });
    await expect(dialog.getByText(/Shipping Weight per KG/)).toBeVisible();
    await expect(stockField(dialog)).toHaveAttribute('step', '0.001');
    await stockField(dialog).fill('12.5');
    await dialog.getByRole('button', { name: 'Add a unit' }).click();
    const row = dialog.getByRole('group', { name: 'Alternate unit 1' });
    await pick(page, row.getByRole('combobox', { name: 'Unit' }), crate, new RegExp(crate));
    await row.getByLabel(/= how many KG/).fill('20');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await page.getByText(fish, { exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Stock' }).click();
    await expect(stockField(dialog)).toHaveValue('12.5', { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // A quote line is typed in crates: the price is for one crate, the quantity is crates.
    const quote = await openNewQuote(page);
    const search = quote.getByRole('combobox', { name: /Quick add/ });
    await search.fill(fish);
    await quote
      .getByRole('option', { name: new RegExp(fish) })
      .first()
      .click();
    await quote.getByRole('button', { name: 'Add', exact: true }).click();
    const unit = quote.getByRole('combobox', { name: `Unit of ${fish}` });
    await expect(unit).toHaveValue(/KG/, { timeout: 30_000 });
    await pick(page, unit, crate, new RegExp(crate));
    await expect(quote.getByLabel(`Unit price of ${fish}`)).toHaveValue('6000', {
      timeout: 30_000,
    });
    await quote.getByRole('spinbutton', { name: `Quantity of ${fish}` }).fill('2');
    await saveQuote(page, quote, `Crate buyer ${tag}`);

    const again = await openQuoteOf(page, `Crate buyer ${tag}`);
    await expect(again.getByRole('combobox', { name: `Unit of ${fish}` })).toHaveValue(
      new RegExp(crate),
      { timeout: 30_000 },
    );
    await expect(again.getByRole('spinbutton', { name: `Quantity of ${fish}` })).toHaveValue('2');
    await expect(again.getByLabel(`Unit price of ${fish}`)).toHaveValue('6000');
  });
});
