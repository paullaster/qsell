
import { has } from '@/lib/has';
/**
 * Receivables rules that need no database: money in whole cents, who a payment is applied to,
 * ageing, and whether a receipt satisfies its payment method. Customer ledger amounts are
 * kept to 2 decimal places, so cents are exact integers here.
 */

export class CentsError extends Error {}

export function toCents(value: string | number): number {
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) {
    throw new CentsError(`"${text}" is not an amount with at most 2 decimal places.`);
  }
  const negative = text.startsWith('-');
  const [whole, frac = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new CentsError('That amount is too large.');
  return negative ? -cents : cents;
}

export function fromCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

export interface OpenInvoice {
  id: string;
  /** What is still owed (positive cents). */
  remainingCents: number;
  dueDate: Date | null;
  createdAt: Date;
  documentNo: string;
}

export interface PlannedApplication {
  entryId: string;
  amountCents: number;
}

/** Oldest due first (no due date counts as the creation date), then oldest created, then number. */
export function planOldestFirst(open: OpenInvoice[], availableCents: number): PlannedApplication[] {
  const ordered = [...open]
    .filter((i) => i.remainingCents > 0)
    .sort((a, b) => {
      const da = (a.dueDate ?? a.createdAt).getTime();
      const db = (b.dueDate ?? b.createdAt).getTime();
      if (da !== db) return da - db;
      const ca = a.createdAt.getTime() - b.createdAt.getTime();
      return ca !== 0 ? ca : a.documentNo.localeCompare(b.documentNo);
    });
  const out: PlannedApplication[] = [];
  let left = availableCents;
  for (const inv of ordered) {
    if (left <= 0) break;
    const take = Math.min(inv.remainingCents, left);
    out.push({ entryId: inv.id, amountCents: take });
    left -= take;
  }
  return out;
}

export interface ApplicationIssue {
  code: 'NOTHING_TO_APPLY' | 'AMOUNT_INVALID' | 'OVER_CREDIT' | 'OVER_INVOICE' | 'DUPLICATE_TARGET';
  message: string;
  entryId?: string;
}

/**
 * Checks a set of applications against what is available on the credit side and what is open on
 * each invoice. Never lets an invoice go negative or a credit be used twice.
 */
export function checkApplications(
  creditAvailableCents: number,
  invoices: Map<string, number>,
  planned: PlannedApplication[],
): ApplicationIssue[] {
  const issues: ApplicationIssue[] = [];
  if (planned.length === 0) {
    return [{ code: 'NOTHING_TO_APPLY', message: 'Choose at least one invoice to apply to.' }];
  }
  const seen = new Set<string>();
  let total = 0;
  for (const p of planned) {
    if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) {
      issues.push({ code: 'AMOUNT_INVALID', message: 'Each amount must be more than zero.', entryId: p.entryId });
      continue;
    }
    if (seen.has(p.entryId)) {
      issues.push({ code: 'DUPLICATE_TARGET', message: 'An invoice can appear only once in one application.', entryId: p.entryId });
      continue;
    }
    seen.add(p.entryId);
    total += p.amountCents;
    const open = invoices.get(p.entryId) ?? 0;
    if (p.amountCents > open) {
      issues.push({
        code: 'OVER_INVOICE',
        message: `Only ${fromCents(open)} is still open on that invoice.`,
        entryId: p.entryId,
      });
    }
  }
  if (total > creditAvailableCents) {
    issues.push({
      code: 'OVER_CREDIT',
      message: `Only ${fromCents(creditAvailableCents)} is available to apply.`,
    });
  }
  return issues;
}

export interface AgeBucket {
  label: string;
  fromDays: number;
  /** Inclusive; null = no upper limit. */
  toDays: number | null;
  cents: number;
  count: number;
}

export const DEFAULT_AGE_BOUNDS = [0, 30, 60, 90];

/**
 * Buckets open invoices by days past due on `asOf`: "Not yet due", then 1–30, 31–60, 61–90 and
 * over 90 by default. Credits (unapplied receipts) are returned separately so they are never
 * silently netted against old debt.
 */
