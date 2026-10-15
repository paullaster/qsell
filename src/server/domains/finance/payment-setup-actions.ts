'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import type { PaymentProviderCode, PaymentProviderEnvironment } from '@/server/domains/payments/types';
import { run } from './action-runner';

const fin = () => getContainer().finance;
const PAGE = '/admin/settings/payments';

/**
 * Everything on Settings → Payments: the providers (company-wide connections with the shared
 * credentials) and, under each, the payment methods that go through it, with what is needed to
 * create one (branches, bank accounts, G/L accounts).
 */
export async function paymentSetupAction() {
  return await run('payment_providers:read', { surface: 'settings/payments', action: 'view' }, async (ctx) => {
    const c = getContainer();
    const company = await c.companySettings.ensureSeeded();
    await c.organizations.ensureDefaultOrgAndBranch(company.id, company.tradingName === '' ? company.legalName : company.tradingName);
    const canMethods = await canPermission('payment_methods:read');
    const [providers, settings, methods] = await Promise.all([
      fin().paymentProviders.list(ctx.companyId, company.publicBaseUrl ?? null),
      fin().setup.getSettings(ctx.companyId),
      canMethods ? fin().paymentMethods.list(ctx.companyId) : Promise.resolve([]),
    ]);
    // The last few requests made to each M-Pesa provider, for the panel under it (one small query each).
    const canActivity = await canPermission('payment_activity:read');
    const recentRequests = Object.fromEntries(
      await Promise.all(
        providers
          .filter((p) => p.daraja !== null && canActivity)
          .map(async (p) => {
            const rows = await c.paymentEngine.activity.operations(ctx.companyId, { providerId: p.id, limit: 15 });
            return [p.id, rows.map((r) => ({ id: r.op.id, operation: r.op.operation, status: r.op.status, failureReason: r.op.failureReason, at: r.op.createdAt.toISOString() }))] as const;
          }),
      ),
    );
    return {
      recentRequests,
      financeSetUp: settings !== null,
      publicBaseUrl: company.publicBaseUrl ?? null,
      providers: providers.map((p) => ({
        ...p,
        methods: canMethods ? p.methods : [],
      })),
      methods: methods.map((r) => ({
        id: r.method.id,
        code: r.method.code,
        name: r.method.name,
        kind: r.method.kind,
        providerId: r.method.providerId,
        branchId: r.method.branchId,
        branchName: r.branchName,
        bankAccountId: r.method.balancingBankAccountId,
        bankLabel: `${r.bankCode} — ${r.bankName}`,
        bankBlocked: r.bankBlocked,
        glAccountId: r.method.glAccountId,
        glLabel: `${r.glNo} ${r.glName}`,
        channelKind: r.method.channelKind,
        channelNumber: r.method.channelNumber,
        requiresReference: r.method.requiresReference,
        requiresEvidence: r.method.requiresEvidence,
        requiresCounterparty: r.method.requiresCounterparty,
        usableFor: r.method.usableFor,
        limits: r.method.limits,
        refundDestination: r.method.refundDestination,
        legacyCodes: r.method.legacyCodes,
        enabled: r.method.enabled,
        sortOrder: r.method.sortOrder,
      })),
      can: {
        createProvider: await canPermission('payment_providers:create'),
        editProvider: await canPermission('payment_providers:edit'),
        setCredentials: await canPermission('payment_providers:set_credentials'),
        enable: await canPermission('payment_providers:enable'),
        test: await canPermission('payment_providers:test'),
        runOperations: await canPermission('payment_operations:run'),
        requestPayout: await canPermission('payment_operations:request_payout'),
        deleteProvider: await canPermission('payment_providers:delete'),
        readMethods: canMethods,
        createMethod: await canPermission('payment_methods:create'),
        editMethod: await canPermission('payment_methods:edit'),
        disableMethod: await canPermission('payment_methods:disable'),
        deleteMethod: await canPermission('payment_methods:delete'),
        seed: await canPermission('payment_setup:seed'),
        linkOrders: await canPermission('payment_setup:link_orders'),
      },
    };
  });
}

export async function createProviderAction(input: { providerCode: PaymentProviderCode; displayName?: string; environment?: PaymentProviderEnvironment }) {
  return await run('payment_providers:create', { surface: 'settings/payments', action: 'create_provider' }, async (ctx) => await fin().paymentProviders.create(ctx, input), [PAGE]);
}

export async function saveProviderAction(input: { id: string; displayName?: string; environment?: PaymentProviderEnvironment; apiBaseUrl?: string }) {
  return await run('payment_providers:edit', { surface: 'settings/payments', action: 'save_provider' }, async (ctx) => {
    const { id, ...rest } = input;
    await fin().paymentProviders.update(ctx, id, rest);
  }, [PAGE]);
}

export async function setProviderCredentialsAction(id: string, credentials: Record<string, string>) {
  return await run('payment_providers:set_credentials', { surface: 'settings/payments', action: 'set_credentials' }, async (ctx) => await fin().paymentProviders.setCredentials(ctx, id, credentials), [PAGE]);
}

export async function setProviderEnabledAction(id: string, enabled: boolean) {
  return await run('payment_providers:enable', { surface: 'settings/payments', action: enabled ? 'enable_provider' : 'disable_provider' }, async (ctx) => await fin().paymentProviders.setEnabled(ctx, id, enabled), [PAGE]);
}

export async function testProviderAction(id: string) {
  return await run('payment_providers:test', { surface: 'settings/payments', action: 'test_connection' }, async (ctx) => await fin().paymentProviders.test(ctx, id), [PAGE]);
}

export async function deleteProviderAction(id: string) {
  return await run('payment_providers:delete', { surface: 'settings/payments', action: 'delete_provider' }, async (ctx) => await fin().paymentProviders.delete(ctx, id), [PAGE]);
}
