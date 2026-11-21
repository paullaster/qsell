import { describe, expect, it } from 'vitest';
import { addToCart, guideTotal, removeLine, setPrice, setQuantity, stepLine, unitCount, type Cart } from './cart';

const item = (id: string, price: number | null = 100) => ({ productId: id, name: id, listPrice: price, imageUrl: '' });

describe('the till cart', () => {
  it('adds one more when the same product is tapped again, and a new line for a new product', () => {
    let cart: Cart = [];
    cart = addToCart(cart, item('a'), 'k1');
    cart = addToCart(cart, item('a'), 'k2');
    cart = addToCart(cart, item('b'), 'k3');
    expect(cart.map((l) => [l.productId, l.quantity])).toEqual([['a', 2], ['b', 1]]);
  });

  it('keeps a package as a line of its own however many times it is added', () => {
    let cart: Cart = addToCart([], item('p'), 'k1');
    cart = addToCart(cart, { ...item('p'), package: { picks: [], note: '' } }, 'k2');
    cart = addToCart(cart, { ...item('p'), package: { picks: [], note: 'x' } }, 'k3');
    expect(cart).toHaveLength(3);
  });

  it('steps a line down and takes it off at zero, and sets a typed quantity', () => {
    let cart: Cart = addToCart([], item('a'), 'k1');
    cart = stepLine(cart, 'k1', 1);
    expect(cart[0]?.quantity).toBe(2);
    cart = stepLine(cart, 'k1', -1);
    cart = stepLine(cart, 'k1', -1);
    expect(cart).toHaveLength(0);
    cart = addToCart([], item('a'), 'k1');
    expect(setQuantity(cart, 'k1', 3.5)[0]?.quantity).toBe(3.5);
    expect(setQuantity(cart, 'k1', 0)).toHaveLength(0);
    expect(setQuantity(cart, 'k1', Number.NaN)).toHaveLength(0);
    expect(removeLine(cart, 'nope')).toHaveLength(1);
  });

  it('counts units and gives a guide total only when every price is known', () => {
    let cart: Cart = addToCart([], item('a', 50), 'k1');
    cart = addToCart(cart, item('b', 20.5), 'k2');
    cart = setQuantity(cart, 'k2', 2);
    expect(unitCount(cart)).toBe(3);
    expect(guideTotal(cart)).toBe(91);
    expect(guideTotal(addToCart(cart, item('c', null), 'k3'))).toBeNull();
  });

  it('keeps a typed price on its line, rounds it to the cent, and clears it for anything that is not a price', () => {
    const cart: Cart = addToCart([], { productId: 'p1', name: 'Tea', listPrice: 100, imageUrl: '' }, 'k1');
    expect(setPrice(cart, 'k1', 95.456)[0]?.price).toBe(95.46);
    expect(setPrice(setPrice(cart, 'k1', 90), 'k1', null)[0]).not.toHaveProperty('price');
    expect(setPrice(cart, 'k1', 0)[0]).not.toHaveProperty('price');
    expect(setPrice(cart, 'k1', Number.NaN)[0]).not.toHaveProperty('price');
    expect(setPrice(cart, 'other', 50)).toEqual(cart);
  });
});
