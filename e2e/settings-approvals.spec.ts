import { expect, test } from '@playwright/test';
import { pick } from './support/quotes';
import { clickUntilVisible, noHorizontalScroll, noNativeSelect, open } from './support/page';

test.describe('approvals', () => {
  test('approvers: a person gets limits through pickers, and a group is made with members from the server list', async ({ page }, testInfo) => {
    await open(page, '/admin/settings/approvals/approvers', 'Approvers');
    await noNativeSelect(page);
    await noHorizontalScroll(page);
    const people = page.getByRole('list', { name: 'Staff' });
    await expect(people.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });

    const first = people.getByRole('listitem').first();
    const form = page.getByRole('form', { name: /^Approver settings for / });
    await clickUntilVisible(first.getByRole('button', { name: /^(Set up|Edit) / }), form);
    await noNativeSelect(page);
    await form.getByRole('combobox', { name: 'Authority for Sales orders' }).click();
    await expect(page.getByRole('option', { name: 'Up to…' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('option', { name: 'Up to…' }).click();
    await expect(form.getByRole('button', { name: 'Save' })).toBeDisabled();
    await pick(page, form.getByRole('combobox', { name: 'Reason' }), '', /./);
    await form.getByLabel('Amount for Sales orders (KES)').fill('250000');
    // The only staff account is this one, so there is nobody else to offer: the list says so.
    await form.getByRole('combobox', { name: 'Their approver (next level up)' }).click();
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await noHorizontalScroll(page);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 30_000 });
    await expect(people.getByText(/Sales orders: up to KES 250,000/).first()).toBeVisible({ timeout: 30_000 });

    // A group, with a member chosen from the server's list.
    const code = `G${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await clickUntilVisible(page.getByRole('tab', { name: 'Groups' }), page.getByRole('button', { name: 'New group' }));
    const group = page.getByRole('form', { name: 'New group' });
    await clickUntilVisible(page.getByRole('button', { name: 'New group' }), group);
    await group.getByLabel('Name').fill(`E2E ${code}`);
    await group.getByLabel('Code').fill(code);
    await pick(page, group.getByRole('combobox', { name: 'Add a member' }), '', /./);
    await group.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(group.getByRole('list').getByRole('listitem')).toHaveCount(1);
    await pick(page, group.getByRole('combobox', { name: 'Reason' }), '', /./);
    await group.getByRole('button', { name: 'Save group' }).click();
    await expect(page.getByText('Group created.')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Search groups').fill(code);
    await expect(page.getByRole('list', { name: 'Approver groups' }).getByText(`E2E ${code}`)).toBeVisible({ timeout: 30_000 });
  });

  test('workflows: one is made, designed with pickers, tried on an example, saved, published and retired', async ({ page }, testInfo) => {
    const code = `WF${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/settings/approvals/workflows', 'Approval workflows');
    await noNativeSelect(page);
    const form = page.getByRole('form', { name: 'New workflow' });
    await clickUntilVisible(page.getByRole('button', { name: 'New workflow' }), form);
    await form.getByLabel('Name').fill(`E2E ${code}`);
    await form.getByLabel('Code').fill(code);
    await form.getByRole('button', { name: 'Create and design' }).click();
    await expect(page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: /when approval is asked/i })).toBeVisible();
    await pick(page, form.getByRole('combobox', { name: 'When is approval asked for?' }), 'Sales order', /Sales order submitted/);
    await form.getByRole('button', { name: 'Create and design' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`E2E ${code}`), level: 2 })).toBeVisible({ timeout: 30_000 });
    await noNativeSelect(page);

    // A condition that never matches real orders, built from the situation's own fields.
    await page.getByRole('button', { name: 'Add a condition' }).first().click();
    const when = page.getByRole('group', { name: 'When this workflow applies' });
    await when.getByRole('combobox', { name: 'Field' }).click();
    await expect(page.getByRole('option', { name: /Amount/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('option', { name: /Amount/ }).click();
    await when.getByRole('combobox', { name: 'Comparison' }).click();
    await expect(page.getByRole('option', { name: 'is more than' })).toBeVisible();
    await page.getByRole('option', { name: 'is more than' }).click();
    await when.getByLabel('Value').fill('999999999');
    await noNativeSelect(page);

    // A step approved by a specific person.
    await page.getByRole('button', { name: 'Add a step' }).click();
    const step = page.getByRole('group', { name: /^Step 1/ });
    await pick(page, step.getByRole('combobox', { name: 'Who approves' }), 'specific', /A specific person/);
    await pick(page, step.getByRole('combobox', { name: 'Person' }), '', /./);
    await noHorizontalScroll(page);

    // Try it: who would be asked.
    const trial = page.getByRole('region', { name: 'Try it on an example' }).or(page.locator('section').filter({ hasText: 'Try it on an example' }));
    await expect(trial.getByRole('button', { name: 'Test' })).toBeDisabled();
    await pick(page, trial.getByRole('combobox', { name: 'Requested by' }), '', /./);
    await trial.getByRole('button', { name: 'Test' }).click();
    await expect(trial.getByText(/does not apply|applies/).first()).toBeVisible({ timeout: 30_000 });

    // Save as a draft, then publish with a reason, then retire.
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft saved. It is not live until you publish it.')).toBeVisible({ timeout: 30_000 });
    const publish = page.getByRole('button', { name: 'Save and publish' });
    await expect(publish).toBeDisabled();
    await pick(page, page.getByRole('combobox', { name: 'Reason' }).last(), '', /./);
    await publish.click();
    await expect(page.getByText(/Published as version 1/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Retire' })).toBeDisabled();
    await pick(page, page.getByRole('combobox', { name: 'Reason' }).last(), '', /./);
    await page.getByRole('button', { name: 'Retire' }).click();
    await expect(page.getByText('Retired.')).toBeVisible({ timeout: 30_000 });

    // Back in the list, found by search.
    await page.getByRole('link', { name: 'All workflows' }).click();
    await page.getByLabel('Search workflows').fill(code);
    await expect(page.getByRole('list', { name: 'Workflows' }).getByText(`E2E ${code}`)).toBeVisible({ timeout: 30_000 });
  });

  test('switches and the monitor open with pickers and no native dropdowns', async ({ page }) => {
    await open(page, '/admin/settings/approvals/switches', 'Approval switches');
    await noNativeSelect(page);
    const exception = page.getByRole('form', { name: 'New branch exception' });
    await expect(exception.getByRole('button', { name: 'Set exception…' })).toBeDisabled();
    await pick(page, exception.getByRole('combobox', { name: 'Branch' }), '', /./);
    await exception.getByRole('combobox', { name: 'Applies to' }).click();
    await expect(page.getByRole('option', { name: /All of/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('option', { name: /All of/ }).first().click();
    await exception.getByRole('button', { name: 'Set exception…' }).click();
    const confirm = page.getByRole('form', { name: 'Confirm switch change' });
    await expect(confirm.getByText(/Turn approvals off for all of/)).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await noHorizontalScroll(page);

    await open(page, '/admin/settings/approvals/monitor', 'Approval monitor');
    await noNativeSelect(page);
    await expect(page.getByText(/\d+ waiting · \d+ overdue/)).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Overdue only').check();
    await expect(page.getByText(/Nothing is overdue|Waiting on|Loading/).first()).toBeVisible({ timeout: 30_000 });
    await noHorizontalScroll(page);
  });
});
