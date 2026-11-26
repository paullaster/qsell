import { describe, expect, it } from 'vitest';
import { callLink, directionsLink, whatsappLink } from './contact';

describe('calling a customer', () => {
  it('makes a link from any way a Kenyan mobile number is written', () => {
    expect(callLink('0712 345 678')).toBe('tel:+254712345678');
    expect(callLink('+254712345678')).toBe('tel:+254712345678');
    expect(callLink('712345678')).toBe('tel:+254712345678');
  });
  it('makes none for a missing or foreign number', () => {
    expect(callLink(null)).toBeNull();
    expect(callLink('')).toBeNull();
    expect(callLink('+447911123456')).toBeNull();
  });
});

describe('writing to a customer on WhatsApp', () => {
  it('opens the chat, with a first line only when there is one', () => {
    expect(whatsappLink('0712345678')).toBe('https://wa.me/254712345678');
    expect(whatsappLink('0712345678', ' Hello & welcome ')).toBe('https://wa.me/254712345678?text=Hello%20%26%20welcome');
    expect(whatsappLink('abc')).toBeNull();
  });
});

describe('directions to a customer', () => {
  it('goes to the map pin when there is one', () => {
    expect(directionsLink({ lat: -1.2921, lng: 36.8219 }, 'Ruiru')).toBe('https://www.google.com/maps/dir/?api=1&destination=-1.2921,36.8219');
  });
  it('goes to the place on the card when there is no pin, or the pin is not a place', () => {
    expect(directionsLink(null, 'Ruiru town')).toBe('https://www.google.com/maps/dir/?api=1&destination=Ruiru%20town');
    expect(directionsLink({ lat: 95, lng: 10 }, 'Ruiru')).toBe('https://www.google.com/maps/dir/?api=1&destination=Ruiru');
    expect(directionsLink({ lat: Number.NaN, lng: 10 }, null)).toBeNull();
  });
  it('is nothing when neither is known', () => {
    expect(directionsLink(null, null)).toBeNull();
    expect(directionsLink(null, '  ')).toBeNull();
  });
});
