import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OrderRepository } from './repository';

/**
 * The rule that makes the order timeline trustworthy: only the stage writer (orders/stages.ts) changes an order's status, payment
 * status, approval status or KRA status. This test fails the build when any other code does, in the ways code can: a drizzle
 * update of the orders table, or SQL text that updates it. (The database trigger catches the rest at run time and flags it.)
 */
const ROOTS = ['src', 'app'];
const STAGE_KEYS = /\b(status|paymentStatus|approvalStatus|kraTransmissionStatus)\s*:/;
const STAGE_SQL = /UPDATE\s+orders\b[\s\S]{0,400}?\bSET\b[\s\S]{0,400}?\b(status|payment_status|approval_status|kra_transmission_status)\s*=/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const EXEMPT = new Set([join('src', 'server', 'domains', 'orders', 'stages.ts')]);

describe('only the stage writer moves an order', () => {
  const sources = ROOTS.flatMap(files).filter((path) => !EXEMPT.has(path)).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('finds the code it is meant to scan', () => {
    expect(sources.length).toBeGreaterThan(500);
    // It knows an update of the orders table that is not about a stage (the tender), so it is not just matching everything.
    const tender = sources.find((s) => s.path.endsWith('tender-service.ts'));
    expect(tender?.text).toMatch(/\.update\(orders\)/);
  });

  it('has no drizzle update of the orders table that sets a stage column', () => {
    const offenders: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/\.update\((?:orders|ordersTable)\)\s*\.set\(\{([\s\S]{0,700}?)\}\)/g)) {
        if (STAGE_KEYS.test(match[1] ?? '')) offenders.push(path);
      }
    }
    expect(offenders, 'These change an order stage without the stage writer (OrderStages in orders/stages.ts).').toEqual([]);
  });

  it('has no SQL text that updates a stage column of orders', () => {
    const offenders = sources.filter(({ text }) => STAGE_SQL.test(text)).map(({ path }) => path);
    expect(offenders, 'These change an order stage in SQL without the stage writer.').toEqual([]);
  });

  it('does not let the generic order update accept a stage column (the compiler refuses it)', () => {
    const never = false as boolean;
    if (never) {
      const repo = undefined as unknown as OrderRepository;
      // @ts-expect-error the stage columns are not accepted: use OrderStages.
      void repo.update('x', { status: 'shipped' });
      // @ts-expect-error likewise for the payment status.
      void repo.update('x', { paymentStatus: 'paid' });
      void repo.update('x', { trackingNumber: 'T1' });
    }
    expect(never).toBe(false);
  });
});
