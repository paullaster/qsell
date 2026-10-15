import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, paymentMethods, providerOperations, type ProviderOperationRow } from '@/server/db/drizzle/schema';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';
import type { PaymentJobs } from '../engine/jobs';
import type { ProviderOperationService } from '../engine/operation-service';
import type { PlatformContexts } from '../engine/context';
import { DARAJA_OPERATIONS, validateOperationInput, type DarajaOperationCode } from './catalog';
import { darajaSettings, OPERATION_DEFAULTS } from './config';
import { OperationRefused } from './operations';
import { randomUUID } from 'node:crypto';

import { has } from '@/lib/has';
import { orElse, readText } from '@/lib/values';

export interface PayoutRequest {
  companyId: string;
  providerId: string;
  methodId: string | null;
  operation: DarajaOperationCode;
  input: Record<string, unknown>;
  requestedBy: string;
  branchId?: string | null;
  origin?: Record<string, unknown>;
  idempotencyKey?: string;
  /** What the payout is for (a refund...). */
  subject?: { type: string; id: string };
  /** Already approved by the document it belongs to (a refund approved by its own workflow): queued at once, still limited and logged. */
  preApproved?: boolean;
}

/** Money leaves only after a different person approved this exact request; it is then sent once. */
export class DarajaDisbursements {
  constructor(
    private readonly db: DrizzleDb,
    private readonly ops: ProviderOperationService,
    private readonly contexts: PlatformContexts,
    private readonly jobs: PaymentJobs,
  ) {}

