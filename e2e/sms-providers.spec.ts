import { expect, test } from '@playwright/test';
import { noHorizontalScroll, noInnerHorizontalScroll, noNativeSelect, open } from './support/page';
import { pick } from './support/quotes';

const KEY = 'e2e-sms-key-ZXCVBNMASDFGHJKL-1234';

test.describe('SMS providers', () => {
  test('a provider is connected from the settings with its key kept secret, tested, made the default, stopped and started', async ({ page }, testInfo) => {
    test.slow();
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;

    // It is on the settings hub, and the screen has no native select and no sideways scroll.
    await open(page, '/admin/settings', /Settings/);
    await expect(page.getByRole('link', { name: /SMS Providers/ }).first()).toBeVisible({ timeout: 30_000 });
    await open(page, '/admin/settings/sms', 'SMS providers');
    await noNativeSelect(page);
    await noHorizontalScroll(page);

    // The form is drawn from the provider chosen: nothing to fill in until one is.
    const form = page.getByRole('form', { name: 'Add an SMS provider' });
    await expect(form.getByRole('button', { name: 'Add the connection' })).toBeDisabled();
    await pick(page, form.getByRole('combobox', { name: 'Provider' }), 'Africa', /Africa/);
    await expect(form.getByLabel('Username')).toBeVisible();
    await expect(form.getByLabel('API key')).toHaveAttribute('type', 'password');
    await form.getByLabel('Name', { exact: true }).fill(`Real ${tag}`);
    await form.getByLabel('Username').fill('e2eshop');
    await form.getByLabel('API key').fill(KEY);
    await form.getByLabel(/Sender name/).fill('two words');
    await form.getByRole('button', { name: 'Add the connection' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /Sender name/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('list', { name: 'SMS connection list' })).not.toContainText(`Real ${tag}`);
    await form.getByLabel(/Sender name/).fill('E2ESHOP');
    await form.getByRole('button', { name: 'Add the connection' }).click();
    await expect(page.getByRole('status').filter({ hasText: /The connection is added/ })).toBeVisible({ timeout: 30_000 });
    await noInnerHorizontalScroll(page);

    // The key is never put back on the screen, not in the list and not when the connection is opened to change it.
    const list = page.getByRole('list', { name: 'SMS connection list' });
    const real = list.getByRole('listitem').filter({ hasText: `Real ${tag}` });
    await expect(real).toContainText('In use');
    await expect(real).toContainText('Not tested yet');
    await real.getByRole('button', { name: `Change Real ${tag}` }).click();
    await expect(real.getByLabel(/API key/)).toHaveValue('');
    await expect(real.getByLabel(/API key/)).toHaveAttribute('placeholder', /saved/);
    expect(await page.content()).not.toContain(KEY);
    await real.getByLabel('Username').fill('e2eshop2');
    await real.getByRole('button', { name: 'Save the connection' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The connection is saved' })).toBeVisible({ timeout: 30_000 });

    // A trial connection that sends nothing: no key to type, tested with a fixed message, made the default.
    await pick(page, form.getByRole('combobox', { name: 'Provider' }), 'server log', /server log/);
    await expect(form.getByLabel('API key')).toHaveCount(0);
    await form.getByLabel('Name', { exact: true }).fill(`Trial ${tag}`);
    await form.getByRole('button', { name: 'Add the connection' }).click();
    await expect(page.getByRole('status').filter({ hasText: /The connection is added/ })).toBeVisible({ timeout: 30_000 });
    const trial = list.getByRole('listitem').filter({ hasText: `Trial ${tag}` });
    await trial.getByRole('button', { name: 'Make this the default' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Messages now go through this connection.' })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('listitem').filter({ hasText: `Trial ${tag}` })).toContainText('Default: messages go through this');
    await expect(list.getByRole('listitem').filter({ hasText: `Real ${tag}` })).not.toContainText('Default: messages go through this');

    await expect(trial.getByRole('button', { name: 'Send the test' })).toBeDisabled();
    await trial.getByLabel('Send a test message to').fill('abc');
    await trial.getByRole('button', { name: 'Send the test' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /mobile phone number/ })).toBeVisible({ timeout: 30_000 });
    await trial.getByLabel('Send a test message to').fill('0712 345 678');
    await trial.getByRole('button', { name: 'Send the test' }).click();
    await expect(page.getByRole('status').filter({ hasText: /test message was accepted/ })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('listitem').filter({ hasText: `Trial ${tag}` })).toContainText('Test message accepted by the provider');
    await noHorizontalScroll(page);

    // Stopping the default leaves no sender and says so; it can be started again and chosen again.
    const again = list.getByRole('listitem').filter({ hasText: `Trial ${tag}` });
    await again.getByRole('button', { name: `Stop using Trial ${tag}` }).click();
    await again.getByRole('button', { name: `Confirm: Stop using Trial ${tag}` }).click();
    await expect(page.getByRole('status').filter({ hasText: /No connection is the default/ })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByRole('listitem').filter({ hasText: `Trial ${tag}` })).toContainText('Stopped');
    await expect(list.getByRole('listitem').filter({ hasText: `Trial ${tag}` }).getByRole('button', { name: 'Send the test' })).toHaveCount(0);
    await list.getByRole('listitem').filter({ hasText: `Trial ${tag}` }).getByRole('button', { name: 'Use it again' }).click();
    await expect(list.getByRole('listitem').filter({ hasText: `Trial ${tag}` })).toContainText('In use', { timeout: 30_000 });
    await noInnerHorizontalScroll(page);
  });

  test('a name already used is refused in words', async ({ page }, testInfo) => {
    const tag = `${testInfo.project.name === 'phone' ? 'P' : 'D'}${String(Date.now()).slice(-6)}`;
    await open(page, '/admin/settings/sms', 'SMS providers');
    const form = page.getByRole('form', { name: 'Add an SMS provider' });
    for (const [name, expectOk] of [[`Same ${tag}`, true], [`same ${tag}`, false]] as const) {
      await pick(page, form.getByRole('combobox', { name: 'Provider' }), 'server log', /server log/);
      await form.getByLabel('Name', { exact: true }).fill(name);
      await form.getByRole('button', { name: 'Add the connection' }).click();
      if (expectOk) await expect(page.getByRole('status').filter({ hasText: /The connection is added/ })).toBeVisible({ timeout: 30_000 });
      else await expect(page.getByRole('alert').filter({ hasText: /already an SMS connection/ })).toBeVisible({ timeout: 30_000 });
    }
  });
});
