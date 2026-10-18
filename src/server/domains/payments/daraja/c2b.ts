import { and, eq, inArray, lt } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { paymentMethods, paymentProviderConfigs, providerTransactions, type PaymentMethodRow, type ProviderEventRow, type ProviderTransactionRow } from '@/server/db/drizzle/schema';
import type { PlatformContexts } from '../engine/context';
import type { ProviderEventService } from '../engine/event-service';
import type { PaymentJobs } from '../engine/jobs';
import { phoneFingerprint, maskPhone } from '../engine/redact';
import type { ProviderOperationService } from '../engine/operation-service';
import type { ProviderTransactionStore } from '../engine/transaction-store';
import type { InboundClaim } from '../engine/types';
import { engineSettings } from '../engine/settings';
import { darajaSettings } from './config';
import type { DarajaOperations } from './operations';
import { parseC2b } from './parsers';
import { looksLikeReceipt, toCentsLoose } from './security';
import { readStatusAnswer, statusAgrees } from './verify';

import { firstFilled, has, isRecord, readText } from '@/lib/values';

/** What counting a verified direct payment means (a customer's receipt, for instance). null: leave it for a person. */
export interface C2bConsumer {
  allocate(tx: ProviderTransactionRow, info: { method: PaymentMethodRow; payerName: string | null; accountReference: string | null; autoAllocate: 'off' | 'by_customer_number' }): Promise<{ type: string; id: string } | null>;
  /** A person places a confirmed payment on a customer they chose. */
  place(tx: ProviderTransactionRow, method: PaymentMethodRow, customerId: string, actor: { id: string }): Promise<{ type: string; id: string }>;
  /** Does this reference belong to someone we know? (Used by the validation policy.) */
  knownReference(companyId: string, reference: string | null): Promise<boolean>;
}

export interface PullRecord {
  transactionId: string;
  trxDate: string | null;
  msisdn: string | null;
  billReference: string | null;
  amountCents: number | null;
  type: string | null;
}

