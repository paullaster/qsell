'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import {
  PAYMENT_PROVIDER_META,
  type PaymentProviderCode,
  type PaymentProviderEnvironment,
} from '@/server/domains/payments/types';
import {
  encryptCredentials,
  decryptCredentials,
  maskCredentials,
} from '@/server/domains/payments/crypto';
import type { BranchRow, PaymentProviderConfigRow } from '@/server/db/drizzle/schema';
import { extractPaymentReference } from '@/server/domains/payments/payment-reference';
import { amountDue } from '@/server/domains/orders/amount-due';

/** Which branches act independently decides what the KRA screens show, so they must refresh. */
const KRA_SETTINGS_PATH = '/admin/settings/tax-compliance/kra-tims-etims';

async function ensureBranchContext() {
  const { companySettings, organizations } = getContainer();
  const company = await companySettings.ensureSeeded();
  const { branch } = await organizations.ensureDefaultOrgAndBranch(
    company.id,
    company.tradingName || company.legalName,
  );
  return { company, branch };
}

export async function listBranchesAction(): Promise<BranchRow[]> {
  await requirePermission('branches:read');
  const { company, branch } = await ensureBranchContext();
  const { branches } = getContainer();
  const list = await branches.listByCompany(company.id);
  return list.length ? list : [branch];
}

export async function createBranchAction(input: {
  code: string;
  name: string;
  actsIndependently?: boolean;
  kraPin?: string;
  publicBaseUrl?: string;
}): Promise<BranchRow> {
  await requirePermission('branches:manage');
  const { company } = await ensureBranchContext();
  const { branches, paymentConfigs } = getContainer();
  const created = await branches.create({
    companyId: company.id,
    code: input.code.trim().toUpperCase(),
    name: input.name.trim(),
    actsIndependently: Boolean(input.actsIndependently),
    kraPin: input.kraPin?.trim() || null,
    publicBaseUrl: input.publicBaseUrl?.trim() || null,
    isDefault: false,
    isActive: true,
  });

  for (const code of Object.keys(PAYMENT_PROVIDER_META) as PaymentProviderCode[]) {
    const meta = PAYMENT_PROVIDER_META[code];
    await paymentConfigs.upsert({
      branchId: created.id,
      providerCode: code,
      displayName: meta.label,
      isEnabled: false,
      environment: 'staging',
      apiBaseUrl: meta.defaultStagingBaseUrl,
      credentialsEncrypted: null,
      replaceCredentials: true,
    });
  }

  revalidatePath('/admin/settings');
  revalidatePath('/admin/settings/payments');
  revalidatePath(KRA_SETTINGS_PATH, 'layout');
  return created;
}

export async function updateBranchAction(
  id: string,
  patch: Partial<{
    name: string;
    code: string;
    actsIndependently: boolean;
    kraPin: string | null;
    publicBaseUrl: string | null;
    isDefault: boolean;
    isActive: boolean;
  }>,
): Promise<BranchRow> {
  await requirePermission('branches:manage');
  const { branches } = getContainer();
  const updated = await branches.update(id, patch);
  revalidatePath('/admin/settings');
  revalidatePath('/admin/settings/payments');
  revalidatePath(KRA_SETTINGS_PATH, 'layout');
  return updated;
}

export type PaymentConfigAdminView = {
  id: string;
  branchId: string;
  providerCode: PaymentProviderCode;
  displayName: string;
  isEnabled: boolean;
  environment: PaymentProviderEnvironment;
  apiBaseUrl: string;
  settings: Record<string, unknown>;
  hasCredentials: boolean;
  maskedCredentials: Record<string, string> | null;
  meta: (typeof PAYMENT_PROVIDER_META)[PaymentProviderCode];
};

function toAdminView(row: PaymentProviderConfigRow): PaymentConfigAdminView {
  const code = row.providerCode as PaymentProviderCode;
  const decrypted = decryptCredentials(row.credentialsEncrypted);
  return {
    id: row.id,
    branchId: row.branchId,
    providerCode: code,
    displayName: row.displayName,
    isEnabled: row.isEnabled,
    environment: row.environment as PaymentProviderEnvironment,
    apiBaseUrl: row.apiBaseUrl,
    settings: (row.settings as Record<string, unknown>) || {},
    hasCredentials: Boolean(row.credentialsEncrypted),
    maskedCredentials: maskCredentials(decrypted),
    meta: PAYMENT_PROVIDER_META[code],
  };
}

