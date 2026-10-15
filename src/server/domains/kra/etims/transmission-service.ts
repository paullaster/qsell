import { and, eq, lt, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { kraTransmissions, type KraTransmissionRow } from '@/server/db/drizzle/schema';
import type { KraConfigResolver } from '../resolver';
import { KraConfigError, type ResolvedEtimsConfig } from '../types';
import {
  EtimsApiError,
  EtimsClient,
  type EtimsInvoiceRequest,
  type EtimsSalesItem,
} from './client';

import { has } from '@/lib/values';

/** A transmission left `pending` longer than this is assumed dead and may be retried. */
const STALE_PENDING_MS = 5 * 60_000;

export interface TransmitEtimsInvoiceInput {
  companyId: string;
  branchId?: string | null;
  orderId?: string | null;
  traderInvoiceNo: string;
  /** Required for credit notes (receiptTypeCode 'R'). */
  traderOrgInvoiceNo?: string;
  receiptTypeCode?: 'S' | 'R';
  salesTypeCode?: 'N' | 'C' | 'P' | 'T';
  paymentType?: string;
  salesDate: Date;
  currency: string;
  exchangeRate?: number;
  customerPin?: string;
  totalAmount: number;
  /** Items must already be registered with KRA; itemCode is KRA's code, not our SKU. */
  lines: EtimsSalesItem[];
}

export type FetchLike = typeof fetch;

export class EtimsTransmissionService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly resolver: KraConfigResolver,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /**
   * Sends an invoice to KRA through eTIMS. Throws KraConfigError before touching the
   * database or network if the configuration is unusable. Idempotent per traderInvoiceNo:
   * a succeeded transmission is returned as-is and never re-sent.
   */
  async transmitInvoice(input: TransmitEtimsInvoiceInput): Promise<KraTransmissionRow> {
    const config = await this.resolver.resolve({
      companyId: input.companyId,
      branchId: input.branchId,
    });
    if (config.mode !== 'etims') throw modeMismatch(config.source, 'TIMS');
    return await this.send(config, input);
  }

  /**
   * Sends a credit note to the gateway that holds its original invoice. The scope and mode
   * are the ones recorded when the original was signed, not whatever the branch is today:
   * if the config for that exact scope is gone, disabled, incomplete, or has been switched
   * to another mode, this throws and nothing is sent.
   */
  async transmitCreditNote(
    input: Omit<TransmitEtimsInvoiceInput, 'receiptTypeCode' | 'traderOrgInvoiceNo'> & {
      originalTraderInvoiceNo: string;
      original: { source: 'company' | 'branch'; branchId: string | null };
    },
  ): Promise<KraTransmissionRow> {
    const config = await this.resolver.resolveExplicit({
      companyId: input.companyId,
      source: input.original.source,
      branchId: input.original.branchId,
    });
    if (config.mode !== 'etims') {
      throw new KraConfigError(
        'MODE_MISMATCH',
        `The ${config.source} was set to eTIMS when the invoice was signed but is now TIMS; the credit note was not sent.`,
        config.source,
      );
    }
    return await this.send(config, {
      ...input,
      branchId: input.original.branchId,
      receiptTypeCode: 'R',
      traderOrgInvoiceNo: input.originalTraderInvoiceNo,
    });
  }

  private async send(
    config: ResolvedEtimsConfig,
    input: TransmitEtimsInvoiceInput,
  ): Promise<KraTransmissionRow> {
    const request = this.buildRequest(input);
    const claimed = await this.claim(input, config, request);
    if (claimed.status === 'succeeded') return claimed;

    try {
      const response = await new EtimsClient(config, this.fetchImpl).createInvoice(request);
      if (response.status !== 200 || !response.data) {
        throw new EtimsApiError(
          response.message ?? 'eTIMS rejected the invoice',
          response.status,
          false,
          response,
        );
      }
      const done = await this.finish(claimed, {
        status: 'succeeded',
        response: response as unknown as Record<string, unknown>,
        scuReceiptNo:
          response.data.scuReceiptNo === undefined ? null : String(response.data.scuReceiptNo),
        verificationUrl: response.data.invoiceVerificationUrl ?? null,
        errorCode: null,
        errorMessage: null,
      });
      return done;
    } catch (error: unknown) {
      const apiError =
        error instanceof EtimsApiError
          ? error
          : new EtimsApiError(
              error instanceof Error ? error.message : 'Unknown error',
              null,
              false,
            );
      await this.finish(claimed, {
        status: 'failed',
        response: (apiError.body as Record<string, unknown> | null | undefined) ?? null,
        scuReceiptNo: null,
        verificationUrl: null,
        errorCode: apiError.httpStatus === null ? 'NETWORK' : `HTTP_${apiError.httpStatus}`,
        errorMessage: apiError.message,
      });
      throw apiError;
    }
  }

  private buildRequest(input: TransmitEtimsInvoiceInput): EtimsInvoiceRequest {
    const receiptTypeCode = input.receiptTypeCode ?? 'S';
    if (receiptTypeCode === 'R' && !has(input.traderOrgInvoiceNo)) {
      throw new Error('A credit note requires the original trader invoice number.');
    }
    if (input.lines.length === 0) throw new Error('An invoice needs at least one line.');
    return {
      traderInvoiceNo: input.traderInvoiceNo,
      ...(receiptTypeCode === 'R' ? { traderOrgInvoiceNo: input.traderOrgInvoiceNo } : {}),
      totalAmount: input.totalAmount,
      paymentType: input.paymentType ?? '01',
      salesTypeCode: input.salesTypeCode ?? 'N',
      receiptTypeCode,
      salesStatusCode: '01',
      salesDate: formatSalesDate(input.salesDate),
      currency: input.currency,
      exchangeRate: input.exchangeRate ?? 1,
      salesItems: input.lines,
      ...(has(input.customerPin) ? { customerPin: input.customerPin } : {}),
    };
  }

  /** Creates the row, or atomically re-claims a failed/stale one. Succeeded rows pass through. */
  private async claim(
    input: TransmitEtimsInvoiceInput,
    config: ResolvedEtimsConfig,
    request: EtimsInvoiceRequest,
  ): Promise<KraTransmissionRow> {
    const [inserted] = await this.db
      .insert(kraTransmissions)
      .values({
        orderId: input.orderId ?? null,
        branchId: config.branchId,
        configSource: config.source,
        mode: 'etims',
        traderInvoiceNo: input.traderInvoiceNo,
        status: 'pending',
        attempts: 1,
        request: request as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: kraTransmissions.traderInvoiceNo })
      .returning();
    if (inserted) return inserted;

    const [existing] = await this.db
      .select()
      .from(kraTransmissions)
      .where(eq(kraTransmissions.traderInvoiceNo, input.traderInvoiceNo))
      .limit(1);
    if (!existing) throw new Error('Transmission row vanished during claim.');
    if (existing.status === 'succeeded') return existing;

    const stale = new Date(Date.now() - STALE_PENDING_MS);
    const [reclaimed] = await this.db
      .update(kraTransmissions)
      .set({
        status: 'pending',
        attempts: sql`${kraTransmissions.attempts} + 1`,
        request: request as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(kraTransmissions.id, existing.id),
          // Typed comparison (not a raw fragment) so the Date serialises on every driver.
          or(eq(kraTransmissions.status, 'failed'), lt(kraTransmissions.updatedAt, stale)),
        ),
      )
      .returning();
    if (!reclaimed) {
      throw new Error(`Invoice ${input.traderInvoiceNo} is already being transmitted.`);
    }
    return reclaimed;
  }

  private async finish(
    row: KraTransmissionRow,
    patch: Pick<
      KraTransmissionRow,
      'status' | 'response' | 'scuReceiptNo' | 'verificationUrl' | 'errorCode' | 'errorMessage'
    >,
  ): Promise<KraTransmissionRow> {
    const [updated] = await this.db
      .update(kraTransmissions)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(kraTransmissions.id, row.id))
      .returning();
    // The order's own status is not touched here: the signing service is its only writer.
    return updated!;
  }
}

function modeMismatch(source: 'company' | 'branch', actual: string): KraConfigError {
  return new KraConfigError(
    'MODE_MISMATCH',
    `${source === 'branch' ? 'Branch' : 'Company'} KRA mode is ${actual}; eTIMS transmission refused.`,
    source,
  );
}

/** KRA expects yyyyMMddHHmmss in Kenyan time regardless of the server's timezone. */
function formatSalesDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}
