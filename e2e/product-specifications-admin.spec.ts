import { expect, test } from '@playwright/test';
import { clickUntilVisible, open } from './support/page';
import { attemptTag } from './support/vendors';

test.describe('editing product specifications', () => {
  test('edits existing specification names and values and keeps them after reopening', async ({
    page,
  }, testInfo) => {
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const productName = testInfo.project.name === 'phone' ? 'Sugar 1kg' : 'Salt 500g';
    const originalName = `E2E spec ${tag}`;
    const editedName = `${originalName} edited`;
    const editedValue = `Updated value ${tag}`;

    await open(page, '/admin/products', /Products|Catalog/);
    const dialog = page.getByRole('dialog');
    await clickUntilVisible(page.getByText(productName, { exact: true }).first(), dialog);
    await expect(dialog.getByRole('combobox', { name: 'Business classification' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stock behaviour' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Stock behaviour' }).click();
    await expect(dialog.getByRole('combobox', { name: 'How should qsell manage this product?' })).toBeVisible();
    await expect(dialog.getByText(/You can change inventory treatment only while the product has no stock or business-document history/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Specs' }).click();

    const specificationNames = dialog.getByRole('textbox', { name: /^Specification name / });
    const startingCount = await specificationNames.count();
    await dialog.getByPlaceholder('Attribute (e.g. RAM)').fill(originalName);
    await dialog.getByPlaceholder('Value (e.g. 16GB)').fill('Original value');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(specificationNames).toHaveCount(startingCount + 1);
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await clickUntilVisible(page.getByText(productName, { exact: true }).first(), dialog);
    await dialog.getByRole('button', { name: 'Specs' }).click();
    await specificationNames.last().fill(editedName);
    await dialog
      .getByRole('textbox', { name: /^Specification value / })
      .last()
      .fill(editedValue);
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await clickUntilVisible(page.getByText(productName, { exact: true }).first(), dialog);
    await dialog.getByRole('button', { name: 'Specs' }).click();
    await expect(specificationNames.last()).toHaveValue(editedName);
    await expect(dialog.getByRole('textbox', { name: /^Specification value / }).last()).toHaveValue(
      editedValue,
    );

    await dialog.getByRole('button', { name: `Remove ${editedName}` }).click();
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });

  test('puts specifications in the order chosen by the buttons and by dragging, and keeps it after saving', async ({ page }, testInfo) => {
    const tag = attemptTag(testInfo.project.name, testInfo.retry);
    const productName = testInfo.project.name === 'phone' ? 'Sugar 1kg' : 'Salt 500g';
    const first = `E2E order A ${tag}`;
    const second = `E2E order B ${tag}`;
    const third = `E2E order C ${tag}`;

    await open(page, '/admin/products', /Products|Catalog/);
    const dialog = page.getByRole('dialog');
    await clickUntilVisible(page.getByText(productName, { exact: true }).first(), dialog);
    await dialog.getByRole('button', { name: 'Specs' }).click();
    const names = dialog.getByRole('textbox', { name: /^Specification name / });
    for (const name of [first, second, third]) {
      await dialog.getByPlaceholder('Attribute (e.g. RAM)').fill(name);
      await dialog.getByPlaceholder('Value (e.g. 16GB)').fill('x');
      await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    }
    const mine = async () => (await names.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).filter((v) => v.startsWith('E2E order '));
    expect(await mine()).toEqual([first, second, third]);

    // The ends cannot move off the list.
    await expect(dialog.getByRole('button', { name: `Move ${third} down` })).toBeDisabled();
    // Buttons: C up twice puts it first, and the keyboard stays on the button it used.
    await dialog.getByRole('button', { name: `Move ${third} up` }).click();
    await expect(dialog.getByRole('button', { name: `Move ${third} up` })).toBeFocused();
    await dialog.getByRole('button', { name: `Move ${third} up` }).click();
    expect(await mine()).toEqual([third, first, second]);
    await expect(dialog.getByRole('button', { name: `Move ${third} up` })).toBeDisabled();
    await expect(dialog.getByRole('status')).toContainText(`${third} moved to position`);

    // Drag (mouse): the last of the three onto the first.
    if (testInfo.project.name === 'desktop') {
      const rows = dialog.getByRole('list', { name: /^Specifications/ }).getByRole('listitem');
      const all = await names.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
      await rows.nth(all.indexOf(second)).getByTitle('Drag to reorder').dragTo(rows.nth(all.indexOf(third)));
      expect(await mine()).toEqual([second, third, first]);
    }

    const before = await mine();
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await clickUntilVisible(page.getByText(productName, { exact: true }).first(), dialog);
    await dialog.getByRole('button', { name: 'Specs' }).click();
    expect(await mine()).toEqual(before);

    for (const name of before) await dialog.getByRole('button', { name: `Remove ${name}` }).click();
    await dialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });
});
