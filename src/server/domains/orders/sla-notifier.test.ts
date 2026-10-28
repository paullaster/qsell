import { describe, expect, it, vi } from 'vitest';
import type { CompanySettingsRepository } from '@/server/domains/company/repository';
import type { EmailMessage, EmailPort } from '@/server/ports/communications';
import { OrderSlaNotifier, type LateOrder } from './sla-notifier';

const company = { ensureSeeded: () => Promise.resolve({ email: 'Owner@Shop.co.ke', tradingName: 'Duka', publicBaseUrl: 'https://duka.example' }) } as unknown as CompanySettingsRepository;
const late = (n: number): LateOrder[] => Array.from({ length: n }, (_, i) => ({ orderNumber: `ORD-${String(i + 1)}`, stage: 'payment_started', waitedMinutes: 45 + i }));

function setup(fail = false) {
  const sent: EmailMessage[] = [];
  const email = {
    name: 'test',
    send: (m: EmailMessage) => {
      if (fail) return Promise.reject(new Error('smtp down'));
      sent.push(m);
      return Promise.resolve({ ok: true });
    },
  } as unknown as EmailPort;
  return { sent, notifier: new OrderSlaNotifier(email, company) };
}

describe('the late-order mail', () => {
  it('sends nothing when no order is late', async () => {
    const { sent, notifier } = setup();
    await notifier.send('raised', [], ['a@b.co']);
    expect(sent).toEqual([]);
  });

  it('is one message per address for any number of orders, in plain words with the stage and the wait', async () => {
    const { sent, notifier } = setup();
    await notifier.send('raised', late(3), ['Ops@Shop.co.ke', 'ops@shop.co.ke', 'boss@shop.co.ke']);
    expect(sent.map((m) => m.to)).toEqual(['ops@shop.co.ke', 'boss@shop.co.ke']);
    expect(sent[0]?.subject).toBe('3 orders have waited too long · Duka');
    expect(sent[0]?.text).toContain('ORD-1: Payment started, 45 min');
    expect(sent[0]?.text).toContain('https://duka.example/admin/orders');
  });

  it('falls back to the company email when the list is empty', async () => {
    const { sent, notifier } = setup();
    await notifier.send('escalated', late(1), []);
    expect(sent.map((m) => m.to)).toEqual(['owner@shop.co.ke']);
    expect(sent[0]?.subject).toBe('1 order has still not moved on · Duka');
  });

  it('lists the oldest twenty and counts the rest', async () => {
    const { sent, notifier } = setup();
    await notifier.send('raised', late(25), ['a@b.co']);
    expect(sent[0]?.text).toContain('ORD-20');
    expect(sent[0]?.text).not.toContain('ORD-21');
    expect(sent[0]?.text).toContain('And: 5 more');
  });

  it('never throws when the mail cannot be sent', async () => {
    const { notifier } = setup(true);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(notifier.send('raised', late(1), ['a@b.co'])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
