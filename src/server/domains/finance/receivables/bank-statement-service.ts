import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankLedgerEntries,
  bankMatchRules,
  bankStatementFormats,
  bankStatementImports,
  bankStatementLines,
  bankStatementMatches,
  customerReceipts,
  customers,
  financeSettings,
  glAccounts,
  paymentMethods,
  receiptEvents,
  refundEvents,
  refundRequests,
  type BankAccountRow,
  type StatementLineStatus,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import {
  MPESA_MAPPING,
  centsOf,
  parseCsvStatement,
  parseMt940,
  readHeaders,
  suggestMatches,
  withHashes,
  type CsvMapping,
  type ParsedStatement,
} from '../domain/bank-statement';
import { fromCents } from '../domain/receivables';
import { checkChargeSplit, type ChargePartInput } from '@/lib/charge-split';
import type { PostingRequest } from '../domain/types';
import { NO_SPECIAL_PERMISSIONS, type PostingEngine, type PostingPermissions, type Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { FxService } from '../fx-service';
import type { ReceiptService } from './receipt-service';
import type { StatementFormat } from '../domain/statement-file';
import { parseCamt053 } from '../domain/bank-statement-camt';
import { DEFAULT_RULES, checkRules, phoneKeyOf, type MatchRules } from '../domain/bank-match';

import { has, orElse, required } from '@/lib/values';

export type { StatementFormat } from '../domain/statement-file';
export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
const CHUNK = 2000;
/** Same amount within this many days is worth suggesting. */
const WINDOW_DAYS = 3;

export interface ImportInput {
  bankAccountId: string;
  fileName: string;
  text: string;
  format: StatementFormat;
  mapping?: CsvMapping;
  saveFormat?: boolean;
}

/**
 * What the bank says happened, and what we did about each line: matched to our own records,
 * turned into a receipt or a bank charge, or set aside with a reason. Nothing here changes the
 * bank's words; every decision is kept with who made it and why.
 */
/** The only item of a list, or nothing when there are none or several. */
function onlyOne<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

export class BankStatementService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly receipts: ReceiptService,
    private readonly numbering: NumberSeriesService,
    private readonly reasons: ReasonCodes,
    private readonly fx: FxService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  private async account(db: Pick<DrizzleDb, 'select'>, companyId: string, id: string): Promise<BankAccountRow> {
    const [a] = await db.select().from(bankAccounts).where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, id)));
    if (!a) throw new FinanceError('ACCOUNT_NOT_FOUND', 'That bank account does not exist.');
    return a;
  }

  private async statementAccount(companyId: string, id: string) {
    const a = await this.account(this.db, companyId, id);
    if (a.kind === 'clearing') throw new FinanceError('ACCOUNT_KIND', `${a.code} is a clearing account: it has no statement of its own.`);
    return a;
  }

  private async glLive(tx: Pick<DrizzleDb, 'select'>, companyId: string, date: string) {
    const [s] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
    return { s, live: s.salesGlGoLive !== null && date >= s.salesGlGoLive };
  }

  // ── formats ──────────────────────────────────────────────────────────────

  async getFormat(companyId: string, bankAccountId: string) {
    const [f] = await this.db.select().from(bankStatementFormats).where(and(eq(bankStatementFormats.companyId, companyId), eq(bankStatementFormats.bankAccountId, bankAccountId)));
    return f ?? null;
  }

  /** The columns of a file, with a few rows to look at, so the person can say which is which. */
  inspect(text: string, headerRow = 1) {
    if (Buffer.byteLength(text) > MAX_STATEMENT_BYTES) throw new FinanceError('FILE_TOO_LARGE', 'That file is larger than 10 MB. Split it by month.');
    const { headers, sample } = readHeaders(text, headerRow);
    const lc = headers.map((h) => h.toLowerCase());
    const suggested = lc.includes('receipt no.') && lc.includes('paid in') ? MPESA_MAPPING : null;
    return { headers, sample, suggested };
  }

  private parse(text: string, format: StatementFormat, mapping?: CsvMapping): ParsedStatement {
    if (Buffer.byteLength(text) > MAX_STATEMENT_BYTES) throw new FinanceError('FILE_TOO_LARGE', 'That file is larger than 10 MB. Split it by month.');
    if (format === 'mt940') return parseMt940(text);
    if (format === 'camt053') return parseCamt053(text);
    if (!mapping) throw new FinanceError('MAPPING_REQUIRED', 'Say which column is which before importing this file.');
    return parseCsvStatement(text, mapping);
  }

  /** What importing would do, without doing it. */
  async preview(companyId: string, input: Omit<ImportInput, 'fileName' | 'saveFormat'>) {
    await this.statementAccount(companyId, input.bankAccountId);
    const parsed = this.parse(input.text, input.format, input.mapping);
    const hashed = withHashes(parsed.lines.map((l) => ({ ...l, description: l.description })));
    const existing = hashed.length === 0 ? [] : await this.db.select({ h: bankStatementLines.lineHash }).from(bankStatementLines).where(and(eq(bankStatementLines.bankAccountId, input.bankAccountId), inArray(bankStatementLines.lineHash, hashed.map((l) => l.lineHash).slice(0, 50000))));
    const have = new Set(existing.map((e) => e.h));
    const fresh = hashed.filter((l) => !have.has(l.lineHash));
    const sum = (f: (n: number) => boolean) => fresh.filter((l) => f(l.amountCents)).reduce((n, l) => n + l.amountCents, 0);
    return {
      errors: parsed.errors.slice(0, 20),
      errorCount: parsed.errors.length,
      lineCount: parsed.lines.length,
      newCount: fresh.length,
      duplicateCount: hashed.length - fresh.length,
      skippedCount: parsed.skipped.length,
      totalIn: fromCents(sum((n) => n > 0)),
      totalOut: fromCents(-sum((n) => n < 0)),
      dateFrom: parsed.lines[0]?.date ?? null,
      dateTo: parsed.lines[parsed.lines.length - 1]?.date ?? null,
      opening: parsed.openingCents === null ? null : fromCents(parsed.openingCents),
      closing: parsed.closingCents === null ? null : fromCents(parsed.closingCents),
      balanceBreaks: parsed.balanceBreaks.slice(0, 10),
      first: parsed.lines.slice(0, 5).map((l) => ({ date: l.date, description: l.description, reference: l.reference, amount: fromCents(l.amountCents) })),
    };
  }

  // ── import ───────────────────────────────────────────────────────────────

  async import(ctx: FinanceContext, input: ImportInput) {
    const account = await this.statementAccount(ctx.companyId, input.bankAccountId);
    if (account.blocked) throw new FinanceError('BANK_BLOCKED', `${account.code} is blocked.`);
    const fileHash = createHash('sha256').update(input.text).digest('hex');
    const [dupFile] = await this.db.select({ id: bankStatementImports.id, at: bankStatementImports.createdAt }).from(bankStatementImports).where(and(eq(bankStatementImports.bankAccountId, account.id), eq(bankStatementImports.fileHash, fileHash)));
    if (dupFile) throw new FinanceError('ALREADY_IMPORTED', `This exact file was already imported on ${dupFile.at.toISOString().slice(0, 10)}.`);
    const parsed = this.parse(input.text, input.format, input.mapping);
    return await this.importParsed(ctx, account, parsed, { fileName: input.fileName, fileHash, format: input.format, mapping: input.mapping, saveFormat: input.saveFormat });
  }

  /**
   * Keeps statement lines that have already been read, whatever they were read from (a file, a bank's push). A line already
   * kept from another delivery is left out; a delivery with any unreadable line is refused whole.
   */
  async importParsed(
    ctx: FinanceContext,
    account: BankAccountRow,
    parsed: ParsedStatement,
    meta: { fileName: string; fileHash: string; format: string; mapping?: CsvMapping; saveFormat?: boolean },
  ) {
    const input = { ...meta, bankAccountId: account.id };
    if (parsed.errors.length > 0) {
      throw new FinanceError('STATEMENT_UNREADABLE', `The file was not imported. ${parsed.errors.slice(0, 3).map((e) => e.message).join(' ')}${parsed.errors.length > 3 ? ` (and ${parsed.errors.length - 3} more)` : ''}`);
    }
    const horizon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const future = parsed.lines.find((l) => l.date > horizon);
    if (future) throw new FinanceError('FUTURE_DATES', `Line ${future.lineNo} is dated ${future.date}, in the future. If the dates are month-first, choose that format and try again.`);
    const fileHash = meta.fileHash;
    const hashed = withHashes(parsed.lines);

    const result = await this.db.transaction(async (tx) => {
      const have = new Set<string>();
      for (let i = 0; i < hashed.length; i += 5000) {
        const rows = await tx.select({ h: bankStatementLines.lineHash }).from(bankStatementLines).where(and(eq(bankStatementLines.bankAccountId, account.id), inArray(bankStatementLines.lineHash, hashed.slice(i, i + 5000).map((l) => l.lineHash))));
        for (const r of rows) have.add(r.h);
      }
      const fresh = hashed.filter((l) => !have.has(l.lineHash));
      if (fresh.length === 0) throw new FinanceError('NOTHING_NEW', 'Every line in this file was already imported from another file.');
      const totalIn = fresh.filter((l) => l.amountCents > 0).reduce((n, l) => n + l.amountCents, 0);
      const totalOut = fresh.filter((l) => l.amountCents < 0).reduce((n, l) => n - l.amountCents, 0);
      const [imp] = await tx
        .insert(bankStatementImports)
        .values({
          companyId: ctx.companyId,
          bankAccountId: account.id,
          fileName: input.fileName.slice(0, 200),
          fileHash,
          format: input.format,
          lineCount: fresh.length,
          skippedCount: parsed.skipped.length + (hashed.length - fresh.length),
          totalIn: fromCents(totalIn),
          totalOut: fromCents(totalOut),
          dateFrom: fresh[0].date,
          dateTo: fresh[fresh.length - 1].date,
          openingBalance: parsed.openingCents === null ? null : fromCents(parsed.openingCents),
          closingBalance: parsed.closingCents === null ? null : fromCents(parsed.closingCents),
          importedBy: ctx.actor.id ?? 'system',
          origin: ctx.origin,
        })
        .returning({ id: bankStatementImports.id });
      for (let i = 0; i < fresh.length; i += CHUNK) {
        await tx.insert(bankStatementLines).values(
          fresh.slice(i, i + CHUNK).map((l) => ({
            companyId: ctx.companyId,
            importId: imp.id,
            bankAccountId: account.id,
            lineNo: l.lineNo,
            lineDate: l.date,
            description: l.description.slice(0, 1000),
            reference: l.reference?.slice(0, 200) ?? null,
            counterparty: l.counterparty?.slice(0, 200) ?? null,
            amount: fromCents(l.amountCents),
            balance: l.balanceCents === null ? null : fromCents(l.balanceCents),
            lineHash: l.lineHash,
          })),
        );
      }
      if (input.saveFormat === true && input.format === 'csv' && input.mapping) {
        await tx
          .insert(bankStatementFormats)
          .values({ companyId: ctx.companyId, bankAccountId: account.id, kind: 'csv', mapping: input.mapping as unknown as Record<string, unknown>, updatedBy: ctx.actor.id ?? 'system' })
          .onConflictDoUpdate({ target: bankStatementFormats.bankAccountId, set: { mapping: input.mapping as unknown as Record<string, unknown>, updatedBy: ctx.actor.id ?? 'system', updatedAt: new Date() } });
      }
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'bank_statement_import', id: imp.id },
          action: 'finance.statement_imported',
          actor: ctx.actor,
          inputs: { origin: ctx.origin, file: input.fileName, account: account.code },
          outcome: { lines: fresh.length, duplicates: hashed.length - fresh.length, totalIn: fromCents(totalIn), totalOut: fromCents(totalOut) },
        },
        tx,
      );
      return { importId: imp.id, lines: fresh.length, duplicates: hashed.length - fresh.length, balanceBreaks: parsed.balanceBreaks.length };
    });
    const matched = await this.autoMatch(ctx, account.id);
    return { ...result, ...matched };
  }

  // ── matching ─────────────────────────────────────────────────────────────

  // ── matching rules ───────────────────────────────────────────────────────

  /** The rules for an account: its own if it has them, else the company's, else the standard ones. */
  async rulesFor(companyId: string, bankAccountId: string | null): Promise<{ rules: MatchRules; scope: 'account' | 'company' | 'standard' }> {
    const rows = await this.db.select().from(bankMatchRules).where(eq(bankMatchRules.companyId, companyId));
    const read = (raw: Record<string, unknown> | undefined): MatchRules | null => {
      if (raw === undefined) return null;
      const checked = checkRules(raw);
      return checked.ok ? checked.rules : null;
    };
    const own = bankAccountId === null ? null : read(rows.find((r) => r.bankAccountId === bankAccountId)?.rules);
    if (own !== null) return { rules: own, scope: 'account' };
    const shared = read(rows.find((r) => r.bankAccountId === null)?.rules);
    return shared === null ? { rules: DEFAULT_RULES, scope: 'standard' } : { rules: shared, scope: 'company' };
  }

  /** Saves the rules for one account, or (with no account) for every account that has none of its own. Matching runs again after. */
  async saveRules(ctx: FinanceContext, bankAccountId: string | null, raw: Record<string, unknown>): Promise<MatchRules> {
    const checked = checkRules(raw);
    if (!checked.ok) throw new FinanceError('RULES_INVALID', checked.error);
    if (bankAccountId !== null) await this.statementAccount(ctx.companyId, bankAccountId);
    await this.db.transaction(async (tx) => {
      const [same] = await tx.select({ id: bankMatchRules.id }).from(bankMatchRules).where(and(eq(bankMatchRules.companyId, ctx.companyId), bankAccountId === null ? isNull(bankMatchRules.bankAccountId) : eq(bankMatchRules.bankAccountId, bankAccountId))).for('update');
      if (same) await tx.update(bankMatchRules).set({ rules: checked.rules as unknown as Record<string, unknown>, updatedBy: ctx.actor.id ?? 'system', updatedAt: new Date() }).where(eq(bankMatchRules.id, same.id));
      else await tx.insert(bankMatchRules).values({ companyId: ctx.companyId, bankAccountId, rules: checked.rules as unknown as Record<string, unknown>, updatedBy: ctx.actor.id ?? 'system' });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_match_rules', id: bankAccountId ?? ctx.companyId }, action: 'finance.bank_match_rules_saved', actor: ctx.actor, inputs: { origin: ctx.origin }, outcome: { ...checked.rules } }, tx);
    });
    return checked.rules;
  }

  /** Ledger entries not yet closed against any line, with the words the bank might quote back. */
  private async openEntries(db: Pick<DrizzleDb, 'select'>, companyId: string, bankAccountId: string, from?: string, to?: string) {
    const rows = await db
      .select({
        e: bankLedgerEntries,
        extRef: customerReceipts.externalReference,
        payoutRef: refundRequests.payoutReference,
        customerName: customers.name,
        customerPhone: customers.phone,
      })
      .from(bankLedgerEntries)
      .leftJoin(customerReceipts, and(eq(customerReceipts.id, bankLedgerEntries.documentId), eq(bankLedgerEntries.documentType, 'customer_receipt')))
      .leftJoin(refundRequests, and(eq(refundRequests.id, bankLedgerEntries.documentId), eq(bankLedgerEntries.documentType, 'refund')))
      .leftJoin(customers, eq(customers.id, sql`coalesce(${customerReceipts.customerId}, ${refundRequests.customerId})`))
      .where(
        and(
          eq(bankLedgerEntries.companyId, companyId),
          eq(bankLedgerEntries.bankAccountId, bankAccountId),
          has(from) ? sql`${bankLedgerEntries.postingDate} >= ${from}::date` : undefined,
          has(to) ? sql`${bankLedgerEntries.postingDate} <= ${to}::date` : undefined,
          sql`NOT EXISTS (SELECT 1 FROM bank_statement_matches m WHERE m.bank_entry_id = ${bankLedgerEntries.id} AND m.undone_at IS NULL)`,
        ),
      )
      .orderBy(asc(bankLedgerEntries.postingDate), asc(bankLedgerEntries.id))
      .limit(50000);
    return rows.map((r) => ({
      id: r.e.id,
      date: r.e.postingDate,
      amountCents: centsOf(r.e.amount),
      refs: [r.e.documentNo, r.extRef, r.payoutRef].filter((x): x is string => Boolean(x)),
      phones: [phoneKeyOf(r.customerPhone)].filter((x): x is string => x !== null),
      names: [r.customerName].filter((x): x is string => has(x)),
      entry: r.e,
    }));
  }

  /**
   * Looks at every line still waiting and closes the certain ones by itself (the bank quoted our
   * own reference, same amount); the likely ones are only suggested. Never touches reconciled lines.
   */
  async autoMatch(ctx: FinanceContext, bankAccountId: string, max = 20000): Promise<{ autoMatched: number; proposed: number }> {
    const lines = await this.db
      .select()
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.companyId, ctx.companyId), eq(bankStatementLines.bankAccountId, bankAccountId), inArray(bankStatementLines.status, ['unmatched', 'proposed']), isNull(bankStatementLines.reconciliationId)))
      .orderBy(asc(bankStatementLines.lineDate), asc(bankStatementLines.id))
      .limit(max);
    if (lines.length === 0) return { autoMatched: 0, proposed: 0 };
    const { rules } = await this.rulesFor(ctx.companyId, bankAccountId);
    const pad = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const reach = Math.max(rules.dateWindowDays, WINDOW_DAYS) + 30;
    const entries = await this.openEntries(this.db, ctx.companyId, bankAccountId, pad(lines[0].lineDate, -reach), pad(lines[lines.length - 1].lineDate, reach));
    const suggestions = suggestMatches(
      lines.map((l) => ({ id: l.id, date: l.lineDate, amountCents: centsOf(l.amount), description: l.description, reference: l.reference, counterparty: l.counterparty })),
      entries.map((e) => ({ id: e.id, date: e.date, amountCents: e.amountCents, refs: e.refs, phones: e.phones, names: e.names })),
      { rules },
    );
    let autoMatched = 0;
    let proposed = 0;
    const origin = { ...ctx.origin, action: orElse(ctx.origin.action, 'auto_match') };
    const actor = ctx.actor;
    for (const s of suggestions) {
      if (s.certainty === 'matched') {
        try {
          await this.db.transaction((tx) => this.applyMatchIn(tx, { ...ctx, origin, actor }, s.lineId, s.entryIds, `auto:${s.rule}`));
          autoMatched++;
        } catch {
          // Someone matched it meanwhile; the next run sees the new state.
        }
      } else {
        await this.db.update(bankStatementLines).set({ status: 'proposed', proposedEntryIds: s.entryIds, matchRule: s.rule }).where(and(eq(bankStatementLines.id, s.lineId), inArray(bankStatementLines.status, ['unmatched', 'proposed']), isNull(bankStatementLines.reconciliationId)));
        proposed++;
      }
    }
    return { autoMatched, proposed };
  }

  private async lockLine(tx: Tx, companyId: string, lineId: number) {
    const [l] = await tx.select().from(bankStatementLines).where(and(eq(bankStatementLines.companyId, companyId), eq(bankStatementLines.id, lineId))).for('update');
    if (!l) throw new FinanceError('LINE_NOT_FOUND', 'That statement line does not exist.');
    return l;
  }

  /** Closes one line against one or more ledger entries whose amounts add up to it exactly. */
  private async applyMatchIn(tx: Tx, ctx: FinanceContext, lineId: number, entryIds: number[], rule: string) {
    const line = await this.lockLine(tx, ctx.companyId, lineId);
    if (has(line.reconciliationId)) throw new FinanceError('LINE_RECONCILED', 'This line is already part of a reconciliation.');
    if (line.status === 'matched') throw new FinanceError('LINE_MATCHED', 'This line is already matched.');
    if (line.status === 'ignored') throw new FinanceError('LINE_IGNORED', 'This line was set aside. Bring it back first.');
    if (entryIds.length === 0) throw new FinanceError('NO_ENTRIES', 'Choose what this line matches.');
    const entries = await tx.select().from(bankLedgerEntries).where(and(eq(bankLedgerEntries.companyId, ctx.companyId), inArray(bankLedgerEntries.id, entryIds)));
    if (entries.length !== new Set(entryIds).size) throw new FinanceError('ENTRY_NOT_FOUND', 'One of those entries does not exist.');
    if (entries.some((e) => e.bankAccountId !== line.bankAccountId)) throw new FinanceError('WRONG_ACCOUNT', 'Those entries belong to a different bank account.');
    const total = entries.reduce((n, e) => n + centsOf(e.amount), 0);
    if (total !== centsOf(line.amount)) throw new FinanceError('AMOUNT_MISMATCH', `The bank says ${line.amount} but the entries add up to ${fromCents(total)}. A line is matched only to entries that add up to it exactly.`);
    const taken = await tx.select({ id: bankStatementMatches.bankEntryId }).from(bankStatementMatches).where(and(inArray(bankStatementMatches.bankEntryId, entryIds), isNull(bankStatementMatches.undoneAt)));
    if (taken.length > 0) throw new FinanceError('ENTRY_TAKEN', 'One of those entries is already matched to another line.');
    for (const e of entries) {
      // Two people may reach the same entry at once; the unique index decides and the loser is told why.
      await tx
        .insert(bankStatementMatches)
        .values({ companyId: ctx.companyId, lineId, bankEntryId: e.id, amount: e.amount, rule, actorType: ctx.actor.type, actorId: ctx.actor.id, origin: ctx.origin })
        .catch((error: unknown) => {
          if (JSON.stringify((error as { cause?: unknown }).cause ?? '').includes('bank_statement_matches_entry_open_uidx') || (error as { cause?: { code?: string } }).cause?.code === '23505') {
            throw new FinanceError('ENTRY_TAKEN', 'One of those entries was just matched to another line.');
          }
          throw error;
        });
    }
    await tx.update(bankStatementLines).set({ status: 'matched', matchRule: rule, proposedEntryIds: [] }).where(eq(bankStatementLines.id, lineId));
    await this.noteDocuments(tx, ctx, entries, 'bank_matched', line.id);
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_statement_line', id: String(lineId) }, action: 'finance.statement_line_matched', actor: ctx.actor, from: line.status, to: 'matched', inputs: { origin: ctx.origin, rule }, outcome: { entries: entryIds, amount: line.amount } }, tx);
  }

  /** Tells the refund or receipt that the bank has shown it (or no longer has). */
  private async noteDocuments(tx: Tx, ctx: FinanceContext, entries: { documentType: string; documentId: string | null; bankAccountId: string }[], event: 'bank_matched' | 'bank_unmatched', lineId: number) {
    for (const e of entries) {
      if (!has(e.documentId)) continue;
      if (e.documentType === 'refund') {
        await tx.update(refundRequests).set({ bankMatchedAt: event === 'bank_matched' ? new Date() : null }).where(eq(refundRequests.id, e.documentId));
        await tx.insert(refundEvents).values({ refundId: e.documentId, event, fromStatus: 'paid', toStatus: 'paid', data: { statementLine: lineId }, actorType: ctx.actor.type, actorId: ctx.actor.id, origin: ctx.origin });
      } else if (e.documentType === 'customer_receipt') {
        await tx.insert(receiptEvents).values({ receiptId: e.documentId, event, data: { statementLine: lineId }, actorType: ctx.actor.type, actorId: ctx.actor.id, origin: ctx.origin });
      }
    }
  }

  async matchLine(ctx: FinanceContext, lineId: number, entryIds: number[]) {
    await this.db.transaction((tx) => this.applyMatchIn(tx, ctx, lineId, entryIds, 'manual'));
  }

  async unmatchLine(ctx: FinanceContext, lineId: number, reason: { code: string; text?: string | null }) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'bank_statement');
    await this.db.transaction(async (tx) => {
      const line = await this.lockLine(tx, ctx.companyId, lineId);
      if (has(line.reconciliationId)) throw new FinanceError('LINE_RECONCILED', 'This line is part of a posted reconciliation. Reverse that reconciliation first.');
      if (line.status !== 'matched') throw new FinanceError('NOT_MATCHED', 'This line is not matched.');
      const active = await tx.select().from(bankStatementMatches).where(and(eq(bankStatementMatches.lineId, lineId), isNull(bankStatementMatches.undoneAt)));
      await tx.update(bankStatementMatches).set({ undoneAt: new Date(), undoneBy: ctx.actor.id, undoReasonCode: rs.code, undoReasonText: rs.text }).where(and(eq(bankStatementMatches.lineId, lineId), isNull(bankStatementMatches.undoneAt)));
      await tx.update(bankStatementLines).set({ status: 'unmatched', matchRule: null, proposedEntryIds: [] }).where(eq(bankStatementLines.id, lineId));
      const entries = await tx.select().from(bankLedgerEntries).where(inArray(bankLedgerEntries.id, active.map((a) => a.bankEntryId)));
      await this.noteDocuments(tx, ctx, entries, 'bank_unmatched', lineId);
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_statement_line', id: String(lineId) }, action: 'finance.statement_line_unmatched', actor: ctx.actor, from: 'matched', to: 'unmatched', reason: rs, inputs: { origin: ctx.origin } }, tx);
    });
  }

  /** Sets a line aside: the bank moved money we do not and will not record (with the reason). */
  async ignoreLine(ctx: FinanceContext, lineId: number, reason: { code: string; text?: string | null }) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'bank_statement');
    await this.db.transaction(async (tx) => {
      const line = await this.lockLine(tx, ctx.companyId, lineId);
      if (has(line.reconciliationId)) throw new FinanceError('LINE_RECONCILED', 'This line is part of a posted reconciliation.');
      if (line.status === 'matched') throw new FinanceError('LINE_MATCHED', 'Unmatch this line before setting it aside.');
      if (line.status === 'ignored') throw new FinanceError('LINE_IGNORED', 'This line is already set aside.');
      await tx.update(bankStatementLines).set({ status: 'ignored', ignoreReason: [rs.code, rs.text].filter(Boolean).join(': '), proposedEntryIds: [], matchRule: 'ignored' }).where(eq(bankStatementLines.id, lineId));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_statement_line', id: String(lineId) }, action: 'finance.statement_line_ignored', actor: ctx.actor, from: line.status, to: 'ignored', reason: rs, inputs: { origin: ctx.origin }, outcome: { amount: line.amount } }, tx);
    });
  }

  async restoreLine(ctx: FinanceContext, lineId: number) {
    await this.db.transaction(async (tx) => {
      const line = await this.lockLine(tx, ctx.companyId, lineId);
      if (has(line.reconciliationId)) throw new FinanceError('LINE_RECONCILED', 'This line is part of a posted reconciliation.');
      if (line.status !== 'ignored') throw new FinanceError('NOT_IGNORED', 'This line was not set aside.');
      await tx.update(bankStatementLines).set({ status: 'unmatched', ignoreReason: null, matchRule: null }).where(eq(bankStatementLines.id, lineId));
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'bank_statement_line', id: String(lineId) }, action: 'finance.statement_line_restored', actor: ctx.actor, from: 'ignored', to: 'unmatched', inputs: { origin: ctx.origin } }, tx);
    });
  }

  // ── turning a line into a record ─────────────────────────────────────────

  /** Methods that pay into this account, for "this deposit is a customer's payment". */
  async receiptMethods(companyId: string, bankAccountId: string) {
    const rows = await this.db.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.balancingBankAccountId, bankAccountId), eq(paymentMethods.enabled, true)));
    return rows.filter((m) => m.usableFor.includes('customer_receipt')).map((m) => ({ id: m.id, name: m.name, kind: m.kind }));
  }

  /**
   * A deposit nobody recorded: create the customer's receipt from it, post it, and close the line
   * against it. If anything fails nothing is left half done (a retry resumes where it stopped).
   */
  async createReceiptFromLine(ctx: FinanceContext, lineId: number, input: { customerId: string; paymentMethodId: string; allocate?: 'oldest_first' | 'none'; permissions?: PostingPermissions }) {
    const [line] = await this.db.select().from(bankStatementLines).where(and(eq(bankStatementLines.companyId, ctx.companyId), eq(bankStatementLines.id, lineId)));
    if (!line) throw new FinanceError('LINE_NOT_FOUND', 'That statement line does not exist.');
    if (has(line.reconciliationId)) throw new FinanceError('LINE_RECONCILED', 'This line is part of a posted reconciliation.');
    if (line.status === 'matched' || line.status === 'ignored') throw new FinanceError('LINE_CLOSED', `This line is already ${line.status}.`);
    if (centsOf(line.amount) <= 0) throw new FinanceError('NOT_A_DEPOSIT', 'Only money received can become a customer receipt.');
    const [method] = await this.db.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, input.paymentMethodId)));
    if (method?.balancingBankAccountId !== line.bankAccountId) throw new FinanceError('METHOD_ACCOUNT', 'That payment method does not pay into this bank account.');
    const account = await this.account(this.db, ctx.companyId, line.bankAccountId);
    const created = await this.receipts.create(ctx, {
      customerId: input.customerId,
      paymentMethodId: method.id,
      amount: fromCents(centsOf(line.amount)),
      currency: account.currency,
      paymentDate: line.lineDate,
      postingDate: line.lineDate,
      externalReference: line.reference,
      payerName: line.counterparty,
      narration: line.description.slice(0, 300),
      source: 'bank_statement',
      sourceRef: `statement_line:${line.id}`,
      idempotencyKey: `statement_line:${line.id}`,
    });
    const [r] = await this.db.select({ status: customerReceipts.status }).from(customerReceipts).where(eq(customerReceipts.id, created.id));
    if (r?.status === 'draft') await this.receipts.post(ctx, created.id, { allocate: input.allocate ?? 'oldest_first', permissions: input.permissions });
    const [entry] = await this.db.select().from(bankLedgerEntries).where(and(eq(bankLedgerEntries.documentId, created.id), eq(bankLedgerEntries.documentType, 'customer_receipt'), eq(bankLedgerEntries.bankAccountId, line.bankAccountId)));
    if (!entry) throw new FinanceError('RECEIPT_NOT_POSTED', `Receipt ${created.number} was created but is not posted. Open it to finish, then match this line to it.`);
    await this.db.transaction((tx) => this.applyMatchIn(tx, ctx, lineId, [entry.id], 'created_receipt'));
    return { receiptId: created.id, number: created.number };
  }

  /** A bank or mobile-money charge on the statement: record it against the fee account and close the line. */
  /** The G/L accounts the payment methods of this account post to: a charge comes out of one of them. */
  async chargeGlChoices(companyId: string, bankAccountId: string) {
    const rows = await this.db
      .select({ glId: paymentMethods.glAccountId, glNo: glAccounts.no, glName: glAccounts.name, method: paymentMethods.name })
      .from(paymentMethods)
      .innerJoin(glAccounts, eq(glAccounts.id, paymentMethods.glAccountId))
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.balancingBankAccountId, bankAccountId)))
      .orderBy(glAccounts.no);
    const byGl = new Map<string, { glId: string; label: string; methods: string[] }>();
    for (const r of rows) {
      const g = byGl.get(r.glId) ?? { glId: r.glId, label: `${r.glNo} ${r.glName}`, methods: [] };
      g.methods.push(r.method);
      byGl.set(r.glId, g);
    }
    return [...byGl.values()];
  }

  /**
   * Records a charge the bank took. By default the whole amount goes to the account's fee account; `parts` splits it over
   * several accounts (the fee, the excise duty on it, a tax) when the bank bundled them in one line. The parts must come to
   * the line exactly, and the bank side is one entry for the whole amount.
   */
  async recordChargeFromLine(ctx: FinanceContext, lineId: number, opts: { glAccountId?: string; parts?: ChargePartInput[]; permissions?: PostingPermissions } = {}) {
    const permissions = opts.permissions ?? NO_SPECIAL_PERMISSIONS;
    return await this.db.transaction(async (tx) => {
      const line = await this.lockLine(tx, ctx.companyId, lineId);
      if (has(line.reconciliationId)) throw new FinanceError('LINE_RECONCILED', 'This line is part of a posted reconciliation.');
      if (line.status === 'matched' || line.status === 'ignored') throw new FinanceError('LINE_CLOSED', `This line is already ${line.status}.`);
      const cents = -centsOf(line.amount);
      if (cents <= 0) throw new FinanceError('NOT_A_CHARGE', 'Only money taken out of the account can be recorded as a charge.');
      const account = await this.account(tx, ctx.companyId, line.bankAccountId);
      const split = opts.parts === undefined ? null : checkChargeSplit(cents, opts.parts);
      if (split !== null && !split.ok) throw new FinanceError('SPLIT_INVALID', split.error);
      // A split names every account itself, so only an unsplit charge needs the bank account's fee account.
      if (split === null && !has(account.feeGlAccountId)) throw new FinanceError('NO_FEE_ACCOUNT', `${account.code} has no fee account. Choose where its charges post (Finance → Bank accounts).`);
      const choices = await this.chargeGlChoices(ctx.companyId, account.id);
      if (choices.length === 0) throw new FinanceError('NO_METHOD', `No payment method pays into ${account.code}, so there is no G/L account to take the charge from. Add one under Settings → Payments.`);
      const bankGl = has(opts.glAccountId) ? choices.find((c) => c.glId === opts.glAccountId) : onlyOne(choices);
      if (bankGl === undefined) throw new FinanceError('GL_CHOICE_NEEDED', has(opts.glAccountId) ? 'That G/L account is not used by any payment method of this bank account.' : `Several G/L accounts are used for ${account.code}: choose the one this charge came out of.`);
      const date = line.lineDate;
      const issues = await this.engine.dateIssues(tx, ctx.companyId, date, permissions);
      if (issues.length > 0) throw new FinanceError(issues[0].code, issues.map((i) => i.message).join(' '));
      const { s, live } = await this.glLive(tx, ctx.companyId, date);
      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('bank_charge', { companyId: ctx.companyId, branchId: undefined, date: businessDate(), document: { kind: 'bank_charge', id }, actor: ctx.actor }, tx);
      let registerId: string | null = null;
      if (live) {
        // A charge in another currency is booked at the rate of the day it was taken.
        const foreign = account.currency.toUpperCase() !== s.baseCurrency;
        const rate = foreign ? await this.fx.requireRate(tx, ctx.companyId, account.currency, date) : '1';
        const req: PostingRequest = {
          companyId: ctx.companyId,
          idempotencyKey: `bank_charge:${line.id}`,
          postingDate: date,
          documentType: 'bank_charge',
          documentNo: number,
          description: `Bank charge ${line.description}`.slice(0, 200),
          currency: foreign ? account.currency.toUpperCase() : s.baseCurrency,
          rate,
          rateSource: foreign ? 'manual' : 'base',
          lines: [
            ...(split === null
              ? [{ accountId: required(account.feeGlAccountId), debit: fromCents(cents), credit: '0', description: line.description.slice(0, 200) }]
              : split.value.map((part) => ({ accountId: part.glAccountId, debit: fromCents(part.cents), credit: '0', description: (has(part.description) ? part.description : line.description).slice(0, 200) }))),
            { accountId: bankGl.glId, debit: '0', credit: fromCents(cents), description: `Charge ${number}`, sourceLedger: 'bank', sourceEntryId: account.id },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'bank_charge', id },
          postedBy: 'engine',
        };
        registerId = (await this.engine.post(req, permissions, tx)).registerId;
      }
      const [entry] = await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: account.id, glAccountId: bankGl.glId, postingDate: date, documentType: 'bank_charge', documentNo: number, documentId: id, description: line.description.slice(0, 300), amount: fromCents(-cents), currency: account.currency, registerId, createdBy: ctx.actor.id }).returning({ id: bankLedgerEntries.id });
      await this.applyMatchIn(tx, ctx, lineId, [entry.id], 'recorded_charge');
      return { number, gl: live, parts: split === null ? 1 : split.value.length };
    });
  }

  /**
   * Money the bank paid in that is not a customer's payment: interest, a refund of bank fees, a grant. Recorded against the
   * income (or other) account the person chooses, and the line is closed against it. Like a charge, it posts only once the books are live.
   */
  async recordIncomeFromLine(ctx: FinanceContext, lineId: number, opts: { incomeGlAccountId: string; description?: string; glAccountId?: string; permissions?: PostingPermissions }) {
    const permissions = opts.permissions ?? NO_SPECIAL_PERMISSIONS;
    return await this.db.transaction(async (tx) => {
      const line = await this.lockLine(tx, ctx.companyId, lineId);
      if (has(line.reconciliationId)) throw new FinanceError('LINE_RECONCILED', 'This line is part of a posted reconciliation.');
      if (line.status === 'matched' || line.status === 'ignored') throw new FinanceError('LINE_CLOSED', `This line is already ${line.status}.`);
      const cents = centsOf(line.amount);
      if (cents <= 0) throw new FinanceError('NOT_INCOME', 'Only money paid into the account can be recorded as income.');
      const account = await this.account(tx, ctx.companyId, line.bankAccountId);
      const [income] = await tx.select().from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), eq(glAccounts.id, opts.incomeGlAccountId)));
      if (income === undefined || income.type !== 'posting' || income.blocked) throw new FinanceError('INCOME_ACCOUNT_INVALID', 'Choose an open account to record this money against.');
      const choices = await this.chargeGlChoices(ctx.companyId, account.id);
      if (choices.length === 0) throw new FinanceError('NO_METHOD', `No payment method pays into ${account.code}, so there is no G/L account to bring the money into. Add one under Settings → Payments.`);
      const bankGl = has(opts.glAccountId) ? choices.find((c) => c.glId === opts.glAccountId) : onlyOne(choices);
      if (bankGl === undefined) throw new FinanceError('GL_CHOICE_NEEDED', has(opts.glAccountId) ? 'That G/L account is not used by any payment method of this bank account.' : `Several G/L accounts are used for ${account.code}: choose the one this money went into.`);
      const date = line.lineDate;
      const issues = await this.engine.dateIssues(tx, ctx.companyId, date, permissions);
      if (issues.length > 0) throw new FinanceError(issues[0].code, issues.map((i) => i.message).join(' '));
      const { s, live } = await this.glLive(tx, ctx.companyId, date);
      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('bank_income', { companyId: ctx.companyId, branchId: undefined, date: businessDate(), document: { kind: 'bank_income', id }, actor: ctx.actor }, tx);
      const note = (has(opts.description) ? opts.description : line.description).trim().slice(0, 200);
      let registerId: string | null = null;
      if (live) {
        const foreign = account.currency.toUpperCase() !== s.baseCurrency;
        const rate = foreign ? await this.fx.requireRate(tx, ctx.companyId, account.currency, date) : '1';
        const req: PostingRequest = {
          companyId: ctx.companyId,
          idempotencyKey: `bank_income:${line.id}`,
          postingDate: date,
          documentType: 'bank_income',
          documentNo: number,
          description: `Bank income ${note}`.slice(0, 200),
          currency: foreign ? account.currency.toUpperCase() : s.baseCurrency,
          rate,
          rateSource: foreign ? 'manual' : 'base',
          lines: [
            { accountId: bankGl.glId, debit: fromCents(cents), credit: '0', description: `Income ${number}`, sourceLedger: 'bank', sourceEntryId: account.id },
            { accountId: income.id, debit: '0', credit: fromCents(cents), description: note },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'bank_income', id },
          postedBy: 'engine',
        };
        registerId = (await this.engine.post(req, permissions, tx)).registerId;
      }
      const [entry] = await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: account.id, glAccountId: bankGl.glId, postingDate: date, documentType: 'bank_income', documentNo: number, documentId: id, description: note, amount: fromCents(cents), currency: account.currency, registerId, createdBy: ctx.actor.id }).returning({ id: bankLedgerEntries.id });
      await this.applyMatchIn(tx, ctx, lineId, [entry.id], 'recorded_income');
      return { number, gl: live };
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /** Every bank-type account with where its statement work stands. */
  async overview(companyId: string) {
    const rows = await this.db.execute<{ id: string; code: string; name: string; kind: string; currency: string; blocked: boolean; has_format: boolean; book: string; last_import: string | null; unmatched: number; proposed: number; matched_open: number; outstanding: number; last_rec_date: string | null; last_rec_balance: string | null }>(sql`
      SELECT a.id, a.code, a.name, a.kind, a.currency, a.blocked,
        EXISTS (SELECT 1 FROM bank_statement_formats f WHERE f.bank_account_id = a.id) AS has_format,
        COALESCE((SELECT SUM(l.amount) FROM bank_ledger_entries l WHERE l.bank_account_id = a.id), 0)::text AS book,
        (SELECT MAX(date_to)::text FROM bank_statement_imports i WHERE i.bank_account_id = a.id) AS last_import,
        (SELECT COUNT(*)::int FROM bank_statement_lines s WHERE s.bank_account_id = a.id AND s.status = 'unmatched') AS unmatched,
        (SELECT COUNT(*)::int FROM bank_statement_lines s WHERE s.bank_account_id = a.id AND s.status = 'proposed') AS proposed,
        (SELECT COUNT(*)::int FROM bank_statement_lines s WHERE s.bank_account_id = a.id AND s.status IN ('matched','ignored') AND s.reconciliation_id IS NULL) AS matched_open,
        (SELECT COUNT(*)::int FROM bank_ledger_entries e WHERE e.bank_account_id = a.id AND NOT EXISTS (SELECT 1 FROM bank_statement_matches m WHERE m.bank_entry_id = e.id AND m.undone_at IS NULL)) AS outstanding,
        (SELECT r.statement_date::text FROM bank_reconciliations r WHERE r.bank_account_id = a.id AND r.status = 'posted' ORDER BY r.statement_date DESC, r.posted_at DESC LIMIT 1) AS last_rec_date,
        (SELECT r.statement_balance::text FROM bank_reconciliations r WHERE r.bank_account_id = a.id AND r.status = 'posted' ORDER BY r.statement_date DESC, r.posted_at DESC LIMIT 1) AS last_rec_balance
      FROM bank_accounts a WHERE a.company_id = ${companyId}::uuid AND a.kind <> 'clearing' ORDER BY a.code`);
    return [...rows];
  }

  /** One account's working screen: lines to deal with (with suggestions), and our entries still open. */
  async workbench(companyId: string, bankAccountId: string, f: { status?: StatementLineStatus | 'open'; before?: number } = {}) {
    const account = await this.account(this.db, companyId, bankAccountId);
    const statusFilter = f.status === undefined || f.status === 'open' ? inArray(bankStatementLines.status, ['unmatched', 'proposed']) : eq(bankStatementLines.status, f.status);
    const limit = 100;
    const lines = await this.db
      .select()
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.companyId, companyId), eq(bankStatementLines.bankAccountId, bankAccountId), statusFilter, f.before !== undefined && f.before !== 0 ? gt(bankStatementLines.id, f.before) : undefined))
      .orderBy(asc(bankStatementLines.id))
      .limit(limit + 1);
    const more = lines.length > limit;
    const page = more ? lines.slice(0, limit) : lines;
    const proposedIds = [...new Set(page.flatMap((l) => l.proposedEntryIds))];
    const matched = page.length === 0 ? [] : await this.db.select({ m: bankStatementMatches, e: bankLedgerEntries }).from(bankStatementMatches).innerJoin(bankLedgerEntries, eq(bankLedgerEntries.id, bankStatementMatches.bankEntryId)).where(and(inArray(bankStatementMatches.lineId, page.map((l) => l.id)), isNull(bankStatementMatches.undoneAt)));
    const proposed = proposedIds.length === 0 ? [] : await this.db.select().from(bankLedgerEntries).where(inArray(bankLedgerEntries.id, proposedIds));
    const outstanding = await this.openEntries(this.db, companyId, bankAccountId);
    const [counts] = await this.db.execute<{ unmatched: number; proposed: number; matched: number; ignored: number; unreconciled: number }>(sql`
      SELECT COUNT(*) FILTER (WHERE status='unmatched')::int unmatched, COUNT(*) FILTER (WHERE status='proposed')::int proposed,
             COUNT(*) FILTER (WHERE status='matched')::int matched, COUNT(*) FILTER (WHERE status='ignored')::int ignored,
             COUNT(*) FILTER (WHERE reconciliation_id IS NULL)::int unreconciled
      FROM bank_statement_lines WHERE bank_account_id = ${bankAccountId}::uuid`);
    const imports = await this.db.select().from(bankStatementImports).where(eq(bankStatementImports.bankAccountId, bankAccountId)).orderBy(desc(bankStatementImports.createdAt)).limit(10);
    const [book] = await this.db.select({ n: sql<string>`COALESCE(SUM(${bankLedgerEntries.amount}), 0)` }).from(bankLedgerEntries).where(eq(bankLedgerEntries.bankAccountId, bankAccountId));
    return {
      account,
      lines: page,
      nextAfter: more ? page[page.length - 1].id : null,
      matched: new Map(page.map((l) => [l.id, matched.filter((m) => m.m.lineId === l.id).map((m) => ({ entryId: m.e.id, documentNo: m.e.documentNo, documentType: m.e.documentType, description: m.e.description, amount: m.e.amount, rule: m.m.rule }))])),
      proposed: new Map(proposed.map((e) => [e.id, e])),
      outstanding: outstanding.slice(0, 200).map((e) => e.entry),
      outstandingCount: outstanding.length,
      outstandingNet: outstanding.reduce((n, e) => n + e.amountCents, 0),
      counts: counts ?? { unmatched: 0, proposed: 0, matched: 0, ignored: 0, unreconciled: 0 },
      imports,
      bookBalance: book?.n ?? '0',
      format: await this.getFormat(companyId, bankAccountId),
    };
  }

  /** Candidate entries for a manual match: open entries of this account, newest first. */
  async candidateEntries(companyId: string, bankAccountId: string, near?: { amount?: string; date?: string }) {
    const all = await this.openEntries(this.db, companyId, bankAccountId);
    const wanted = near?.amount;
    const withAmt = has(wanted) ? all.filter((e) => e.amountCents === centsOf(wanted)) : all;
    return (withAmt.length > 0 ? withAmt : all).slice(-100).reverse().map((e) => e.entry);
  }
}
