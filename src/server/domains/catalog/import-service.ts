import { quantityProblem } from '@/lib/unit-rules';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { MediaService } from '@/server/domains/media/service';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  categories,
  inventoryMovements,
  itemTypes,
  productImportJobs,
  productImportRows,
  products,
  taxCategories,
  unitsOfMeasure,
  type CategoryRow,
  type ItemTypeRow,
  type ProductImportJobRow,
  type ProductInsert,
  type TaxCategoryRow,
  type UnitOfMeasureRow,
} from '@/server/db/drizzle/schema';
import { CsvParseError, parseCsv, toCsv, UTF8_BOM, type CsvRecord } from '@/lib/csv';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  PRODUCT_CSV_COLUMNS,
  parseProductRow,
  resolveHeaders,
  slugify,
  type HeaderMap,
  type ProductImportDraft,
} from '@/lib/productCsv';

/** A problem found while validating an upload. `row` is the file line, null for file-level issues. */
export interface ImportProblem {
  row: number | null;
  column: string | null;
  message: string;
}

export type StageResult =
  | { ok: true; jobId: string; totalRows: number }
  | { ok: false; problems: ImportProblem[]; rowsWithProblems: number; totalRows: number };

export interface ImportJobView {
  id: string;
  status: ProductImportJobRow['status'];
  fileName: string;
  totalRows: number;
  createdCount: number;
  failedCount: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const PRODUCT_IMPORT_TASK = 'process-product-import';
/** One queue ⇒ imports run one at a time, so two imports never race for the same SKUs. */
const PRODUCT_IMPORT_QUEUE = 'product-imports';
const MAX_ATTEMPTS = 5;
const CHUNK_SIZE = 100;
const STAGE_BATCH = 500;
/** Stop listing problems after this many; the count is still reported. */
const MAX_REPORTED_PROBLEMS = 1000;

/** Row-level failure that retrying cannot fix (bad data, missing reference). */
class RowRejected extends Error {}

interface References {
  /** The company the products are numbered under. */
  companyId: string;
  categoryByName: Map<string, CategoryRow>;
  itemTypeByRef: Map<string, ItemTypeRow>;
  /** Active units by code. */
  unitByCode: Map<string, UnitOfMeasureRow>;
  defaultItemType: ItemTypeRow | undefined;
  taxByRef: Map<string, TaxCategoryRow>;
  defaultTax: TaxCategoryRow | undefined;
  defaultUnit: UnitOfMeasureRow | undefined;
}

const key = (value: string) => value.trim().toLowerCase();

function isUniqueViolation(
  error: unknown,
): error is { code: string; constraint_name?: string; constraint?: string } {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505';
}

function uniqueViolationMessage(error: unknown): string {
  const cause = ((error as { cause?: unknown } | null)?.cause ?? error) as {
    constraint_name?: string;
    constraint?: string;
  };
  const constraint = cause.constraint_name ?? cause.constraint ?? '';
  if (constraint.includes('sku')) return 'SKU: another product already uses this SKU.';
  if (constraint.includes('stock_code'))
    return 'Stock_Code: another product already uses this stock code.';
  if (constraint.includes('slug')) return 'Slug: another product already uses this slug.';
  return 'A product with the same identifying details already exists.';
}

/** User-facing reason for a row failure, or null when the error is transient (retry the chunk). */
function rowFailureMessage(error: unknown): string | null {
  if (error instanceof RowRejected) return error.message;
  if (isUniqueViolation(error)) return uniqueViolationMessage(error);
  return null;
}

function toView(job: ProductImportJobRow): ImportJobView {
  return {
    id: job.id,
    status: job.status,
    fileName: job.fileName,
    totalRows: job.totalRows,
    createdCount: job.createdCount,
    failedCount: job.failedCount,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Bulk product import.
 *
 * `stage` runs in the request: it validates the entire file (format rules shared
 * with the product form, references and uniqueness against the database) and
 * rejects it outright if anything is wrong, so a half-imported catalogue is not
 * possible from bad data. A valid file is staged row-by-row and its worker job
 * is enqueued in the same transaction — there is never a job without rows or
 * rows without a job.
 *
 * `process` runs in the worker. Each chunk is one transaction and each row a
 * savepoint inside it: a product, its opening stock-ledger entry and the row's
 * status commit together, so work is exactly-once and a crash resumes from the
 * first unprocessed row.
 */
export class ProductImportService {
  constructor(
    private readonly db: DrizzleDb,
    /** Ensures the job queue's tables exist before the first enqueue. */
    private readonly ensureQueue: () => Promise<void>,
    /** Imported image links become shared media assets, exactly like the product form's. */
    private readonly media: MediaService,
    /** Numbering for products imported without a SKU or stock code. */
    private readonly deps: {
      numbering: () => NumberSeriesService;
      companyId: () => Promise<string>;
    },
  ) {}

  // ── Staging (request side) ────────────────────────────────────────────────

  async stage(input: {
    fileName: string;
    bytes: Uint8Array;
    actor: { id: string; email: string };
  }): Promise<StageResult> {
    const fail = (message: string): StageResult => ({
      ok: false,
      problems: [{ row: null, column: null, message }],
      rowsWithProblems: 0,
      totalRows: 0,
    });

    if (input.bytes.byteLength === 0) return fail('The file is empty.');
    if (input.bytes.byteLength > MAX_IMPORT_BYTES) {
      return fail(
        `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Split it into smaller files.`,
      );
    }

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes).replace(/^\uFEFF/, '');
    } catch {
      return fail(
        'The file is not UTF-8 text. In Excel use "Save As → CSV UTF-8 (Comma delimited)".',
      );
    }

    let records: CsvRecord[];
    try {
      records = parseCsv(text);
    } catch (error) {
      if (error instanceof CsvParseError) {
        return {
          ok: false,
          problems: [{ row: error.line, column: null, message: error.message }],
          rowsWithProblems: 1,
          totalRows: 0,
        };
      }
      throw error;
    }

    const headerRecord = records.at(0);
    if (headerRecord === undefined) return fail('The file has no header row.');
    const allDataRecords = records.slice(1);
    // Spreadsheets often save blank rows as ",,,,": they are not products.
    const dataRecords = allDataRecords.filter((record) =>
      record.fields.some((f) => f.trim() !== ''),
    );
    const headers = resolveHeaders(headerRecord.fields);
    if (!headers.ok) {
      return {
        ok: false,
        problems: headers.errors.map((message) => ({
          row: headerRecord.line,
          column: null,
          message,
        })),
        rowsWithProblems: 0,
        totalRows: 0,
      };
    }
    if (dataRecords.length === 0) return fail('The file has a header but no product rows.');
    if (dataRecords.length > MAX_IMPORT_ROWS) {
      return fail(
        `The file has ${dataRecords.length} rows; the limit is ${MAX_IMPORT_ROWS}. Split it into smaller files.`,
      );
    }

    const problems: ImportProblem[] = [];
    const badRows = new Set<number>();
    const report = (row: number, column: string | null, message: string) => {
      badRows.add(row);
      if (problems.length < MAX_REPORTED_PROBLEMS) problems.push({ row, column, message });
    };

    // 1. Format checks (same rules as the product form).
    const parsed: { line: number; draft: ProductImportDraft; raw: Record<string, string> }[] = [];
    for (const record of dataRecords) {
      if (record.fields.length > headerRecord.fields.length) {
        report(
          record.line,
          null,
          `Has ${record.fields.length} values but the header has ${headerRecord.fields.length} columns. Check for an unquoted comma.`,
        );
        continue;
      }
      const result = parseProductRow(record.fields, headers.map);
      if (!result.ok) {
        for (const error of result.errors)
          report(record.line, error.column, `${error.column} ${error.message}`);
        continue;
      }
      parsed.push({
        line: record.line,
        draft: result.draft,
        raw: rawCells(record.fields, headers.map),
      });
    }

    // 2. Database-aware checks: references, sellable pricing, uniqueness.
    const refs = await this.loadReferences();
    const existing = await this.existingIdentifiers();
    const seen = {
      sku: new Map<string, number>(),
      stockCode: new Map<string, number>(),
      slug: new Map<string, number>(),
    };

    for (const { line, draft } of parsed) {
      if (!refs.categoryByName.has(key(draft.categoryName))) {
        report(
          line,
          'Category',
          `Category "${draft.categoryName}" does not exist. Create it first or fix the spelling.`,
        );
      }
      const itemType =
        draft.itemTypeRef === null
          ? refs.defaultItemType
          : refs.itemTypeByRef.get(key(draft.itemTypeRef));
      if (!itemType) {
        report(
          line,
          'Item_Type',
          draft.itemTypeRef === null
            ? 'No default item type exists. Set Item_Type or create one first.'
            : `Item type "${draft.itemTypeRef}" does not exist.`,
        );
      } else if (itemType.isSellable && (draft.price === null || draft.price <= 0)) {
        report(
          line,
          'Price',
          `Price is required and must be above 0 for the sellable item type "${itemType.name}".`,
        );
      }
      if (draft.taxRef !== null && !refs.taxByRef.has(key(draft.taxRef))) {
        report(line, 'Tax_Category', `Tax category "${draft.taxRef}" does not exist.`);
      }
      // Stock is counted in the product's unit: 2.5 pieces cannot be on a shelf.
      const unit = draft.unitRef === null ? refs.defaultUnit : refs.unitByCode.get(key(draft.unitRef));
      if (unit === undefined) {
        report(line, 'Unit', draft.unitRef === null ? 'There is no default unit of measure.' : `Unit "${draft.unitRef}" does not exist or is switched off.`);
      } else {
        for (const [column, value] of [['Stock_Qty', draft.stockQuantity], ['Low_Stock_Threshold', draft.lowStockThreshold]] as const) {
          const problem = quantityProblem(value, unit.decimals, unit.name, column.replace('_', ' '));
          if (problem !== null) report(line, column, problem);
        }
      }

      const unique = (field: 'sku' | 'stockCode', column: string, value: string) => {
        if (existing[field].has(value)) {
          report(
            line,
            column,
            `${column} "${value}" is already used by an existing product. Imports only create new products.`,
          );
        }
        const first = seen[field].get(value);
        if (first !== undefined)
          report(line, column, `${column} "${value}" is also used on row ${first}.`);
        else seen[field].set(value, line);
      };
      // A blank code is numbered automatically when the row is created, so there is nothing to clash.
      if (draft.sku !== '') unique('sku', 'SKU', draft.sku);
      if (draft.stockCode !== '') unique('stockCode', 'Stock_Code', draft.stockCode);

      if (draft.slug !== null) {
        if (existing.slug.has(draft.slug))
          report(line, 'Slug', `Slug "${draft.slug}" is already used by an existing product.`);
        const first = seen.slug.get(draft.slug);
        if (first !== undefined)
          report(line, 'Slug', `Slug "${draft.slug}" is also used on row ${first}.`);
        else seen.slug.set(draft.slug, line);
      }
    }

    if (badRows.size > 0) {
      return {
        ok: false,
        problems: problems.sort((a, b) => (a.row ?? 0) - (b.row ?? 0)),
        rowsWithProblems: badRows.size,
        totalRows: dataRecords.length,
      };
    }

    // 3. Fill in generated slugs, unique against the catalogue and this file.
    for (const { draft } of parsed) {
      if (draft.slug !== null) continue;
      const base = [slugify(draft.name), slugify(draft.sku)].find((s) => s !== '') ?? 'product';
      let candidate = base;
      for (let n = 2; existing.slug.has(candidate) || seen.slug.has(candidate); n++)
        candidate = `${base}-${n}`;
      draft.slug = candidate;
      seen.slug.set(candidate, 0);
    }

    // 4. Stage rows and enqueue the job atomically.
    await this.ensureQueue();
    const fileSha256 = createHash('sha256').update(input.bytes).digest('hex');
    try {
      const jobId = await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(productImportJobs)
          .values({
            fileName: input.fileName.slice(0, 255),
            fileSha256,
            totalRows: parsed.length,
            createdBy: input.actor.id,
            createdByEmail: input.actor.email,
          })
          .returning({ id: productImportJobs.id });
        const job = inserted.at(0);
        if (job === undefined) throw new Error('Could not create the import job.');
        for (let i = 0; i < parsed.length; i += STAGE_BATCH) {
          await tx.insert(productImportRows).values(
            parsed.slice(i, i + STAGE_BATCH).map(({ line, draft, raw }) => ({
              jobId: job.id,
              rowNumber: line,
              data: draft as unknown as Record<string, unknown>,
              raw,
            })),
          );
        }
        await tx.execute(sql`select graphile_worker.add_job(
          ${PRODUCT_IMPORT_TASK},
          json_build_object('jobId', ${job.id}::text),
          queue_name => ${PRODUCT_IMPORT_QUEUE},
          max_attempts => ${MAX_ATTEMPTS},
          job_key => ${`product-import:${job.id}`}
        )`);
        return job.id;
      });
      return { ok: true, jobId, totalRows: parsed.length };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return fail('This exact file is already being imported. Wait for that import to finish.');
      }
      throw error;
    }
  }

  // ── Processing (worker side) ──────────────────────────────────────────────

  async process(jobId: string, log: (message: string) => void): Promise<void> {
    const claimed = await this.db
      .update(productImportJobs)
      .set({
        status: 'processing',
        startedAt: sql`coalesce(${productImportJobs.startedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productImportJobs.id, jobId),
          inArray(productImportJobs.status, ['queued', 'processing']),
        ),
      )
      .returning();
    const job = claimed.at(0);
    if (job === undefined) {
      log(`import ${jobId}: nothing to do (finished or unknown)`);
      return;
    }

    const refs = await this.loadReferences();
    for (;;) {
      const processed = await this.db.transaction(async (tx) => {
        // SKIP LOCKED: even if two processors ever ran, they would never share a row.
        const rows = await tx
          .select()
          .from(productImportRows)
          .where(and(eq(productImportRows.jobId, jobId), eq(productImportRows.status, 'pending')))
          .orderBy(asc(productImportRows.rowNumber))
          .limit(CHUNK_SIZE)
          .for('update', { skipLocked: true });

        for (const row of rows) {
          const draft = row.data as unknown as ProductImportDraft;
          try {
            await tx.transaction(async (savepoint) => {
              const productId = await this.createProduct(
                savepoint as unknown as DrizzleDb,
                draft,
                refs,
                job,
              );
              await savepoint
                .update(productImportRows)
                .set({ status: 'created', productId, errors: [], processedAt: new Date() })
                .where(eq(productImportRows.id, row.id));
            });
          } catch (error) {
            const message = rowFailureMessage(error);
            // Anything else (connection loss, deadlock…) is transient: abort the chunk and let the queue retry.
            if (message === null) throw error;
            await tx
              .update(productImportRows)
              .set({ status: 'failed', errors: [message], processedAt: new Date() })
              .where(eq(productImportRows.id, row.id));
          }
        }
        return rows.length;
      });

      await this.refreshCounters(jobId);
      if (processed < CHUNK_SIZE) break;
    }

    await this.refreshCounters(jobId, 'completed');
    log(`import ${jobId}: completed`);
  }

  /** Called by the worker when the queue has exhausted its retries. */
  async markFailed(jobId: string, reason: string): Promise<void> {
    await this.refreshCounters(jobId);
    await this.db
      .update(productImportJobs)
      .set({
        status: 'failed',
        errorMessage: reason.slice(0, 500),
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productImportJobs.id, jobId),
          inArray(productImportJobs.status, ['queued', 'processing']),
        ),
      );
  }

  /** Resume a failed import; rows already created are never touched again. */
  async retry(jobId: string): Promise<boolean> {
    await this.ensureQueue();
    return await this.db.transaction(async (tx) => {
      const requeued = await tx
        .update(productImportJobs)
        .set({ status: 'queued', errorMessage: null, finishedAt: null, updatedAt: new Date() })
        .where(and(eq(productImportJobs.id, jobId), eq(productImportJobs.status, 'failed')))
        .returning({ id: productImportJobs.id });
      const job = requeued.at(0);
      if (job === undefined) return false;
      await tx.execute(sql`select graphile_worker.add_job(
        ${PRODUCT_IMPORT_TASK},
        json_build_object('jobId', ${job.id}::text),
        queue_name => ${PRODUCT_IMPORT_QUEUE},
        max_attempts => ${MAX_ATTEMPTS},
        job_key => ${`product-import:${job.id}`}
      )`);
      return true;
    });
  }

  private async createProduct(
    db: DrizzleDb,
    draft: ProductImportDraft,
    refs: References,
    job: ProductImportJobRow,
  ): Promise<string> {
    // References are re-checked: they may have changed since the file was validated.
    const category = refs.categoryByName.get(key(draft.categoryName));
    if (!category) throw new RowRejected(`Category: "${draft.categoryName}" no longer exists.`);
    const itemType =
      draft.itemTypeRef === null
        ? refs.defaultItemType
        : refs.itemTypeByRef.get(key(draft.itemTypeRef));
    if (!itemType)
      throw new RowRejected(`Item_Type: "${draft.itemTypeRef ?? 'default'}" no longer exists.`);
    const unit = draft.unitRef === null ? refs.defaultUnit : refs.unitByCode.get(key(draft.unitRef));
    if (!unit)
      throw new RowRejected(`Unit: "${draft.unitRef ?? 'default'}" no longer exists or is switched off.`);
    if (itemType.isSellable && (draft.price === null || draft.price <= 0)) {
      throw new RowRejected(
        `Price: required above 0 for the sellable item type "${itemType.name}".`,
      );
    }
    const tax = draft.taxRef === null ? refs.defaultTax : refs.taxByRef.get(key(draft.taxRef));
    if (draft.taxRef !== null && !tax)
      throw new RowRejected(`Tax_Category: "${draft.taxRef}" no longer exists.`);

    const now = new Date();
    const id = `prod_${randomUUID()}`;
    // Blank codes are numbered by their series inside this row's own savepoint, so a rejected row
    // gives its numbers back (the series allow gaps, so this is cheap and never contended).
    const code = async (value: string, kind: 'product_sku' | 'product_stock_code') =>
      value !== ''
        ? value
        : (
            await this.deps
              .numbering()
              .assign(
                kind,
                { companyId: refs.companyId, date: businessDate(), document: { kind, id } },
                db as never,
              )
          ).number.toUpperCase();
    const values: ProductInsert = {
      id,
      sku: await code(draft.sku, 'product_sku'),
      stockCode: await code(draft.stockCode, 'product_stock_code'),
      name: draft.name,
      slug: draft.slug ?? slugify(draft.name),
      description: draft.description,
      categoryId: category.id,
      categoryName: category.name,
      brand: draft.brand,
      itemTypeId: itemType.id,
      isSellable: itemType.isSellable,
      baseUnitId: unit.id,
      price: draft.price === null ? null : draft.price.toFixed(2),
      compareAtPrice: draft.compareAtPrice === null ? null : draft.compareAtPrice.toFixed(2),
      costPrice: draft.costPrice.toFixed(2),
      // Tax is snapshotted onto the product, exactly as the product form does.
      taxCategoryId: tax?.id ?? null,
      taxRate: tax ? tax.rate : '0',
      isTaxInclusive: tax ? tax.isInclusive : true,
      weight: draft.weight === null ? null : String(draft.weight),
      specifications: draft.specifications,
      stockQuantity: draft.stockQuantity,
      reservedQuantity: 0,
      lowStockThreshold: draft.lowStockThreshold,
      isActive: draft.isActive,
      imageUrl: draft.imageUrl,
      additionalImages: draft.additionalImages,
      rating: '0',
      reviewCount: 0,
      tags: draft.tags,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(products).values(values);
    const imageLinks = [draft.imageUrl, ...draft.additionalImages].filter(
      (url) => url.trim() !== '',
    );
    if (imageLinks.length > 0) {
      await this.media.setProductGalleryFromUrls(
        db,
        id,
        imageLinks,
        job.createdByEmail === '' ? 'import' : job.createdByEmail,
      );
    }
    await db.insert(inventoryMovements).values({
      id: `ledger_${randomUUID()}`,
      productId: id,
      productName: draft.name,
      changeAmount: draft.stockQuantity,
      previousStock: 0,
      newStock: draft.stockQuantity,
      changeType: 'restock',
      referenceId: `IMPORT:${job.id}`,
      actor: job.createdByEmail === '' ? 'import' : job.createdByEmail,
      note: `Created by CSV import (${job.fileName}) with opening stock of ${draft.stockQuantity} units`,
    });
    return id;
  }

  /** Counters are recomputed from the rows (the source of truth), never incremented. */
  private async refreshCounters(jobId: string, finalStatus?: 'completed'): Promise<void> {
    const tally = await this.db
      .select({ status: productImportRows.status, n: count() })
      .from(productImportRows)
      .where(eq(productImportRows.jobId, jobId))
      .groupBy(productImportRows.status);
    const of = (status: string) => tally.find((t) => t.status === status)?.n ?? 0;
    await this.db
      .update(productImportJobs)
      .set({
        createdCount: of('created'),
        failedCount: of('failed'),
        updatedAt: new Date(),
        ...(finalStatus === undefined ? {} : { status: finalStatus, finishedAt: new Date() }),
      })
      .where(eq(productImportJobs.id, jobId));
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async getJob(jobId: string): Promise<ImportJobView | null> {
    const rows = await this.db
      .select()
      .from(productImportJobs)
      .where(eq(productImportJobs.id, jobId))
      .limit(1);
    const job = rows.at(0);
    return job === undefined ? null : toView(job);
  }

  async listRecent(limit = 5): Promise<ImportJobView[]> {
    const rows = await this.db
      .select()
      .from(productImportJobs)
      .orderBy(desc(productImportJobs.createdAt))
      .limit(limit);
    return rows.map(toView);
  }

  /** CSV of the rows that failed during processing, with the reason — ready to fix and re-import. */
  async failedRowsCsv(jobId: string): Promise<string> {
    const rows = await this.db
      .select({
        rowNumber: productImportRows.rowNumber,
        raw: productImportRows.raw,
        errors: productImportRows.errors,
      })
      .from(productImportRows)
      .where(and(eq(productImportRows.jobId, jobId), eq(productImportRows.status, 'failed')))
      .orderBy(asc(productImportRows.rowNumber));
    const headers = PRODUCT_CSV_COLUMNS.filter((c) => !('exportOnly' in c)).map((c) => c.header);
    return (
      UTF8_BOM +
      toCsv([
        ['Row', 'Problem', ...headers],
        ...rows.map((r) => [
          String(r.rowNumber),
          r.errors.join(' '),
          ...headers.map((h) => r.raw[h] ?? ''),
        ]),
      ])
    );
  }

  /** Housekeeping: staged rows are only needed for progress and error reports. */
  async purgeFinishedBefore(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(productImportJobs)
      .where(
        and(
          inArray(productImportJobs.status, ['completed', 'failed']),
          sql`${productImportJobs.finishedAt} < ${cutoff}`,
        ),
      )
      .returning({ id: productImportJobs.id });
    return rows.length;
  }

  async templateExamples(): Promise<{
    category?: string;
    itemType?: string;
    taxCategory?: string;
  }> {
    const refs = await this.loadReferences();
    return {
      category: refs.categoryByName.values().next().value?.name,
      itemType: refs.defaultItemType?.name,
      taxCategory: refs.defaultTax?.name,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async loadReferences(): Promise<References> {
    const [categoryRows, itemTypeRows, taxRows, unitRows] = await Promise.all([
      this.db.select().from(categories),
      this.db.select().from(itemTypes).orderBy(asc(itemTypes.code)),
      this.db.select().from(taxCategories).orderBy(asc(taxCategories.name)),
      this.db.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.isActive, true)),
    ]);
    const itemTypeByRef = new Map<string, ItemTypeRow>();
    for (const type of itemTypeRows) {
      itemTypeByRef.set(key(type.name), type);
      itemTypeByRef.set(String(type.code), type);
    }
    const taxByRef = new Map<string, TaxCategoryRow>();
    for (const tax of taxRows) {
      taxByRef.set(key(tax.name), tax);
      taxByRef.set(key(tax.code), tax);
    }
    return {
      companyId: await this.deps.companyId(),
      categoryByName: new Map(categoryRows.map((c) => [key(c.name), c])),
      itemTypeByRef,
      // Same fallbacks as the product form.
      defaultItemType:
        itemTypeRows.find((t) => t.isDefault && t.isActive) ??
        itemTypeRows.find((t) => t.isDefault) ??
        itemTypeRows[0],
      taxByRef,
      defaultTax: taxRows.find((t) => t.isDefault) ?? taxRows[0],
      unitByCode: new Map(unitRows.map((u) => [key(u.code), u])),
      defaultUnit: unitRows.find((u) => u.isDefault),
    };
  }

  /** Existing identifiers in one pass; the unique indexes remain the final guard. */
  private async existingIdentifiers(): Promise<{
    sku: Set<string>;
    stockCode: Set<string>;
    slug: Set<string>;
  }> {
    const rows = await this.db
      .select({ sku: products.sku, stockCode: products.stockCode, slug: products.slug })
      .from(products)
      // Deleted products released their codes (the unique indexes are partial).
      .where(isNull(products.deletedAt));
    return {
      sku: new Set(rows.map((r) => r.sku.toUpperCase())),
      stockCode: new Set(rows.map((r) => r.stockCode.toUpperCase())),
      slug: new Set(rows.map((r) => r.slug)),
    };
  }
}

function rawCells(fields: readonly string[], headers: HeaderMap): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [header, index] of headers) raw[header] = fields[index] ?? '';
  return raw;
}
