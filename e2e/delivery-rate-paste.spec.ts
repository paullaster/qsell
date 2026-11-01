import { expect, test, type Locator, type Page } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';

/** Brings a button to the middle of the screen first; on a phone the development badge covers the bottom corner. */
async function press(button: Locator): Promise<void> {
  await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await button.click();
}

async function makeZone(page: Page, code: string, name: string): Promise<void> {
  await open(page, '/admin/delivery/zones', 'Delivery zones');
  await page.getByRole('button', { name: 'New zone' }).click();
  const form = page.getByRole('form', { name: 'New delivery zone' });
  await form.getByLabel('Code').fill(code);
  await form.getByLabel('Name').fill(name);
  await form.getByRole('button', { name: 'Add zone' }).click();
  await expect(page.getByText(`${code} added.`)).toBeVisible({ timeout: 30_000 });
}

test.describe('pasting a rate card', () => {
  test('a card pasted from a spreadsheet is read, its mistakes named, its zones matched, and used only when sound', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    const cbd = `RC${tag}`;
    await makeZone(page, cbd, `Town ${tag}`);

    await open(page, '/admin/delivery/charges', 'Delivery charges');
    await noNativeSelect(page);
    await page.getByRole('button', { name: 'New policy' }).click();
    const form = page.getByRole('form', { name: 'New charge policy' });
    await form.getByLabel('Code').fill(`RP${tag}`);
    await form.getByLabel('Name', { exact: true }).fill(`Pasted ${tag}`);
    await form.getByRole('radio', { name: /By zone/ }).check();

    await press(form.getByRole('button', { name: 'Paste a rate card' }));
    const paste = form.getByRole('group', { name: 'Paste a rate card' });
    await expect(paste.getByRole('button', { name: 'Use these fees' })).toBeDisabled();

    // Mistakes are named by line and nothing is used; a zone nobody has is named too.
    const header = 'Zone\tFrom kg\tUp to kg\tFee\tEach extra kg';
    await paste.getByLabel('Rate card').fill([header, `${cbd}\t0\t5\t250`, `${cbd}\t5\t3\t350`, `GHOST-${tag}\t0\t\t900`, `${cbd}\t5\t\tabc`].join('\n'));
    await press(paste.getByRole('button', { name: 'Read it' }));
    const found = paste.getByText(/fees? read/);
    await expect(found).toContainText('2 fees read, 2 lines with a mistake');
    await expect(paste.getByRole('list', { name: 'Lines with a mistake' })).toContainText('Line 3');
    await expect(paste.getByRole('list', { name: 'Lines with a mistake' })).toContainText('Line 5');
    await expect(paste).toContainText(`No zone has the code GHOST-${tag}`);
    await expect(paste.getByRole('button', { name: /^Use these/ })).toBeDisabled();
    await noHorizontalScroll(page);
    await noInnerHorizontalScroll(page);

    // Corrected, with a thousands mark in a spreadsheet copy and a fee for any other zone.
    await paste.getByLabel('Rate card').fill([header, `${cbd.toLowerCase()}\t0\t5\t250`, `${cbd}\t5\t\t1,250.50\t40`, '*\t0\t\t900'].join('\n'));
    await expect(paste.getByRole('button', { name: /^Use these/ })).toBeDisabled();
    await press(paste.getByRole('button', { name: 'Read it' }));
    await expect(paste.getByText(/fees? read/)).toContainText('3 fees read.');
    await press(paste.getByRole('button', { name: 'Use these 3 fees' }));
    await expect(page.getByText('The card now has 3 fees.')).toBeVisible();

    const fees = form.getByRole('list', { name: 'Fees' }).getByRole('listitem');
    await expect(fees).toHaveCount(3);
    await expect(fees.nth(0).getByLabel('Fee', { exact: true })).toHaveValue('250');
    await expect(fees.nth(1).getByLabel('Fee', { exact: true })).toHaveValue('1250.50');
    await expect(fees.nth(1).getByLabel('Each extra kg')).toHaveValue('40');
    await expect(fees.nth(1).getByLabel('Up to kg')).toHaveValue('');
    await expect(fees.nth(0).getByRole('combobox', { name: 'Zone' })).toHaveValue(`Town ${tag} (${cbd})`);
    await expect(fees.nth(2).getByRole('combobox', { name: 'Zone' })).toHaveValue('');

    // More can be added to the card without losing what is there.
    await press(form.getByRole('button', { name: 'Paste a rate card' }));
    await paste.getByLabel('Rate card').fill(`${cbd};10;20;300`);
    await paste.getByRole('radio', { name: 'Add to the fees' }).check({ force: true });
    await press(paste.getByRole('button', { name: 'Read it' }));
    await press(paste.getByRole('button', { name: 'Use these 1 fee' }));
    await expect(page.getByText('Added 1 fee.')).toBeVisible();
    await expect(fees).toHaveCount(4);

    // The pasted card saves as a draft, and the words of the rules still guard it (weights must run on without gaps).
    await form.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible({ timeout: 30_000 });
  });
});
