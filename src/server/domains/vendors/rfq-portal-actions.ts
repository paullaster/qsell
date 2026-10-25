'use server';

import { getContainer } from '@/server/di/container';
import type { QuoteLineInput } from '@/lib/rfq';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProfileError('NOT_FOUND', 'That request does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

export async function vendorRfqsAction(before: { issuedAt: string; id: string } | null = null) {
  return await portal('rfq_list', async (me) => {
    const cursor = before !== null && typeof before === 'object' && UUID.test(before.id) && before.issuedAt.length <= 40 ? { issuedAt: before.issuedAt, id: before.id } : null;
    return await getContainer().rfqPortal.list(me.vendorId, cursor);
  });
}

export async function vendorRfqAction(rfqId: string) {
  return await portal('rfq_view', async (me) => await getContainer().rfqPortal.load(me, idOf(rfqId)));
}

const quoteOf = (raw: unknown) => {
  const q = obj(raw);
  const lines: QuoteLineInput[] = (Array.isArray(q.lines) ? q.lines.slice(0, 400) : []).map((x) => {
    const l = obj(x);
    return {
      rfqLineId: idOf(l.rfqLineId),
      noBid: l.noBid === true,
      isAlternative: l.isAlternative === true,
      unitPrice: str(l.unitPrice, 20),
      quantity: str(l.quantity, 20),
      taxRate: str(l.taxRate, 8),
      leadTimeDays: str(l.leadTimeDays, 6),
      brand: str(l.brand, 150),
      warranty: str(l.warranty, 150),
      note: str(l.note, 600),
    };
  });
  return { paymentTerms: str(q.paymentTerms), deliveryTerms: str(q.deliveryTerms), validUntil: str(q.validUntil, 12), notes: str(q.notes, 2000), lines };
};

export async function saveQuoteAction(rfqId: string, quote: unknown) {
  return await portal('rfq_save', async (me) => await getContainer().rfqPortal.saveDraft(me, idOf(rfqId), quoteOf(quote)));
}

export async function submitQuoteAction(rfqId: string, quote: unknown) {
  return await portal('rfq_submit', async (me) => {
    const container = getContainer();
    // What is on screen is saved first, so what is sent is what the vendor sees; the server then checks the saved copy in full.
    await container.rfqPortal.saveDraft(me, idOf(rfqId), quoteOf(quote));
    return await container.rfqPortal.submit(me, idOf(rfqId), me.companyId);
  }, 'vendor_submit');
}

export async function withdrawQuoteAction(rfqId: string) {
  return await portal('rfq_withdraw', async (me) => {
    await getContainer().rfqPortal.withdraw(me, idOf(rfqId));
  });
}

export async function declineRfqAction(rfqId: string, reason: string) {
  return await portal('rfq_decline', async (me) => {
    await getContainer().rfqPortal.decline(me, idOf(rfqId), str(reason));
  });
}

export async function askRfqQuestionAction(rfqId: string, question: string) {
  return await portal('rfq_ask', async (me) => {
    await getContainer().rfqPortal.ask(me, idOf(rfqId), str(question, 1000));
  }, 'vendor_submit');
}