/** The rows of a Pull Transactions answer, wherever the answer put them. */
export function pullRecords(body: Record<string, unknown> | null): PullRecord[] {
  if (!body) return [];
  const lists: unknown[][] = [];
  const visit = (v: unknown, depth = 0) => {
    if (depth > 3) return;
    if (Array.isArray(v)) {
      lists.push(v);
      for (const x of v) if (Array.isArray(x)) visit(x, depth + 1);
    } else if (isRecord(v)) for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(body);
  const out = new Map<string, PullRecord>();
  for (const list of lists) {
    for (const item of list.flat()) {
      if (!isRecord(item)) continue;
      const r = item;
      const id = r.transactionId ?? r.TransactionId ?? r.transactionID;
      if (typeof id !== 'string' || !has(id)) continue;
      out.set(id, {
        transactionId: id,
        trxDate: typeof r.trxDate === 'string' ? r.trxDate : null,
        msisdn: r.msisdn === undefined || r.msisdn === null ? null : readText(r.msisdn),
        billReference: firstFilled(typeof r.billreference === 'string' ? r.billreference : null, typeof r.billReference === 'string' ? r.billReference : null),
        amountCents: toCentsLoose(r.amount),
        type: typeof r.transactiontype === 'string' ? r.transactiontype : null,
      });
    }
  }
  return [...out.values()];
}

const pad = (n: number) => String(n).padStart(2, '0');
const pullTime = (d: Date) => {
  // Pull Transactions takes East Africa Time as "YYYY-MM-DD HH:MM:SS".
  const e = new Date(d.getTime() + 3 * 3600_000);
  return `${e.getUTCFullYear()}-${pad(e.getUTCMonth() + 1)}-${pad(e.getUTCDate())} ${pad(e.getUTCHours())}:${pad(e.getUTCMinutes())}:${pad(e.getUTCSeconds())}`;
};

/**
 * Money paid straight to a paybill or till. Safaricom tells us (confirmation), we write it down and
 * claim the M-Pesa code once, then confirm with Safaricom (Transaction Status by the code, or Pull
 * Transactions) before it is counted. A payment whose callback never arrived is found by the pull sweep.
 */
export class DarajaC2b {
  constructor(
    private readonly db: DrizzleDb,
    private readonly contexts: PlatformContexts,
    private readonly events: ProviderEventService,
    private readonly ops: ProviderOperationService,
    private readonly txs: ProviderTransactionStore,
    private readonly darajaOps: DarajaOperations,
    private readonly jobs: PaymentJobs,
    private readonly consumer: C2bConsumer | null,
  ) {}

  /** Told when a confirmed payment has been put on someone (by the rules, or by a person): Bill Manager invoices follow it. */
  onPlaced: ((tx: ProviderTransactionRow) => Promise<void>) | null = null;

  /** Calls the placed-hook with the transaction as it now stands. A problem there never undoes the payment. */
  async notePlaced(txId: string): Promise<void> {
    if (this.onPlaced === null) return;
    const row = await this.txs.get(txId);
    if (row?.state !== 'consumed') return;
    try {
      await this.onPlaced(row);
    } catch (error) {
      console.error('[payments] the placed-payment follow-up failed', error instanceof Error ? error.message : error);
    }
  }

  /** The method (shortcode, branch, bank account, G/L account) a payment to this shortcode belongs to. */
  private async methodFor(providerId: string, shortcode: string | null): Promise<PaymentMethodRow | null> {
    if (!has(shortcode)) return null;
    const [m] = await this.db
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.providerId, providerId), eq(paymentMethods.channelNumber, shortcode), eq(paymentMethods.enabled, true)))
      .limit(1);
    return m ?? null;
  }

  /** Answers Safaricom's validation request, in time, by the provider's policy. Always writes the event first. */
  async validate(event: ProviderEventRow, claim: InboundClaim | null, providerId: string): Promise<{ ResultCode: string; ResultDesc: string }> {
    const accept = { ResultCode: '0', ResultDesc: 'Accepted' };
    const reject = (code: string) => ({ ResultCode: code, ResultDesc: 'Rejected' });
    if (!claim) {
      await this.events.setState(event.id, 'rejected', { failureCode: 'UNREADABLE', failureReason: 'The validation request could not be read.' });
      return reject('C2B00016');
    }
    const ctx = await this.contexts.forProvider(providerId);
    const settings = darajaSettings(ctx.settings);
    const method = await this.methodFor(providerId, claim.shortcode);
    const creds = ctx.credentials as { shortcode?: string };
    if (!method && claim.shortcode !== creds.shortcode) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'UNKNOWN_SHORTCODE', failureReason: `${claim.shortcode ?? 'No shortcode'} is not one of this provider's paybills or tills.` });
      return reject('C2B00015');
    }
    if (settings.c2b.validation === 'reject_all') {
      await this.events.setState(event.id, 'rejected', { failureCode: 'POLICY_REJECT', failureReason: 'The provider is set to reject every payment at validation.' });
      return reject('C2B00016');
    }
    if (settings.c2b.validation === 'known_reference') {
      const known = this.consumer ? await this.consumer.knownReference(ctx.companyId, claim.accountReference) : false;
      if (!known) {
        await this.events.setState(event.id, 'rejected', { failureCode: 'UNKNOWN_REFERENCE', failureReason: `The account number "${claim.accountReference ?? ''}" does not match anyone we know.` });
        return reject('C2B00012');
      }
    }
    await this.events.setState(event.id, 'ignored', { failureCode: null, failureReason: null, platformReference: claim.platformReference });
    return accept;
  }

  /** A completed payment was announced. Claim it (once), then have it checked with Safaricom. */
  async confirmed(event: ProviderEventRow, claim: InboundClaim | null, providerId: string): Promise<void> {
    if (!has(claim?.platformReference) || claim.amountCents === null) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'UNREADABLE', failureReason: 'The confirmation has no transaction id or amount.' });
      return;
    }
    if (!looksLikeReceipt(claim.platformReference)) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'RECEIPT_FORMAT', failureReason: `"${claim.platformReference}" does not look like an M-Pesa transaction id.` });
      return;
    }
    const ctx = await this.contexts.forProvider(providerId);
    const method = await this.methodFor(providerId, claim.shortcode);
    const creds = ctx.credentials as { shortcode?: string };
    if (!method && claim.shortcode !== creds.shortcode) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'UNKNOWN_SHORTCODE', failureReason: `${claim.shortcode ?? 'No shortcode'} is not one of this provider's paybills or tills.` });
      return;
    }
    const { row, created, amountDiffers } = await this.txs.claim({
      companyId: ctx.companyId,
      providerId,
      methodId: method?.id ?? null,
      kind: 'c2b',
      platformReference: claim.platformReference,
      amount: (claim.amountCents / 100).toFixed(2),
      payerMasked: claim.payerMasked,
      payerHash: claim.payerFingerprint,
      shortcode: claim.shortcode,
      accountReference: claim.accountReference,
      occurredAt: claim.occurredAt,
    });
    if (amountDiffers) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'REFERENCE_REUSED', failureReason: `Transaction ${claim.platformReference} was already recorded for a different amount.`, platformReference: claim.platformReference });
      return;
    }
    await this.events.setState(event.id, created ? 'awaiting_verification' : 'ignored', { platformReference: claim.platformReference, amount: (claim.amountCents / 100).toFixed(2), failureCode: created ? null : 'DUPLICATE', failureReason: created ? null : 'This transaction was already announced; nothing was counted twice.' });
    if (created) await this.jobs.verifyTransaction(row.id, 2);
  }

  /**
   * Bill Manager says an invoice was paid. The notice is a claim like any other: the payment is written down under its M-Pesa
   * code (once, whichever way it was announced first), checked with Safaricom, and only then put on the customer. A payment we
   * already know from the paybill's own confirmation is not counted a second time.
   */
  async billNoticed(event: ProviderEventRow, claim: InboundClaim | null, providerId: string): Promise<void> {
    await this.claimAnnounced(event, claim, providerId, 'bill', 'The notice has no transaction id or amount.');
  }

  /** The other business's payment to us through B2B Express Checkout, claimed under its M-Pesa code and then checked. */
  async expressPaid(event: ProviderEventRow, claim: InboundClaim | null, providerId: string, methodId: string | null): Promise<void> {
    await this.claimAnnounced(event, claim, providerId, 'b2b_express', 'The callback has no transaction id or amount.', methodId);
  }

  private async claimAnnounced(event: ProviderEventRow, claim: InboundClaim | null, providerId: string, kind: 'bill' | 'b2b_express', unreadable: string, methodId: string | null = null): Promise<void> {
    if (!has(claim?.platformReference) || claim.amountCents === null) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'UNREADABLE', failureReason: unreadable });
      return;
    }
    if (!looksLikeReceipt(claim.platformReference)) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'RECEIPT_FORMAT', failureReason: `"${claim.platformReference}" does not look like an M-Pesa transaction id.` });
      return;
    }
    const ctx = await this.contexts.forProvider(providerId);
    const method = has(methodId) ? ((await this.db.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)))[0] ?? null) : await this.methodFor(providerId, claim.shortcode);
    const creds = ctx.credentials as { shortcode?: string };
    const shortcode = claim.shortcode ?? method?.channelNumber ?? creds.shortcode ?? null;
    if (!method && shortcode !== creds.shortcode) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'UNKNOWN_SHORTCODE', failureReason: `${shortcode ?? 'No shortcode'} is not one of this provider's paybills or tills.` });
      return;
    }
    const { row, created, amountDiffers } = await this.txs.claim({
      companyId: ctx.companyId,
      providerId,
      methodId: method?.id ?? null,
      kind,
      platformReference: claim.platformReference,
      amount: (claim.amountCents / 100).toFixed(2),
      payerMasked: claim.payerMasked,
      payerHash: claim.payerFingerprint,
      shortcode,
      accountReference: claim.accountReference,
      occurredAt: claim.occurredAt,
    });
    if (amountDiffers) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'REFERENCE_REUSED', failureReason: `Transaction ${claim.platformReference} was already recorded for a different amount.`, platformReference: claim.platformReference });
      return;
    }
    await this.events.setState(event.id, created ? 'awaiting_verification' : 'ignored', { platformReference: claim.platformReference, amount: (claim.amountCents / 100).toFixed(2), failureCode: created ? null : 'DUPLICATE', failureReason: created ? null : 'This transaction was already announced; nothing was counted twice.' });
    if (created) await this.jobs.verifyTransaction(row.id, 2);
  }

  /** Asks Safaricom about a claimed payment and, if it agrees, counts it. Safe to run repeatedly. */
  async verify(txId: string): Promise<{ state: string; reason?: string }> {
    const tx = await this.txs.get(txId);
    if (!tx) return { state: 'missing' };
    if (tx.state === 'consumed' || tx.state === 'rejected' || tx.state === 'review') return { state: tx.state };
    const ctx = await this.contexts.forProvider(tx.providerId);
    const settings = darajaSettings(ctx.settings);
    const creds = ctx.credentials;
    const hasInitiator = Boolean(has(creds.initiatorName?.trim()) && has(creds.initiatorPassword) && creds.certificate?.trim());

    // 1. Transaction Status by the M-Pesa code, when the API operator is set up.
    if (hasInitiator && settings.operations.transaction_status?.enabled === true) {
      const [existing] = (await this.ops.bySubject('provider_transaction', tx.id, 'transaction_status')).slice(-1);
      if (!existing) {
        await this.darajaOps.start({ providerId: tx.providerId, methodId: tx.methodId, operation: 'transaction_status', input: { transactionId: tx.platformReference, shortcode: tx.shortcode }, idempotencyKey: `txs:${tx.platformReference}`, subject: { type: 'provider_transaction', id: tx.id } });
        return { state: 'waiting', reason: 'Asked Safaricom for the transaction status.' };
      }
      if (['succeeded', 'failed'].includes(existing.status)) {
        const answer = readStatusAnswer(existing.result);
        if (!answer) return await this.reject(tx, 'STATUS_UNREADABLE', 'The transaction status answer could not be read.');
        const agreed = statusAgrees(answer, { receipt: tx.platformReference, amountCents: Math.round(Number(tx.amount) * 100), shortcode: tx.shortcode });
        if (!agreed.ok) return await this.reject(tx, agreed.code, agreed.reason);
        await this.txs.addEvidence(tx.id, { transactionStatus: existing.result }, 'transaction_status');
        return await this.verified(tx, 'transaction_status');
      }
      if (existing.status === 'failed') return await this.reject(tx, existing.failureCode ?? 'STATUS_FAILED', existing.failureReason ?? 'Safaricom could not confirm the transaction.');
      return { state: 'waiting', reason: 'Waiting for the transaction status answer.' };
    }

    // 2. Pull Transactions, when registered.
    if (settings.pull.registered && settings.operations.pull_query?.enabled === true) {
      const when = tx.occurredAt ?? tx.createdAt;
      const from = new Date(when.getTime() - 30 * 60_000);
      const to = new Date(when.getTime() + 30 * 60_000);
      const { op } = await this.darajaOps.start({ providerId: tx.providerId, methodId: tx.methodId, operation: 'pull_query', input: { shortcode: tx.shortcode, startDate: pullTime(from), endDate: pullTime(to), offset: 0 }, idempotencyKey: `pull:${tx.id}:${Math.floor(Date.now() / 300_000)}`, subject: { type: 'provider_transaction', id: tx.id } });
      if (op.status !== 'succeeded') return { state: 'waiting', reason: op.failureReason ?? 'The pull did not answer.' };
      const hit = pullRecords(op.result).find((r) => r.transactionId === tx.platformReference);
      if (!hit) return { state: 'waiting', reason: 'Safaricom does not list this transaction yet.' };
      if (hit.amountCents !== null && hit.amountCents !== Math.round(Number(tx.amount) * 100)) return await this.reject(tx, 'PULL_AMOUNT_MISMATCH', `Safaricom lists ${(hit.amountCents / 100).toFixed(2)} for this code, not ${Number(tx.amount).toFixed(2)}.`);
      if (has(hit.billReference) && has(tx.accountReference) && hit.billReference !== tx.accountReference) return await this.reject(tx, 'PULL_REFERENCE_MISMATCH', 'Safaricom lists a different account number for this code.');
      await this.txs.addEvidence(tx.id, { pull: { transactionId: hit.transactionId, amountCents: hit.amountCents, billReference: hit.billReference, type: hit.type } }, 'pull');
      return await this.verified(tx, 'pull');
    }

    // 3. Nothing to ask with: it stays claimed. Counting it on the callback alone is exactly what is refused.
    await this.txs.setState(tx.id, 'claimed', { failureCode: 'NO_VERIFICATION_METHOD', failureReason: 'No way to confirm this payment with Safaricom is set up. Add the API operator (Transaction Status) or register for Pull Transactions on the provider.' });
    return { state: 'claimed', reason: 'No way to confirm with Safaricom is set up.' };
  }

  private async reject(tx: ProviderTransactionRow, code: string, reason: string) {
    await this.txs.setState(tx.id, 'rejected', { failureCode: code, failureReason: reason });
    return { state: 'rejected', reason };
  }

  /** Confirmed by Safaricom: put it on someone's account if the rules say so, else leave it for a person to place. */
  private async verified(tx: ProviderTransactionRow, by: string) {
    await this.txs.setState(tx.id, 'verified', { verifiedBy: by });
    const method = has(tx.methodId) ? (await this.db.select().from(paymentMethods).where(eq(paymentMethods.id, tx.methodId)))[0] ?? null : null;
    const ctx = await this.contexts.forProvider(tx.providerId);
    const settings = darajaSettings(ctx.settings);
    let placed: { type: string; id: string } | null = null;
    if (this.consumer && method && settings.c2b.autoAllocate !== 'off') {
      placed = await this.consumer.allocate((await this.txs.get(tx.id)), { method, payerName: null, accountReference: tx.accountReference, autoAllocate: settings.c2b.autoAllocate });
    }
    if (placed) {
      await this.txs.consume(tx.id, placed.type, placed.id);
      await this.notePlaced(tx.id);
      return { state: 'consumed' };
    }
    await this.txs.setState(tx.id, 'review', { verifiedBy: by });
    return { state: 'review' };
  }

  /**
   * Asks Safaricom for what it has received lately and reconciles it with what we know: payments whose
   * callback never came are found and checked in; payments we claimed get their confirmation.
   */
  async pullSweep(providerId: string, windowMinutes = 120): Promise<{ checked: number; found: number; missing: number }> {
    const ctx = await this.contexts.forProvider(providerId);
    const settings = darajaSettings(ctx.settings);
    if (!settings.pull.registered || settings.operations.pull_query?.enabled !== true) return { checked: 0, found: 0, missing: 0 };
    const methods = await this.db.select().from(paymentMethods).where(and(eq(paymentMethods.providerId, providerId), eq(paymentMethods.enabled, true)));
    const shortcodes = [...new Set(methods.map((m) => m.channelNumber).filter((x): x is string => Boolean(x)))];
    let checked = 0;
    let found = 0;
    let missing = 0;
    const to = new Date();
    const from = new Date(to.getTime() - windowMinutes * 60_000);
    for (const shortcode of shortcodes) {
      for (let offset = 0; offset < 5; offset += 1) {
        const { op } = await this.darajaOps.start({ providerId, methodId: methods.find((m) => m.channelNumber === shortcode)?.id ?? null, operation: 'pull_query', input: { shortcode, startDate: pullTime(from), endDate: pullTime(to), offset }, idempotencyKey: `pullsweep:${providerId}:${shortcode}:${Math.floor(to.getTime() / 600_000)}:${offset}` });
        if (op.status !== 'succeeded') break;
        const records = pullRecords(op.result);
        if (records.length === 0) break;
        for (const r of records) {
          checked += 1;
          if (!looksLikeReceipt(r.transactionId) || r.amountCents === null) continue;
          const existing = await this.txs.byReference(providerId, r.transactionId);
          if (existing) {
            if (existing.state === 'claimed' && Math.round(Number(existing.amount) * 100) === r.amountCents) {
              await this.txs.addEvidence(existing.id, { pull: { transactionId: r.transactionId, amountCents: r.amountCents } }, 'pull');
              await this.verified(existing, 'pull');
              found += 1;
            }
            continue;
          }
          // Safaricom has a payment we were never told about: take it in, already confirmed by Safaricom itself.
          missing += 1;
          const { row } = await this.txs.claim({
            companyId: ctx.companyId,
            providerId,
            methodId: methods.find((m) => m.channelNumber === shortcode)?.id ?? null,
            kind: 'c2b',
            platformReference: r.transactionId,
            amount: (r.amountCents / 100).toFixed(2),
            payerMasked: has(r.msisdn) ? maskPhone(r.msisdn) : null,
            payerHash: has(r.msisdn) && r.msisdn.replace(/\D/g, '').length >= 9 ? phoneFingerprint(r.msisdn) : null,
            shortcode,
            accountReference: r.billReference,
            occurredAt: has(r.trxDate) ? new Date(r.trxDate) : null,
          });
          await this.txs.addEvidence(row.id, { pull: { transactionId: r.transactionId, amountCents: r.amountCents, billReference: r.billReference, found: 'by sweep, no callback had arrived' } }, 'pull');
          await this.verified(row, 'pull');
        }
        if (records.length < 50) break;
      }
    }
    return { checked, found, missing };
  }

  /** Claimed payments that nobody has finished checking (a lost job, a restart): ask again. */
  async sweepClaimed(limit = 200): Promise<number> {
    const stale = await this.db
      .select({ id: providerTransactions.id })
      .from(providerTransactions)
      .where(and(eq(providerTransactions.state, 'claimed'), inArray(providerTransactions.kind, ['c2b', 'bill', 'b2b_express']), lt(providerTransactions.updatedAt, new Date(Date.now() - 60_000))))
      .limit(limit);
    for (const s of stale) await this.jobs.verifyTransaction(s.id, 0);
    return stale.length;
  }

  async providersWithPull(): Promise<string[]> {
    const rows = await this.db.select({ id: paymentProviderConfigs.id, s: paymentProviderConfigs.settings, enabled: paymentProviderConfigs.isEnabled }).from(paymentProviderConfigs).where(eq(paymentProviderConfigs.providerCode, 'mpesa_daraja'));
    return rows.filter((r) => r.enabled && darajaSettings(r.s).pull.registered).map((r) => r.id);
  }

  settingsOf(raw: unknown) {
    return { engine: engineSettings(raw), daraja: darajaSettings(raw) };
  }

  parse(kind: 'c2b_validation' | 'c2b_confirmation', body: unknown) {
    return parseC2b(kind, body);
  }
}

