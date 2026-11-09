import { describe, expect, it } from 'vitest';
import { cartReminderContent, cleanCartLines, isReminderToken, mergeCartLines, sameCartLines, SERVER_CART_MAX_LINES } from './shop-cart';

describe('cleanCartLines', () => {
  it('keeps good lines once and drops the rest', () => {
    expect(cleanCartLines([{ productId: 'a', quantity: 2 }, { productId: 'a', quantity: 5 }, { productId: '', quantity: 1 }, { productId: 'b', quantity: 0 }, { productId: 'c', quantity: -1 }, { productId: 'd', quantity: Number.NaN }, { productId: 'e', quantity: 1.5 }, null, 'x', { productId: 7, quantity: 1 }])).toEqual([
      { productId: 'a', quantity: 2 },
      { productId: 'e', quantity: 1.5 },
    ]);
  });
  it('returns nothing for something that is not a list and caps the length', () => {
    expect(cleanCartLines({})).toEqual([]);
    expect(cleanCartLines(Array.from({ length: 300 }, (_, i) => ({ productId: `p${i}`, quantity: 1 })))).toHaveLength(SERVER_CART_MAX_LINES);
  });
  it('refuses an id that is too long and a quantity that is absurd', () => {
    expect(cleanCartLines([{ productId: 'x'.repeat(101), quantity: 1 }, { productId: 'y', quantity: 1_000_000 }])).toEqual([]);
  });
});

describe('mergeCartLines', () => {
  it('takes the larger quantity of a product in both, never the sum', () => {
    const account = [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }];
    const browser = [{ productId: 'a', quantity: 5 }, { productId: 'c', quantity: 3 }];
    expect(mergeCartLines(account, browser)).toEqual([{ productId: 'a', quantity: 5 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 3 }]);
  });
  it('is the same cart when merged again', () => {
    const once = mergeCartLines([{ productId: 'a', quantity: 2 }], [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }]);
    expect(sameCartLines(mergeCartLines(once, once), once)).toBe(true);
  });
  it('works when one side is empty', () => {
    expect(mergeCartLines([], [{ productId: 'a', quantity: 1 }])).toEqual([{ productId: 'a', quantity: 1 }]);
    expect(mergeCartLines([{ productId: 'a', quantity: 1 }], [])).toEqual([{ productId: 'a', quantity: 1 }]);
  });
});

describe('sameCartLines', () => {
  it('ignores order and notices a different quantity', () => {
    expect(sameCartLines([{ productId: 'a', quantity: 1 }, { productId: 'b', quantity: 2 }], [{ productId: 'b', quantity: 2 }, { productId: 'a', quantity: 1 }])).toBe(true);
    expect(sameCartLines([{ productId: 'a', quantity: 1 }], [{ productId: 'a', quantity: 2 }])).toBe(false);
    expect(sameCartLines([{ productId: 'a', quantity: 1 }], [])).toBe(false);
  });
});

describe('isReminderToken', () => {
  it('accepts only the long url-safe form', () => {
    expect(isReminderToken('a'.repeat(43))).toBe(true);
    expect(isReminderToken('a'.repeat(42))).toBe(false);
    expect(isReminderToken(`${'a'.repeat(42)}!`)).toBe(false);
    expect(isReminderToken(undefined)).toBe(false);
  });
});

describe('cartReminderContent', () => {
  const base = { tradingName: 'Acme', customerName: 'Wanjiru Kamau', items: [{ name: 'Kettle', quantity: '1' }], cartUrl: 'https://s/checkout', stopUrl: 'https://s/off?token=t' };
  it('greets by first name and names the shop', () => {
    const c = cartReminderContent(base);
    expect(c.greeting).toBe('Hello Wanjiru,');
    expect(c.subject).toContain('Acme');
    expect(c.details).toEqual([['Kettle', '× 1']]);
    expect(c.footer).toContain('https://s/off?token=t');
    expect(c.body).toContain('an item');
  });
  it('shows the first few lines and counts the rest', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, quantity: '2' }));
    const c = cartReminderContent({ ...base, items, customerName: '' });
    expect(c.greeting).toBe('Hello,');
    expect(c.details).toHaveLength(7);
    expect(c.details[6]).toEqual(['and 3 more', '']);
    expect(c.body).toContain('some items');
  });
});
