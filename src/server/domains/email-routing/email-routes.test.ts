import { describe, expect, it } from 'vitest';
import { EMAIL_POINTS, EMAIL_POINT_KEYS, pointOf } from './email-points';
import { addressing, checkRouteInput, idsNeeded, parseSource, readRouteConfig, resolveRoute, type ResolveContext, type RouteConfig } from './email-routes';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const none: RouteConfig = { enabled: true, to: [], cc: [], bcc: [], replyTo: [], shown: [] };
const context: ResolveContext = {
  customerEmail: 'buyer@customer.test',
  companyEmail: 'info@acme.co.ke',
  channelEmails: new Map([['sales', 'sales@acme.co.ke']]),
  staffEmails: new Map([[A, 'wanjiru@acme.co.ke'], [B, 'otieno@acme.co.ke']]),
  actorUserId: A,
  ownerUserId: B,
};

describe('the points', () => {
  it('has one entry for every key, and every default can be read back unchanged', () => {
    expect(EMAIL_POINTS.map((p) => p.key).sort()).toEqual([...EMAIL_POINT_KEYS].sort());
    for (const point of EMAIL_POINTS) expect(readRouteConfig(point.defaults, point.defaults)).toEqual(point.defaults);
  });

  it('keeps today\'s behaviour with no configuration, and leaves the new staff alerts off', () => {
    expect(resolveRoute(pointOf('shop_quote_request_staff').defaults, context).to).toEqual(['info@acme.co.ke']);
    expect(resolveRoute(pointOf('shop_quote_request_customer').defaults, context).to).toEqual(['buyer@customer.test']);
    const sent = resolveRoute(pointOf('quote_sent').defaults, context);
    expect([sent.to, sent.replyTo]).toEqual([['buyer@customer.test'], ['info@acme.co.ke']]);
    expect(resolveRoute(pointOf('shop_order_placed_staff').defaults, context)).toMatchObject({ send: false, reason: 'This email is switched off.' });
    expect(resolveRoute(pointOf('quote_document_shop').defaults, context).shown).toEqual(['info@acme.co.ke']);
  });
});

describe('finding the addresses', () => {
  it('follows each kind of source to its address, so a change elsewhere is followed', () => {
    const r = resolveRoute({ ...none, to: [{ kind: 'staff', userId: A }, { kind: 'channel', channelId: 'sales' }], cc: [{ kind: 'company' }, { kind: 'actor' }], bcc: [{ kind: 'owner' }, { kind: 'customer' }], replyTo: [{ kind: 'address', address: 'help@acme.co.ke' }] }, context);
    expect(r.to).toEqual(['wanjiru@acme.co.ke', 'sales@acme.co.ke']);
    expect(r.cc).toEqual(['info@acme.co.ke']);
    expect(r.bcc).toEqual(['otieno@acme.co.ke', 'buyer@customer.test']);
    expect(r.replyTo).toEqual(['help@acme.co.ke']);
  });

  it('writes to an address once: To wins over Cc and Cc over Bcc, ignoring case', () => {
    const r = resolveRoute({ ...none, to: [{ kind: 'company' }], cc: [{ kind: 'address', address: 'INFO@acme.co.ke' }, { kind: 'staff', userId: A }], bcc: [{ kind: 'staff', userId: A }, { kind: 'staff', userId: B }] }, context);
    expect([r.to, r.cc, r.bcc]).toEqual([['info@acme.co.ke'], ['wanjiru@acme.co.ke'], ['otieno@acme.co.ke']]);
  });

  it('skips a source it cannot find and says why, without stopping the mail', () => {
    const r = resolveRoute({ ...none, to: [{ kind: 'company' }, { kind: 'staff', userId: '33333333-3333-4333-8333-333333333333' }, { kind: 'channel', channelId: 'gone' }], cc: [{ kind: 'customer' }] }, { ...context, customerEmail: null });
    expect(r.send).toBe(true);
    expect(r.skipped.map((s) => [s.list, s.source.kind])).toEqual([['to', 'staff'], ['to', 'channel'], ['cc', 'customer']]);
  });

  it('does not send with nobody to write to, or when it is switched off, and says which', () => {
    expect(resolveRoute({ ...none, to: [{ kind: 'customer' }] }, { ...context, customerEmail: null })).toMatchObject({ send: false, reason: 'There is nobody to write to.' });
    expect(resolveRoute({ ...none, enabled: false, to: [{ kind: 'company' }] }, context)).toMatchObject({ send: false, reason: 'This email is switched off.' });
  });

  it('never uses an address that is not deliverable', () => {
    const r = resolveRoute({ ...none, to: [{ kind: 'company' }] }, { ...context, companyEmail: 'admin@localhost' });
    expect(r.send).toBe(false);
  });
});

