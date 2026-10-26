/** UBL 2.1 for purchase orders (written) and supplier invoices (read): the common format vendors' systems already speak. Pure. */
import { allOf, escapeXml, parseXml, pick, textOf, type XmlNode } from './xml-lite';
import { isDay } from './vendor-insights';

export interface UblOrderInput {
  number: string;
  issueDate: string;
  currency: string;
  note?: string;
  buyer: { name: string; taxId?: string };
  seller: { name: string; taxId?: string };
  expectedDate?: string;
  lines: { id: string; description: string; quantity: string; unit: string; unitPrice: string; discountPercent: string; taxRate: string; net: string; productCode?: string }[];
  total: string;
  taxTotal: string;
  subtotal: string;
}

/** Unit codes UBL expects (UN/ECE rec. 20) for the units people write. Others are sent as "C62" (one) with the name in the description. */
const UNIT_CODES: Record<string, string> = { each: 'C62', piece: 'C62', pieces: 'C62', pcs: 'C62', kg: 'KGM', g: 'GRM', l: 'LTR', litre: 'LTR', m: 'MTR', box: 'BX', carton: 'CT', pack: 'PK', set: 'SET', hour: 'HUR', day: 'DAY' };
export const unitCodeOf = (unit: string): string => UNIT_CODES[unit.trim().toLowerCase()] ?? 'C62';

const party = (p: { name: string; taxId?: string }): string =>
  `<cac:Party>${p.taxId === undefined || p.taxId === '' ? '' : `<cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(p.taxId)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`}<cac:PartyLegalEntity><cbc:RegistrationName>${escapeXml(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party>`;

export function buildUblOrder(o: UblOrderInput): string {
  const lines = o.lines
    .map((l) => {
      const price = (Number(l.unitPrice) * (1 - Number(l.discountPercent === '' ? '0' : l.discountPercent) / 100)).toFixed(2);
      return `<cac:OrderLine><cac:LineItem><cbc:ID>${escapeXml(l.id)}</cbc:ID><cbc:Quantity unitCode="${unitCodeOf(l.unit)}">${escapeXml(l.quantity)}</cbc:Quantity><cbc:LineExtensionAmount currencyID="${escapeXml(o.currency)}">${escapeXml(l.net)}</cbc:LineExtensionAmount><cac:Price><cbc:PriceAmount currencyID="${escapeXml(o.currency)}">${price}</cbc:PriceAmount></cac:Price><cac:Item><cbc:Description>${escapeXml(l.description)}</cbc:Description><cbc:Name>${escapeXml(l.description.slice(0, 100))}</cbc:Name>${l.productCode === undefined || l.productCode === '' ? '' : `<cac:SellersItemIdentification><cbc:ID>${escapeXml(l.productCode)}</cbc:ID></cac:SellersItemIdentification>`}<cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>${escapeXml(l.taxRate)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item></cac:LineItem></cac:OrderLine>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Order xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:ID>${escapeXml(o.number)}</cbc:ID><cbc:IssueDate>${o.issueDate}</cbc:IssueDate><cbc:DocumentCurrencyCode>${escapeXml(o.currency)}</cbc:DocumentCurrencyCode>${o.note === undefined || o.note === '' ? '' : `<cbc:Note>${escapeXml(o.note)}</cbc:Note>`}<cac:BuyerCustomerParty>${party(o.buyer)}</cac:BuyerCustomerParty><cac:SellerSupplierParty>${party(o.seller)}</cac:SellerSupplierParty>${o.expectedDate === undefined || o.expectedDate === '' ? '' : `<cac:Delivery><cac:RequestedDeliveryPeriod><cbc:EndDate>${o.expectedDate}</cbc:EndDate></cac:RequestedDeliveryPeriod></cac:Delivery>`}<cac:TaxTotal><cbc:TaxAmount currencyID="${escapeXml(o.currency)}">${escapeXml(o.taxTotal)}</cbc:TaxAmount></cac:TaxTotal><cac:AnticipatedMonetaryTotal><cbc:LineExtensionAmount currencyID="${escapeXml(o.currency)}">${escapeXml(o.subtotal)}</cbc:LineExtensionAmount><cbc:PayableAmount currencyID="${escapeXml(o.currency)}">${escapeXml(o.total)}</cbc:PayableAmount></cac:AnticipatedMonetaryTotal>${lines}</Order>`;
}

export interface UblInvoiceLine {
  /** The vendor's own line number. */
  id: string;
  /** Our order line number the vendor says it is for. */
  orderLineId: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitPrice: string;
}

export interface UblInvoice {
  vendorInvoiceNo: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  /** Our order number. */
  orderNumber: string;
  lines: UblInvoiceLine[];
}

const AMOUNT = /^\d{1,12}(\.\d{1,4})?$/;
const QTY = /^\d{1,11}(\.\d{1,3})?$/;

/** Reads a UBL 2.1 Invoice. Problems are plain sentences for the person who uploaded the file. */
export function parseUblInvoice(xml: string): { ok: true; invoice: UblInvoice } | { ok: false; error: string } {
  const parsed = parseXml(xml);
  if (!parsed.ok) return parsed;
  const root: XmlNode = parsed.root;
  if (root.name !== 'Invoice') return { ok: false, error: 'This is not a UBL invoice. The file should start with an Invoice element.' };
  const vendorInvoiceNo = textOf(root, 'ID');
  const issueDate = textOf(root, 'IssueDate');
  const dueDate = textOf(root, 'DueDate');
  const orderNumber = textOf(root, 'OrderReference', 'ID');
  if (vendorInvoiceNo === '') return { ok: false, error: 'The invoice has no number (cbc:ID).' };
  if (!isDay(issueDate)) return { ok: false, error: 'The invoice has no valid issue date (cbc:IssueDate, like 2026-12-31).' };
  if (dueDate !== '' && !isDay(dueDate)) return { ok: false, error: 'The due date (cbc:DueDate) is not a valid date.' };
  if (orderNumber === '') return { ok: false, error: 'The invoice does not say which order it is for (cac:OrderReference/cbc:ID).' };
  const rows = allOf(root, 'InvoiceLine');
  if (rows.length === 0) return { ok: false, error: 'The invoice has no lines.' };
  if (rows.length > 300) return { ok: false, error: 'The invoice has too many lines.' };
  const lines: UblInvoiceLine[] = [];
  for (const [i, r] of rows.entries()) {
    const q = pick(r, 'InvoicedQuantity');
    const quantity = q?.text.trim() ?? '';
    const unitPrice = textOf(r, 'Price', 'PriceAmount');
    if (!QTY.test(quantity) || Number(quantity) <= 0) return { ok: false, error: `Line ${String(i + 1)} has no valid quantity (cbc:InvoicedQuantity).` };
    if (!AMOUNT.test(unitPrice)) return { ok: false, error: `Line ${String(i + 1)} has no valid unit price (cac:Price/cbc:PriceAmount).` };
    lines.push({ id: textOf(r, 'ID'), orderLineId: textOf(r, 'OrderLineReference', 'LineID'), description: textOf(r, 'Item', 'Description') === '' ? textOf(r, 'Item', 'Name') : textOf(r, 'Item', 'Description'), quantity, unitCode: q?.attrs.unitCode ?? '', unitPrice: Number(unitPrice).toFixed(2) });
  }
  return { ok: true, invoice: { vendorInvoiceNo, issueDate, dueDate, currency: textOf(root, 'DocumentCurrencyCode').toUpperCase(), orderNumber, lines } };
}
