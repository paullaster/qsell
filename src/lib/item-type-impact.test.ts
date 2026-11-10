import { describe, expect, it } from 'vitest';
import { itemTypeChangeView, type ItemTypeImpact } from './item-type-impact';

const impact = (over: Partial<ItemTypeImpact> = {}): ItemTypeImpact => ({ total: 10, sellingNow: 6, wouldSell: 3, wouldNeedPrice: 1, packaging: 0, ...over });

describe('itemTypeChangeView', () => {
  it('says nothing when the answer does not change', () => {
    expect(itemTypeChangeView(impact(), true, true)).toMatchObject({ effect: 'none', message: '', blocked: null });
  });
  it('turning off counts the products that stop being sold and says what is left alone', () => {
    const v = itemTypeChangeView(impact(), true, false);
    expect(v).toMatchObject({ effect: 'stop', affected: 6, blocked: null });
    expect(v.message).toContain('6 products will stop being sold');
    expect(v.message).toContain('Quotes already made keep their lines');
  });
  it('turning off is refused while products are offered as checkout packaging', () => {
    const v = itemTypeChangeView(impact({ packaging: 2 }), true, false);
    expect(v.blocked).toContain('2 products of this classification are offered as checkout packaging');
  });
  it('turning on counts the products that start and the ones that wait for a price', () => {
    const v = itemTypeChangeView(impact(), false, true);
    expect(v).toMatchObject({ effect: 'start', affected: 3, needPrice: 1, blocked: null });
    expect(v.message).toContain('3 products will be sold');
    expect(v.message).toContain('1 product has no selling price and stays unsold until it is priced');
  });
  it('is plain when nothing is affected, and uses the singular', () => {
    expect(itemTypeChangeView(impact({ sellingNow: 0 }), true, false).message).toContain('nothing else changes');
    expect(itemTypeChangeView(impact({ wouldSell: 0, wouldNeedPrice: 0 }), false, true).message).toContain('nothing else changes');
    expect(itemTypeChangeView(impact({ sellingNow: 1 }), true, false).message).toContain('1 product will stop');
  });
});
