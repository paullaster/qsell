import type { MpesaDarajaCredentials } from '../types';
import type { HttpCallResult } from '../engine/http-client';
import type { PlatformContext } from '../engine/types';

/** Access tokens last about an hour; a new token invalidates the previous one, so one is shared per app. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const EXPIRY_BUFFER_MS = 60_000;

export interface DarajaFailure {
  /** Safaricom's own code (errorCode or ResultCode) when it sent one. */
  code: string;
  message: string;
  /** Worth asking again with the same request (network, overload, rate limit). */
  retryable: boolean;
  /** The platform already has this request (same OriginatorConversationID). */
  duplicate: boolean;
  /** The token was refused: get a fresh one and try once more. */
  tokenRejected: boolean;
}

const TOKEN_REJECTED = new Set(['400.003.01', '401.002.01', '404.001.03', '400.008.01']);
const BUSY = new Set(['500.003.02', '500.003.03', '500.001.1001-busy']);

/** Turns a failed call into a failure we can reason about; null when the platform accepted it. */
export function darajaFailure(res: HttpCallResult): DarajaFailure | null {
  if (!res.reached) {
    return { code: 'NO_RESPONSE', message: res.networkError ?? 'No answer from Safaricom.', retryable: true, duplicate: false, tokenRejected: false };
  }
  const j = res.json ?? {};
  const errorCode = typeof j.errorCode === 'string' ? j.errorCode : null;
  const errorMessage = typeof j.errorMessage === 'string' ? j.errorMessage : null;
  if (res.status >= 200 && res.status < 300 && !errorCode) return null;
  const code = errorCode ?? (typeof j.ResponseCode === 'string' ? j.ResponseCode : `HTTP_${res.status}`);
  const message = errorMessage ?? (typeof j.ResponseDescription === 'string' ? j.ResponseDescription : `Safaricom answered ${res.status}${res.text.trim() ? `: ${res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)}` : ' with an empty body'}`);
  return {
    code,
    message,
    retryable: res.status >= 500 || res.status === 429 || BUSY.has(code),
    duplicate: code === '500.002.1001',
    tokenRejected: TOKEN_REJECTED.has(code) || (res.status === 401 && !errorCode),
  };
}

/** A client with no database logging, for the connection test (it still shares the one token cache). */
export function standaloneContext(credentials: Record<string, unknown>, apiBaseUrl: string): PlatformContext {
  return {
    companyId: '',
    provider: { apiBaseUrl } as PlatformContext['provider'],
    credentials: credentials as Record<string, string>,
    settings: {},
    publicBaseUrl: null,
    now: () => new Date(),
    call: async (input) => {
      const started = Date.now();
      try {
        const response = await fetch(input.url, { method: input.method, headers: { Accept: 'application/json', ...(input.headers ?? {}) }, signal: AbortSignal.timeout(input.timeoutMs ?? 15_000) });
        const text = await response.text().catch(() => '');
        let json: Record<string, unknown> | null = null;
        try {
          const p: unknown = text ? JSON.parse(text) : null;
          json = p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
        } catch {
          json = null;
        }
        return { reached: true, status: response.status, json, text, durationMs: Date.now() - started, networkError: null, correlationId: 'test' };
      } catch (error) {
        return { reached: false, status: 0, json: null, text: '', durationMs: Date.now() - started, networkError: error instanceof Error ? error.message : 'The call failed.', correlationId: 'test' };
      }
    },
  };
}

export class DarajaClient {
  constructor(private readonly ctx: PlatformContext) {}

  get credentials(): MpesaDarajaCredentials {
    return this.ctx.credentials as unknown as MpesaDarajaCredentials;
  }

  get baseUrl(): string {
    return this.ctx.provider.apiBaseUrl.replace(/\/$/, '');
  }

  private cacheKey(): string {
    return `${this.baseUrl}|${(this.credentials.consumerKey ?? '').trim()}`;
  }

  forgetToken() {
    tokenCache.delete(this.cacheKey());
  }

  async token(force = false): Promise<{ token: string } | { error: DarajaFailure }> {
    const key = (this.credentials.consumerKey ?? '').trim();
    const secret = (this.credentials.consumerSecret ?? '').trim();
    if (!key || !secret) return { error: { code: 'NO_CREDENTIALS', message: 'The consumer key and secret are not saved yet.', retryable: false, duplicate: false, tokenRejected: false } };
    const cached = tokenCache.get(this.cacheKey());
    if (!force && cached && cached.expiresAt > Date.now()) return { token: cached.token };
    const res = await this.ctx.call({
      label: 'oauth',
      provider: 'mpesa_daraja',
      method: 'GET',
      url: `${this.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
      timeoutMs: 15_000,
    });
    const failure = darajaFailure(res);
    const access = typeof res.json?.access_token === 'string' ? res.json.access_token : null;
    if (failure || !access) {
      tokenCache.delete(this.cacheKey());
      const blocked = res.reached && !res.text.trim();
      return {
        error: failure ?? {
          code: 'NO_TOKEN',
          message: blocked ? "Safaricom's gateway answered without a token. Check the consumer key and secret for this app and that the app is active." : 'Safaricom did not return an access token.',
          retryable: false,
          duplicate: false,
          tokenRejected: false,
        },
      };
    }
    const seconds = Number(res.json?.expires_in);
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
    tokenCache.set(this.cacheKey(), { token: access, expiresAt: Date.now() + Math.max(30_000, lifetime - EXPIRY_BUFFER_MS) });
    return { token: access };
  }

  /** An authenticated call. If Safaricom refuses the token, one fresh token is fetched and the call repeated once. */
  async request(label: string, method: 'GET' | 'POST', path: string, body: unknown, opts: { operationId?: string | null; timeoutMs?: number } = {}): Promise<HttpCallResult> {
    const send = async (token: string) =>
      await this.ctx.call({
        label,
        provider: 'mpesa_daraja',
        method,
        url: `${this.baseUrl}${path}`,
        headers: { Authorization: `Bearer ${token}` },
        body: method === 'GET' ? undefined : body,
        operationId: opts.operationId,
        timeoutMs: opts.timeoutMs,
      });
    const first = await this.token();
    if ('error' in first) return this.failedBeforeSending(first.error);
    const res = await send(first.token);
    if (darajaFailure(res)?.tokenRejected) {
      const second = await this.token(true);
      if ('error' in second) return this.failedBeforeSending(second.error);
      return await send(second.token);
    }
    return res;
  }

  private failedBeforeSending(f: DarajaFailure): HttpCallResult {
    return { reached: false, status: 0, json: null, text: '', durationMs: 0, networkError: f.message, correlationId: 'not-sent' };
  }
}