export function ageOpenItems(
  items: { remainingCents: number; dueDate: Date | null; createdAt: Date }[],
  asOf: Date,
  bounds: number[] = DEFAULT_AGE_BOUNDS,
): { buckets: AgeBucket[]; creditsCents: number; creditsCount: number } {
  const edges = [...bounds].sort((a, b) => a - b);
  const buckets: AgeBucket[] = [{ label: 'Not yet due', fromDays: Number.NEGATIVE_INFINITY, toDays: 0, cents: 0, count: 0 }];
  for (let i = 0; i < edges.length; i++) {
    const from = edges[i] + 1;
    const to = i + 1 < edges.length ? edges[i + 1] : null;
    buckets.push({
      label: to === null ? `Over ${edges[i]} days` : `${from}–${to} days`,
      fromDays: from,
      toDays: to,
      cents: 0,
      count: 0,
    });
  }
  let creditsCents = 0;
  let creditsCount = 0;
  const day = 24 * 60 * 60 * 1000;
  for (const it of items) {
    if (it.remainingCents < 0) {
      creditsCents += -it.remainingCents;
      creditsCount += 1;
      continue;
    }
    if (it.remainingCents === 0) continue;
    const due = (it.dueDate ?? it.createdAt).getTime();
    const daysPast = Math.floor((asOf.getTime() - due) / day);
    const bucket =
      daysPast <= 0
        ? buckets[0]
        : buckets.slice(1).find((b) => daysPast >= b.fromDays && (b.toDays === null || daysPast <= b.toDays)) ??
          buckets[buckets.length - 1];
    bucket.cents += it.remainingCents;
    bucket.count += 1;
  }
  return { buckets, creditsCents, creditsCount };
}

export interface MethodRules {
  kind: string;
  requiresReference: boolean;
  requiresEvidence: boolean;
  requiresCounterparty: boolean;
  limits: { min?: string; max?: string };
  usableFor: string[];
  enabled: boolean;
}

export interface ReceiptInputFacts {
  amountCents: number;
  externalReference: string | null;
  counterparty: Record<string, string>;
  evidenceCount: number;
}

export interface RuleIssue {
  code: string;
  message: string;
}

/** The counterparty fields a cheque must have. */
export const CHEQUE_FIELDS = ['chequeNo', 'bank', 'drawer'] as const;

/** What stops this receipt from being recorded (draft) vs. posted. `forPosting` adds the evidence rule. */
export function checkReceiptAgainstMethod(
  m: MethodRules,
  r: ReceiptInputFacts,
  forPosting: boolean,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!m.enabled) issues.push({ code: 'METHOD_DISABLED', message: 'That payment method is switched off.' });
  if (!m.usableFor.includes('customer_receipt')) {
    issues.push({ code: 'METHOD_NOT_FOR_RECEIPTS', message: 'That payment method cannot be used to receive money from customers.' });
  }
  if (r.amountCents <= 0) issues.push({ code: 'AMOUNT_INVALID', message: 'The amount must be more than zero.' });
  if (m.requiresReference && !has((r.externalReference ?? '').trim())) {
    issues.push({ code: 'REFERENCE_REQUIRED', message: 'This payment method needs the payment reference (transaction code, slip or bank reference).' });
  }
  if (m.requiresCounterparty) {
    const missing = CHEQUE_FIELDS.filter((f) => !has((r.counterparty[f] ?? '').trim()));
    if (missing.length > 0) {
      issues.push({
        code: 'COUNTERPARTY_REQUIRED',
        message: `This payment method needs: ${missing.map((f) => ({ chequeNo: 'cheque number', bank: "the drawer's bank", drawer: 'the drawer' })[f]).join(', ')}.`,
      });
    }
  }
  if (m.limits.min !== undefined && r.amountCents < toCents(m.limits.min)) {
    issues.push({ code: 'BELOW_MINIMUM', message: `The minimum for this method is ${m.limits.min}.` });
  }
  if (m.limits.max !== undefined && r.amountCents > toCents(m.limits.max)) {
    issues.push({ code: 'ABOVE_MAXIMUM', message: `The maximum for this method is ${m.limits.max}.` });
  }
  if (forPosting && m.requiresEvidence && r.evidenceCount === 0) {
    issues.push({ code: 'EVIDENCE_REQUIRED', message: 'Attach the evidence (deposit slip, screenshot or cheque image) before posting.' });
  }
  return issues;
}