describe('what is stored', () => {
  it('is made safe: unreadable rows take the defaults and bad entries are dropped', () => {
    const defaults = pointOf('quote_sent').defaults;
    expect(readRouteConfig(null, defaults)).toBe(defaults);
    expect(readRouteConfig('x', defaults)).toBe(defaults);
    const read = readRouteConfig({ to: [{ kind: 'staff', userId: 'not-a-uuid' }, { kind: 'company' }, { kind: 'company' }, 7], cc: 'nope' }, defaults);
    expect(read.to).toEqual([{ kind: 'company' }]);
    expect(read.cc).toEqual(defaults.cc);
    expect(read.replyTo).toEqual(defaults.replyTo);
  });

  it('keeps a list that was emptied on purpose', () => {
    expect(readRouteConfig({ replyTo: [] }, pointOf('quote_sent').defaults).replyTo).toEqual([]);
  });

  it('reads a source only when it is one', () => {
    expect(parseSource({ kind: 'staff', userId: A })).toEqual({ kind: 'staff', userId: A });
    expect(parseSource({ kind: 'address', address: 'a b@c.co' })).toBeNull();
    expect(parseSource({ kind: 'sms' })).toBeNull();
    expect(parseSource(null)).toBeNull();
  });
});

describe('what the screen sends', () => {
  it('needs someone to write to when a mail is on, and allows a mail that is off to have no one', () => {
    expect(checkRouteInput({ enabled: true, to: [] }, 'mail')).toEqual({ ok: false, error: 'Choose who it is sent to, or switch it off.' });
    expect(checkRouteInput({ enabled: false, to: [] }, 'mail').ok).toBe(true);
  });

  it('refuses a bad address by name, and a list that is too long, and anything unreadable', () => {
    expect(checkRouteInput({ to: [{ kind: 'address', address: 'nope' }] }, 'mail')).toEqual({ ok: false, error: 'That address does not look right: nope' });
    expect(checkRouteInput({ to: Array.from({ length: 21 }, (_, i) => ({ kind: 'address', address: `a${String(i)}@b.co` })) }, 'mail').ok).toBe(false);
    expect(checkRouteInput({ to: 'x' }, 'mail').ok).toBe(false);
    expect(checkRouteInput(null, 'mail').ok).toBe(false);
    expect(checkRouteInput({ to: [{ kind: 'staff', userId: 'x' }] }, 'mail').ok).toBe(false);
  });

  it('drops repeats, keeps the order, and keeps only the lists that mean something for the kind of point', () => {
    const mail = checkRouteInput({ to: [{ kind: 'company' }, { kind: 'company' }], shown: [{ kind: 'company' }] }, 'mail');
    expect(mail.ok && mail.config).toMatchObject({ to: [{ kind: 'company' }], shown: [] });
    const doc = checkRouteInput({ shown: [{ kind: 'company' }, { kind: 'staff', userId: A }], to: [{ kind: 'customer' }] }, 'document');
    expect(doc.ok && doc.config).toMatchObject({ to: [], shown: [{ kind: 'company' }, { kind: 'staff', userId: A }] });
  });
});

describe('what has to be loaded', () => {
  it('names the staff and channels the lists use, with the people on the document for actor and owner', () => {
    const needed = idsNeeded({ ...none, to: [{ kind: 'staff', userId: A }, { kind: 'actor' }], cc: [{ kind: 'channel', channelId: 'sales' }, { kind: 'owner' }] }, { actorUserId: B, ownerUserId: null });
    expect(needed.staff.sort()).toEqual([A, B].sort());
    expect(needed.channels).toEqual(['sales']);
  });
});

describe('the addressing of a mail', () => {
  it('takes the first person as To and the rest as more, and leaves off the lists that are empty', () => {
    const r = resolveRoute({ ...none, to: [{ kind: 'staff', userId: A }, { kind: 'staff', userId: B }], cc: [{ kind: 'company' }], replyTo: [{ kind: 'channel', channelId: 'sales' }] }, context);
    expect(addressing(r)).toEqual({ to: 'wanjiru@acme.co.ke', toMore: ['otieno@acme.co.ke'], cc: ['info@acme.co.ke'], replyTo: ['sales@acme.co.ke'] });
    expect(addressing(resolveRoute({ ...none, to: [{ kind: 'customer' }] }, context))).toEqual({ to: 'buyer@customer.test' });
  });
});
