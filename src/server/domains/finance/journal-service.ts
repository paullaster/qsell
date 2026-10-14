import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { financeSettings, glAccounts, journalBatches, journalLines } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { formatAmount, parseAmount } from './domain/amount';
import type { PostingRequest } from './domain/types';
import { type PostingEngine, PostingError, type PostingPermissions, type PostingPreview } from './engine';
import { FinanceError, type FinanceContext } from './errors';

export interface LineInput {
  postingDate: string;
  documentNo: string;
  accountId: string;
  description?: string | null;
  debit: string;
  credit: string;
  /** Defaults to the base currency. */
  currency?: string;
  rate?: string;
  dimensionSetId?: string | null;
}

export interface DocumentGroupPreview extends PostingPreview {
  documentNo: string;
  postingDate: string;
  currency: string;
}

const CHAIN = 'general';

export class JournalService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly engine: PostingEngine,
    private readonly decisions: DecisionLog,
  ) {}

  async listBatches(companyId: string) {
    const rows = await this.db
      .select({
        id: journalBatches.id,
        code: journalBatches.code,
        name: journalBatches.name,
        createdAt: journalBatches.createdAt,
        lineCount: sql<number>`(select count(*)::int from journal_lines l where l.batch_id = ${journalBatches.id})`,
      })
      .from(journalBatches)
      .where(eq(journalBatches.companyId, companyId))
      .orderBy(asc(journalBatches.code));
    return rows;
  }

  async createBatch(ctx: FinanceContext, code: string, name: string) {
    if (code.trim() === '' || name.trim() === '') throw new FinanceError('BATCH_INVALID', 'A batch needs a code and a name.');
    const [dup] = await this.db
      .select({ id: journalBatches.id })
      .from(journalBatches)
      .where(and(eq(journalBatches.companyId, ctx.companyId), eq(journalBatches.code, code.trim())));
    if (dup) throw new FinanceError('DUPLICATE_BATCH', `Batch ${code} already exists.`);
    const [row] = await this.db
      .insert(journalBatches)
      .values({ companyId: ctx.companyId, code: code.trim(), name: name.trim(), createdBy: ctx.actor.id ?? 'system' })
      .returning();
    return row;
  }

  async getBatch(companyId: string, batchId: string) {
    const [batch] = await this.db
      .select()
      .from(journalBatches)
      .where(and(eq(journalBatches.companyId, companyId), eq(journalBatches.id, batchId)));
    if (!batch) return null;
    const lines = await this.db
      .select({
        id: journalLines.id,
        lineNo: journalLines.lineNo,
        postingDate: journalLines.postingDate,
        documentNo: journalLines.documentNo,
        accountId: journalLines.accountId,
        accountNo: glAccounts.no,
        accountName: glAccounts.name,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
        currency: journalLines.currency,
        rate: journalLines.rate,
      })
      .from(journalLines)
      .innerJoin(glAccounts, eq(glAccounts.id, journalLines.accountId))
      .where(eq(journalLines.batchId, batchId))
      .orderBy(asc(journalLines.lineNo));
    return { batch, lines };
  }

  private async assertBatch(ctx: FinanceContext, batchId: string) {
    const [batch] = await this.db
      .select()
      .from(journalBatches)
      .where(and(eq(journalBatches.companyId, ctx.companyId), eq(journalBatches.id, batchId)));
    if (!batch) throw new FinanceError('NOT_FOUND', 'That batch does not exist.');
    return batch;
  }

  private normalise(input: LineInput) {
    const debit = parseAmount(input.debit === '' ? '0' : input.debit);
    const credit = parseAmount(input.credit === '' ? '0' : input.credit);
    if (debit < 0n || credit < 0n) throw new FinanceError('AMOUNT_NEGATIVE', 'Enter debits and credits as positive amounts.');
    if ((debit === 0n) === (credit === 0n)) {
      throw new FinanceError('ONE_SIDE_ONLY', 'A line needs either a debit or a credit, not both and not neither.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.postingDate)) throw new FinanceError('DATE_INVALID', 'The posting date is not a date.');
    if (input.documentNo.trim() === '') throw new FinanceError('DOC_REQUIRED', 'Each line needs a document number.');
    return { debit, credit };
  }

  async saveLine(ctx: FinanceContext, batchId: string, input: LineInput, lineId?: string) {
    await this.assertBatch(ctx, batchId);
    const { debit, credit } = this.normalise(input);
    const [settings] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId));
    if (!settings) throw new FinanceError('NOT_SET_UP', 'Apply a chart of accounts first.');
    const [account] = await this.db
      .select({ id: glAccounts.id })
      .from(glAccounts)
      .where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, input.accountId)));
    if (!account) throw new FinanceError('ACCOUNT_UNKNOWN', 'That account does not exist.');
    const values = {
      postingDate: input.postingDate,
      documentNo: input.documentNo.trim(),
      accountId: input.accountId,
      description: input.description?.trim() || null,
      debit: formatAmount(debit),
      credit: formatAmount(credit),
      currency: input.currency ?? settings.baseCurrency,
      rate: input.rate ?? '1',
      dimensionSetId: input.dimensionSetId ?? null,
      updatedAt: new Date(),
    };
    if (lineId) {
      await this.db.update(journalLines).set(values).where(and(eq(journalLines.id, lineId), eq(journalLines.batchId, batchId)));
      return lineId;
    }
    const [{ next }] = await this.db
      .select({ next: sql<number>`coalesce(max(${journalLines.lineNo}), 0) + 1` })
      .from(journalLines)
      .where(eq(journalLines.batchId, batchId));
    const [row] = await this.db
      .insert(journalLines)
      .values({ batchId, lineNo: next ?? 1, createdBy: ctx.actor.id ?? 'system', ...values })
      .returning({ id: journalLines.id });
    return row.id;
  }

  async deleteLine(ctx: FinanceContext, batchId: string, lineId: string) {
    await this.assertBatch(ctx, batchId);
    await this.db.delete(journalLines).where(and(eq(journalLines.id, lineId), eq(journalLines.batchId, batchId)));
  }

  /** Lines of a batch grouped into the documents they will post as. */
  private async groups(batchId: string) {
    const lines = await this.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.batchId, batchId))
      .orderBy(asc(journalLines.lineNo));
    const map = new Map<string, typeof lines>();
    for (const l of lines) {
      const key = `${l.documentNo}|${l.postingDate}|${l.currency}|${l.rate}`;
      map.set(key, [...(map.get(key) ?? []), l]);
    }
    return [...map.values()];
  }

  private requestFor(ctx: FinanceContext, batchId: string, lines: (typeof journalLines.$inferSelect)[]): PostingRequest {
    const first = lines[0];
    const fingerprint = createHash('sha256')
      .update(lines.map((l) => l.id).sort().join(','))
      .digest('hex')
      .slice(0, 32);
    return {
      companyId: ctx.companyId,
      idempotencyKey: `journal:${batchId}:${fingerprint}`,
      postingDate: first.postingDate,
      documentType: 'journal',
      documentNo: first.documentNo,
      description: first.description ?? undefined,
      currency: first.currency,
      rate: first.rate,
      rateSource: first.rate === '1' ? 'base' : 'manual',
      lines: lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        dimensionSetId: l.dimensionSetId,
        currency: l.currency,
      })),
      chainKey: CHAIN,
      origin: ctx.origin,
      source: { type: 'journal_batch', id: batchId },
      postedBy: 'user',
    };
  }

  /** What posting the whole batch would write, per document. Writes nothing. */
  async preview(ctx: FinanceContext, batchId: string, perms: PostingPermissions): Promise<DocumentGroupPreview[]> {
    await this.assertBatch(ctx, batchId);
    const groups = await this.groups(batchId);
    const out: DocumentGroupPreview[] = [];
    for (const g of groups) {
      const req = this.requestFor(ctx, batchId, g);
      out.push({ ...(await this.engine.preview(req, perms)), documentNo: req.documentNo, postingDate: req.postingDate, currency: req.currency });
    }
    return out;
  }

  /** Posts every document in the batch or none of them, then clears the draft lines. */
  async post(ctx: FinanceContext, batchId: string, perms: PostingPermissions) {
    await this.assertBatch(ctx, batchId);
    const groups = await this.groups(batchId);
    if (groups.length === 0) throw new FinanceError('NOTHING_TO_POST', 'The batch has no lines to post.');
    try {
      return await this.db.transaction(async (tx) => {
        const posted = [];
        for (const g of groups) {
          posted.push(await this.engine.post(this.requestFor(ctx, batchId, g), perms, tx));
        }
        await tx.delete(journalLines).where(inArray(journalLines.id, groups.flat().map((l) => l.id)));
        await this.decisions.record(
          {
            companyId: ctx.companyId,
            subject: { type: 'journal_batch', id: batchId },
            action: 'finance.journal_batch_posted',
            actor: ctx.actor,
            inputs: { origin: ctx.origin },
            outcome: { registers: posted.map((p) => p.registerId) },
          },
          tx,
        );
        return posted;
      });
    } catch (error) {
      if (error instanceof PostingError) throw new FinanceError(error.code, error.message, error.issues);
      throw error;
    }
  }
}
