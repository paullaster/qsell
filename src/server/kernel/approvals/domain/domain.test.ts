import { describe, expect, it } from 'vitest';
import { evaluateCondition } from './conditions';
import { validateDefinition } from './definition';
import {
  NoEligibleApprover,
  nextOffers,
  type ApproverDirectory,
  type StepEntryRecord,
} from './resolve';
import type { StepDefinition } from './types';
import { nth } from '@/lib/values';

const doc = {
  amount: 120000,
  discountPercent: 12,
  customer: { overCreditLimit: true, accountType: 'credit' },
  belowFloor: false,
};

describe('conditions', () => {
  it('compares, combines and reads nested fields', () => {
    expect(evaluateCondition({ op: 'gt', field: 'amount', value: 100000 }, doc)).toBe(true);
    expect(
      evaluateCondition({ op: 'between', field: 'discountPercent', value: [5, 15] }, doc),
    ).toBe(true);
    expect(
      evaluateCondition({ op: 'eq', field: 'customer.overCreditLimit', value: true }, doc),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'and',
          children: [
            { op: 'gt', field: 'amount', value: 1 },
            { op: 'not', child: { op: 'eq', field: 'belowFloor', value: true } },
          ],
        },
        doc,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'in', field: 'customer.accountType', value: ['cash', 'credit'] },
        doc,
      ),
    ).toBe(true);
  });
  it('compares one field with another', () => {
    expect(
      evaluateCondition({ op: 'gt', field: 'amount', value: { field: 'discountPercent' } }, doc),
    ).toBe(true);
  });
  it('treats missing fields as no match instead of failing', () => {
    expect(evaluateCondition({ op: 'gt', field: 'nope', value: 1 }, doc)).toBe(false);
    expect(evaluateCondition({ op: 'eq', field: 'nope', value: null }, doc)).toBe(false);
    expect(evaluateCondition(undefined, doc)).toBe(true);
  });
  it('compares numeric strings as numbers', () => {
    expect(evaluateCondition({ op: 'gt', field: 'amount', value: 9 }, { amount: '100.00' })).toBe(
      true,
    );
  });
});

describe('definition validation', () => {
  const step = (over: Partial<StepDefinition> = {}): StepDefinition => ({
    sequence: 1,
    name: 'Manager',
    approver: { type: 'user', userId: 'u1' },
    ...over,
  });
  it('accepts a complete workflow', () => {
    expect(validateDefinition('sales_order.submitted', { steps: [step()] })).toEqual([]);
  });
  it('rejects unknown triggers, fields, empty or duplicate steps', () => {
    expect(validateDefinition('nope', { steps: [step()] })).toHaveLength(1);
    expect(nth(validateDefinition('sales_order.submitted', { steps: [] }), 0).path).toBe('steps');
    expect(
      validateDefinition('sales_order.submitted', {
        conditions: { op: 'gt', field: 'bogus', value: 1 },
        steps: [step(), step()],
      }).map((i) => i.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('bogus'),
        expect.stringContaining('share the order'),
      ]),
    );
    expect(
      validateDefinition('sales_order.submitted', {
        steps: [step({ approver: { type: 'group', groupId: '', require: 'all' } })],
      }),
    ).toHaveLength(1);
  });
});

