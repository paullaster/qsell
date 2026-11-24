import { describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { catalogueVersion } from '../catalogue/version';
import type { ReportDefinition } from '../registry/definition';
import { ReportRunner, registerExecutor, type ReportAuditEntry, type ReportExecutor } from './run';

const NOW = new Date('2026-03-10T18:00:00Z');

const def = (over: Partial<ReportDefinition> = {}): ReportDefinition => ({
  code: 'stub-report',
  titleId: 'report.business_overview.title',
  questionId: 'report.business_overview.question',
  family: 'sales',
  permissions: ['report_sales:read'],
  measures: ['sales.total'],
  dimensions: ['date'],
  tier: 'live',
  scope: 'both',
  tieOut: { kind: 'none', reason: 'A stub report that reads nothing and ties to nothing.' },
  sensitivity: 'normal',
  exportFormats: [],
  maxRows: 100,
  timeoutMs: 1_000,
  keywords: ['stub', 'sample'],
  docs: { file: '01-business-overview-and-dashboard.md', heading: 'Section C' },
  view: 'table',
  catalogue: 'complete',
  ...over,
});

const access = (held: PermissionKey[]) => ({
  can: (_user: string, key: PermissionKey) => Promise.resolve(held.includes(key)),
});

interface Params {
  n: number;
}

function stub(over: Partial<ReportExecutor<Params, { n: number; saw: string[] }>> = {}) {
  const calls: Params[] = [];
  const executor: ReportExecutor<Params, { n: number; saw: string[] }> = {
    code: 'stub-report',
    permissions: ['report_profit:read'],
    readParams: (raw) => {
      const n = (raw as { n?: unknown } | null)?.n;
      return typeof n === 'number'
        ? { ok: true, params: { n } }
        : { ok: false, error: 'n must be a number' };
    },
    execute: ({ params, allowed }) => {
      calls.push(params);
      return Promise.resolve({ data: { n: params.n, saw: [...allowed].sort() } });
    },
    ...over,
  };
  return { executor, calls };
}

const runner = (
  held: PermissionKey[],
  executor: ReportExecutor<Params, { n: number; saw: string[] }>,
  options: { reports?: ReportDefinition[]; audit?: (e: ReportAuditEntry) => Promise<void> } = {},
) =>
  new ReportRunner({
    access: access(held),
    executors: [registerExecutor(executor)],
    reports: options.reports ?? [def()],
    clock: () => NOW,
    ...(options.audit === undefined ? {} : { audit: { record: options.audit } }),
  });

describe('ReportRunner', () => {
  it('refuses an unknown report', async () => {
    const { executor } = stub();
    const r = await runner(['report_sales:read'], executor).run('nothing', {}, 'u1');
    expect(r).toMatchObject({ ok: false, code: 'unknown_report' });
  });

  it('refuses before any read when a permission is missing', async () => {
    const { executor, calls } = stub();
    const r = await runner([], executor).run('stub-report', { n: 1 }, 'u1');
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(calls).toEqual([]);
  });

  it('needs every permission the report lists, not just one', async () => {
    const { executor, calls } = stub();
    const two = def({ permissions: ['report_sales:read', 'report_collections:read'] });
    const r = await runner(['report_sales:read'], executor, { reports: [two] }).run(
      'stub-report',
      { n: 1 },
      'u1',
    );
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
    expect(calls).toEqual([]);
  });

  it('refuses parameters it cannot read, in words, without running', async () => {
    const { executor, calls } = stub();
    const r = await runner(['report_sales:read'], executor).run('stub-report', { n: 'x' }, 'u1');
    expect(r).toEqual({ ok: false, code: 'bad_params', error: 'n must be a number' });
    expect(calls).toEqual([]);
  });

  it('hands the executor only the permissions the viewer really holds', async () => {
    const { executor } = stub();
    const held: PermissionKey[] = ['report_sales:read'];
    const r = await runner(held, executor).run<{ n: number; saw: string[] }>(
      'stub-report',
      { n: 2 },
      'u1',
    );
    expect(r.ok && r.data.saw).toEqual(['report_sales:read']);
    const withCost = await runner([...held, 'report_profit:read'], executor).run<{
      n: number;
      saw: string[];
    }>('stub-report', { n: 2 }, 'u1');
    expect(withCost.ok && withCost.data.saw).toEqual(['report_profit:read', 'report_sales:read']);
  });

  it('returns the facts every report carries', async () => {
    const { executor } = stub();
    const r = await runner(['report_sales:read'], executor).run('stub-report', { n: 3 }, 'u1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta).toEqual({
      code: 'stub-report',
      asOf: NOW.toISOString(),
      tier: 'live',
      definitionsVersion: catalogueVersion(),
      cached: false,
      truncated: false,
      tieOut: { declared: 'none', checked: false },
    });
  });

  it('passes on what the executor says about truncation, its own read time and its own cache', async () => {
    const { executor } = stub({
      execute: () =>
        Promise.resolve({
          data: { n: 1, saw: [] },
          truncated: true,
          asOf: '2026-03-10T17:59:50.000Z',
          cached: true,
        }),
    });
    const r = await runner(['report_sales:read'], executor).run('stub-report', { n: 1 }, 'u1');
    expect(r.ok && r.meta).toMatchObject({
      truncated: true,
      asOf: '2026-03-10T17:59:50.000Z',
      cached: true,
    });
  });

  it('gives the executor the report row limit', async () => {
    let seen = 0;
    const { executor } = stub({
      execute: ({ maxRows }) => {
        seen = maxRows;
        return Promise.resolve({ data: { n: 0, saw: [] } });
      },
    });
    await runner(['report_sales:read'], executor, { reports: [def({ maxRows: 250 })] }).run(
      'stub-report',
      { n: 1 },
      'u1',
    );
    expect(seen).toBe(250);
  });

  it('masks a failure: the viewer gets a sentence, not the error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { executor } = stub({
      execute: () => Promise.reject(new Error('relation "orders" does not exist')),
    });
    const r = await runner(['report_sales:read'], executor).run('stub-report', { n: 1 }, 'u1');
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(JSON.stringify(r)).not.toMatch(/relation|orders/);
    spy.mockRestore();
  });

  it('stops a report that takes longer than its limit', async () => {
    const { executor } = stub({
      execute: () =>
        new Promise((resolve) => setTimeout(() => resolve({ data: { n: 1, saw: [] } }), 200)),
    });
    const r = await runner(['report_sales:read'], executor, {
      reports: [def({ timeoutMs: 20 })],
    }).run('stub-report', { n: 1 }, 'u1');
    expect(r).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('lists only the reports whose every permission the person holds', async () => {
    const { executor } = stub();
    const a = def({ code: 'a', permissions: ['report_sales:read'] });
    const b = def({ code: 'b', permissions: ['report_sales:read', 'report_profit:read'] });
    const r = runner(['report_sales:read'], executor, { reports: [a, b] });
    expect((await r.list('u1')).map((x) => x.code)).toEqual(['a']);
    const both = runner(['report_sales:read', 'report_profit:read'], executor, { reports: [a, b] });
    expect((await both.list('u1')).map((x) => x.code)).toEqual(['a', 'b']);
  });
});