export async function listPaymentConfigsAction(
  branchId?: string,
): Promise<PaymentConfigAdminView[]> {
  await requirePermission('payments:manage_gateways');
  const { branch } = await ensureBranchContext();
  const { paymentConfigs } = getContainer();
  const targetBranchId = branchId || branch.id;
  let rows = await paymentConfigs.listByBranch(targetBranchId);

  // Ensure all known providers exist as rows
  for (const code of Object.keys(PAYMENT_PROVIDER_META) as PaymentProviderCode[]) {
    if (!rows.find((r) => r.providerCode === code)) {
      const meta = PAYMENT_PROVIDER_META[code];
      await paymentConfigs.upsert({
        branchId: targetBranchId,
        providerCode: code,
        displayName: meta.label,
        isEnabled: false,
        environment: 'staging',
        apiBaseUrl: meta.defaultStagingBaseUrl,
        replaceCredentials: false,
      });
    }
  }
  rows = await paymentConfigs.listByBranch(targetBranchId);
  return rows.map(toAdminView);
}

export async function getPaymentConfigAction(
  branchId: string,
  providerCode: PaymentProviderCode,
): Promise<PaymentConfigAdminView> {
  await requirePermission('payments:manage_gateways');
  await ensureBranchContext();
  const { paymentConfigs } = getContainer();
  let row = await paymentConfigs.getByBranchAndProvider(branchId, providerCode);
  if (!row) {
    const meta = PAYMENT_PROVIDER_META[providerCode];
    row = await paymentConfigs.upsert({
      branchId,
      providerCode,
      displayName: meta.label,
      isEnabled: false,
      environment: 'staging',
      apiBaseUrl: meta.defaultStagingBaseUrl,
      replaceCredentials: false,
    });
  }
  return toAdminView(row);
}

export async function savePaymentConfigAction(input: {
  branchId: string;
  providerCode: PaymentProviderCode;
  displayName?: string;
  isEnabled: boolean;
  environment: PaymentProviderEnvironment;
  apiBaseUrl: string;
  settings?: Record<string, unknown>;
  /** When provided, replaces encrypted credentials. Omit to keep existing. */
  credentials?: Record<string, string> | null;
}): Promise<PaymentConfigAdminView> {
  await requirePermission('payments:manage_gateways');
  await ensureBranchContext();
  const { paymentConfigs } = getContainer();
  const meta = PAYMENT_PROVIDER_META[input.providerCode];

  let credentialsEncrypted = undefined as ReturnType<typeof encryptCredentials> | null | undefined;
  let replaceCredentials = false;
  if (input.credentials) {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.credentials)) {
      if (typeof v === 'string' && v.trim() && !v.includes('•')) {
        cleaned[k] = v.trim();
      }
    }
    if (Object.keys(cleaned).length > 0) {
      // Merge with existing so partial updates work
      const existing = await paymentConfigs.getByBranchAndProvider(
        input.branchId,
        input.providerCode,
      );
      const prev = decryptCredentials(existing?.credentialsEncrypted) || {};
      credentialsEncrypted = encryptCredentials({ ...prev, ...cleaned });
      replaceCredentials = true;
    }
  }

  const defaultUrl =
    input.environment === 'production' ? meta.defaultProductionBaseUrl : meta.defaultStagingBaseUrl;

  const row = await paymentConfigs.upsert({
    branchId: input.branchId,
    providerCode: input.providerCode,
    displayName: input.displayName || meta.label,
    isEnabled: input.isEnabled,
    environment: input.environment,
    apiBaseUrl: (input.apiBaseUrl || defaultUrl).replace(/\/$/, ''),
    settings: input.settings,
    credentialsEncrypted: credentialsEncrypted ?? null,
    replaceCredentials,
  });

  revalidatePath('/admin/settings/payments');
  return toAdminView(row);
}

export async function updateCompanyPublicBaseUrlAction(url: string): Promise<void> {
  await requirePermission('settings:manage');
  const { companySettings } = getContainer();
  const cleaned = url.trim().replace(/\/$/, '');
  // Payment providers only call back over https; plain http is allowed for a machine's own address.
  if (cleaned && !/^https:\/\//i.test(cleaned) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(cleaned)) {
    throw new Error('The public address must start with https:// (payment providers will not call back over plain http).');
  }
  await companySettings.update({
    publicBaseUrl: cleaned || null,
  });
  revalidatePath('/admin/settings');
  revalidatePath('/admin/company');
}

