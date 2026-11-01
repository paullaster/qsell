import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { inventoryMovements, products, stockDocumentLines, stockDocuments, unitsOfMeasure, type StockDocumentLineRow, type StockDocumentRow } from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { quantityProblem } from '@/lib/unit-rules';
import { isLedgerModeIn } from './settings';
import { StockError } from './errors';
import type { StockLedger } from './ledger';

export type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface DocActor {
  id: string;
}

export interface DocumentDeps {
  db: DrizzleDb;
  ledger: StockLedger;
  numbering: NumberSeriesService;
  decisionLog: DecisionLog;
}

export interface ProductFacts {
  id: string;
  name: string;
  cost: number;
  unitName: string;
  decimals: number;
  deleted: boolean;
}

/** The document, locked for the rest of the transaction. Refused when it is not this company's or not this kind. */
export async function lockDocument(tx: Tx, companyId: string, id: string, kind: 'transfer' | 'count'): Promise<StockDocumentRow> {
  const [doc] = await tx.select().from(stockDocuments).where(and(eq(stockDocuments.id, id), eq(stockDocuments.companyId, companyId), eq(stockDocuments.kind, kind))).for('update').limit(1);
  if (doc === undefined) throw new StockError(kind === 'transfer' ? 'That transfer could not be found.' : 'That count could not be found.', 'NOT_FOUND');
  return doc;
}

export async function documentLines(tx: Tx, documentId: string): Promise<StockDocumentLineRow[]> {
  return await tx.select().from(stockDocumentLines).where(eq(stockDocumentLines.documentId, documentId)).orderBy(stockDocumentLines.lineNo);
}

export function mustBe(doc: StockDocumentRow, states: readonly string[], doing: string): void {
  if (!states.includes(doc.state)) throw new StockError(`${doc.number} is ${doc.state.replace('_', ' ')}, so it cannot be ${doing}.`, 'WRONG_STATE');
}

/** The cost, the unit and whether the product is gone, for many products in one query. */
export async function productFacts(tx: Tx, ids: readonly string[]): Promise<Map<string, ProductFacts>> {
  const out = new Map<string, ProductFacts>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ id: products.id, name: products.name, cost: products.costPrice, unitName: unitsOfMeasure.name, decimals: unitsOfMeasure.decimals, deletedAt: products.deletedAt })
    .from(products)
    .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId))
    .where(inArray(products.id, [...ids]));
  for (const r of rows) out.set(r.id, { id: r.id, name: r.name, cost: Number(r.cost), unitName: r.unitName ?? 'unit', decimals: r.decimals ?? 3, deleted: r.deletedAt !== null });
  return out;
}

/** Each quantity must fit the unit the product is counted in. */
export function unitProblem(facts: ProductFacts, quantity: number, what: string): string | null {
  return quantityProblem(quantity, facts.decimals, facts.unitName, `${what} of "${facts.name}"`);
}

export async function nextNumber(deps: DocumentDeps, tx: Tx, kind: 'stock_transfer' | 'stock_count', companyId: string, documentId: string): Promise<string> {
  const { number } = await deps.numbering.assign(kind, { companyId, date: businessDate(), document: { kind, id: documentId } }, tx);
  return number;
}

/** One line in the document's history: who moved it from where to where, when (the log stamps the time), and why. */
export async function logStep(
  deps: DocumentDeps,
  tx: Tx,
  doc: Pick<StockDocumentRow, 'id' | 'companyId' | 'kind'>,
  action: string,
  actor: DocActor,
  from: string | null,
  to: string | null,
  extra: { reason?: string; outcome?: Record<string, unknown> } = {},
): Promise<void> {
  await deps.decisionLog.record(
    {
      companyId: doc.companyId,
      subject: { type: doc.kind === 'transfer' ? 'stock_transfer' : 'stock_count', id: doc.id },
      action: `stock.${doc.kind}.${action}`,
      actor: { type: 'user', id: actor.id },
      from,
      to,
      reason: extra.reason === undefined ? undefined : { text: extra.reason },
      outcome: extra.outcome ?? {},
    },
    tx,
  );
}

/** Raises the version and stamps the time; every change of a document goes through here. */
export type DocumentPatch = { [K in keyof typeof stockDocuments.$inferInsert]?: (typeof stockDocuments.$inferInsert)[K] | SQL };

export async function touch(tx: Tx, id: string, set: DocumentPatch): Promise<void> {
  await tx
    .update(stockDocuments)
    .set({ ...set, version: sql`${stockDocuments.version} + 1`, updatedAt: sql`now()` })
    .where(eq(stockDocuments.id, id));
}

export function cleanReason(reason: unknown, what: string, required = true): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (required && text === '') throw new StockError(`Say why: ${what}.`, 'REASON_NEEDED');
  if (text.length > 300) throw new StockError('Keep the reason to 300 characters.', 'REASON_TOO_LONG');
  return text;
}

/**
 * A change in what the company owns (a loss, a count's difference) is also a row in the old journal, which is what feeds the books
 * until the cut-over. The ledger movement has already been made; this writes the matching line with the totals before and after.
 */
export async function journalChange(tx: Tx, input: { productId: string; delta: number; changeType: string; referenceId: string; actor: string; note: string }): Promise<void> {
  const rows = [...(await tx.execute<{ total: string }>(sql`SELECT COALESCE(sum(on_hand), 0) AS total FROM stock_balances WHERE product_id = ${input.productId}`))];
  const after = Number(rows[0]?.total ?? 0);
  const [p] = await tx.select({ name: products.name }).from(products).where(eq(products.id, input.productId)).limit(1);
  await tx.insert(inventoryMovements).values({
    id: `ledger_${crypto.randomUUID()}`,
    productId: input.productId,
    productName: p?.name ?? '',
    changeAmount: input.delta,
    previousStock: Math.round((after - input.delta) * 1000) / 1000,
    newStock: after,
    changeType: input.changeType,
    referenceId: input.referenceId,
    actor: input.actor.slice(0, 200),
    note: input.note.slice(0, 250),
  });
}

/**
 * Transfers and counts move stock in the per-location ledger. Until that ledger is the truth (the cut-over), the old counters are, and
 * a movement made only in the ledger would split the two. So they wait.
 */
export async function requireLedger(tx: Tx): Promise<void> {
  if (!(await isLedgerModeIn(tx))) {
    throw new StockError('Transfers and counts work on the new stock ledger, which is not switched on for this company yet.', 'LEDGER_OFF');
  }
}