describe('ReportRunner cache', () => {
  const cachedStub = () => stub({ runnerCacheMs: 15_000 });

  it('serves a repeated request from the cache and says so', async () => {
    const { executor, calls } = cachedStub();
    const r = runner(['report_sales:read'], executor);
    const first = await r.run('stub-report', { n: 1 }, 'u1');
    const second = await r.run('stub-report', { n: 1 }, 'u1');
    expect(first.ok && first.meta.cached).toBe(false);
    expect(second.ok && second.meta.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('keeps different parameters apart', async () => {
    const { executor, calls } = cachedStub();
    const r = runner(['report_sales:read'], executor);
    await r.run('stub-report', { n: 1 }, 'u1');
    await r.run('stub-report', { n: 2 }, 'u1');
    expect(calls).toHaveLength(2);
  });

  it('never serves one permission set an answer made for another', async () => {
    const { executor, calls } = cachedStub();
    const held: PermissionKey[] = ['report_sales:read'];
    // Two runners are two processes; share one cache by using one runner whose access changes with the user.
    const mixed = new ReportRunner({
      access: {
        can: (user: string, key: PermissionKey) =>
          Promise.resolve(
            user === 'rich' ? [...held, 'report_profit:read'].includes(key) : held.includes(key),
          ),
      },
      executors: [registerExecutor(executor)],
      reports: [def({ scope: 'company' })],
      clock: () => NOW,
    });
    const a = await mixed.run<{ n: number; saw: string[] }>('stub-report', { n: 1 }, 'poor');
    const b = await mixed.run<{ n: number; saw: string[] }>('stub-report', { n: 1 }, 'rich');
    expect(a.ok && a.data.saw).toEqual(['report_sales:read']);
    expect(b.ok && b.data.saw).toEqual(['report_profit:read', 'report_sales:read']);
    expect(calls).toHaveLength(2);
  });

  it('caches per person for a report that depends on who asks (their own branch)', async () => {
    const { executor, calls } = cachedStub();
    const r = runner(['report_sales:read'], executor, { reports: [def({ scope: 'both' })] });
    await r.run('stub-report', { n: 1 }, 'u1');
    await r.run('stub-report', { n: 1 }, 'u2');
    expect(calls).toHaveLength(2);
    await r.run('stub-report', { n: 1 }, 'u1');
    expect(calls).toHaveLength(2);
  });

  it('shares one answer between people for a company-wide report', async () => {
    const { executor, calls } = cachedStub();
    const r = runner(['report_sales:read'], executor, { reports: [def({ scope: 'company' })] });
    await r.run('stub-report', { n: 1 }, 'u1');
    await r.run('stub-report', { n: 1 }, 'u2');
    expect(calls).toHaveLength(1);
  });
});

describe('ReportRunner audit', () => {
  it('writes an audit entry for a personal, bank or pay report', async () => {
    for (const sensitivity of ['personal', 'bank', 'pay'] as const) {
      const entries: ReportAuditEntry[] = [];
      const { executor } = stub();
      const r = runner(['report_sales:read'], executor, {
        reports: [def({ sensitivity })],
        audit: (e) => {
          entries.push(e);
          return Promise.resolve();
        },
      });
      await r.run('stub-report', { n: 1 }, 'u1');
      expect(entries, sensitivity).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        userId: 'u1',
        reportCode: 'stub-report',
        action: 'run',
        params: { n: 1 },
        definitionsVersion: catalogueVersion(),
        truncated: false,
      });
    }
  });

  it('does not audit an ordinary or a cost report on every run', async () => {
    for (const sensitivity of ['normal', 'cost'] as const) {
      const entries: ReportAuditEntry[] = [];
      const { executor } = stub();
      const r = runner(['report_sales:read'], executor, {
        reports: [def({ sensitivity })],
        audit: (e) => {
          entries.push(e);
          return Promise.resolve();
        },
      });
      await r.run('stub-report', { n: 1 }, 'u1');
      expect(entries, sensitivity).toHaveLength(0);
    }
  });

  it('does not audit a refused run, and never lets an audit failure block a read', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const entries: ReportAuditEntry[] = [];
    const { executor } = stub();
    const refused = runner([], executor, {
      reports: [def({ sensitivity: 'pay' })],
      audit: (e) => {
        entries.push(e);
        return Promise.resolve();
      },
    });
    await refused.run('stub-report', { n: 1 }, 'u1');
    expect(entries).toEqual([]);

    const failing = runner(['report_sales:read'], executor, {
      reports: [def({ sensitivity: 'pay' })],
      audit: () => Promise.reject(new Error('audit table missing')),
    });
    const r = await failing.run('stub-report', { n: 1 }, 'u1');
    expect(r.ok).toBe(true);
    spy.mockRestore();
  });
});
