import { describe, expect, it } from 'vitest';
import { cleanDisplayName, formatAddress, isDeliverableAddress, resolveSender, type SenderConfig } from './sender';

const mailbox: SenderConfig = { mailbox: 'mailer@mail.test', fromName: null, policy: 'mailbox' };
const business: SenderConfig = { ...mailbox, policy: 'business' };

describe('what counts as an address', () => {
  it('accepts a plain address with a real domain', () => {
    expect(isDeliverableAddress('sales@acme.co.ke')).toBe(true);
    expect(isDeliverableAddress('  a.b+c@x-y.example  ')).toBe(true);
  });

  it('refuses a made-up local address, anything with a name or a line break, and nothing', () => {
    for (const bad of ['admin@localhost', 'a@b.localhost', 'a@b', 'Name <a@b.co>', 'a@b.co\nBcc: x@y.co', 'a b@c.co', '@c.co', '', '   ']) {
      expect(isDeliverableAddress(bad), bad).toBe(false);
    }
    expect(isDeliverableAddress(undefined)).toBe(false);
    expect(isDeliverableAddress(null)).toBe(false);
  });
});

describe('display names', () => {
  it('cannot break out of the header', () => {
    expect(cleanDisplayName('Acme "Best" <x@y.co>\r\nBcc: z@y.co')).toBe('Acme Best x@y.co Bcc: z@y.co');
    expect(cleanDisplayName('  Acme   Ltd ')).toBe('Acme Ltd');
    expect(cleanDisplayName('x'.repeat(200)).length).toBe(80);
    expect(cleanDisplayName(undefined)).toBe('');
  });

  it('is quoted with the address, or left off', () => {
    expect(formatAddress('Acme Ltd', 'a@b.co')).toBe('"Acme Ltd" <a@b.co>');
    expect(formatAddress('', 'a@b.co')).toBe('a@b.co');
  });
});

describe('the mailbox policy (servers that only accept the account they log in as)', () => {
  it('sends from the mailbox in the business’s name and sends answers to the business', () => {
    expect(resolveSender(mailbox, { sender: { name: 'Acme Ltd', address: 'sales@acme.co.ke' } })).toEqual({
      from: '"Acme Ltd" <mailer@mail.test>',
      sender: null,
      replyTo: 'sales@acme.co.ke',
      envelopeFrom: 'mailer@mail.test',
    });
  });

  it('leaves Reply-To off when the business has no real address, rather than inventing one', () => {
    expect(resolveSender(mailbox, { sender: { name: 'Acme Ltd', address: 'admin@localhost' } }).replyTo).toBeNull();
    expect(resolveSender(mailbox, {}).replyTo).toBeNull();
  });

  it('does not reply to itself', () => {
    expect(resolveSender(mailbox, { sender: { address: 'MAILER@mail.test' } }).replyTo).toBeNull();
  });

  it('uses an explicit Reply-To when it is a real address, and drops one that is not', () => {
    expect(resolveSender(mailbox, { sender: { address: 'sales@acme.co.ke' }, replyTo: 'accounts@acme.co.ke' }).replyTo).toBe('accounts@acme.co.ke');
    expect(resolveSender(mailbox, { replyTo: 'bad address' }).replyTo).toBeNull();
  });

  it('uses the configured name for mail that names no business, and none when there is none', () => {
    expect(resolveSender({ ...mailbox, fromName: 'Acme Portal' }, {}).from).toBe('"Acme Portal" <mailer@mail.test>');
    expect(resolveSender(mailbox, {}).from).toBe('mailer@mail.test');
  });
});

describe('the business policy (servers that accept another From)', () => {
  it('shows the business’s own address, and names the mailbox in Sender and the envelope', () => {
    expect(resolveSender(business, { sender: { name: 'Acme Ltd', address: 'sales@acme.co.ke' } })).toEqual({
      from: '"Acme Ltd" <sales@acme.co.ke>',
      sender: 'mailer@mail.test',
      replyTo: null,
      envelopeFrom: 'mailer@mail.test',
    });
  });

  it('falls back to the mailbox when the business has no real address', () => {
    expect(resolveSender(business, { sender: { name: 'Acme Ltd', address: 'admin@localhost' } })).toEqual({
      from: '"Acme Ltd" <mailer@mail.test>',
      sender: null,
      replyTo: null,
      envelopeFrom: 'mailer@mail.test',
    });
  });

  it('needs no Sender when the business address is the mailbox', () => {
    expect(resolveSender(business, { sender: { address: 'mailer@mail.test' } }).sender).toBeNull();
  });
});

describe('the envelope', () => {
  it('is the mailbox whatever the policy and whatever the message asks for', () => {
    for (const config of [mailbox, business]) {
      expect(resolveSender(config, { sender: { name: 'A', address: 'a@b.co' }, replyTo: 'c@d.co' }).envelopeFrom).toBe('mailer@mail.test');
    }
  });
});
