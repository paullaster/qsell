import type { ResolvedEtimsConfig } from '../types';

import { has } from '@/lib/values';

const REQUEST_TIMEOUT_MS = 20_000;

export class EtimsApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null when the request never completed (network, timeout). */
    readonly httpStatus: number | null,
    /** True when sending the same request again may succeed. */
    readonly retryable: boolean,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'EtimsApiError';
  }
}

export interface EtimsSalesItem {
  itemCode: string;
  qty: number;
  pkg?: number;
  unitPrice: number;
  amount: number;
  discountAmount?: number;
}

export interface EtimsInvoiceRequest {
  traderInvoiceNo: string;
  traderOrgInvoiceNo?: string;
  totalAmount: number;
  paymentType: string;
  /** N normal, C copy, P proforma, T training. */
  salesTypeCode: 'N' | 'C' | 'P' | 'T';
  /** S sale, R credit note. */
  receiptTypeCode: 'S' | 'R';
  salesStatusCode: string;
  /** yyyyMMddHHmmss */
  salesDate: string;
  currency: string;
  exchangeRate: number;
  salesItems: EtimsSalesItem[];
  customerPin?: string;
}

export interface EtimsInvoiceResponse {
  status: number;
  statusCode?: string;
  message?: string;
  data?: {
    invoiceNo?: number;
    traderInvoiceNo?: string;
    totalAmount?: number;
    totalTaxableAmount?: number;
    totalTaxAmount?: number;
    scuReceiptNo?: number;
    scuReceiptDate?: string;
    scdcId?: string;
    signature?: string;
    internalData?: string;
    invoiceVerificationUrl?: string;
  };
}

export interface EtimsEnvelope<T = undefined> {
  status: number;
  statusCode?: string;
  message?: string;
  data?: T;
}

/** Fields the gateway accepts when creating or updating an item. */
export interface EtimsItemWrite {
  name: string;
  orgCountryCode: string;
  unitPrice: number;
  /** 1 raw material, 2 finished product, 3 service. */
  itemTypeCode: string;
  /** eTIMS tax code: A exempt, B 16%, C 0%, D non-VAT, E 8%. */
  taxCode: string;
  qtyUnitCode: string;
  pkgUnitCode: string;
  itemClassCode: string;
}

/** Item as returned by GET /items. `typeCode` (not itemTypeCode) is the gateway's spelling. */
export interface EtimsItem {
  itemCode?: string;
  name?: string;
  orgCountryCode?: string;
  unitPrice?: number;
  typeCode?: string;
  itemType?: string;
  qtyUnitCode?: string;
  pkgUnitCode?: string;
  itemClassCode?: string;
  stock?: number;
}

/** Thin client for the Easy Tax gateway in front of the KRA eTIMS VSCU. */
export class EtimsClient {
  constructor(
    private readonly config: ResolvedEtimsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  createInvoice(body: EtimsInvoiceRequest): Promise<EtimsInvoiceResponse> {
    return this.request('POST', '/invoices', body);
  }

  getInvoiceByTraderNo(traderInvoiceNo: string): Promise<EtimsInvoiceResponse> {
    return this.request('GET', `/invoices/${encodeURIComponent(traderInvoiceNo)}`);
  }

  createItem(body: EtimsItemWrite & { initialStock: number }): Promise<EtimsEnvelope<EtimsItem>> {
    return this.request('POST', '/items', body);
  }

  /** Also used for stock changes: the gateway takes the new quantity as `stock`. */
  updateItem(itemCode: string, body: EtimsItemWrite & { stock: number }): Promise<EtimsEnvelope> {
    return this.request('PUT', `/items/${encodeURIComponent(itemCode)}`, body);
  }

  deleteItem(itemCode: string): Promise<EtimsEnvelope> {
    return this.request('DELETE', `/items/${encodeURIComponent(itemCode)}`);
  }

  getItem(itemCode: string): Promise<EtimsEnvelope<EtimsItem>> {
    return this.request('GET', `/items/${encodeURIComponent(itemCode)}`);
  }

  listItems(): Promise<EtimsEnvelope<EtimsItem[]>> {
    return this.request('GET', '/items');
  }

  private async request<T = never>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { username, password } = this.config.credentials;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new EtimsApiError(`eTIMS gateway unreachable: ${reason}`, null, true);
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = has(text) ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body handled below */
    }

    if (!res.ok) {
      const message =
        (parsed as { message?: string } | null)?.message ?? `eTIMS gateway returned ${res.status}`;
      // 5xx and 429 may succeed on retry; other 4xx are request/auth problems.
      const retryable = res.status >= 500 || res.status === 429;
      throw new EtimsApiError(message, res.status, retryable, parsed);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new EtimsApiError(
        'eTIMS gateway returned an unreadable response',
        res.status,
        false,
        text,
      );
    }
    // The gateway can answer HTTP 200 with a non-200 `status` in its envelope.
    const envelopeStatus = (parsed as { status?: unknown }).status;
    if (typeof envelopeStatus === 'number' && envelopeStatus !== 200) {
      const message = (parsed as { message?: string }).message ?? 'eTIMS rejected the request';
      throw new EtimsApiError(message, envelopeStatus, envelopeStatus >= 500, parsed);
    }
    return parsed as T;
  }
}
