import { describe, expect, it } from 'vitest';
import { nth } from '@/lib/values';
import type { TriggerField } from '@/server/kernel/approvals/domain/triggers';
import type { Comparison } from '@/server/kernel/approvals/domain/types';
import {
  newWorkflowPayload, effectiveSwitch, parseScope, scopeId, switchQuestion,
  asRoot, blankFor, blankStep, buildFacts, comparedField, comparisonChoices, extraFields, generalIssues, groupPayload, isGroup, issuesOfStep, limitsFrom, metaPayload,
  moveMember, moveStep, parseList, profilePayload, removeAt, renumber, replaceAt, ruleOfType, statusChangedWords, withComparedField, withField, withOp,
} from './approval-forms';

const amount: TriggerField = { path: 'amount', label: 'Amount', type: 'number' };
const city: TriggerField = { path: 'customer.city', label: 'City', type: 'text' };
const flag: TriggerField = { path: 'belowFloor', label: 'Below floor', type: 'boolean' };
const other: TriggerField = { path: 'discountPercent', label: 'Discount', type: 'number' };

describe('conditions', () => {
  it('starts a comparison to suit the field', () => {
    expect(blankFor(amount)).toEqual({ op: 'gt', field: 'amount', value: 0 });
    expect(blankFor(city)).toEqual({ op: 'eq', field: 'customer.city', value: '' });
    expect(blankFor(flag)).toEqual({ op: 'eq', field: 'belowFloor', value: true });
  });
  it('offers the comparisons for each kind of field', () => {
    expect(comparisonChoices('boolean').map((c) => c.id)).toEqual(['eq', 'ne']);
    expect(comparisonChoices('number').map((c) => c.id)).toContain('between');
    expect(comparisonChoices('text').map((c) => c.id)).toContain('contains');
  });
  it('turns one comparison into a group of one, and nothing into nothing', () => {
    expect(asRoot(undefined)).toBeNull();
    expect(asRoot({ op: 'gt', field: 'amount', value: 1 })).toEqual({ op: 'and', children: [{ op: 'gt', field: 'amount', value: 1 }] });
    const group = { op: 'or' as const, children: [] };
    expect(asRoot(group)).toBe(group);
    expect(isGroup(group)).toBe(true);
  });
  it('keeps a row when the new field suits it, else starts afresh', () => {
    const row: Comparison = { op: 'gt', field: 'amount', value: 5 };
    expect(withField(row, amount, other)).toEqual({ op: 'gt', field: 'discountPercent', value: 5 });
    expect(withField(row, amount, city)).toEqual(blankFor(city));
    expect(withField({ op: 'between', field: 'amount', value: [1, 2] }, amount, other)).toMatchObject({ field: 'discountPercent' });
  });
  it('gives a new comparison a value that suits it', () => {
    const row: Comparison = { op: 'gt', field: 'amount', value: 7 };
    expect(withOp(row, 'between', 'number')).toEqual({ op: 'between', field: 'amount', value: [0, 0] });
    expect(withOp(row, 'in', 'number')).toEqual({ op: 'in', field: 'amount', value: [] });
    expect(withOp(row, 'exists', 'number')).toEqual({ op: 'exists', field: 'amount', value: true });
    expect(withOp(row, 'contains', 'text')).toEqual({ op: 'contains', field: 'amount', value: '' });
    expect(withOp(row, 'gte', 'number')).toEqual({ op: 'gte', field: 'amount', value: 7 });
    expect(withOp({ op: 'in', field: 'x', value: ['a'] }, 'eq', 'text')).toEqual({ op: 'eq', field: 'x', value: '' });
  });
  it('compares with another field or with a value', () => {
    const row: Comparison = { op: 'gt', field: 'amount', value: 0 };
    const against = withComparedField(row, true, 'number', 'discountPercent');
    expect(comparedField(against)).toBe('discountPercent');
    expect(comparedField(withComparedField(against, false, 'number', undefined))).toBeNull();
    expect(withComparedField(row, false, 'text', undefined)).toMatchObject({ value: '' });
  });
  it('reads lists typed with commas', () => {
    expect(parseList('a, b ,, c', false)).toEqual(['a', 'b', 'c']);
    expect(parseList('1, 2, x', true)).toEqual([1, 2, 'x']);
  });
  it('replaces and removes by position without touching the original', () => {
    const items = ['a', 'b', 'c'];
    expect(replaceAt(items, 1, 'x')).toEqual(['a', 'x', 'c']);
    expect(removeAt(items, 0)).toEqual(['b', 'c']);
    expect(items).toEqual(['a', 'b', 'c']);
  });
});

