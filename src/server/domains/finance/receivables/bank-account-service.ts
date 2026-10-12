import { and, asc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankLedgerEntries,
  glAccounts,
  paymentMethods,
  type BankAccountRow,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { FinanceError, type FinanceContext } from '../errors';

export interface BankAccountInput {
  code: string;
  name: string;
  kind: 'bank' | 'cash' | 'mobile_money' | 'clearing';
  currency: string;
  glAccountId: string;
  feeGlAccountId?: string | null;
  branchId?: string | null;
  providerConfigId?: string | null;
  details?: Record<string, string>;
  statementFormat?: string | null;
}

const KINDS = ['bank', 'cash', 'mobile_money', 'clearing'] as const;

/** Bank, cash, mobile-money and clearing accounts: where money sits, and which G/L account carries it. */
export class BankAccountService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  async list(companyId: string) {
    const rows = await this.db
      .select({
        account: bankAccounts,
        glNo: glAccounts.no,
        glName: glAccounts.name,
        balance: sql<string>`COALESCE((SELECT SUM(l.amount) FROM bank_ledger_entries l WHERE l.bank_account_id = ${bankAccounts.id}), 0)`,
        methods: sql<number>`(SELECT COUNT(*)::int FROM payment_methods m WHERE m.balancing_bank_account_id = ${bankAccounts.id})`,
      })
      .from(bankAccounts)
      .innerJoin(glAccounts, eq(glAccounts.id, bankAccounts.glAccountId))
      .where(eq(bankAccounts.companyId, companyId))
      .orderBy(asc(bankAccounts.code));
    return rows;
  }

  async get(companyId: string, id: string): Promise<BankAccountRow | null> {
    const [row] = await this.db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, id)))
      .limit(1);
    return row ?? null;
  }

  private async checkGl(db: Pick<DrizzleDb, 'select'>, companyId: string, id: string, label: string) {
    const [gl] = await db
      .select()
      .from(glAccounts)
      .where(and(eq(glAccounts.companyId, companyId), eq(glAccounts.id, id)))
      .limit(1);
    if (!gl) throw new FinanceError('ACCOUNT_NOT_FOUND', `The ${label} account does not exist.`);
    if (gl.type !== 'posting') throw new FinanceError('ACCOUNT_NOT_POSTING', `${gl.no} ${gl.name} is a heading; pick an account that can be posted to.`);
    if (gl.blocked) throw new FinanceError('ACCOUNT_BLOCKED', `${gl.no} ${gl.name} is blocked.`);
    return gl;
  }

  private validate(input: BankAccountInput) {
    if (!input.code.trim() || !input.name.trim()) {
      throw new FinanceError('INVALID', 'A bank account needs a code and a name.');
    }
    if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(input.code.trim())) {
      throw new FinanceError('CODE_INVALID', 'The code uses capital letters, digits, "-" or "_" (up to 20).');
    }
    if (!KINDS.includes(input.kind)) throw new FinanceError('INVALID', 'Unknown kind of account.');
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new FinanceError('CURRENCY_INVALID', 'The currency is a 3-letter code such as KES.');
  }

  async create(ctx: FinanceContext, input: BankAccountInput): Promise<BankAccountRow> {
    this.validate(input);
    return this.db.transaction(async (tx) => {
      const gl = await this.checkGl(tx, ctx.companyId, input.glAccountId, 'ledger');
      if (gl.category !== 'assets') {
        throw new FinanceError('ACCOUNT_NOT_ASSET', `${gl.no} ${gl.name} is not an asset account; money held by the business is an asset.`);
      }
      if (gl.currencyPolicy !== 'any' && gl.currencyPolicy !== input.currency) {
        throw new FinanceError('CURRENCY_MISMATCH', `${gl.no} only carries ${gl.currencyPolicy}.`);
      }
      if (input.feeGlAccountId) await this.checkGl(tx, ctx.companyId, input.feeGlAccountId, 'fee');
      const [dup] = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.code, input.code.trim())));
      if (dup) throw new FinanceError('DUPLICATE', `A bank account with code ${input.code} already exists.`);
      const [row] = await tx
        .insert(bankAccounts)
        .values({
          companyId: ctx.companyId,
          code: input.code.trim(),
          name: input.name.trim(),
          kind: input.kind,
          currency: input.currency,
          glAccountId: input.glAccountId,
          feeGlAccountId: input.feeGlAccountId ?? null,
          branchId: input.branchId ?? null,
          providerConfigId: input.providerConfigId ?? null,
          details: input.details ?? {},
          statementFormat: input.statementFormat ?? null,
          createdBy: ctx.actor.id ?? 'system',
        })
        .returning();
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'bank_account', id: row!.id },
          action: 'finance.bank_account_created',
          actor: ctx.actor,
          inputs: { origin: ctx.origin },
          outcome: { code: row!.code, kind: row!.kind, glAccount: gl.no, currency: row!.currency },
        },
        tx,
      );
      return row!;
    });
  }

  async update(ctx: FinanceContext, id: string, input: Partial<BankAccountInput>): Promise<BankAccountRow> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, id)))
        .for('update');
      if (!current) throw new FinanceError('NOT_FOUND', 'That bank account does not exist.');
      const [moved] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(bankLedgerEntries)
        .where(eq(bankLedgerEntries.bankAccountId, id));
      const used = (moved?.n ?? 0) > 0;
      if (used && input.glAccountId && input.glAccountId !== current.glAccountId) {
        throw new FinanceError('ACCOUNT_IN_USE', 'Money has moved through this account, so its ledger account cannot change.');
      }
      if (used && input.currency && input.currency !== current.currency) {
        throw new FinanceError('ACCOUNT_IN_USE', 'Money has moved through this account, so its currency cannot change.');
      }
      if (used && input.kind && input.kind !== current.kind) {
        throw new FinanceError('ACCOUNT_IN_USE', 'Money has moved through this account, so its kind cannot change.');
      }
      const next = { ...current, ...stripUndefined(input) } as BankAccountRow;
      this.validate({ ...next, details: next.details });
      if (input.glAccountId) {
        const gl = await this.checkGl(tx, ctx.companyId, input.glAccountId, 'ledger');
        if (gl.category !== 'assets') throw new FinanceError('ACCOUNT_NOT_ASSET', `${gl.no} ${gl.name} is not an asset account.`);
      }
      if (input.feeGlAccountId) await this.checkGl(tx, ctx.companyId, input.feeGlAccountId, 'fee');
      if (input.code && input.code !== current.code) {
        throw new FinanceError('CODE_FIXED', 'The code of a bank account does not change; block it and add a new one.');
      }
      const [row] = await tx
        .update(bankAccounts)
        .set({
          name: next.name,
          kind: next.kind,
          currency: next.currency,
          glAccountId: next.glAccountId,
          feeGlAccountId: next.feeGlAccountId,
          branchId: next.branchId,
          providerConfigId: next.providerConfigId,
          details: next.details,
          statementFormat: next.statementFormat,
          updatedAt: new Date(),
        })
        .where(eq(bankAccounts.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'bank_account', id },
          action: 'finance.bank_account_updated',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, changed: Object.keys(stripUndefined(input)) },
        },
        tx,
      );
      return row!;
    });
  }

  async setBlocked(ctx: FinanceContext, id: string, blocked: boolean, reason?: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(bankAccounts)
        .set({ blocked, updatedAt: new Date() })
        .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, id)))
        .returning({ id: bankAccounts.id });
      if (!row) throw new FinanceError('NOT_FOUND', 'That bank account does not exist.');
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'bank_account', id },
          action: blocked ? 'finance.bank_account_blocked' : 'finance.bank_account_unblocked',
          actor: ctx.actor,
          reason: reason ? { text: reason } : undefined,
          inputs: { origin: ctx.origin },
        },
        tx,
      );
    });
  }

  async delete(ctx: FinanceContext, id: string) {
    await this.db.transaction(async (tx) => {
      const [acct] = await tx
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.id, id)))
        .for('update');
      if (!acct) throw new FinanceError('NOT_FOUND', 'That bank account does not exist.');
      const [moved] = await tx.select({ id: bankLedgerEntries.id }).from(bankLedgerEntries).where(eq(bankLedgerEntries.bankAccountId, id)).limit(1);
      if (moved) throw new FinanceError('ACCOUNT_IN_USE', 'Money has moved through this account; block it instead of deleting it.');
      const [method] = await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.balancingBankAccountId, id)).limit(1);
      if (method) throw new FinanceError('ACCOUNT_IN_USE', 'A payment method uses this account. Point the method elsewhere first.');
      await tx.delete(bankAccounts).where(eq(bankAccounts.id, id));
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'bank_account', id },
          action: 'finance.bank_account_deleted',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, code: acct.code },
        },
        tx,
      );
    });
  }

  /** The bank ledger of one account, newest first, with a running balance computed in the database. */
  async ledger(companyId: string, id: string, limit = 200) {
    const rows = await this.db.execute<{
      id: string; posting_date: string; document_type: string; document_no: string;
      description: string | null; amount: string; currency: string; running: string; register_id: string | null;
    }>(sql`
      SELECT * FROM (
        SELECT l.id, l.posting_date, l.document_type, l.document_no, l.description, l.amount, l.currency, l.register_id,
               SUM(l.amount) OVER (ORDER BY l.posting_date, l.id) AS running
        FROM bank_ledger_entries l
        WHERE l.company_id = ${companyId} AND l.bank_account_id = ${id}
      ) t ORDER BY posting_date DESC, id DESC LIMIT ${limit}`);
    return [...rows];
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
