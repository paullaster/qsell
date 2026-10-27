import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as React from 'react';
import type { DrizzleDb } from '@/server/db/drizzle/client';

// Inside a request React's cache hands every caller the same value; here that is a memo of a function with no arguments.
const newRequest: (() => void)[] = [];
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return {
    ...actual,
    cache: <T>(fn: () => T): (() => T) => {
      let value: { v: T } | null = null;
      newRequest.push(() => { value = null; });
      return () => (value ??= { v: fn() }).v;
    },
  };
});

const { CompanySettingsRepository } = await import('./repository');

const row = (name: string) => ({ id: 'c1', tradingName: name, uiConfig: {} });
let reads = 0;
let current = row('Before');

const db = {
  select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => { reads += 1; return Promise.resolve([current]); } }) }) }) }),
  update: () => ({ set: (values: { tradingName?: string }) => ({ where: () => ({ returning: () => { current = row(values.tradingName ?? current.tradingName); return Promise.resolve([current]); } }) }) }),
} as unknown as DrizzleDb;

beforeEach(() => {
  for (const reset of newRequest) reset();
  reads = 0;
  current = row('Before');
});

describe('the company row within one request', () => {
  it('is read once however many parts of the page ask, even side by side', async () => {
    const repo = new CompanySettingsRepository(db);
    const rows = await Promise.all([repo.ensureSeeded(), repo.ensureSeeded(), repo.ensureSeeded()]);
    await repo.ensureSeeded();
    expect(reads).toBe(1);
    expect(rows.every((r) => r.tradingName === 'Before')).toBe(true);
  });

  it('is read again after a save, so what follows in the same request is the saved row', async () => {
    const repo = new CompanySettingsRepository(db);
    await repo.ensureSeeded();
    await repo.update({ tradingName: 'After' });
    expect((await repo.ensureSeeded()).tradingName).toBe('After');
    expect(reads).toBe(2);
  });

  it('does not keep a failed read', async () => {
    const failing = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.reject(new Error('down')) }) }) }) }), insert: () => ({ values: () => ({ returning: () => Promise.reject(new Error('down')) }) }) } as unknown as DrizzleDb;
    const repo = new CompanySettingsRepository(failing);
    await expect(repo.ensureSeeded()).rejects.toThrow(/Company settings unavailable/);
    const healthy = new CompanySettingsRepository(db);
    expect((await healthy.ensureSeeded()).tradingName).toBe('Before');
  });
});