describe('steps', () => {
  it('numbers steps from one and moves them without gaps', () => {
    const steps = renumber([blankStep(9), blankStep(9), blankStep(9)]);
    expect(steps.map((s) => s.sequence)).toEqual([1, 2, 3]);
    const moved = moveStep([{ ...nth(steps, 0), name: 'A' }, { ...nth(steps, 1), name: 'B' }], 0, 1);
    expect(moved.map((s) => `${String(s.sequence)}${s.name}`)).toEqual(['1B', '2A']);
    expect(moveStep(steps, 0, -1)).toHaveLength(3);
    expect(moveStep(steps, 2, 1).map((s) => s.sequence)).toEqual([1, 2, 3]);
  });
  it('makes a fresh rule with the fields its type needs', () => {
    expect(ruleOfType('user')).toEqual({ type: 'user', userId: '' });
    expect(ruleOfType('group')).toEqual({ type: 'group', groupId: '', require: 'all' });
    expect(ruleOfType('role')).toEqual({ type: 'role', roleKey: '' });
    expect(ruleOfType('chain_by_limit')).toEqual({ type: 'chain_by_limit' });
  });
  it('sorts problems into the step they belong to', () => {
    const issues = [{ path: 'steps[0]', message: 'a' }, { path: 'steps[0].approver', message: 'b' }, { path: 'steps[1]', message: 'c' }, { path: 'conditions', message: 'd' }];
    expect(issuesOfStep(issues, 0).map((i) => i.message)).toEqual(['a', 'b']);
    expect(issuesOfStep(issues, 10)).toEqual([]);
    expect(generalIssues(issues).map((i) => i.message)).toEqual(['d']);
  });
  it('words a status change', () => {
    expect(statusChangedWords('enabled')).toBe('Turned on.');
    expect(statusChangedWords('retired')).toBe('Retired.');
    expect(statusChangedWords('disabled')).toMatch(/Turned off/);
  });
  it('defaults the order to 100 and drops an empty branch', () => {
    expect(metaPayload({ name: 'n', description: 'd', priority: 0 }, '')).toEqual({ name: 'n', description: 'd', priority: 100, branchId: null });
    expect(metaPayload({ name: 'n', description: 'd', priority: 5 }, 'b1')).toMatchObject({ priority: 5, branchId: 'b1' });
  });
});

describe('the "try it" facts', () => {
  it('nests dotted names and converts values by kind', () => {
    const facts = buildFacts([amount, city, flag, { path: 'customer.id', label: 'Customer', type: 'text' }], { 'customer.city': 'Nairobi', 'customer.id': 'c1', belowFloor: 'true', amount: '5' });
    expect(facts).toEqual({ customer: { city: 'Nairobi', id: 'c1' }, belowFloor: true, amount: 5 });
  });
  it('leaves out what was not typed', () => {
    expect(buildFacts([amount, city], { amount: '', 'customer.city': undefined as never })).toEqual({});
  });
  it('asks for the fields that have no input of their own', () => {
    expect(extraFields([amount, { path: 'branchId', label: 'Branch', type: 'text' }, city]).map((f) => f.path)).toEqual(['customer.city']);
  });
});

