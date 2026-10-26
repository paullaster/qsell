import { firstFilled, orElse } from '@/lib/values';
import { POLICY_LIMITS, type PolicyPage } from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** A title made into an address part: lowercase letters, digits and single dashes. */
export function policySlug(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, POLICY_LIMITS.slug)
    .replace(/-+$/g, '');
}

/** Where a policy page lives. */
export const policyAddress = (page: Pick<PolicyPage, 'slug'>): string => `/policies/${page.slug}`;

/**
 * Normalises stored or submitted policy pages. Pages without a title or text are dropped, a missing or invalid
 * address is made from the title, and two pages never share an address. Never throws.
 */
export function resolvePolicies(raw: unknown): PolicyPage[] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set<string>();
  const out: PolicyPage[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) continue;
    const title = text(item.title, POLICY_LIMITS.title);
    const body = text(item.body, POLICY_LIMITS.body);
    if (title === '' || body === '') continue;
    const base = firstFilled(policySlug(text(item.slug, POLICY_LIMITS.slug)), policySlug(title)) ?? 'policy';
    let slug = base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base.slice(0, POLICY_LIMITS.slug - 4)}-${String(n)}`;
    taken.add(slug);
    out.push({ id: orElse(text(item.id, 64), `policy-${String(index)}`), slug, title, body });
    if (out.length >= POLICY_LIMITS.pages) break;
  }
  return out;
}

export type PolicyBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

/** The policy text as blocks to draw. Everything stays text: nothing in the body is ever treated as markup. */
export function parsePolicyBody(body: string): PolicyBlock[] {
  const blocks: PolicyBlock[] = [];
  for (const chunk of body.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
    let paragraph: string[] = [];
    let list: string[] = [];
    const flush = () => {
      if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      if (list.length > 0) blocks.push({ kind: 'list', items: list });
      paragraph = [];
      list = [];
    };
    for (const line of lines) {
      const heading = /^#{1,3}\s+(.*\S)\s*$/.exec(line);
      const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
      if (heading?.[1] !== undefined) {
        flush();
        blocks.push({ kind: 'heading', text: heading[1] });
      } else if (item?.[1] !== undefined) {
        if (paragraph.length > 0) flush();
        list.push(item[1]);
      } else {
        if (list.length > 0) flush();
        paragraph.push(line.trim());
      }
    }
    flush();
  }
  return blocks;
}
