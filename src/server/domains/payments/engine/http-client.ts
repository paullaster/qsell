import { randomUUID } from 'node:crypto';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { integrationAuditLog } from '@/server/db/drizzle/schema';
import { redactDeep, redactHeaders, redactUrl } from './redact';

import { has } from '@/lib/has';
import { orElse } from '@/lib/values';

export interface HttpCallInput {
  companyId: string;
  providerId: string;
  operationId?: string | null;
  /** What this call is for, shown in the log ("stk_push", "oauth", "transaction_status"...). */
  label: string;
  provider: string;
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  correlationId?: string;
}

export interface HttpCallResult {
  /** The platform answered (with any status). False only when nothing came back. */
  reached: boolean;
  status: number;
  json: Record<string, unknown> | null;
  text: string;
  durationMs: number;
  /** Set when nothing came back: timeout, DNS, refused, reset. */
  networkError: string | null;
  correlationId: string;
}

const MAX_LOGGED_TEXT = 8000;

/**
 * Every call to a payment platform: sent with a deadline, never throwing for what the platform
 * says, and recorded (redacted) with how long it took and how it ended. A failure to write the log
 * never hides the answer, and a failure of the platform never loses the record.
 */
export async function loggedCall(
  db: DrizzleDb,
  input: HttpCallInput,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<HttpCallResult> {
  const correlationId = input.correlationId ?? randomUUID();
  const started = Date.now();
  const sentAt = new Date();
  let res: HttpCallResult;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000);
  try {
    const response = await fetchImpl(input.url, {
      method: input.method,
      headers: { Accept: 'application/json', ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(input.headers ?? {}) },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = has(text) ? JSON.parse(text) : null;
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : parsed === null ? null : { value: parsed };
    } catch {
      json = null;
    }
    res = { reached: true, status: response.status, json, text, durationMs: Date.now() - started, networkError: null, correlationId };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    res = {
      reached: false,
      status: 0,
      json: null,
      text: '',
      durationMs: Date.now() - started,
      networkError: aborted ? `No answer within ${Math.round((input.timeoutMs ?? 20_000) / 1000)} seconds.` : error instanceof Error ? error.message.slice(0, 300) : 'The call failed.',
      correlationId,
    };
  } finally {
    clearTimeout(timer);
  }
  try {
    await db.insert(integrationAuditLog).values({
      correlationId,
      direction: 'outbound',
      provider: input.provider,
      operation: input.label,
      requestPayload: input.body === undefined ? null : (redactDeep(input.body) as Record<string, unknown>),
      responsePayload: res.json ? (redactDeep(res.json) as Record<string, unknown>) : has(res.text) ? { text: res.text.slice(0, MAX_LOGGED_TEXT) } : null,
      requestHeaders: redactHeaders(input.headers ?? {}),
      httpMethod: input.method,
      url: redactUrl(input.url),
      statusCode: res.reached ? res.status : null,
      errorCode: res.reached ? (res.status >= 400 ? `HTTP_${res.status}` : null) : 'NO_RESPONSE',
      errorMessage: res.networkError ?? (res.reached && res.status >= 400 ? (orElse(res.text, '')).slice(0, 500) : null),
      durationMs: res.durationMs,
      requestSentAt: sentAt,
      responseReceivedAt: res.reached ? new Date() : null,
      providerId: input.providerId,
      operationId: input.operationId ?? null,
      retentionUntil: new Date(Date.now() + 400 * 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    console.error('[payments] could not write the call log', error);
  }
  return res;
}
