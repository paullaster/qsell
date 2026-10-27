'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import {
  PAYMENT_PROVIDER_META,
  type PaymentProviderCode,
} from '@/server/domains/payments/types';
import { extractPaymentReference } from '@/server/domains/payments/payment-reference';
import { startOrderPayment, type StartedPayment } from '@/server/domains/payments/start-payment';

import { emptyToNull, has, orElse } from '@/lib/values';

/** Which branches act independently decides what the KRA screens show, so they must refresh. */

async function ensureBranchContext() {
  const { companySettings, organizations } = getContainer();
  const company = await companySettings.ensureSeeded();
  const { branch } = await organizations.ensureDefaultOrgAndBranch(
    company.id,
    orElse(company.tradingName, company.legalName),
  );
  return { company, branch };
}

export async function updateCompanyPublicBaseUrlAction(url: string): Promise<void> {
  await requirePermission('settings:manage');
  const { companySettings } = getContainer();
  const cleaned = url.trim().replace(/\/$/, '');
  // Payment providers only call back over https; plain http is allowed for a machine's own address.
  if (has(cleaned) && !/^https:\/\//i.test(cleaned) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(cleaned)) {
    throw new Error('The public address must start with https:// (payment providers will not call back over plain http).');
  }
  await companySettings.update({
    publicBaseUrl: emptyToNull(cleaned),
  });
  revalidatePath('/admin/settings');
  revalidatePath('/admin/company');
}

export async function listEnabledCheckoutProvidersAction(): Promise<
  { code: PaymentProviderCode; label: string; description: string }[]
> {
  const { branch } = await ensureBranchContext();
  const { payments } = getContainer();
  const enabled = await payments.listEnabledProviders(branch);
  return enabled.map((c) => {
    const code = c.providerCode as PaymentProviderCode;
    const meta = PAYMENT_PROVIDER_META[code];
    const rawLabel = orElse(c.displayName, meta.label);
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
}): Promise<StartedPayment> {
  // The prompt goes to the number the order already holds; the caller cannot name another (see startOrderPayment).
  return await startOrderPayment({ orderId: input.orderId, providerCode: input.providerCode, source: 'staff' });
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
    throw new Error(orElse(res.errorMessage, 'M-Pesa initiation failed'));
  }
  return {
    checkoutRequestId: res.attemptId,
    merchantRequestId: res.attemptId,
    customerMessage: orElse(res.customerMessage, 'STK push sent'),
  };
}

async function startPesapal(orderId: string) {
  await requirePermission('orders:update');
  const res = await initiateBranchPaymentAction({
    orderId,
    providerCode: 'pesapal_v3',
  });
  if (res.status === 'failed') {
    throw new Error(orElse(res.errorMessage, 'Pesapal initiation failed'));
  }
  return {
    orderTrackingId: res.attemptId,
    merchantReference: res.attemptId,
    redirectUrl: orElse(res.redirectUrl, ''),
  };
}

/** @deprecated Prefer initiateBranchPaymentAction */
export async function initiatePesapalPaymentAction(orderId: string) {
  return startPesapal(orderId);
}

export async function submitPesapalOrderAction(orderId: string) {
  await requirePermission('orders:update');
  return startPesapal(orderId);
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
