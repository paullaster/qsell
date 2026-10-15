import type { Comparison, ConditionNode, ConditionTrace, Operand } from './types';

import { compareValues } from '@/lib/values';

/** Reads `a.b.c` from a document snapshot. Missing paths are `undefined`. */
export function readField(snapshot: Record<string, unknown>, path: string): unknown {
  let current: unknown = snapshot;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolve(snapshot: Record<string, unknown>, operand: Operand): unknown {
  return operand !== null && typeof operand === 'object'
    ? readField(snapshot, operand.field)
    : operand;
}

/** Numbers and numeric strings compare as numbers; everything else compares as given. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Whether an ordering comparison holds, given how the two values compare (negative, zero or positive). */
function orderHolds(op: 'gt' | 'gte' | 'lt' | 'lte', c: number): boolean {
  if (op === 'gt') return c > 0;
  if (op === 'gte') return c >= 0;
  return op === 'lt' ? c < 0 : c <= 0;
}

function compare(a: unknown, b: unknown): number | null {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x !== null && y !== null) return x - y;
  if (typeof a === 'string' && typeof b === 'string') return compareValues(a, b);
  return null;
}

/**
 * Evaluates a condition on a document snapshot. A comparison with a missing or incomparable value
 * is false (never an error), so a typo can make a workflow stop matching but never crash a sale;
 * validation catches unknown fields before a workflow is published.
 */
export function evaluateCondition(
  node: ConditionNode | undefined,
  snapshot: Record<string, unknown>,
  trace: ConditionTrace[] = [],
): boolean {
  if (node === undefined) return true;
  const record = (label: string, result: boolean, detail?: string) => {
    trace.push({ node: label, result, detail });
    return result;
  };
  switch (node.op) {
    case 'and': {
      const results = node.children.map((c) => evaluateCondition(c, snapshot, trace));
      return record('and', results.every(Boolean));
    }
    case 'or': {
      const results = node.children.map((c) => evaluateCondition(c, snapshot, trace));
      return record('or', results.some(Boolean));
    }
    case 'not':
      return record('not', !evaluateCondition(node.child, snapshot, trace));
    case 'exists': {
      const v = readField(snapshot, node.field);
      const present = v !== undefined && v !== null && v !== '';
      return record(`${node.field} exists`, present === node.value);
    }
    case 'in':
    case 'not_in': {
      const v = readField(snapshot, node.field);
      const found = node.value.some((o) => compare(v, o) === 0);
      return record(`${node.field} ${node.op}`, node.op === 'in' ? found : !found, String(v));
    }
    case 'between': {
      const v = readField(snapshot, node.field);
      const lo = compare(v, node.value[0]);
      const hi = compare(v, node.value[1]);
      return record(
        `${node.field} between`,
        lo !== null && hi !== null && lo >= 0 && hi <= 0,
        String(v),
      );
    }
    case 'contains': {
      const v = readField(snapshot, node.field);
      return record(
        `${node.field} contains`,
        typeof v === 'string' && v.toLowerCase().includes(node.value.toLowerCase()),
      );
    }
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cmp = node;
      const left = readField(snapshot, cmp.field);
      const right = resolve(snapshot, cmp.value);
      const c = compare(left, right);
      let result = false;
      if (cmp.op === 'eq') result = c === 0 || (c === null && left === right && left !== undefined);
      else if (cmp.op === 'ne')
        result = !(c === 0 || (c === null && left === right && left !== undefined));
      else if (c !== null) {
        result =
          orderHolds(cmp.op, c);
      }
      return record(`${cmp.field} ${cmp.op}`, result, `${String(left)} vs ${String(right)}`);
    }
  }
}

/** Every field a condition reads, for validating against a trigger's field catalogue. */
export function fieldsUsed(node: ConditionNode | undefined, into = new Set<string>()): Set<string> {
  if (!node) return into;
  if (node.op === 'and' || node.op === 'or') node.children.forEach((c) => fieldsUsed(c, into));
  else if (node.op === 'not') fieldsUsed(node.child, into);
  else {
    const leaf = node as Comparison;
    into.add(leaf.field);
    const value = (node as { value?: unknown }).value;
    if (value !== null && typeof value === 'object' && 'field' in (value)) {
      into.add((value as { field: string }).field);
    }
  }
  return into;
}