describe('approver settings', () => {
  const kinds = ['sales_order', 'credit_note'];
  const form = { approverUserId: '', substituteUserId: '', substituteFrom: '2026-01-01', substituteTo: '2026-02-01', isActive: true };
  it('fills the limits from the saved ones', () => {
    expect(limitsFrom(kinds, [{ documentKind: 'sales_order', maxAmount: 500, unlimited: false }])).toEqual({ sales_order: { mode: 'up_to', amount: '500' }, credit_note: { mode: 'none', amount: '' } });
    expect(limitsFrom(kinds, [{ documentKind: 'credit_note', maxAmount: null, unlimited: true }]).credit_note).toEqual({ mode: 'unlimited', amount: '' });
  });
  it('sends only the limits that are set, and refuses an "up to" without an amount', () => {
    const ok = profilePayload('u1', form, kinds, { sales_order: { mode: 'up_to', amount: '100' }, credit_note: { mode: 'unlimited', amount: '' } });
    expect(ok).toMatchObject({ ok: true, payload: { userId: 'u1', approverUserId: null, limits: [{ documentKind: 'sales_order', maxAmount: 100, unlimited: false }, { documentKind: 'credit_note', maxAmount: null, unlimited: true }] } });
    expect(profilePayload('u1', form, kinds, { sales_order: { mode: 'up_to', amount: '' }, credit_note: { mode: 'none', amount: '' } })).toMatchObject({ ok: false });
    expect(profilePayload('u1', form, kinds, { sales_order: { mode: 'up_to', amount: '-3' }, credit_note: { mode: 'none', amount: '' } })).toMatchObject({ ok: false });
  });
  it('keeps the cover dates only when someone covers', () => {
    const none = profilePayload('u1', form, kinds, {});
    expect(none).toMatchObject({ payload: { substituteFrom: null, substituteTo: null } });
    const covered = profilePayload('u1', { ...form, substituteUserId: 'u2' }, kinds, {});
    expect(covered).toMatchObject({ payload: { substituteUserId: 'u2', substituteFrom: '2026-01-01', substituteTo: '2026-02-01' } });
  });
  it('orders a group and checks it', () => {
    expect(moveMember(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveMember(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(groupPayload(undefined, { code: ' fin ', name: ' Finance ' }, ['a'])).toEqual({ ok: true, payload: { code: 'FIN', name: 'Finance', memberUserIds: ['a'] } });
    expect(groupPayload('g1', { code: 'X', name: 'Y' }, [])).toMatchObject({ ok: true, payload: { id: 'g1' } });
    expect(groupPayload(undefined, { code: '', name: 'Y' }, [])).toMatchObject({ ok: false });
  });
});

describe('switches', () => {
  const list = [
    { module: 'sales', trigger: null, branchId: null, enabled: false },
    { module: 'sales', trigger: 'sales_order.submitted', branchId: null, enabled: true },
    { module: 'pricing', trigger: null, branchId: 'b1', enabled: false },
  ];
  it('is on unless it was turned off', () => {
    expect(effectiveSwitch([], 'sales', null)).toEqual({ on: true, inherited: true });
    expect(effectiveSwitch(list, 'sales', null)).toEqual({ on: false, inherited: false });
  });
  it('lets a situation follow its area unless it was set separately', () => {
    expect(effectiveSwitch(list, 'sales', 'sales_quote.submitted')).toEqual({ on: false, inherited: true });
    expect(effectiveSwitch(list, 'sales', 'sales_order.submitted')).toEqual({ on: true, inherited: false });
  });
  it('ignores a branch exception when reading the company-wide state', () => {
    expect(effectiveSwitch(list, 'pricing', null)).toEqual({ on: true, inherited: true });
  });
  it('turns a scope into an id and back', () => {
    expect(scopeId('sales', null)).toBe('sales|');
    expect(parseScope('sales|')).toEqual({ module: 'sales', trigger: null });
    expect(parseScope(scopeId('sales', 'sales_order.submitted'))).toEqual({ module: 'sales', trigger: 'sales_order.submitted' });
    expect(parseScope('|x')).toBeNull();
  });
  it('asks the question in words', () => {
    expect(switchQuestion({ enabled: false, areaLabel: 'Sales', triggerLabel: null, branchLabel: null })).toBe('Turn approvals off for all of Sales?');
    expect(switchQuestion({ enabled: true, areaLabel: 'Sales', triggerLabel: 'Quote submitted', branchLabel: 'Nairobi' })).toBe('Turn approvals on for Quote submitted at Nairobi?');
  });
});

describe('newWorkflowPayload', () => {
  it('keeps codes in capitals and drops an empty branch', () => {
    expect(newWorkflowPayload({ code: ' so-big ', name: ' Big ' }, 'sales_order.submitted', '')).toEqual({ ok: true, payload: { code: 'SO-BIG', name: 'Big', trigger: 'sales_order.submitted', branchId: null } });
  });
  it('needs a name, a good code and a trigger', () => {
    expect(newWorkflowPayload({ code: 'A', name: '' }, 'x', null)).toMatchObject({ ok: false });
    expect(newWorkflowPayload({ code: 'bad code', name: 'n' }, 'x', null)).toMatchObject({ ok: false });
    expect(newWorkflowPayload({ code: 'A', name: 'n' }, null, null)).toMatchObject({ ok: false });
  });
});