describe('approver resolution', () => {
  // clerk -> sup (limit 50k) -> mgr (limit 500k) -> fin (unlimited)
  const chain: Record<string, string | null> = { clerk: 'sup', sup: 'mgr', mgr: 'fin', fin: null };
  const limits: Record<string, number> = { sup: 50_000, mgr: 500_000, fin: Infinity };
  const dir = (inactive: string[] = []): ApproverDirectory => ({
    approverOf: (u) => chain[u] ?? null,
    qualifies: (u, _k, amount) => (limits[u] ?? 0) >= amount,
    isEligible: (u) => !inactive.includes(u),
    groupMembers: () => ['a', 'b', 'c'],
    roleMembers: () => [],
  });
  const run = (step: StepDefinition, amount: number, entries: StepEntryRecord[] = [], d = dir()) =>
    nextOffers({
      step,
      directory: d,
      requesterId: 'clerk',
      documentKind: 'sales_order',
      amount,
      entries,
    });
  const entry = (userId: string, position = 0): StepEntryRecord => ({
    position,
    approverUserId: userId,
    status: 'approved',
  });
  const s = (
    approver: StepDefinition['approver'],
    extra: Partial<StepDefinition> = {},
  ): StepDefinition => ({ sequence: 1, name: 'S', approver, ...extra });

  it('chain by limit climbs one hop at a time until someone covers the amount', () => {
    const step = s({ type: 'chain_by_limit' });
    expect(run(step, 120_000)).toEqual({ done: false, offers: [{ userId: 'sup', position: 0 }] });
    expect(run(step, 120_000, [entry('sup')])).toEqual({
      done: false,
      offers: [{ userId: 'mgr', position: 1 }],
    });
    expect(run(step, 120_000, [entry('sup'), entry('mgr', 1)])).toEqual({ done: true });
  });
  it('a small amount is covered by the first approver', () => {
    expect(run(s({ type: 'chain_by_limit' }), 10_000, [entry('sup')])).toEqual({ done: true });
  });
  it('first qualified skips straight to someone who can cover it, and asks only them', () => {
    const step = s({ type: 'first_qualified' });
    expect(run(step, 120_000)).toEqual({ done: false, offers: [{ userId: 'mgr', position: 0 }] });
    expect(run(step, 120_000, [entry('mgr')])).toEqual({ done: true });
  });
  it('fails clearly when nobody up the chain has enough limit', () => {
    const d = { ...dir(), qualifies: () => false };
    expect(() => run(s({ type: 'first_qualified' }), 1, [], d)).toThrow(NoEligibleApprover);
  });
  it('climbs past inactive approvers, and never offers the requester their own request', () => {
    expect(run(s({ type: 'chain_by_limit' }), 10_000, [], dir(['sup']))).toEqual({
      done: false,
      offers: [{ userId: 'mgr', position: 0 }],
    });
    const loop: ApproverDirectory = {
      ...dir(),
      approverOf: (u) => (u === 'clerk' ? 'clerk' : null),
    };
    expect(() => run(s({ type: 'owner_approver' }), 1, [], loop)).toThrow(NoEligibleApprover);
    expect(run(s({ type: 'owner_approver' }, { allowSelfApproval: true }), 1, [], loop)).toEqual({
      done: false,
      offers: [{ userId: 'clerk', position: 0 }],
    });
  });
  it('detects a looping chain instead of spinning', () => {
    const loop: ApproverDirectory = {
      ...dir(),
      approverOf: (u) => (u === 'clerk' ? 'x' : u === 'x' ? 'y' : 'x'),
      qualifies: () => false,
    };
    expect(() => run(s({ type: 'chain_by_limit' }), 1, [entry('x'), entry('y', 1)], loop)).toThrow(
      NoEligibleApprover,
    );
  });
  it('group "all" goes member by member; "any_one" offers everyone at once', () => {
    const all = s({ type: 'group', groupId: 'g', require: 'all' });
    expect(run(all, 1)).toEqual({ done: false, offers: [{ userId: 'a', position: 0 }] });
    expect(run(all, 1, [entry('a')])).toEqual({
      done: false,
      offers: [{ userId: 'b', position: 1 }],
    });
    expect(run(all, 1, [entry('a'), entry('b'), entry('c')])).toEqual({ done: true });
    const any = s({ type: 'group', groupId: 'g', require: 'any_one' });
    expect(run(any, 1)).toEqual({
      done: false,
      offers: [
        { userId: 'a', position: 0 },
        { userId: 'b', position: 1 },
        { userId: 'c', position: 2 },
      ],
    });
    expect(run(any, 1, [entry('b')])).toEqual({ done: true });
  });
  it('a member covered by a substitute still counts as having taken their turn', () => {
    const all = s({ type: 'group', groupId: 'g', require: 'all' });
    const covered: StepEntryRecord = {
      position: 0,
      approverUserId: 'zed',
      onBehalfOfUserId: 'a',
      status: 'approved',
    };
    expect(run(all, 1, [covered])).toEqual({ done: false, offers: [{ userId: 'b', position: 1 }] });
  });
  it('"n of": offers everyone at once, waits until enough approved, fails if it can no longer be reached', () => {
    const nOf = s({ type: 'group', groupId: 'g', require: 'n_of', count: 2 });
    expect(run(nOf, 1)).toEqual({
      done: false,
      offers: [
        { userId: 'a', position: 0 },
        { userId: 'b', position: 1 },
        { userId: 'c', position: 2 },
      ],
    });
    const open = (u: string, position: number): StepEntryRecord => ({
      position,
      approverUserId: u,
      status: 'open',
    });
    expect(run(nOf, 1, [entry('a'), open('b', 1), open('c', 2)])).toEqual({
      done: false,
      offers: [],
    });
    expect(run(nOf, 1, [entry('a'), entry('b', 1), open('c', 2)])).toEqual({ done: true });
    const canceled = (u: string, position: number): StepEntryRecord => ({
      position,
      approverUserId: u,
      status: 'canceled',
    });
    expect(() => run(nOf, 1, [entry('a'), canceled('b', 1), canceled('c', 2)])).toThrow(
      NoEligibleApprover,
    );
    const tooMany = s({ type: 'group', groupId: 'g', require: 'n_of', count: 4 });
    expect(() => run(tooMany, 1)).toThrow(NoEligibleApprover);
  });
  it('role: offers every eligible holder at once and is done after the first to act', () => {
    const d: ApproverDirectory = { ...dir(), roleMembers: () => ['clerk', 'x', 'y'] };
    const roleStep = s({ type: 'role', roleKey: 'r' });
    expect(run(roleStep, 1, [], d)).toEqual({
      done: false,
      offers: [
        { userId: 'x', position: 0 },
        { userId: 'y', position: 1 },
      ], // never the requester
    });
    expect(run(roleStep, 1, [entry('x')], d)).toEqual({ done: true });
  });
});
