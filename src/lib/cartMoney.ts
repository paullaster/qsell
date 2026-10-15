import type { CurrencyConfig, PublicProduct } from '@/types/index';
import { formatPriceWithCurrency } from '@/lib/currency';
import { computeCheckoutTotals, type PricedLine } from '@/lib/checkoutPricing';

import { has } from '@/lib/has';

export function cartLine(product: PublicProduct, quantity: number): PricedLine {
  return {
    productId: product.id,
    quantity,
    unitPrice: product.price ?? 0,
    taxRate: Math.max(0, product.taxRate ?? 0),
    isTaxInclusive: product.isTaxInclusive !== false,
  };
}

export function cartTotals(items: { product: PublicProduct; quantity: number }[]) {
  return computeCheckoutTotals(items.map((item) => cartLine(item.product, item.quantity)));
}

function rawLineTax(line: PricedLine): number {
  const gross = line.unitPrice * line.quantity;
  if (line.isTaxInclusive && line.taxRate > 0) {
    const net = gross / (1 + line.taxRate / 100);
    return gross - net;
  }
  return gross * (line.taxRate / 100);
}

export interface CartTaxRow { key: string; label: string; amount: number }

/** Tax rows labeled from each product's tax category. Amounts sum to the order tax. */
export function cartTaxRows(items: { product: PublicProduct; quantity: number }[]): CartTaxRow[] {
  const totals = cartTotals(items);
  const groups = new Map<string, { label: string; amount: number }>();

  for (const item of items) {
    const line = cartLine(item.product, item.quantity);
    const name = item.product.taxCategoryName?.trim();
    const key = `${name ?? ''}|${line.taxRate}|${line.isTaxInclusive ? 'in' : 'ex'}`;
    const label = has(name)
      ? `${name} (${line.taxRate}%)`
      : line.taxRate > 0
        ? `Tax (${line.taxRate}%)`
        : 'Tax';
    const current = groups.get(key) ?? { label, amount: 0 };
    current.amount += rawLineTax(line);
    groups.set(key, current);
  }

  const rows = [...groups.entries()].map(([key, row]) => ({
    key,
    label: row.label,
    amount: Math.round(row.amount),
  }));

  if (rows.length === 0) {
    return [{ key: 'tax', label: 'Tax', amount: totals.tax }];
  }

  const drift = totals.tax - rows.reduce((sum, row) => sum + row.amount, 0);
  rows[rows.length - 1].amount += drift;
  return rows;
}

export function formatCartAmount(amount: number, currency: CurrencyConfig | null): string {
  if (!currency) {
    return amount.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }
  return formatPriceWithCurrency(amount, currency);
}

export function resolveBaseCurrency(currencies: CurrencyConfig[]): CurrencyConfig | null {
  return (
    currencies.find((currency) => currency.isBaseCurrency && currency.isEnabled) ??
    currencies.find((currency) => currency.isEnabled) ??
    null
  );
}