  /** Writes the request down and sends it to the approval workflow. Nothing is sent to the platform yet. */
  async request(input: PayoutRequest): Promise<{ op: ProviderOperationRow; status: 'pending_approval' | 'queued' }> {
    const info = DARAJA_OPERATIONS[input.operation];
    if (!info?.moneyOut) throw new OperationRefused('NOT_MONEY_OUT', `${input.operation} is not a payout.`);
    const ctx = await this.contexts.forProvider(input.providerId);
    if (ctx.provider.providerCode !== 'mpesa_daraja') throw new OperationRefused('WRONG_PROVIDER', 'That provider is not an M-Pesa (Daraja) connection.');
    const settings = darajaSettings(ctx.settings);
    const cfg = settings.operations[input.operation];
    if ((cfg?.enabled ?? OPERATION_DEFAULTS[input.operation]) !== true) throw new OperationRefused('OPERATION_OFF', `${info.label} is switched off for this provider (Settings → Payments).`);
    const checked = validateOperationInput(info, input.input);
    if (!checked.ok) throw new OperationRefused('INVALID_INPUT', checked.error);
    const amount = readText(checked.input.amount, '');
    if (!has(amount) || Number(amount) <= 0) throw new OperationRefused('INVALID_INPUT', 'An amount is required.');
    if (has(cfg?.maxAmount) && Number(amount) > Number(cfg.maxAmount)) throw new OperationRefused('OVER_LIMIT', `${info.label} is limited to ${cfg.maxAmount} per request for this provider.`);
    const c = ctx.credentials;
    if (!has(c.initiatorName?.trim()) || !has(c.initiatorPassword) || !has(c.certificate?.trim())) {
      throw new OperationRefused('NO_INITIATOR', "This needs the M-Pesa API operator's name and password and Safaricom's certificate. Save them on the provider (Settings → Payments).");
    }
    if (!has(input.methodId)) throw new OperationRefused('NO_METHOD', 'Choose the paybill or till the money is paid from.');
    const [method] = await this.db.select().from(paymentMethods).where(eq(paymentMethods.id, input.methodId));
    if (!method || method.providerId !== input.providerId) throw new OperationRefused('METHOD_MISMATCH', 'That payment method does not go through this provider.');
    if (has(settings.dailyPayoutLimit)) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [row] = await this.db
        .select({ total: sql<string>`coalesce(sum(${providerOperations.amount}), 0)` })
        .from(providerOperations)
        .where(and(eq(providerOperations.providerId, input.providerId), eq(providerOperations.companyId, input.companyId), inArray(providerOperations.operation, ['reversal', 'b2c', 'b2b_paybill', 'b2b_buygoods', 'tax_remittance']), inArray(providerOperations.status, ['pending_approval', 'approved', 'queued', 'submitted', 'accepted', 'timed_out', 'in_doubt', 'succeeded']), gte(providerOperations.createdAt, since)));
      if (Number(row?.total ?? 0) + Number(amount) > Number(settings.dailyPayoutLimit)) throw new OperationRefused('DAILY_LIMIT', `That would take the last 24 hours of payouts past this provider's limit of ${settings.dailyPayoutLimit}.`);
    }
    const { getContainer } = await import('@/server/di/container');
    return await this.db.transaction(async (tx) => {
      const { ProviderOperationService } = await import('../engine/operation-service');
      const { op, created } = await new ProviderOperationService(tx as unknown as DrizzleDb).create({
        companyId: input.companyId,
        providerId: input.providerId,
        methodId: input.methodId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey ?? `payout:${randomUUID()}`,
        originatorId: randomUUID(),
        subjectType: input.subject?.type ?? 'payout',
        subjectId: input.subject?.id ?? null,
        amount,
        currency: 'KES',
        input: checked.input,
        requestedBy: input.requestedBy,
        origin: input.origin ?? {},
        status: input.preApproved === true ? 'queued' : 'pending_approval',
        ...(input.preApproved === true ? { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } : {}),
      });
      if (input.preApproved === true) return { op, status: 'queued' as const };
      if (!created) return { op, status: op.status === 'queued' ? ('queued' as const) : ('pending_approval' as const) };
      const outcome = await getContainer().approvals.submit(
        {
          companyId: input.companyId,
          trigger: 'provider.disbursement',
          documentId: op.id,
          branchId: input.branchId ?? method.branchId ?? (await this.defaultBranch(input.companyId)),
          requestedBy: input.requestedBy,
          amount: Number(amount),
          snapshot: { operation: input.operation, providerId: input.providerId },
        },
        tx,
      );
      // Money out is never released without a workflow that says who may release it.
      if (!outcome.required) throw new OperationRefused('NO_APPROVAL_WORKFLOW', 'Paying money out needs an approval workflow, and none covers it. Ask an administrator to set one up for "Payout through a payment provider" (Settings → Approvals).');
      if (outcome.released) {
        await this.releaseIn(tx as unknown as DrizzleDb, op.id);
        return { op, status: 'queued' as const };
      }
      return { op, status: 'pending_approval' as const };
    }).then(async (r) => {
      if (r.status === 'queued') await this.jobs.sendOperation(r.op.id).catch(() => undefined);
      return { ...r, op: (await this.ops.get(r.op.id)) };
    });
  }

  private async defaultBranch(companyId: string): Promise<string> {
    const [b] = await this.db.select({ id: branches.id }).from(branches).where(eq(branches.companyId, companyId)).orderBy(sql`${branches.isDefault} desc`).limit(1);
    if (!b) throw new OperationRefused('NO_BRANCH', 'The company has no branch to attach this approval to.');
    return b.id;
  }

  private async releaseIn(db: DrizzleDb, id: string) {
    await db.update(providerOperations).set({ status: 'queued', nextAttemptAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), updatedAt: new Date() }).where(and(eq(providerOperations.id, id), eq(providerOperations.status, 'pending_approval')));
  }

  /** The approval handler: what approving, rejecting and withdrawing a payout does. */
  handler(): DocumentHandler {
    return {
      onReleased: async (id, tx) => {
        await this.releaseIn(tx as unknown as DrizzleDb, id);
        // Sent after the approval has committed, never inside it.
        await this.jobs.sendOperation(id, 1).catch(() => undefined); // the minute sweep sends it if this cannot be queued
      },
      onRejected: async (id, tx, info) => {
        await (tx as unknown as DrizzleDb).update(providerOperations).set({ status: 'rejected', failureCode: 'REJECTED', failureReason: orElse(info.comment, info.reasonCode), updatedAt: new Date() }).where(and(eq(providerOperations.id, id), eq(providerOperations.status, 'pending_approval')));
      },
      onReopened: async () => {},
      onCanceled: async (id, tx) => {
        await (tx as unknown as DrizzleDb).update(providerOperations).set({ status: 'cancelled', failureCode: 'WITHDRAWN', failureReason: 'The request was withdrawn.', updatedAt: new Date() }).where(and(eq(providerOperations.id, id), eq(providerOperations.status, 'pending_approval')));
      },
      describe: async (id) => {
        const op = await this.ops.get(id);
        if (!op) return null;
        const i = op.input;
        const info = DARAJA_OPERATIONS[op.operation as DarajaOperationCode];
        const to = [i.phone, i.partyB, i.prn, i.transactionId].find((v) => typeof v === 'string');
        return { title: `${info?.label ?? op.operation}: KES ${Number(op.amount ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}${has(to) ? ` to ${String(to)}` : ''}`, lines: [typeof i.remarks === 'string' ? `Remarks: ${i.remarks}` : '', typeof i.accountReference === 'string' ? `Account: ${i.accountReference}` : ''].filter(Boolean) };
      },
    };
  }
}
