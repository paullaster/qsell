/** Rules for vendor contracts (blanket orders): agreed prices for a period, with limits, and the orders called off against them. Pure. */
import { isDay } from './vendor-insights';
import { orderTotals } from './purchase-order';

export const CONTRACT_STATUS: Record<'draft' | 'pending_approval' | 'active' | 'closed' | 'cancelled', { label: string; tone: 'gray' | 'amber' | 'green' | 'red' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  active: { label: 'In force', tone: 'green' },
  closed: { label: 'Closed', tone: 'gray' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export interface ContractHeaderForm {
  vendorId: string;
  categoryId: string;
  title: string;
  currency: string;
  validFrom: string;
  validTo: string;
  /** Empty means no ceiling. */
  maxValue: string;
  terms: string;
}

export interface ContractLineForm {
  productId: string;
  description: string;
  specification: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRate: string;
  /** Empty means no limit on the line. */
  maxQuantity: string;
}

export const emptyContractLine = (): ContractLineForm => ({ productId: '', description: '', specification: '', unit: 'each', unitPrice: '', discountPercent: '0', taxRate: '0', maxQuantity: '' });

const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const QTY = /^\d{1,11}(\.\d{1,3})?$/;

export function checkContractHeader(h: ContractHeaderForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (h.vendorId === '') p.vendorId = 'Choose the vendor.';
  if (h.categoryId === '') p.categoryId = 'Choose the category.';
  if (h.title.trim().length < 3 || h.title.trim().length > 150) p.title = 'Give the contract a short title, 3 to 150 characters.';
  if (h.currency.trim() === '') p.currency = 'Choose the currency.';
  if (!isDay(h.validFrom)) p.validFrom = 'Use the first day it applies, like 2026-12-31.';
  if (!isDay(h.validTo)) p.validTo = 'Use the last day it applies, like 2027-12-31.';
  if (p.validFrom === undefined && p.validTo === undefined && h.validTo < h.validFrom) p.validTo = 'The last day cannot be before the first.';
  if (h.maxValue.trim() !== '' && (!MONEY.test(h.maxValue.trim()) || Number(h.maxValue) <= 0)) p.maxValue = 'The most that may be ordered is an amount above zero, or empty for no limit.';
  if (h.terms.length > 4000) p.terms = 'Keep the terms to 4000 characters.';
  return p;
}

export function checkContractLine(l: ContractLineForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (l.description.trim().length < 2 || l.description.trim().length > 300) p.description = 'Describe the item in 2 to 300 characters.';
  if (l.unit.trim() === '' || l.unit.trim().length > 20) p.unit = 'Give the unit, like each, kg or box.';
  if (!MONEY.test(l.unitPrice.trim())) p.unitPrice = 'The agreed price is an amount, like 250 or 99.50.';
  const discount = l.discountPercent.trim() === '' ? '0' : l.discountPercent.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(discount) || Number(discount) > 100) p.discountPercent = 'The discount is a percentage from 0 to 100.';
  const tax = l.taxRate.trim() === '' ? '0' : l.taxRate.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(tax) || Number(tax) > 100) p.taxRate = 'The tax rate is a percentage from 0 to 100.';
  if (l.maxQuantity.trim() !== '' && (!QTY.test(l.maxQuantity.trim()) || Number(l.maxQuantity) <= 0)) p.maxQuantity = 'The most that may be ordered is a quantity above zero, or empty for no limit.';
  return p;
}

export interface CallOffLine {
  contractLineId: string;
  quantity: string;
}

export interface ContractLineState {
  id: string;
  description: string;
  unitPrice: string;
  discountPercent: string;
  taxRate: string;
  maxQuantity: string | null;
  /** Already on orders called off (not cancelled), in the contract line's unit. */
  usedQuantity: number;
}

/** What is left on a line: the limit less what is used, to three decimals, or null for no limit. */
export const remainingQuantity = (maxQuantity: string | null, used: number): number | null => (maxQuantity === null ? null : Math.max(0, Math.round((Number(maxQuantity) - used) * 1000) / 1000));

/**
 * Checks an order about to be called off: the contract is in force on the order date, the lines are on it, the quantities fit what is
 * left on each line, and the value fits what is left under the ceiling. Returns plain-language problems; empty means it fits.
 */
export function callOffProblems(input: {
  status: string;
  validFrom: string;
  validTo: string;
  orderDate: string;
  maxValueCents: number | null;
  usedValueCents: number;
  lines: readonly ContractLineState[];
  asked: readonly CallOffLine[];
}): string[] {
  const out: string[] = [];
  if (input.status !== 'active') out.push('This contract is not in force.');
  else if (input.orderDate < input.validFrom) out.push(`This contract starts on ${input.validFrom}.`);
  else if (input.orderDate > input.validTo) out.push(`This contract ended on ${input.validTo}.`);
  if (input.asked.length === 0) out.push('Choose what to order.');
  const seen = new Set<string>();
  const priced: { quantity: string; unitPrice: string; discountPercent: string; taxRate: string }[] = [];
  for (const a of input.asked) {
    const line = input.lines.find((l) => l.id === a.contractLineId);
    if (line === undefined) {
      out.push('One of the lines is not on the contract.');
      continue;
    }
    if (seen.has(a.contractLineId)) out.push(`“${line.description}” is on the order twice.`);
    seen.add(a.contractLineId);
    if (!QTY.test(a.quantity.trim()) || Number(a.quantity) <= 0) {
      out.push(`“${line.description}”: give a quantity above zero.`);
      continue;
    }
    const left = remainingQuantity(line.maxQuantity, line.usedQuantity);
    if (left !== null && Math.round(Number(a.quantity) * 1000) > Math.round(left * 1000)) out.push(`“${line.description}”: only ${String(left)} is left on the contract.`);
    priced.push({ quantity: a.quantity, unitPrice: line.unitPrice, discountPercent: line.discountPercent, taxRate: line.taxRate });
  }
  if (input.maxValueCents !== null && priced.length > 0) {
    const value = orderTotals(priced).total;
    if (input.usedValueCents + value > input.maxValueCents) out.push(`This order comes to ${(value / 100).toFixed(2)}, but only ${(Math.max(0, input.maxValueCents - input.usedValueCents) / 100).toFixed(2)} is left under the contract’s ceiling.`);
  }
  return out;
}
