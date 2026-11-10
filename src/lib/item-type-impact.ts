/** What changing a business classification's "sold to customers" answer does to the products that use it. Pure: the numbers and the words. */

export interface ItemTypeImpact {
  /** Products of the classification (deleted ones left out). */
  total: number;
  /** Of them, sold to customers now. */
  sellingNow: number;
  /** Not sold now, have a selling price: would be sold if the classification were. */
  wouldSell: number;
  /** Not sold now, have no selling price: would stay unsold until priced. */
  wouldNeedPrice: number;
  /** Active products offered as checkout packaging. */
  packaging: number;
}

export interface ItemTypeChangeView {
  /** What the change does: stop selling, start selling, or nothing to the products. */
  effect: 'stop' | 'start' | 'none';
  /** Products affected: the ones that stop being sold, or the ones that start. */
  affected: number;
  needPrice: number;
  /** A reason the change cannot be made, in words; null when it can. */
  blocked: string | null;
  /** The sentence to put in front of the person before they confirm; empty when nothing changes. */
  message: string;
}

const products = (n: number): string => `${String(n)} product${n === 1 ? '' : 's'}`;

export function itemTypeChangeView(impact: ItemTypeImpact, was: boolean, next: boolean): ItemTypeChangeView {
  if (was === next) return { effect: 'none', affected: 0, needPrice: 0, blocked: null, message: '' };
  if (!next) {
    if (impact.packaging > 0) {
      return {
        effect: 'stop',
        affected: impact.sellingNow,
        needPrice: 0,
        blocked: `${products(impact.packaging)} of this classification ${impact.packaging === 1 ? 'is' : 'are'} offered as checkout packaging, which must be sold. Stop offering ${impact.packaging === 1 ? 'it' : 'them'} as packaging first.`,
        message: '',
      };
    }
    return {
      effect: 'stop',
      affected: impact.sellingNow,
      needPrice: 0,
      blocked: null,
      message:
        impact.sellingNow === 0
          ? 'No product of this classification is being sold now, so nothing else changes.'
          : `${products(impact.sellingNow)} will stop being sold: they leave the web shop and cannot be added to new quotes or orders. Quotes already made keep their lines, and orders and invoices already made are not touched.`,
    };
  }
  const parts: string[] = [];
  if (impact.wouldSell > 0) parts.push(`${products(impact.wouldSell)} will be sold to customers (the web shop shows each one unless it was set not to)`);
  if (impact.wouldNeedPrice > 0) parts.push(`${products(impact.wouldNeedPrice)} ${impact.wouldNeedPrice === 1 ? 'has' : 'have'} no selling price and stay${impact.wouldNeedPrice === 1 ? 's' : ''} unsold until ${impact.wouldNeedPrice === 1 ? 'it is' : 'they are'} priced`);
  return {
    effect: 'start',
    affected: impact.wouldSell,
    needPrice: impact.wouldNeedPrice,
    blocked: null,
    message: parts.length === 0 ? 'No product of this classification is waiting to be sold, so nothing else changes.' : `${parts.join('; ')}.`,
  };
}
