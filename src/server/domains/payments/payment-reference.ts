
import { emptyToNull, has, isRecord, readText } from '@/lib/values';
/**
 * The payment reference a provider assigns when money is captured.
 * This is not the checkout-request id we sent when the prompt was created.
 *
 * M-Pesa Daraja (and KCB Buni STK, which uses the same callback):
 * Body.stkCallback.CallbackMetadata.Item[{ Name: "MpesaReceiptNumber" }].
 */

interface MetadataItem {
  Name?: string;
  name?: string;
  Value?: string | number;
  value?: string | number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return value;
}

export function stkMetadataItems(body: unknown): MetadataItem[] {
  const root = asRecord(body);
  const envelope = asRecord(root?.Body) ?? asRecord(root?.body);
  const stk = asRecord(envelope?.stkCallback);
  const meta = asRecord(stk?.CallbackMetadata) ?? asRecord(stk?.callbackMetadata);
  const items = meta?.Item ?? meta?.item;
  return Array.isArray(items) ? (items as MetadataItem[]) : [];
}

export function metadataItemValue(items: MetadataItem[], name: string): string | null {
  const wanted = name.toLowerCase();
  const found = items.find(
    (item) => readText(item.Name, item.name).toLowerCase() === wanted,
  );
  const value = found?.Value ?? found?.value;
  if (value == null) return null;
  const text = String(value).trim();
  return emptyToNull(text);
}

function firstText(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && has(value.trim())) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Provider payment reference for a successful callback. Null when the payload has none. */
export function extractPaymentReference(providerCode: string, body: unknown): string | null {
  const record = asRecord(body) ?? {};
  if (providerCode === 'mpesa_daraja' || providerCode === 'kcb_buni') {
    return (
      metadataItemValue(stkMetadataItems(body), 'MpesaReceiptNumber') ??
      firstText(record, ['MpesaReceiptNumber', 'mpesaReceiptNumber'])
    );
  }
  if (providerCode === 'pesapal_v3') {
    return firstText(record, [
      'confirmation_code',
      'ConfirmationCode',
      'order_tracking_id',
      'OrderTrackingId',
    ]);
  }
  if (providerCode === 'jenga_hq') {
    return firstText(record, [
      'receiptNumber',
      'bankReference',
      'transactionReference',
      'transactionId',
    ]);
  }
  return null;
}
