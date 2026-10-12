import type { BusinessOverview } from './types';

type Pieces = Pick<BusinessOverview, 'sales' | 'collections' | 'attention'> & {
  meta: Pick<BusinessOverview['meta'], 'baseCurrency' | 'compare'>;
};

function money(n: number, currency: string): string {
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : 2;
  return `${currency} ${n.toLocaleString('en-KE', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function change(pct: number | null, basis: string): string {
  if (pct === null) return '';
  if (pct === 0) return `, level with ${basis.toLowerCase()}`;
  return `, ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on ${basis.toLowerCase()}`;
}

/**
 * Up to three sentences an executive can read in five seconds. Built only from the sections
 * the viewer is allowed to see, so it can never reveal a number they have no permission for.
 */
export function buildHeadline(o: Pieces): string[] {
  const out: string[] = [];
  const cur = o.meta.baseCurrency;
  const basis = o.meta.compare.label;

  if (o.sales) {
    const { sales, orders } = o.sales;
    out.push(
      orders.current === 0
        ? 'No sales were recorded in this period.'
        : `Sales were ${money(sales.current, cur)} from ${orders.current.toLocaleString('en-KE')} order${orders.current === 1 ? '' : 's'}${change(sales.changePct, basis)}.`,
    );
  }

  if (o.collections?.configured) {
    const c = o.collections;
    const rate = c.collectionRatePct === null ? '' : ` (${c.collectionRatePct}% of sales)`;
    const waiting =
      c.inFlight.pendingCount > 0
        ? `, with ${c.inFlight.pendingCount} payment${c.inFlight.pendingCount === 1 ? '' : 's'} still unconfirmed`
        : '';
    out.push(
      c.collected.current === 0 && c.inFlight.pendingCount === 0
        ? 'No money was collected in this period.'
        : `${money(c.collected.current, cur)} was collected${rate}${waiting}.`,
    );
  }

  const critical = o.attention.filter((a) => a.tone === 'critical').length;
  if (o.attention.length > 0) {
    out.push(
      `${o.attention.length} item${o.attention.length === 1 ? ' needs' : 's need'} your attention${critical > 0 ? `, ${critical} of them urgent` : ''}.`,
    );
  }
  return out;
}
