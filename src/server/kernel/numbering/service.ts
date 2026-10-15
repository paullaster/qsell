import type { PageInput } from '@/server/domains/settings/paging';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type {
  NumberSeriesAllocationRow,
  NumberSeriesLineRow,
  NumberSeriesRow,
} from '@/server/db/drizzle/schema';
import type { Actor } from '../context';
import type { DecisionLog } from '../decision-log/service';
import type { ReasonCodes, ReasonInput } from '../reason-codes/service';
import { DOCUMENT_KINDS, isDocumentKind, type DocumentKind } from './document-kinds';
import { formatNumber, isBeyondEnd, nextSequence } from './domain/format';
import { counterKey, isIsoDate } from './domain/period';
import { selectLines } from './domain/select-line';
import { TemplateError, numbersPerBranch, validateTemplate } from './domain/template';
import type { ConsideredLine, Issue, LineConfig, ResetPolicy, SeriesMode } from './domain/types';
import { findOverlap, frozenViolations, validateLine } from './domain/validate';
import {
  isUniqueViolation,
  seriesRepo as repo,
  type Executor,
  type LineWithBranch,
} from './repository';

import { has } from '@/lib/values';

export type NumberSeriesErrorCode =
  | 'UNKNOWN_DOCUMENT_KIND'
  | 'SERIES_NOT_FOUND'
  | 'SERIES_INACTIVE'
  | 'NO_BINDING'
  | 'NO_OPEN_LINE'
  | 'SERIES_EXHAUSTED'
  | 'MANUAL_NOT_ALLOWED'
  | 'MANUAL_NUMBER_REQUIRED'
  | 'MANUAL_NUMBER_INVALID'
  | 'DUPLICATE_NUMBER'
  | 'TRANSACTION_REQUIRED'
  | 'DATE_ORDER'
  | 'BRANCH_REQUIRED'
  | 'BAD_DATE'
  | 'INVALID_CONFIG'
  | 'LINE_OVERLAP'
  | 'FROZEN'
  | 'FISCAL_REQUIRES_GAP_FREE'
  | 'IN_USE'
  | 'DUPLICATE_CODE'
  | 'NOT_FOUND';

export class NumberSeriesError extends Error {
  constructor(
    readonly code: NumberSeriesErrorCode,
    message: string,
    readonly detail: { issues?: Issue[]; trace?: ConsideredLine[] } = {},
  ) {
    super(message);
    this.name = 'NumberSeriesError';
  }
}

export interface NumberSeriesOptions {
  /**
   * Where an older numbering scheme left off, so the standard series carries on from there
   * instead of restarting. Return null when there is nothing to carry on from.
   */
  legacyStart?: (companyId: string, kind: DocumentKind) => Promise<number | null>;
  /**
   * An existing setting that should shape the standard prefix (the company's configured invoice
   * prefix, for instance). Return null to use the standard one. Ignored if it is not a valid pattern.
   */
  legacyPrefix?: (companyId: string, kind: DocumentKind) => Promise<string | null>;
  /**
   * Set up the standard series the first time a document kind is numbered, so a sale never fails
   * because numbering was not configured. On by default; turn off to require explicit setup.
   */
  autoSetup?: boolean;
  /**
   * Connection used for number-block reservation, which happens while the caller holds its own
   * transaction. Give it a pool of its own (see `kernelDb`); defaults to the main database.
   */
  counterDb?: DrizzleDb;
  /**
   * When a series numbers per branch but the document has none (e.g. an order placed through the
   * store), use the company's default branch instead of failing the sale. Off by default so
   * configuration mistakes stay visible; the application turns it on.
   */
  fallbackToDefaultBranch?: boolean;
  /** Does first-use setup on its own connection pool, for the same reason. */
  setupService?: NumberSeriesService;
}

export interface AssignRequest {
  companyId: string;
  branchId?: string | null;
  /** The document's business date (ISO `YYYY-MM-DD`). Not the clock. */
  date: string;
  /** Asking twice for the same document returns the number it already has. */
  document?: { kind: string; id: string };
  /** A number typed in by a person; only for series that allow it. */
  manualNo?: string;
  actor?: Actor;
}

export interface AssignedNumber {
  number: string;
  seriesCode: string;
  lineNo: number | null;
  sequence: number | null;
  periodKey: string;
  source: 'auto' | 'manual';
  /** True when the document already had a number and it was returned unchanged. */
  reused: boolean;
  /** Set when the series is near its end. */
  warning: string | null;
  /** The lines considered and why each was or was not used. */
  trace: ConsideredLine[];
}

export interface NumberPreview {
  ok: boolean;
  number: string | null;
  seriesCode: string | null;
  lineNo: number | null;
  note: string | null;
  error: { code: NumberSeriesErrorCode; message: string } | null;
  trace: ConsideredLine[];
}

export interface SeriesInput {
  code: string;
  description: string;
  mode: SeriesMode;
  manualAllowed?: boolean;
  defaultNumbers?: boolean;
  dateOrder?: boolean;
  blockSize?: number;
}

export interface LineInput {
  branchId?: string | null;
  startsOn: string;
  endsOn?: string | null;
  prefix?: string;
  suffix?: string;
  digits?: number;
  startNo?: number;
  endNo?: number | null;
  increment?: number;
  warnAt?: number | null;
  reset?: ResetPolicy;
  isOpen?: boolean;
}

interface Block {
  next: number;
  last: number;
}

/**
 * Block cache for allow-gaps series: numbers handed to this app instance in one database
 * round trip. Lost on restart (a recorded, accepted gap). Process-wide on purpose.
 */
const blocks = new Map<string, Block>();
/** Reservations in flight, so concurrent callers share one trip to the database. */
const reservations = new Map<string, Promise<Block | 'exhausted'>>();
/** First-use setups in flight. */
const setups = new Map<string, Promise<void>>();
export function clearNumberBlockCache(): void {
  blocks.clear();
  reservations.clear();
}

