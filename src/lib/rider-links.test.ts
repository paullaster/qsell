import { describe, expect, it } from 'vitest';
import { callLink, chatLink, navigateLink } from './rider-links';

describe('links a rider presses', () => {
  it('calls a number, tidied', () => {
    expect(callLink('0711 000 555')).toBe('tel:0711000555');
    expect(callLink('abc')).toBeNull();
    expect(callLink(null)).toBeNull();
  });

  it('chats on WhatsApp with international digits, reading a local number as Kenyan', () => {
    expect(chatLink('0711 000 555')).toBe('https://wa.me/254711000555');
    expect(chatLink('+254 711 000 555')).toBe('https://wa.me/254711000555');
    expect(chatLink('12')).toBeNull();
  });

  it('navigates to the pin, or to the written address, or nowhere', () => {
    expect(navigateLink({ latitude: -1.286389, longitude: 36.817223 }, ['x'])).toBe('geo:-1.286389,36.817223?q=-1.286389,36.817223');
    expect(navigateLink(null, ['1 Moi Avenue', ' ', 'Nairobi'])).toBe('geo:0,0?q=1%20Moi%20Avenue%2C%20Nairobi');
    expect(navigateLink(null, [' '])).toBeNull();
  });
});
