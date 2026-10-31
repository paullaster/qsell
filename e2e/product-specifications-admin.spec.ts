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
});
