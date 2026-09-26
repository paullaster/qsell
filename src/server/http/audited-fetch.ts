import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';
import { encryptCredentials } from '@/server/domains/payments/crypto';
import type { IntegrationAuditLogInsert } from '@/server/db/drizzle/schema';

interface AuditedFetchContext {
  provider: string;
  operation: string;
  correlationId?: string;
  queueCallback?: boolean;
  retentionDays?: number;
  redactHeaders?: string[];
  encryptPaths?: string[];
}

export async function auditedFetch(
  url: string,
  options: RequestInit = {},
  context: AuditedFetchContext,
): Promise<Response> {
  const correlationId = context.correlationId ?? randomUUID();
  const requestSentAt = new Date();
  const provider = context.provider;
  const operation = context.operation;
  const retentionDays = context.retentionDays ?? (isPaymentProvider(provider) ? 365 : 30);

  let requestBody: unknown = undefined;
  if (options.body) {
    try {
      requestBody = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    } catch {
      requestBody = { _raw: String(options.body).slice(0, 1000) };
    }
  }

  const requestHeaders = sanitizeHeaders(options.headers as Record<string, string>, context.redactHeaders);

  let response: Response = new Response('', { status: 500 });
  let responseBody: unknown = undefined;
  let responseHeaders: Record<string, string> = {};
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let statusCode: number | undefined;

  try {
    response = await fetch(url, options);
    statusCode = response.status;

    const cloned = response.clone();
    try {
      responseBody = await cloned.json();
    } catch {
      responseBody = { _raw: (await cloned.text()).slice(0, 1000) };
    }

    responseHeaders = sanitizeHeaders(Object.fromEntries(response.headers.entries()), context.redactHeaders);

    if (!response.ok) {
      errorCode = `HTTP_${response.status}`;
      errorMessage = `Request failed with status ${response.status}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    errorCode = 'FETCH_ERROR';
    errorMessage = msg;
    statusCode = 0;
    response = new Response(JSON.stringify({ error: msg }), { status: 500 });
  } finally {
    const responseReceivedAt = new Date();
    const durationMs = responseReceivedAt.getTime() - requestSentAt.getTime();

    const safeRequestPayload = requestBody ? encryptSensitiveFields(requestBody, context.encryptPaths) : undefined;
    const safeResponsePayload = responseBody ? encryptSensitiveFields(responseBody, context.encryptPaths) : undefined;

    const retentionUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

    const auditInsert: IntegrationAuditLogInsert = {
      correlationId,
      direction: 'outbound',
      provider,
      operation,
      requestPayload: safeRequestPayload as any,
      responsePayload: safeResponsePayload as any,
      requestHeaders,
      responseHeaders,
      httpMethod: options.method ?? 'GET',
      url: sanitizeUrl(url),
      statusCode,
      errorCode,
      errorMessage,
      durationMs,
      requestSentAt,
      responseReceivedAt,
      retentionUntil,
    };

    insertAuditLog(auditInsert).catch((err) => {
      console.error('[audit] failed to insert outbound audit log:', err);
    });

    if (context.queueCallback && response.ok) {
      enqueueCallbackProcessor(correlationId, provider, operation, responseBody as Record<string, unknown>, requestHeaders)
        .catch((err) => console.error('[audit] failed to enqueue callback:', err));
    }
  }

  return response;
}

async function insertAuditLog(values: IntegrationAuditLogInsert): Promise<void> {
  const container = getContainer();
  await container.paymentRecords.insertAuditLog(values);
}

async function enqueueCallbackProcessor(
  correlationId: string,
  provider: string,
  operation: string,
  responsePayload: Record<string, unknown>,
  requestHeaders: Record<string, string>,
): Promise<void> {
  const { enqueueWebhook } = await import('../queue/worker');
  await enqueueWebhook({
    auditId: '',
    correlationId,
    provider,
    operation,
    payload: responsePayload,
    headers: requestHeaders,
  });
}

function isPaymentProvider(provider: string): boolean {
  return ['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni', 'card_direct'].includes(provider);
}

function sanitizeHeaders(
  headers: Record<string, string> | undefined,
  extraRedact: string[] = [],
): Record<string, string> {
  if (!headers) return {};
  const redact = new Set([
    'authorization', 'cookie', 'x-api-key', 'api-key', 'x-auth-token', 'proxy-authorization',
    ...extraRedact.map((h) => h.toLowerCase()),
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = redact.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const secretParams = ['api_key', 'apikey', 'token', 'access_token', 'secret', 'password', 'signature'];
    for (const param of secretParams) {
      if (u.searchParams.has(param)) u.searchParams.set(param, '[REDACTED]');
    }
    return u.toString();
  } catch {
    return url;
  }
}

function encryptSensitiveFields(obj: unknown, paths: string[] = []): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;

  const sensitiveKeys = new Set([
    'password', 'secret', 'token', 'api_key', 'access_token', 'refresh_token',
    'card_number', 'cvv', 'pin', 'phone', 'email', 'msisdn', 'credential', 'key',
    ...paths,
  ]);

  if (Array.isArray(obj)) {
    return obj.map((item) => encryptSensitiveFields(item, paths));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (sensitiveKeys.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' ? encryptCredentials({ value: v }) : encryptCredentials({ value: JSON.stringify(v) });
    } else if (typeof v === 'object' && v !== null) {
      out[k] = encryptSensitiveFields(v, paths);
    } else {
      out[k] = v;
    }
  }
  return out;
}
