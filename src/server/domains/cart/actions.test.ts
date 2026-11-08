import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, get, save, merge, stopReminders } = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), save: vi.fn(), merge: vi.fn(), stopReminders: vi.fn() }));
vi.mock('@/auth', () => ({ auth }));
vi.mock('./service', () => ({ ShopCartService: { get, save, merge, stopReminders } }));

const { serverCartAction, saveServerCartAction, mergeServerCartAction, stopCartRemindersAction } = await import('./actions');

beforeEach(() => {
  auth.mockReset().mockResolvedValue({ user: { id: 'u1', role: 'customer' } });
  get.mockReset().mockResolvedValue([{ productId: 'a', quantity: 1 }]);
  save.mockReset().mockImplementation((_id: string, lines: unknown) => Promise.resolve(lines));
  merge.mockReset().mockResolvedValue([{ productId: 'a', quantity: 2 }]);
  stopReminders.mockReset().mockResolvedValue(true);
});

describe('the saved cart actions', () => {
  it('give a guest nothing to read and refuse to save or join', async () => {
    auth.mockResolvedValue(null);
    expect(await serverCartAction()).toEqual({ ok: true, data: null });
    expect((await saveServerCartAction([])).ok).toBe(false);
    expect((await mergeServerCartAction([])).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(merge).not.toHaveBeenCalled();
  });

  it('give staff and vendors no shop cart', async () => {
    auth.mockResolvedValue({ user: { id: 'staff', role: 'manager' } });
    expect(await serverCartAction()).toEqual({ ok: true, data: null });
    expect((await saveServerCartAction([{ productId: 'a', quantity: 1 }])).ok).toBe(false);
  });

  it('use the account of the signed-in shopper, never one sent by the browser', async () => {
    await saveServerCartAction([{ productId: 'a', quantity: 1 }, { userId: 'someone-else' }]);
    expect(save.mock.calls[0]?.[0]).toBe('u1');
    await mergeServerCartAction([{ productId: 'a', quantity: 1 }]);
    expect(merge.mock.calls[0]?.[0]).toBe('u1');
  });

  it('read the cart of the shopper', async () => {
    expect(await serverCartAction()).toEqual({ ok: true, data: [{ productId: 'a', quantity: 1 }] });
  });

  it('look at only the first lines of an oversized list', async () => {
    await saveServerCartAction(Array.from({ length: 5000 }, (_, i) => ({ productId: `p${String(i)}`, quantity: 1 })));
    expect((save.mock.calls[0]?.[1] as unknown[]).length).toBe(300);
  });

  it('return a failure as data without the internal error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    save.mockRejectedValue(new Error('connection refused to 10.0.0.5'));
    const result = await saveServerCartAction([]);
    expect(result).toEqual({ ok: false, error: 'Your cart could not be saved. Please try again.' });
    log.mockRestore();
  });
});

describe('stopCartRemindersAction', () => {
  it('refuses a token of the wrong shape without touching the database', async () => {
    expect((await stopCartRemindersAction('short')).ok).toBe(false);
    expect((await stopCartRemindersAction(undefined)).ok).toBe(false);
    expect(stopReminders).not.toHaveBeenCalled();
  });
  it('stops reminders for a good token and says so in plain words', async () => {
    const result = await stopCartRemindersAction('a'.repeat(43));
    expect(result).toMatchObject({ ok: true });
    expect(stopReminders).toHaveBeenCalledWith('a'.repeat(43));
  });
  it('says the link is not valid when no cart has that token', async () => {
    stopReminders.mockResolvedValue(false);
    expect(await stopCartRemindersAction('a'.repeat(43))).toEqual({ ok: false, error: 'This link is not valid.' });
  });
});