const MANUAL_PATTERN = /^[A-Za-z0-9\-_/.]{1,40}$/;
/** Bounded retries when a typed-in number happens to equal the next automatic one. */
const MAX_COLLISIONS = 25;

function isTransaction(ex: Executor): boolean {
  return typeof (ex as { rollback?: unknown }).rollback === 'function';
}

function toLineConfig(row: NumberSeriesLineRow): LineConfig {
  return {
    id: row.id,
    lineNo: row.lineNo,
    branchId: row.branchId,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    prefix: row.prefix,
    suffix: row.suffix,
    digits: row.digits,
    startNo: row.startNo,
    endNo: row.endNo,
    increment: row.increment,
    warnAt: row.warnAt,
    reset: row.reset,
    isOpen: row.isOpen,
  };
}

/**
 * Business Central style number series: lines with ranges and dates, bound to document kinds,
 * gap-free or block-allocated, with a live preview and a full explanation of every choice.
 * See docs/architecture/sales-order-blueprint.md §4.4.
 */
export class NumberSeriesService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly options: NumberSeriesOptions = {},
  ) {}

  private get legacyStart() {
    return this.options.legacyStart;
  }

  // ═══ Runtime: assigning numbers ═══════════════════════════════════════

  /**
   * Numbers a document by its kind, using the series bound to that kind (the branch's own
   * binding if it has one, else the default). For gap-free series call this INSIDE the
   * transaction that saves the document, so a rollback gives the number back.
   */
  async assign(kind: string, req: AssignRequest, tx?: Executor): Promise<AssignedNumber> {
    if (!isDocumentKind(kind)) {
      throw new NumberSeriesError(
        'UNKNOWN_DOCUMENT_KIND',
        `"${kind}" is not a numbered document kind.`,
      );
    }
    const ex = tx ?? this.db;
    const find = async () =>
      (has(req.branchId) ? await repo.binding(ex, req.companyId, kind, req.branchId) : null) ??
      (await repo.binding(ex, req.companyId, kind, null));
    let binding = await find();
    if (!binding && this.options.autoSetup !== false) {
      // First use of this kind: set up the standard series. It commits on its own (it is
      // configuration, not part of the document), so the caller's transaction is unaffected.
      await this.setUpOnce(
        req.companyId,
        kind,
        req.actor ?? { type: 'system', id: null },
        req.date,
      );
      binding = await find();
    }
    if (!binding) {
      throw new NumberSeriesError(
        'NO_BINDING',
        `No number series is set up for ${DOCUMENT_KINDS[kind].label.toLowerCase()}. Choose one under Document Numbering.`,
      );
    }
    const series = await repo.seriesById(ex, req.companyId, binding.seriesId);
    if (!series)
      throw new NumberSeriesError('SERIES_NOT_FOUND', 'The bound number series no longer exists.');
    return await this.assignIn(series, req, tx);
  }

  /** Numbers a document from a specific series (e.g. one a user picked from related series). */
  async assignFromSeries(
    seriesCode: string,
    req: AssignRequest,
    tx?: Executor,
  ): Promise<AssignedNumber> {
    const series = await repo.seriesByCode(tx ?? this.db, req.companyId, seriesCode);
    if (!series)
      throw new NumberSeriesError(
        'SERIES_NOT_FOUND',
        `Number series "${seriesCode}" does not exist.`,
      );
    return await this.assignIn(series, req, tx);
  }

  private async assignIn(
    series: NumberSeriesRow,
    req: AssignRequest,
    tx: Executor | undefined,
  ): Promise<AssignedNumber> {
    if (!isIsoDate(req.date))
      throw new NumberSeriesError('BAD_DATE', `"${req.date}" is not a valid date.`);
    if (!series.isActive)
      throw new NumberSeriesError('SERIES_INACTIVE', `Number series ${series.code} is not active.`);
    const ex = tx ?? this.db;
    const document = req.document;

    if (document) {
      const existing = await repo.allocationForDocument(
        ex,
        req.companyId,
        document.kind,
        document.id,
      );
      if (existing) return this.fromAllocation(series, existing, true, []);
    }

    let branch = has(req.branchId) ? await repo.branchRef(ex, req.branchId) : null;
    if (has(req.branchId) && (!branch || branch.companyId !== req.companyId)) {
      throw new NumberSeriesError('BRANCH_REQUIRED', `Branch ${req.branchId} was not found.`);
    }

    if (req.manualNo !== undefined) return await this.assignManual(series, req, ex, branch?.id ?? null);

    if (!series.defaultNumbers) {
      throw new NumberSeriesError(
        'MANUAL_NUMBER_REQUIRED',
        `Series ${series.code} needs a number to be typed in.`,
      );
    }
    if (series.mode === 'gap_free' && !isTransaction(ex)) {
      throw new NumberSeriesError(
        'TRANSACTION_REQUIRED',
        `Series ${series.code} is gap-free, so it must be numbered inside the transaction that saves the document. Otherwise a failed save would leave a gap.`,
      );
    }

    const lines = await repo.lines(ex, series.id);
    const branchCodes = new Map(lines.map((l) => [l.line.id, l.branchCode]));
    const selection = selectLines(
      lines.map((l) => toLineConfig(l.line)),
      {
        branchId: branch?.id ?? null,
        date: req.date,
      },
    );
    if (selection.ranked.length === 0) {
      throw new NumberSeriesError(
        'NO_OPEN_LINE',
        `Series ${series.code} has no open line for ${req.date}${branch ? ` and branch ${branch.code}` : ''}. ${describeTrace(selection.considered)}`,
        { trace: selection.considered },
      );
    }

    const trace = [...selection.considered];
    for (const line of selection.ranked) {
      if (numbersPerBranch(line) && !branch && this.options.fallbackToDefaultBranch === true) {
        branch = await repo.defaultBranchRef(ex, req.companyId);
      }
      if (numbersPerBranch(line) && !branch) {
        throw new NumberSeriesError(
          'BRANCH_REQUIRED',
          `Line ${line.lineNo} of ${series.code} numbers each branch separately, but the document has no branch.`,
          { trace: selection.considered },
        );
      }
      const period = counterKey(line.reset, req.date, numbersPerBranch(line), branch?.code ?? null);
      // Record the branch actually used (it may be the default one), not just the one asked for.
      const used = branch && branch.id !== req.branchId ? { ...req, branchId: branch.id } : req;
      const taken =
        series.mode === 'gap_free'
          ? await this.takeGapFree(
              series,
              line,
              period,
              used,
              ex,
              branch?.code ?? null,
              branchCodes.get(line.id) ?? null,
            )
          : await this.takeFromBlock(series, line, period, used, ex, branch?.code ?? null);
      if (taken === 'exhausted') {
        trace.push({ lineNo: line.lineNo, accepted: false, reason: 'range used up' });
        continue;
      }
      return {
        ...this.fromAllocation(series, taken.allocation, taken.reused, trace),
        warning: taken.warning,
      };
    }
    throw new NumberSeriesError(
      'SERIES_EXHAUSTED',
      `Every open line of ${series.code} has used its whole range. Add a new line or extend the ending number.`,
      { trace },
    );
  }

  private async assignManual(
    series: NumberSeriesRow,
    req: AssignRequest,
    ex: Executor,
    branchId: string | null,
  ): Promise<AssignedNumber> {
    if (!series.manualAllowed) {
      throw new NumberSeriesError(
        'MANUAL_NOT_ALLOWED',
        `Series ${series.code} does not allow typed-in numbers.`,
      );
    }
    const number = req.manualNo!.trim();
    if (!MANUAL_PATTERN.test(number)) {
      throw new NumberSeriesError(
        'MANUAL_NUMBER_INVALID',
        'Use 1–40 letters, digits and - _ / . only.',
      );
    }
    const row = await repo.insertAllocation(ex, {
      companyId: req.companyId,
      seriesId: series.id,
      lineId: null,
      number,
      sequence: null,
      periodKey: '',
      branchId,
      documentKind: req.document?.kind ?? null,
      documentId: req.document?.id ?? null,
      source: 'manual',
      documentDate: req.date,
      allocatedBy: req.actor?.id ?? null,
    });
    if (!row)
      throw new NumberSeriesError(
        'DUPLICATE_NUMBER',
        `${number} has already been used in series ${series.code}.`,
      );
    return this.fromAllocation(series, row, false, []);
  }

  /** Gap-free: the counter row is locked in the caller's transaction until it commits or rolls back. */
  private async takeGapFree(
    series: NumberSeriesRow,
    line: LineConfig,
    period: string,
    req: AssignRequest,
    ex: Executor,
    branchCode: string | null,
    _lineBranchCode: string | null,
  ): Promise<
    { allocation: NumberSeriesAllocationRow; reused: boolean; warning: string | null } | 'exhausted'
  > {
    await repo.ensureCounter(ex, line.id, period);
    const counter = await repo.lockCounter(ex, line.id, period);

    // A concurrent request for the same document may have numbered it while we waited.
    if (req.document) {
      const existing = await repo.allocationForDocument(
        ex,
        req.companyId,
        req.document.kind,
        req.document.id,
      );
      if (existing) return { allocation: existing, reused: true, warning: null };
    }
    if (series.dateOrder && has(counter.lastDate) && req.date < counter.lastDate) {
      throw new NumberSeriesError(
        'DATE_ORDER',
        `Series ${series.code} numbers documents in date order. The last one was dated ${counter.lastDate}, so a document dated ${req.date} cannot be numbered now.`,
      );
    }

    let seq = nextSequence(counter.lastNo, line);
    for (let attempt = 0; attempt <= MAX_COLLISIONS; attempt++) {
      if (isBeyondEnd(seq, line)) return 'exhausted';
      const number = this.render(line, seq, req.date, branchCode);
      const allocation = await repo.insertAllocation(
        ex,
        this.allocationValues(series, line, period, seq, number, req, branchCode),
      );
      if (allocation) {
        const lastDate =
          has(counter.lastDate) && counter.lastDate > req.date ? counter.lastDate : req.date;
        const crossed = line.warnAt !== null && seq >= line.warnAt && !counter.warned;
        await repo.updateCounter(ex, counter.id, {
          lastNo: seq,
          lastDate,
          ...(crossed ? { warned: true } : {}),
        });
        if (crossed) await this.recordNearEnd(series, line, seq, ex);
        return { allocation, reused: false, warning: this.warning(series, line, seq) };
      }
      // Either the document got a number meanwhile, or a typed-in number equals this one.
      if (req.document) {
        const existing = await repo.allocationForDocument(
          ex,
          req.companyId,
          req.document.kind,
          req.document.id,
        );
        if (existing) return { allocation: existing, reused: true, warning: null };
      }
      seq = nextSequence(seq, line);
    }
    throw new NumberSeriesError(
      'DUPLICATE_NUMBER',
      `Could not find a free number in ${series.code} after ${MAX_COLLISIONS} tries.`,
    );
  }

  /**
   * Allow-gaps: numbers come from a block this instance reserved earlier. A block is reserved
   * in its own short transaction, and concurrent callers share ONE reservation (single
   * flight) instead of each reserving a block of their own.
   */
  private async takeFromBlock(
    series: NumberSeriesRow,
    line: LineConfig,
    period: string,
    req: AssignRequest,
    ex: Executor,
    branchCode: string | null,
  ): Promise<
    { allocation: NumberSeriesAllocationRow; reused: boolean; warning: string | null } | 'exhausted'
  > {
    const key = `${line.id}|${period}`;
    let collisions = 0;
    for (;;) {
      let block = blocks.get(key);
      if (!block || block.next > block.last) {
        let pending = reservations.get(key);
        if (!pending) {
          pending = this.reserveBlock(series, line, period).finally(() => reservations.delete(key));
          reservations.set(key, pending);
        }
        const reserved = await pending;
        if (reserved === 'exhausted') return 'exhausted';
        // Everyone waiting on this reservation holds the same block object; install it once.
        if (blocks.get(key) !== reserved) blocks.set(key, reserved);
        block = reserved;
        // Other callers may have used it up while we waited: ask again rather than overrun it.
        if (block.next > block.last) continue;
      }
      const seq = block.next;
      block.next += line.increment;
      const number = this.render(line, seq, req.date, branchCode);
      const allocation = await repo.insertAllocation(
        ex,
        this.allocationValues(series, line, period, seq, number, req, branchCode),
      );
      if (allocation)
        return { allocation, reused: false, warning: this.warning(series, line, seq) };
      if (req.document) {
        const existing = await repo.allocationForDocument(
          ex,
          req.companyId,
          req.document.kind,
          req.document.id,
        );
        if (existing) return { allocation: existing, reused: true, warning: null };
      }
      if (++collisions > MAX_COLLISIONS) {
        throw new NumberSeriesError(
          'DUPLICATE_NUMBER',
          `Could not find a free number in ${series.code} after ${MAX_COLLISIONS} tries.`,
        );
      }
    }
  }

  private async reserveBlock(
    series: NumberSeriesRow,
    line: LineConfig,
    period: string,
  ): Promise<Block | 'exhausted'> {
    return await (this.options.counterDb ?? this.db).transaction(async (tx) => {
      await repo.ensureCounter(tx, line.id, period);
      const counter = await repo.lockCounter(tx, line.id, period);
      const start = nextSequence(counter.lastNo, line);
      if (isBeyondEnd(start, line)) return 'exhausted' as const;
      const capacity = 10 ** line.digits - 1;
      const cap = Math.min(line.endNo ?? capacity, capacity);
      const maxSeq = start + Math.floor((cap - start) / line.increment) * line.increment;
      const last = Math.min(start + (Math.max(series.blockSize, 1) - 1) * line.increment, maxSeq);
      const crossed = line.warnAt !== null && last >= line.warnAt && !counter.warned;
      await repo.updateCounter(tx, counter.id, {
        lastNo: last,
        ...(crossed ? { warned: true } : {}),
      });
      if (crossed) await this.recordNearEnd(series, line, last, tx);
      return { next: start, last };
    });
  }

  private render(line: LineConfig, seq: number, date: string, branchCode: string | null): string {
    try {
      return formatNumber(line, seq, { date, branchCode });
    } catch (error) {
      if (error instanceof TemplateError) {
        throw new NumberSeriesError(
          error.code === 'BRANCH_REQUIRED' ? 'BRANCH_REQUIRED' : 'BAD_DATE',
          error.message,
        );
      }
      throw new NumberSeriesError(
        'INVALID_CONFIG',
        error instanceof Error ? error.message : 'Cannot format the number.',
      );
    }
  }

  private allocationValues(
    series: NumberSeriesRow,
    line: LineConfig,
    period: string,
    seq: number,
    number: string,
    req: AssignRequest,
    _branchCode: string | null,
  ) {
    return {
      companyId: req.companyId,
      seriesId: series.id,
      lineId: line.id,
      number,
      sequence: seq,
      periodKey: period,
      branchId: req.branchId ?? null,
      documentKind: req.document?.kind ?? null,
      documentId: req.document?.id ?? null,
      source: 'auto' as const,
      documentDate: req.date,
      allocatedBy: req.actor?.id ?? null,
    };
  }

  private warning(series: NumberSeriesRow, line: LineConfig, seq: number): string | null {
    if (line.warnAt === null || seq < line.warnAt) return null;
    return line.endNo === null
      ? `Series ${series.code} (line ${line.lineNo}) has reached ${seq}.`
      : `Series ${series.code} (line ${line.lineNo}) is near its end: ${seq} of ${line.endNo}.`;
  }

  private async recordNearEnd(
    series: NumberSeriesRow,
    line: LineConfig,
    seq: number,
    ex: Executor,
  ): Promise<void> {
    await this.decisions.record(
      {
        companyId: series.companyId,
        subject: { type: 'number_series', id: series.id },
        action: 'numbering.near_end',
        reason: { code: 'EXHAUSTED' },
        inputs: { lineNo: line.lineNo, sequence: seq, warnAt: line.warnAt, endNo: line.endNo },
        outcome: { message: this.warning(series, line, seq) },
      },
      ex,
    );
  }

  private fromAllocation(
    series: NumberSeriesRow,
    a: NumberSeriesAllocationRow,
    reused: boolean,
    trace: ConsideredLine[],
  ): AssignedNumber {
    return {
      number: a.number,
      seriesCode: series.code,
      lineNo: null,
      sequence: a.sequence,
      periodKey: a.periodKey,
      source: a.source,
      reused,
      warning: null,
      trace,
    };
  }

  // ═══ Preview: what would the next number be? (consumes nothing) ═══════

  async preview(
    companyId: string,
    target: { kind: string } | { seriesCode: string },
    opts: { branchId?: string | null; date: string },
  ): Promise<NumberPreview> {
    const fail = (
      code: NumberSeriesErrorCode,
      message: string,
      trace: ConsideredLine[] = [],
    ): NumberPreview => ({
      ok: false,
      number: null,
      seriesCode: null,
      lineNo: null,
      note: null,
      error: { code, message },
      trace,
    });
    if (!isIsoDate(opts.date)) return fail('BAD_DATE', 'Enter a valid date.');

    let series: NumberSeriesRow | null;
    if ('seriesCode' in target) {
      series = await repo.seriesByCode(this.db, companyId, target.seriesCode);
      if (!series)
        return fail('SERIES_NOT_FOUND', `Number series "${target.seriesCode}" does not exist.`);
    } else {
      if (!isDocumentKind(target.kind))
        return fail('UNKNOWN_DOCUMENT_KIND', `"${target.kind}" is not a numbered document kind.`);
      const binding =
        (has(opts.branchId)
          ? await repo.binding(this.db, companyId, target.kind, opts.branchId)
          : null) ?? (await repo.binding(this.db, companyId, target.kind, null));
      if (!binding) return fail('NO_BINDING', 'No number series is set up for this document.');
      series = await repo.seriesById(this.db, companyId, binding.seriesId);
      if (!series) return fail('SERIES_NOT_FOUND', 'The bound number series no longer exists.');
    }
    if (!series.isActive)
      return fail('SERIES_INACTIVE', `Number series ${series.code} is not active.`);

    const branch = has(opts.branchId) ? await repo.branchRef(this.db, opts.branchId) : null;
    const lines = await repo.lines(this.db, series.id);
    const selection = selectLines(
      lines.map((l) => toLineConfig(l.line)),
      { branchId: branch?.id ?? null, date: opts.date },
    );
    if (selection.ranked.length === 0) {
      return fail(
        'NO_OPEN_LINE',
        `No open line for ${opts.date}. ${describeTrace(selection.considered)}`,
        selection.considered,
      );
    }
    for (const line of selection.ranked) {
      if (numbersPerBranch(line) && !branch) {
        return fail(
          'BRANCH_REQUIRED',
          `Line ${line.lineNo} numbers each branch separately; choose a branch.`,
          selection.considered,
        );
      }
      const period = counterKey(
        line.reset,
        opts.date,
        numbersPerBranch(line),
        branch?.code ?? null,
      );
      const counter = await repo.readCounter(this.db, line.id, period);
      const seq = nextSequence(counter?.lastNo ?? null, line);
      if (isBeyondEnd(seq, line)) continue;
      try {
        const number = formatNumber(line, seq, {
          date: opts.date,
          branchCode: branch?.code ?? null,
        });
        return {
          ok: true,
          number,
          seriesCode: series.code,
          lineNo: line.lineNo,
          note:
            series.mode === 'allow_gaps'
              ? 'This series hands out numbers in blocks, so the actual number may be higher.'
              : null,
          error: null,
          trace: selection.considered,
        };
      } catch (error) {
        if (error instanceof TemplateError)
          return fail('BRANCH_REQUIRED', error.message, selection.considered);
        throw error;
      }
    }
    return fail(
      'SERIES_EXHAUSTED',
      'Every open line has used its whole range.',
      selection.considered,
    );
  }

  // ═══ Administration ════════════════════════════════════════════════════

  async listSeries(companyId: string): Promise<NumberSeriesRow[]> {
    return await repo.listSeries(this.db, companyId);
  }

  async seriesLabels(companyId: string, ids: string[]) {
    return await repo.seriesLabels(this.db, companyId, ids);
  }

  async branchCodes(ids: string[]) {
    return await repo.branchCodes(this.db, ids);
  }

  async branchLabels(ids: string[]) {
    return await repo.branchLabels(this.db, ids);
  }

  async pageSeries(companyId: string, input: PageInput) {
    const page = await repo.pageSeries(this.db, companyId, input);
    const counts = await repo.lineCounts(this.db, page.rows.map((r) => r.id));
    const bindings = await repo.bindingsForSeriesIds(this.db, page.rows.map((r) => r.id));
    return { rows: page.rows, lineCounts: counts, bindings, nextCursor: page.nextCursor };
  }

  async seriesDetail(companyId: string, seriesId: string) {
    const series = await repo.seriesById(this.db, companyId, seriesId);
    if (!series) throw new NumberSeriesError('NOT_FOUND', 'Number series not found.');
    const lines = await repo.lines(this.db, series.id);
    const counters = await repo.countersForLines(
      this.db,
      lines.map((l) => l.line.id),
    );
    const bindings = await repo.bindingsForSeries(this.db, series.id);
    const relationships = await repo.relationships(this.db, series.id);
    return { series, lines, counters, bindings, relationships };
  }

  async recentAllocations(
    companyId: string,
    seriesId: string,
    limit = 50,
  ): Promise<NumberSeriesAllocationRow[]> {
    const series = await repo.seriesById(this.db, companyId, seriesId);
    if (!series) throw new NumberSeriesError('NOT_FOUND', 'Number series not found.');
    return await repo.recentAllocations(this.db, seriesId, Math.min(limit, 200));
  }

  async createSeries(
    companyId: string,
    input: SeriesInput,
    actor: Actor,
    reason?: ReasonInput,
  ): Promise<NumberSeriesRow> {
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,20}$/.test(code)) {
      throw new NumberSeriesError(
        'INVALID_CONFIG',
        'The code must be 1–20 letters, digits, - or _.',
        {
          issues: [{ field: 'code', message: 'Use 1–20 letters, digits, - or _.' }],
        },
      );
    }
    if (!has(input.description.trim())) {
      throw new NumberSeriesError('INVALID_CONFIG', 'Add a description.', {
        issues: [{ field: 'description', message: 'Required.' }],
      });
    }
    if (input.dateOrder === true && input.mode !== 'gap_free') {
      throw new NumberSeriesError(
        'INVALID_CONFIG',
        'Date order can only be enforced on a gap-free series.',
        {
          issues: [{ field: 'dateOrder', message: 'Only for gap-free series.' }],
        },
      );
    }
    return await this.db.transaction(async (tx) => {
      if (await repo.seriesByCode(tx, companyId, code)) {
        throw new NumberSeriesError(
          'DUPLICATE_CODE',
          `A number series with code ${code} already exists.`,
        );
      }
      const row = await repo.insertSeries(tx, {
        companyId,
        code,
        description: input.description.trim(),
        mode: input.mode,
        manualAllowed: input.manualAllowed ?? false,
        defaultNumbers: input.defaultNumbers ?? true,
        dateOrder: input.dateOrder ?? false,
        blockSize: Math.max(1, Math.min(input.blockSize ?? 50, 10_000)),
      });
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'number_series', id: row.id },
          action: 'numbering.series_created',
          actor,
          reason: this.cleanReason(reason),
          to: row.mode,
          inputs: { code },
        },
        tx,
      );
      return row;
    });
  }

  async updateSeries(
    companyId: string,
    seriesId: string,
    patch: Partial<
      Pick<
        SeriesInput,
        'description' | 'mode' | 'manualAllowed' | 'defaultNumbers' | 'dateOrder' | 'blockSize'
      >
    > & { isActive?: boolean },
    actor: Actor,
    reason: ReasonInput,
  ): Promise<NumberSeriesRow> {
    const checked = await this.reasons.require(companyId, reason, 'numbering.series_updated');
    return await this.db.transaction(async (tx) => {
      const series = await repo.seriesById(tx, companyId, seriesId);
      if (!series) throw new NumberSeriesError('NOT_FOUND', 'Number series not found.');
      const mode = patch.mode ?? series.mode;
      const dateOrder = patch.dateOrder ?? series.dateOrder;
      if (dateOrder && mode !== 'gap_free') {
        throw new NumberSeriesError(
          'INVALID_CONFIG',
          'Date order can only be enforced on a gap-free series.',
        );
      }
      if (mode !== 'gap_free') {
        const fiscal = (await repo.bindingsForSeries(tx, series.id)).find(
          (b) => isDocumentKind(b.documentKind) && DOCUMENT_KINDS[b.documentKind].fiscal,
        );
        if (fiscal) {
          throw new NumberSeriesError(
            'FISCAL_REQUIRES_GAP_FREE',
            `This series numbers ${DOCUMENT_KINDS[fiscal.documentKind as DocumentKind].label.toLowerCase()}s, which are fiscal documents and must be gap-free.`,
          );
        }
      }
      const updated = await repo.updateSeries(tx, series.id, {
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.manualAllowed !== undefined ? { manualAllowed: patch.manualAllowed } : {}),
        ...(patch.defaultNumbers !== undefined ? { defaultNumbers: patch.defaultNumbers } : {}),
        ...(patch.dateOrder !== undefined ? { dateOrder: patch.dateOrder } : {}),
        ...(patch.blockSize !== undefined
          ? { blockSize: Math.max(1, Math.min(patch.blockSize, 10_000)) }
          : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      });
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'number_series', id: series.id },
          action: 'numbering.series_updated',
          actor,
          reason: checked,
          from: series.mode,
          to: updated.mode,
          inputs: { before: pick(series, Object.keys(patch)), patch },
        },
        tx,
      );
      return updated;
    });
  }

  async deleteSeries(
    companyId: string,
    seriesId: string,
    actor: Actor,
    reason: ReasonInput,
  ): Promise<void> {
    const checked = await this.reasons.require(companyId, reason, 'numbering.series_deleted');
    await this.db.transaction(async (tx) => {
      const series = await repo.seriesById(tx, companyId, seriesId);
      if (!series) throw new NumberSeriesError('NOT_FOUND', 'Number series not found.');
      if (
        (await repo.seriesHasAllocations(tx, series.id)) ||
        (await repo.bindingsForSeries(tx, series.id)).length > 0
      ) {
        throw new NumberSeriesError(
          'IN_USE',
          'This series has issued numbers or is bound to a document, so it cannot be deleted. Deactivate it instead.',
        );
      }
      await repo.deleteSeries(tx, series.id);
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'number_series', id: series.id },
          action: 'numbering.series_deleted',
          actor,
          reason: checked,
          inputs: { code: series.code },
        },
        tx,
      );
    });
  }

  async addLine(
    companyId: string,
    seriesId: string,
    input: LineInput,
    actor: Actor,
    reason?: ReasonInput,
  ): Promise<NumberSeriesLineRow> {
    return await this.db.transaction(async (tx) => {
      const series = await repo.seriesById(tx, companyId, seriesId);
      if (!series) throw new NumberSeriesError('NOT_FOUND', 'Number series not found.');
      const candidate = this.lineDefaults(input);
      await this.assertLineValid(tx, series, candidate, null);
      const row = await repo.insertLine(tx, {
        seriesId,
        lineNo: await repo.nextLineNo(tx, seriesId),
        branchId: candidate.branchId,
        startsOn: candidate.startsOn,
        endsOn: candidate.endsOn,
        prefix: candidate.prefix,
        suffix: candidate.suffix,
        digits: candidate.digits,
        startNo: candidate.startNo,
        endNo: candidate.endNo,
        increment: candidate.increment,
        warnAt: candidate.warnAt,
        reset: candidate.reset,
        isOpen: candidate.isOpen,
      });
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'number_series', id: seriesId },
          action: 'numbering.line_added',
          actor,
          reason: this.cleanReason(reason),
          inputs: { lineNo: row.lineNo, ...candidate },
        },
        tx,
      );
      return row;
    });
  }

  async updateLine(
    companyId: string,
    lineId: string,
    patch: Partial<LineInput>,
    actor: Actor,
    reason: ReasonInput,
  ): Promise<NumberSeriesLineRow> {
    const checked = await this.reasons.require(companyId, reason, 'numbering.line_updated');
    return await this.db.transaction(async (tx) => {
      const current = await repo.lineById(tx, lineId);
      const series = current ? await repo.seriesById(tx, companyId, current.seriesId) : null;
      if (!current || !series) throw new NumberSeriesError('NOT_FOUND', 'Line not found.');

      const merged = { ...toLineConfig(current), ...definedOnly(patch) };
      if (await repo.lineHasIssued(tx, current.id)) {
        const violations = frozenViolations(
          toLineConfig(current),
          definedOnly(patch),
        );
        if (violations.length > 0) {
          throw new NumberSeriesError(
            'FROZEN',
            'These fields cannot change once the line has issued numbers.',
            { issues: violations },
          );
        }
      }
      await this.assertLineValid(tx, series, merged, current.id);
      const updated = await repo.updateLine(
        tx,
        current.id,
        definedOnly(patch),
      );
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'number_series', id: series.id },
          action: 'numbering.line_updated',
          actor,
          reason: checked,
          inputs: { lineNo: current.lineNo, before: pick(current, Object.keys(patch)), patch },
        },
        tx,
      );
      blocks.forEach((_v, k) => k.startsWith(`${current.id}|`) && blocks.delete(k));
      return updated;
    });
  }

  /** Closing stops a line issuing numbers (e.g. at year end); reopening needs a reason too. */
  async setLineOpen(
    companyId: string,
    lineId: string,
    open: boolean,
    actor: Actor,
    reason: ReasonInput,
  ): Promise<NumberSeriesLineRow> {
    const checked = await this.reasons.require(companyId, reason, 'numbering.line_open_changed');
    return await this.db.transaction(async (tx) => {
      const current = await repo.lineById(tx, lineId);
      const series = current ? await repo.seriesById(tx, companyId, current.seriesId) : null;
      if (!current || !series) throw new NumberSeriesError('NOT_FOUND', 'Line not found.');
      if (open) {
        const siblings = (await repo.lines(tx, series.id)).map((l) => toLineConfig(l.line));
        const clash = findOverlap(siblings, { ...toLineConfig(current), isOpen: true });
        if (clash) {
          throw new NumberSeriesError(
            'LINE_OVERLAP',
            `Line ${clash.lineNo} is open for an overlapping period and branch. Close it first.`,
          );
        }
      }
      const updated = await repo.updateLine(tx, current.id, { isOpen: open });
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'number_series', id: series.id },
          action: open ? 'numbering.line_opened' : 'numbering.line_closed',
          actor,
          reason: checked,
          from: current.isOpen ? 'open' : 'closed',
          to: open ? 'open' : 'closed',
          inputs: { lineNo: current.lineNo },
        },
        tx,
      );
      blocks.forEach((_v, k) => k.startsWith(`${current.id}|`) && blocks.delete(k));
      return updated;
    });
  }

  // ── bindings ─────────────────────────────────────────────────────────

  async bindings(companyId: string) {
    return await repo.bindings(this.db, companyId);
  }

  async setBinding(
    companyId: string,
    input: { documentKind: string; branchId?: string | null; seriesId: string },
    actor: Actor,
    reason: ReasonInput,
  ): Promise<void> {
    if (!isDocumentKind(input.documentKind)) {
      throw new NumberSeriesError(
        'UNKNOWN_DOCUMENT_KIND',
        `"${input.documentKind}" is not a numbered document kind.`,
      );
    }
    const kind = input.documentKind; // narrowed to DocumentKind by the guard above
    const checked = await this.reasons.require(companyId, reason, 'numbering.binding_changed');
    await this.db.transaction(async (tx) => {
      const series = await repo.seriesById(tx, companyId, input.seriesId);
      if (!series) throw new NumberSeriesError('SERIES_NOT_FOUND', 'Number series not found.');
      if (!series.isActive)
        throw new NumberSeriesError(
          'SERIES_INACTIVE',
          `Number series ${series.code} is not active.`,
        );
      const def = DOCUMENT_KINDS[kind];
      if (def.fiscal && series.mode !== 'gap_free') {
        throw new NumberSeriesError(
          'FISCAL_REQUIRES_GAP_FREE',
          `${def.label} is a fiscal document and must use a gap-free series. ${series.code} allows gaps.`,
        );
      }
      const branchId = input.branchId ?? null;
      const existing = await repo.binding(tx, companyId, kind, branchId);
      if (existing) await repo.updateBindingSeries(tx, existing.id, series.id);
      else
        await repo.insertBinding(tx, {
          companyId,
          documentKind: kind,
          branchId,
          seriesId: series.id,
        });
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'document_numbering', id: kind },
          action: 'numbering.binding_set',
          actor,
          reason: checked,
          from: existing?.seriesId ?? null,
          to: series.id,
          inputs: { branchId, seriesCode: series.code },
        },
        tx,
      );
    });
  }

  async clearBinding(
    companyId: string,
    documentKind: string,
    branchId: string | null,
    actor: Actor,
    reason: ReasonInput,
  ): Promise<void> {
    const checked = await this.reasons.require(companyId, reason, 'numbering.binding_changed');
    await this.db.transaction(async (tx) => {
      const existing = await repo.binding(tx, companyId, documentKind, branchId);
      if (!existing) return;
      await repo.deleteBinding(tx, existing.id);
      await this.decisions.record(
        {
          companyId,
          subject: { type: 'document_numbering', id: documentKind },
          action: 'numbering.binding_cleared',
          actor,
          reason: checked,
          from: existing.seriesId,
          inputs: { branchId },
        },
        tx,
      );
    });
  }

  async addRelationship(
    companyId: string,
    seriesId: string,
    relatedSeriesId: string,
  ): Promise<void> {
    if (seriesId === relatedSeriesId)
      throw new NumberSeriesError('INVALID_CONFIG', 'A series cannot relate to itself.');
    const [a, b] = await Promise.all([
      repo.seriesById(this.db, companyId, seriesId),
      repo.seriesById(this.db, companyId, relatedSeriesId),
    ]);
    if (!a || !b) throw new NumberSeriesError('SERIES_NOT_FOUND', 'Number series not found.');
    await repo.addRelationship(this.db, seriesId, relatedSeriesId);
  }

  async removeRelationship(
    companyId: string,
    seriesId: string,
    relatedSeriesId: string,
  ): Promise<void> {
    if (!(await repo.seriesById(this.db, companyId, seriesId)))
      throw new NumberSeriesError('SERIES_NOT_FOUND', 'Number series not found.');
    await repo.removeRelationship(this.db, seriesId, relatedSeriesId);
  }

  // ── setup ────────────────────────────────────────────────────────────

  /** One first-use setup per (company, kind) at a time; everyone else waits for that one. */
  private async setUpOnce(
    companyId: string,
    kind: DocumentKind,
    actor: Actor,
    today: string,
  ): Promise<void> {
    const key = `${companyId}|${kind}`;
    let running = setups.get(key);
    if (!running) {
      running = (this.options.setupService ?? this)
        .seedKind(companyId, kind, actor, today)
        .then(() => undefined)
        .finally(() => setups.delete(key));
      setups.set(key, running);
    }
    await running;
  }

  /**
   * Gives one document kind its standard series and binding if it has none: gap-free for fiscal
   * documents, block-allocated otherwise, yearly restart where it makes sense, sized for the
   * agreed volume. Idempotent and safe to race: whoever loses a race simply uses the winner's.
   * `startAt` lets a kind carry on from an older counter instead of restarting at 1.
   */
  async seedKind(
    companyId: string,
    kind: DocumentKind,
    actor: Actor,
    today: string,
  ): Promise<boolean> {
    if (await repo.binding(this.db, companyId, kind, null)) return false;
    await this.reasons.ensureSystemReasons(companyId);
    const def = DOCUMENT_KINDS[kind];
    const code = def.suggested.code;
    try {
      let series = await repo.seriesByCode(this.db, companyId, code);
      if (!series) {
        series = await this.createSeries(
          companyId,
          {
            code,
            description: def.label,
            mode: def.fiscal ? 'gap_free' : 'allow_gaps',
            dateOrder: def.fiscal,
            blockSize: def.suggested.blockSize,
          },
          actor,
          { code: 'POLICY_CHANGE', text: 'Standard setup' },
        );
        const startAt = (await this.legacyStart?.(companyId, kind)) ?? 1;
        const custom = await this.options.legacyPrefix?.(companyId, kind);
        const prefix = has(custom) && !has(validateTemplate(custom)) ? custom : def.suggested.prefix;
        await this.addLine(
          companyId,
          series.id,
          {
            startsOn: `${today.slice(0, 4)}-01-01`,
            prefix,
            digits: def.suggested.digits,
            reset: def.suggested.reset,
            startNo: Math.max(1, startAt),
          },
          actor,
        );
      }
      await this.setBinding(companyId, { documentKind: kind, seriesId: series.id }, actor, {
        code: 'POLICY_CHANGE',
        text: 'Standard setup',
      });
      return true;
    } catch (error) {
      // A concurrent request set it up first: that is what we wanted.
      if (
        isUniqueViolation(error) ||
        (error instanceof NumberSeriesError &&
          (error.code === 'DUPLICATE_CODE' || error.code === 'LINE_OVERLAP'))
      ) {
        return false;
      }
      throw error;
    }
  }

  /** Sets up every document kind that has no series yet. */
  async seedStandard(
    companyId: string,
    actor: Actor,
    today: string,
  ): Promise<{ created: string[] }> {
    const created: string[] = [];
    for (const kind of Object.keys(DOCUMENT_KINDS) as DocumentKind[]) {
      if (await this.seedKind(companyId, kind, actor, today)) created.push(kind);
    }
    return { created };
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private cleanReason(reason?: ReasonInput) {
    return has(reason?.code) ? { code: reason.code, text: reason.text ?? undefined } : undefined;
  }

  private lineDefaults(input: LineInput): Omit<LineConfig, 'id' | 'lineNo'> {
    return {
      branchId: input.branchId ?? null,
      startsOn: input.startsOn,
      endsOn: input.endsOn ?? null,
      prefix: input.prefix ?? '',
      suffix: input.suffix ?? '',
      digits: input.digits ?? 6,
      startNo: input.startNo ?? 1,
      endNo: input.endNo ?? null,
      increment: input.increment ?? 1,
      warnAt: input.warnAt ?? null,
      reset: input.reset ?? 'never',
      isOpen: input.isOpen ?? true,
    };
  }

  private async assertLineValid(
    ex: Executor,
    series: NumberSeriesRow,
    line: Omit<LineConfig, 'id' | 'lineNo'> & { id?: string },
    ownId: string | null,
  ): Promise<void> {
    const issues = validateLine(line, { mode: series.mode, dateOrder: series.dateOrder });
    if (issues.length > 0) {
      throw new NumberSeriesError('INVALID_CONFIG', issues.map((i) => i.message).join(' '), {
        issues,
      });
    }
    if (has(line.branchId)) {
      const branch = await repo.branchRef(ex, line.branchId);
      if (!branch || branch.companyId !== series.companyId) {
        throw new NumberSeriesError('INVALID_CONFIG', 'That branch was not found.', {
          issues: [{ field: 'branchId', message: 'Unknown branch.' }],
        });
      }
    }
    const siblings = (await repo.lines(ex, series.id)).map((l) => toLineConfig(l.line));
    const clash = findOverlap(siblings, {
      id: ownId ?? 'new',
      branchId: line.branchId,
      startsOn: line.startsOn,
      endsOn: line.endsOn,
      isOpen: line.isOpen,
    });
    if (clash) {
      throw new NumberSeriesError(
        'LINE_OVERLAP',
        `Line ${clash.lineNo} already covers ${clash.startsOn} to ${clash.endsOn ?? 'no end'} for ${has(clash.branchId) ? 'this branch' : 'all branches'}. Close it or change the dates.`,
        { issues: [{ field: 'startsOn', message: 'Overlaps another open line.' }] },
      );
    }
  }
}

function describeTrace(trace: ConsideredLine[]): string {
  if (trace.length === 0) return 'The series has no lines.';
  return `Lines: ${trace.map((t) => `${t.lineNo} (${t.reason})`).join(', ')}.`;
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function pick(o: object, keys: string[]): Record<string, unknown> {
  const src = o as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => k in src).map((k) => [k, src[k]]));
}

export type { LineWithBranch };
