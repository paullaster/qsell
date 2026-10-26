/** Rules for purchase requisitions: an internal request to buy, approved by another person. Pure: shared by the form and the server. */
import { isDay } from './vendor-insights';

export const REQUISITION_STATUS: Record<'draft' | 'submitted' | 'approved' | 'rejected' | 'converted' | 'cancelled', { label: string; tone: 'gray' | 'amber' | 'green' | 'red' | 'sky' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  submitted: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Refused', tone: 'red' },
  converted: { label: 'Turned into an order or request', tone: 'sky' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export interface RequisitionHeaderForm {
  title: string;
  purpose: string;
  categoryId: string;
  currency: string;
  neededBy: string;
}

export interface RequisitionLineForm {
  productId: string;
  description: string;
  specification: string;
  quantity: string;
  unit: string;
  estimatedUnitPrice: string;
}

export const emptyRequisitionLine = (): RequisitionLineForm => ({ productId: '', description: '', specification: '', quantity: '1', unit: 'each', estimatedUnitPrice: '' });

const QTY = /^\d{1,11}(\.\d{1,3})?$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export function checkRequisitionHeader(h: RequisitionHeaderForm, today: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (h.title.trim().length < 3 || h.title.trim().length > 150) p.title = 'Give it a short title, 3 to 150 characters.';
  if (h.purpose.length > 1000) p.purpose = 'Keep the reason to 1000 characters.';
  if (h.categoryId === '') p.categoryId = 'Choose the kind of purchase.';
  if (h.currency.trim() === '') p.currency = 'Choose the currency.';
  if (h.neededBy !== '' && !isDay(h.neededBy)) p.neededBy = 'Use a date like 2026-12-31.';
  else if (h.neededBy !== '' && h.neededBy < today) p.neededBy = 'The date it is needed by cannot be in the past.';
  return p;
}

export function checkRequisitionLine(l: RequisitionLineForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (l.description.trim().length < 2 || l.description.trim().length > 300) p.description = 'Describe what is wanted in 2 to 300 characters.';
  if (!QTY.test(l.quantity.trim()) || Number(l.quantity) <= 0) p.quantity = 'The quantity is a number above zero, like 12 or 2.5.';
  if (l.unit.trim() === '' || l.unit.trim().length > 20) p.unit = 'Give the unit, like each, kg or box.';
  if (l.estimatedUnitPrice.trim() !== '' && !MONEY.test(l.estimatedUnitPrice.trim())) p.estimatedUnitPrice = 'The estimated price is an amount, like 250 or 99.50, or empty.';
  return p;
}

/** The estimated total in cents: quantity (three decimals) times the estimated price, line by line, rounded to the cent. */
export function estimatedTotalCents(lines: readonly RequisitionLineForm[]): number {
  return lines.reduce((sum, l) => {
    const price = l.estimatedUnitPrice.trim() === '' ? 0 : Math.round(Number(l.estimatedUnitPrice) * 100);
    return sum + Math.round(Number(l.quantity) * price);
  }, 0);
}
