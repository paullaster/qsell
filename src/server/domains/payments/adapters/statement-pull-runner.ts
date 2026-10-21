import type { PlatformContext } from '../engine/types';
import type { HttpCallResult } from '../engine/http-client';
import { MAX_PULL_PAGES, type PulledLine, type StatementPullResult } from '../statement-pull';

import { has } from '@/lib/values';

export interface PullPage {
  lines: PulledLine[];
  /** How many transactions the bank sent in this page (also those that made no line). */
  count: number;
  /** What to send to ask for the page after this one; null when this is the last. */
  cursor: Record<string, unknown> | null;
  problem: string | null;
}

export interface PullPlan {
  provider: string;
  label: string;
  /** The call for a page: `cursor` is null for the first. */
  request: (cursor: Record<string, unknown> | null) => { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: unknown };
  read: (json: Record<string, unknown> | null) => PullPage;
}

/** Why a call left us without a usable answer; null when it answered well. */
export function callFailure(label: string, res: Pick<HttpCallResult, 'reached' | 'status' | 'networkError' | 'text'>): { error: string; retryable: boolean } | null {
  if (!res.reached) return { error: `${label} did not answer${has(res.networkError) ? `: ${res.networkError}` : '.'}`, retryable: true };
  if (res.status >= 500 || res.status === 429) return { error: `${label} answered ${String(res.status)}. Try again in a little while.`, retryable: true };
  if (res.status >= 400) return { error: `${label} refused the request (${String(res.status)}): ${res.text.slice(0, 200)}`, retryable: false };
  return null;
}

const fingerprint = (l: PulledLine): string => `${l.date}|${String(l.amountCents)}|${l.reference ?? ''}|${l.description}`;

/**
 * Reads a bank's statement page by page until a page comes back short or has nothing after it. Every call is made through the
 * logged caller. A bank that sends the same page again, or more pages than a pull may read, stops the pull with what was read
 * marked as cut short: the lines kept are real, and the next pull picks up the rest.
 */
export async function runPull(ctx: PlatformContext, plan: PullPlan, pageSize: number): Promise<StatementPullResult> {
  const lines: PulledLine[] = [];
  let cursor: Record<string, unknown> | null = null;
  let firstOfPrevious: string | null = null;
  for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
    const call = plan.request(cursor);
    const res = await ctx.call({ label: plan.label, provider: plan.provider, method: call.method, url: call.url, headers: call.headers, body: call.body, timeoutMs: 30_000 });
    const failure = callFailure(plan.provider, res);
    if (failure !== null) return { ok: false, ...failure };
    const got = plan.read(res.json);
    if (got.problem !== null) return { ok: false, error: got.problem, retryable: false };
    const first = got.lines[0];
    if (first !== undefined && fingerprint(first) === firstOfPrevious) {
      return { ok: false, error: `${plan.provider} sent the same page again, so the statement could not be read to its end. Nothing was kept.`, retryable: false };
    }
    firstOfPrevious = first === undefined ? null : fingerprint(first);
    lines.push(...got.lines.map((l, i) => ({ ...l, order: lines.length + i })));
    if (got.count < pageSize || got.cursor === null) return { ok: true, lines, pages: page, truncated: false };
    cursor = got.cursor;
  }
  return { ok: true, lines, pages: MAX_PULL_PAGES, truncated: true };
}
