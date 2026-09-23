/**
 * ABAC condition evaluator.
 *
 * Conditions are stored as JSON in `access_policies.condition` and evaluated
 * against a small environment: `user.*` (user attributes), `ctx.*` (request
 * context supplied by the caller), and `res.*` (subject resource attributes).
 *
 * Supported shapes (combined freely):
 *   - `{ "and": [ ...nodes ] }`   – all children must match
 *   - `{ "or": [ ...nodes ] }`    – at least one child matches
 *   - `{ "not": { ...node } }`    – negate a node
 *   - `{ "user.department": "sales" }`                    – equality leaf
 *   - `{ "ctx.grossAmount": { "gte": 10000 } }`           – operator leaf
 *   - `{ "res.status": { "in": ["open", "pending"] } }`   – set leaf
 *
 * Operators: eq, neq, gt, gte, lt, lte, in, not_in, contains, matches,
 * exists, is_null.
 *
 * This module is intentionally small, pure, and free of external deps so it
 * can be unit-tested and reused across server boundaries.
 */

export interface ConditionEnv {
  user: Record<string, unknown>;
  ctx: Record<string, unknown>;
  res: Record<string, unknown>;
}

const OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'contains',
  'matches',
  'exists',
  'is_null',
] as const;

type Operator = (typeof OPERATORS)[number];

const COMBINATORS = new Set(['and', 'or', 'not']);

function resolvePath(path: string, env: ConditionEnv): unknown {
  const dot = path.indexOf('.');
  if (dot === -1) {
    return undefined;
  }
  const rootName = path.slice(0, dot);
  let root: Record<string, unknown>;
  if (rootName === 'user') {
    root = env.user;
  } else if (rootName === 'ctx') {
    root = env.ctx;
  } else if (rootName === 'res') {
    root = env.res;
  } else {
    return undefined;
  }
  const segments = path.split('.');
  segments.shift();
  let current: unknown = root;
  for (const segment of segments) {
    if (current == null) return undefined;
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return undefined;
    current = record[segment];
  }
  return current;
}

function compareValues(actual: unknown, expected: unknown, op: Operator): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in': {
      if (!Array.isArray(expected)) return false;
      return (expected as unknown[]).some((item) => item === actual);
    }
    case 'not_in': {
      if (!Array.isArray(expected)) return false;
      return (expected as unknown[]).every((item) => item !== actual);
    }
    case 'contains': {
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return (actual as unknown[]).some((item) => item === expected);
      }
      return false;
    }
    case 'matches': {
      if (typeof actual !== 'string' || typeof expected !== 'string') return false;
      try {
        return new RegExp(expected).test(actual);
      } catch {
        return false;
      }
    }
    case 'exists': {
      const present = actual !== undefined && actual !== null;
      return expected === true ? present : !present;
    }
    case 'is_null': {
      const isNull = actual === null || actual === undefined;
      return expected === true ? isNull : !isNull;
    }
  }
}

function isOperatorNode(value: unknown): value is { op: Operator; value: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const op = record.op;
  return typeof op === 'string' && (OPERATORS as readonly string[]).includes(op);
}

export function evaluateCondition(node: ConditionEnv['user'] | null | undefined, env: ConditionEnv): boolean {
  if (node === null || node === undefined) return true;
  if (typeof node !== 'object' || Array.isArray(node)) return false;

  const entries = Object.entries(node);

  // Combinators.
  if (entries.length === 1 && COMBINATORS.has(entries[0][0])) {
    const first = entries[0] ?? ['', undefined];
    const [name, value] = first;
    if (name === 'not') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      return !evaluateCondition(value as Record<string, unknown>, env);
    }
    if (!Array.isArray(value)) return false;
    const children = value;
    if (name === 'and') {
      return children.every((child) => evaluateLeafOrNode(child, env));
    }
    if (name === 'or') {
      return children.some((child) => evaluateLeafOrNode(child, env));
    }
  }

  // Leaf: single field comparison.
  if (entries.length === 1) {
    const first = entries[0] ?? ['', undefined];
    const [field, value] = first;
    if (!COMBINATORS.has(field)) {
      return evaluateLeaf(field, value, env);
    }
  }

  return false;
}

function evaluateLeafOrNode(node: unknown, env: ConditionEnv): boolean {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
  return evaluateCondition(node as Record<string, unknown>, env);
}

function isCombinatorShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => COMBINATORS.has(key));
}

function evaluateLeaf(field: string, value: unknown, env: ConditionEnv): boolean {
  const actual = resolvePath(field, env);
  if (isOperatorNode(value)) {
    return compareValues(actual, value.value, value.op);
  }
  if (isCombinatorShape(value)) {
    return evaluateCondition(value as Record<string, unknown>, env);
  }
  // Bare value = equality.
  return compareValues(actual, value, 'eq');
}

/** Normalize a raw policy condition into a validated object (write-time guard). */
export function normalizeCondition(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid condition: expected an object');
  }
  return raw;
}