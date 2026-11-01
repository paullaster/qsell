import type { ResetPolicy } from './domain/types';

export interface DocumentKindDef {
  label: string;
  /**
   * Fiscal documents (anything reported to the tax authority) may only be numbered by a
   * gap-free series: a missing number is something an auditor will ask about.
   */
  fiscal: boolean;
  /** What "create the standard series" sets up. */
  suggested: {
    code: string;
    prefix: string;
    digits: number;
    reset: ResetPolicy;
    blockSize: number;
  };
}

/**
 * Every kind of document or record that gets a number. Add a kind here, then bind a series to it
 * (or let first use set up the standard one).
 *
 * Digits are sized for roughly 900,000 orders a day (~330 million a year): a high-volume kind
 * with too few digits would run out within days. Fiscal kinds count per branch ({BRANCH}),
 * so each branch has an unbroken sequence and its own lock.
 */
export const DOCUMENT_KINDS = {
  sales_inquiry: {
    label: 'Sales inquiry',
    fiscal: false,
    suggested: { code: 'INQ', prefix: 'INQ-{YY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
  sales_quote: {
    label: 'Sales quote',
    fiscal: false,
    suggested: { code: 'QTE', prefix: 'QTE-{YYYY}-', digits: 8, reset: 'yearly', blockSize: 50 },
  },
  sales_order: {
    label: 'Sales order',
    fiscal: false,
    suggested: { code: 'SO', prefix: 'ORD-{YYYY}-', digits: 10, reset: 'yearly', blockSize: 200 },
  },
  sales_delivery: {
    label: 'Delivery',
    fiscal: false,
    suggested: { code: 'DLV', prefix: 'DLV-{YY}-', digits: 10, reset: 'yearly', blockSize: 200 },
  },
  proforma_invoice: {
    label: 'Proforma invoice',
    fiscal: false,
    suggested: { code: 'PRO', prefix: 'PRO-{YY}-', digits: 10, reset: 'yearly', blockSize: 100 },
  },
  tax_invoice: {
    label: 'Tax invoice',
    fiscal: true,
    suggested: {
      code: 'INV',
      prefix: 'INV-{BRANCH}-{YY}-',
      digits: 9,
      reset: 'yearly',
      blockSize: 50,
    },
  },
  credit_note: {
    label: 'Credit note',
    fiscal: true,
    suggested: {
      code: 'CN',
      prefix: 'CN-{BRANCH}-{YY}-',
      digits: 8,
      reset: 'yearly',
      blockSize: 50,
    },
  },
  debit_note: {
    label: 'Debit note',
    fiscal: true,
    suggested: {
      code: 'DN',
      prefix: 'DN-{BRANCH}-{YY}-',
      digits: 8,
      reset: 'yearly',
      blockSize: 50,
    },
  },
  pos_receipt: {
    label: 'POS receipt',
    fiscal: true,
    suggested: {
      code: 'RCT',
      prefix: 'RCT-{BRANCH}-{YY}-',
      digits: 9,
      reset: 'yearly',
      blockSize: 50,
    },
  },
  returns_order: {
    label: 'Returns order',
    fiscal: false,
    suggested: { code: 'RET', prefix: 'RET-{YY}-', digits: 8, reset: 'yearly', blockSize: 50 },
  },
  refund: {
    label: 'Refund',
    fiscal: false,
    suggested: { code: 'RFD', prefix: 'RFD-{YY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
  credit_adjustment: {
    label: 'Credit adjustment',
    fiscal: false,
    suggested: { code: 'CAJ', prefix: 'CAJ-{YY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
  refund_file: {
    label: 'Refund payment file',
    fiscal: false,
    suggested: { code: 'RPF', prefix: 'RPF-{YY}-', digits: 6, reset: 'yearly', blockSize: 5 },
  },
  return_receipt: {
    label: 'Return receipt',
    fiscal: false,
    suggested: { code: 'RRC', prefix: 'RRC-{YY}-', digits: 8, reset: 'yearly', blockSize: 50 },
  },
  bank_reconciliation: {
    label: 'Bank reconciliation',
    fiscal: false,
    suggested: { code: 'BRC', prefix: 'BRC-{YY}-', digits: 6, reset: 'yearly', blockSize: 5 },
  },
  bank_charge: {
    label: 'Bank charge',
    fiscal: false,
    suggested: { code: 'BCH', prefix: 'BCH-{YY}-', digits: 8, reset: 'yearly', blockSize: 50 },
  },
  bank_income: {
    label: 'Bank income',
    fiscal: false,
    suggested: { code: 'BIN', prefix: 'BIN-{YY}-', digits: 8, reset: 'yearly', blockSize: 50 },
  },
  cash_count: {
    label: 'Cash count',
    fiscal: false,
    suggested: { code: 'CCT', prefix: 'CCT-{YY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
  customer_payment: {
    label: 'Customer payment',
    fiscal: false,
    suggested: { code: 'PAY', prefix: 'PAY-{YY}-', digits: 10, reset: 'yearly', blockSize: 200 },
  },
  customer: {
    label: 'Customer',
    fiscal: false,
    suggested: { code: 'CUS', prefix: 'C', digits: 9, reset: 'never', blockSize: 100 },
  },
  product_sku: {
    label: 'Product SKU',
    fiscal: false,
    suggested: { code: 'SKU', prefix: 'SKU-', digits: 9, reset: 'never', blockSize: 500 },
  },
  product_stock_code: {
    label: 'Product stock code',
    fiscal: false,
    suggested: { code: 'STK', prefix: 'STK-', digits: 9, reset: 'never', blockSize: 500 },
  },
  stock_adjustment: {
    label: 'Stock adjustment',
    fiscal: false,
    suggested: { code: 'ADJ', prefix: 'ADJ-{YY}-', digits: 8, reset: 'yearly', blockSize: 50 },
  },
  stock_receipt: {
    label: 'Stock receipt',
    fiscal: false,
    suggested: { code: 'GRN', prefix: 'GRN-{YY}-', digits: 8, reset: 'yearly', blockSize: 50 },
  },
  stock_write_off: {
    label: 'Stock write-off',
    fiscal: false,
    suggested: { code: 'WO', prefix: 'WO-{YY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
  stock_count: {
    label: 'Stock count',
    fiscal: false,
    suggested: { code: 'CNT', prefix: 'CNT-{YY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
  stock_transfer: {
    label: 'Stock transfer',
    fiscal: false,
    suggested: { code: 'TRF', prefix: 'TRF-{YY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
  vendor: {
    label: 'Vendor',
    fiscal: false,
    suggested: { code: 'VND', prefix: 'V-', digits: 6, reset: 'never', blockSize: 20 },
  },
  purchase_order: {
    label: 'Purchase order',
    fiscal: false,
    suggested: { code: 'PO', prefix: 'PO-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  rgn: {
    label: 'Received goods note',
    fiscal: false,
    suggested: { code: 'RGN', prefix: 'RGN-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  supplier_invoice: {
    label: 'Supplier invoice',
    fiscal: false,
    suggested: { code: 'SINV', prefix: 'SINV-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  purchase_invoice: {
    label: 'Purchase invoice (booked)',
    fiscal: false,
    suggested: { code: 'PINV', prefix: 'PINV-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  vendor_payment: {
    label: 'Vendor payment voucher',
    fiscal: false,
    suggested: { code: 'VPV', prefix: 'VPV-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  vendor_payment_batch: {
    label: 'Vendor payment run',
    fiscal: false,
    suggested: { code: 'VPB', prefix: 'VPB-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  withholding_certificate: {
    label: 'Withholding tax certificate',
    fiscal: false,
    suggested: { code: 'WHC', prefix: 'WHC-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  vendor_credit_memo: {
    label: 'Vendor credit memo',
    fiscal: false,
    suggested: { code: 'VCM', prefix: 'VCM-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  petty_cash_voucher: {
    label: 'Petty cash voucher',
    fiscal: false,
    suggested: { code: 'PCV', prefix: 'PCV-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  petty_cash_replenishment: {
    label: 'Petty cash replenishment',
    fiscal: false,
    suggested: { code: 'PCR', prefix: 'PCR-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  landed_cost: {
    label: 'Landed cost allocation',
    fiscal: false,
    suggested: { code: 'LCA', prefix: 'LCA-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  vendor_contract: {
    label: 'Vendor contract (blanket order)',
    fiscal: false,
    suggested: { code: 'CTR', prefix: 'CTR-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  purchase_requisition: {
    label: 'Purchase requisition',
    fiscal: false,
    suggested: { code: 'PRQ', prefix: 'PRQ-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  purchase_return: {
    label: 'Purchase return',
    fiscal: false,
    suggested: { code: 'PRT', prefix: 'PRT-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  vendor_refund: {
    label: 'Vendor refund received',
    fiscal: false,
    suggested: { code: 'VRF', prefix: 'VRF-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  rfq: {
    label: 'Request for quotation',
    fiscal: false,
    suggested: { code: 'RFQ', prefix: 'RFQ-{YYYY}-', digits: 5, reset: 'yearly', blockSize: 20 },
  },
  project: {
    label: 'Project',
    fiscal: false,
    suggested: { code: 'PRJ', prefix: 'PRJ-{YYYY}-', digits: 8, reset: 'yearly', blockSize: 20 },
  },
} as const satisfies Record<string, DocumentKindDef>;

export type DocumentKind = keyof typeof DOCUMENT_KINDS;

export const DOCUMENT_KIND_LIST = Object.keys(DOCUMENT_KINDS) as DocumentKind[];

export function isDocumentKind(value: string): value is DocumentKind {
  return value in DOCUMENT_KINDS;
}