export async function listEnabledCheckoutProvidersAction(): Promise<
  { code: PaymentProviderCode; label: string; description: string }[]
> {
  const { branch } = await ensureBranchContext();
  const { payments } = getContainer();
  const enabled = await payments.listEnabledProviders(branch.id);
  return enabled.map((c) => {
    const code = c.providerCode as PaymentProviderCode;
    const meta = PAYMENT_PROVIDER_META[code];
    const rawLabel = c.displayName || meta.label;
    const rawDescription = meta.description;

    // Keep provider implementation terminology out of the storefront UI.
    return {
      code,
      label: code === 'mpesa_daraja' ? rawLabel.replace(/\s*\(?daraja\)?/gi, '').trim() : rawLabel,
      description:
        code === 'mpesa_daraja' ? 'Pay securely with M-Pesa on your phone.' : rawDescription,
    };
  });
}

export async function initiateBranchPaymentAction(input: {
  orderId: string;
  providerCode: PaymentProviderCode;
}): Promise<{
  attemptId: string;
  status: string;
  redirectUrl?: string | null;
  customerMessage?: string;
  errorMessage?: string | null;
}> {
  const { branch } = await ensureBranchContext();
  const { payments, orders } = getContainer();
  const order = await orders.getById(input.orderId);
  if (!order) throw new Error('Order not found');
  if (amountDue(order) <= 0) throw new Error('Nothing is left to pay on this order.');

  const { attempt, result } = await payments.initiatePayment({
    branch,
    providerCode: input.providerCode,
    orderId: order.id,
    orderNumber: order.orderNumber,
    amount: amountDue(order),
    currency: order.currency,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    description: `Order ${order.orderNumber}`,
  });

  return {
    attemptId: attempt.id,
    status: attempt.status,
    redirectUrl: attempt.redirectUrl,
    customerMessage: result.customerMessage,
    errorMessage: attempt.errorMessage,
  };
}

export async function getPaymentAttemptStatusAction(attemptId: string) {
  const { paymentAttempts } = getContainer();
  const attempt = await paymentAttempts.getById(attemptId);
  if (!attempt) throw new Error('Payment attempt not found');
  return {
    id: attempt.id,
    status: attempt.status,
    errorMessage: attempt.errorMessage,
    redirectUrl: attempt.redirectUrl,
    providerReference: attempt.providerReference,
    receiptNumber: extractPaymentReference(attempt.providerCode, attempt.responsePayload),
  };
}

/** @deprecated Prefer initiateBranchPaymentAction — kept for transitional UI. */
export async function initiateDarajaStkAction(orderId: string, _phone?: string) {
  await requirePermission('orders:update');
  const res = await initiateBranchPaymentAction({
    orderId,
    providerCode: 'mpesa_daraja',
  });
  if (res.status === 'failed') {
    throw new Error(res.errorMessage || 'M-Pesa initiation failed');
  }
  return {
    checkoutRequestId: res.attemptId,
    merchantRequestId: res.attemptId,
    customerMessage: res.customerMessage || 'STK push sent',
  };
}

/** @deprecated Prefer initiateBranchPaymentAction */
export async function initiatePesapalPaymentAction(orderId: string) {
  await requirePermission('orders:update');
  const res = await initiateBranchPaymentAction({
    orderId,
    providerCode: 'pesapal_v3',
  });
  if (res.status === 'failed') {
    throw new Error(res.errorMessage || 'Pesapal initiation failed');
  }
  return {
    orderTrackingId: res.attemptId,
    merchantReference: res.attemptId,
    redirectUrl: res.redirectUrl || '',
  };
}

export async function submitPesapalOrderAction(orderId: string) {
  await requirePermission('orders:update');
  return initiatePesapalPaymentAction(orderId);
}

/** Removed: payments are live via provider callbacks. */
export async function simulateDarajaUserAction(
  _checkoutRequestId: string,
  _action: 'success' | 'cancel' | 'timeout',
) {
  throw new Error(
    'Local payment simulation is disabled. Complete payment on the phone; status updates via Daraja callback.',
  );
}

/** Removed: payments are live via provider callbacks. */
export async function simulatePesapalPaymentAction(_orderTrackingId: string, _channel?: string) {
  throw new Error(
    'Local payment simulation is disabled. Complete payment on Pesapal; status updates via IPN callback.',
  );
}
