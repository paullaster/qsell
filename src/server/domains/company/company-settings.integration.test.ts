import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContainer } from '@/server/di/container';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import { appearancePayload, moduleLabelsPayload, profileFormFrom, profilePayload } from '@/lib/company-forms';
import { toPublicCompany } from '@/lib/company-view';
import { resolveCompanyUiConfig, resolveSupportConfig } from '@/config/company-ui';

/**
 * Company setup against a real database: the profile is saved from the checked form (empty boxes clear the
 * optional parts), each part of the stored look changes on its own without touching the others, and the
 * public view never carries the bank details.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('company setup (database)', () => {
  let c: AppContainer;
  let original: CompanySettingsRow;

  beforeAll(async () => {
    c = (await import('@/server/di/container')).getContainer();
    original = await c.companySettings.ensureSeeded();
  });

  afterAll(async () => {
    // The company row is shared by every test: put back what was there.
    const { id: _id, createdAt: _created, updatedAt: _updated, ...rest } = original;
    await c.companySettings.update(rest);
  });

  it('saves the profile from the checked form, and an empty optional box clears what was there', async () => {
    const form = { ...profileFormFrom(original), legalName: 'Setup Test Ltd', tradingName: 'Setup Test', email: 'Hello@Setup.TEST', phone: '+254 711 000 111', kraPin: 'p012345678q', invoicePrefix: 'stp', streetAddress: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', postalCode: '00100', country: 'Kenya', bankName: 'Test Bank', bankAccountNumber: '12345', tagline: 'Hello' };
    const checked = profilePayload(form);
    if (!checked.ok) throw new Error(checked.error);
    const saved = await c.companySettings.update(checked.payload);
    expect(saved).toMatchObject({ legalName: 'Setup Test Ltd', email: 'hello@setup.test', kraPin: 'P012345678Q', invoicePrefix: 'STP', bankName: 'Test Bank', tagline: 'Hello' });

    const cleared = profilePayload({ ...form, bankName: '', bankAccountNumber: '', tagline: '  ' });
    if (!cleared.ok) throw new Error(cleared.error);
    const after = await c.companySettings.update(cleared.payload);
    expect(after).toMatchObject({ bankName: null, bankAccountNumber: null, tagline: null, legalName: 'Setup Test Ltd' });
  });

  it('changes one part of the stored look without touching the others, even when saved one after the other', async () => {
    await c.companySettings.setUiConfigSection('support', resolveSupportConfig({ name: 'Help desk', channels: [{ id: 'a', kind: 'phone', label: 'Call', value: '0700 000 000', detail: '', url: '' }] }));
    const look = appearancePayload({ primaryColor: '#112233', accentColor: '#aabbcc', desktopColumns: 3 });
    if (!look.ok) throw new Error(look.error);
    await c.companySettings.update({ primaryColor: look.payload.primaryColor, accentColor: look.payload.accentColor });
    await c.companySettings.setUiConfigSection('productGrid', { desktopColumns: look.payload.desktopColumns });
    const labels = moduleLabelsPayload({ sales: ' Selling ', nope: 'x' }, ['sales', 'orders']);
    if (!labels.ok) throw new Error(labels.error);
    const row = await c.companySettings.setUiConfigSection('moduleLabels', labels.payload);

    const ui = resolveCompanyUiConfig(row.uiConfig);
    expect(ui.productGrid.desktopColumns).toBe(3);
    expect(ui.moduleLabels).toEqual({ sales: 'Selling' });
    expect(ui.support.name).toBe('Help desk');
    expect(ui.support.channels).toHaveLength(1);
    expect(row).toMatchObject({ primaryColor: '#112233', accentColor: '#aabbcc' });
  });

  it('keeps the bank details out of what visitors are told', async () => {
    const row = await c.companySettings.update({ bankName: 'Secret Bank', bankAccountName: 'Acme', bankAccountNumber: '999', bankBranch: 'Main' });
    const view = toPublicCompany(row);
    expect(JSON.stringify(view)).not.toMatch(/Secret Bank|"999"|bankName|bankAccountNumber|bankBranch|bankAccountName/);
    expect(view.tradingName).toBe(row.tradingName);
  });
});
