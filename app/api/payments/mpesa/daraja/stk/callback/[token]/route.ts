import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';

/**
 * M-Pesa Daraja STK Push Callback - Async Pattern
 *
 * 1. Persist raw callback to integration_audit_log immediately
 * 2. Return 200 OK to M-Pesa (required within 10s)
 * 3. Enqueue graphile-worker job for async processing
 * 4. Worker handles reconciliation, inventory fulfilment, notifications
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;

  // Basic token validation (extend as needed)
  if (!token || token.length < 10) {
    return NextResponse.json(
      { ResultCode: 1, ResultDesc: 'Invalid callback token' },
      { status: 401 },
    );
  }

  const correlationId = randomUUID();
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const parsedPayload = safeJsonParse(rawBody);
  const receivedPayload = parsedPayload ?? { raw: rawBody };
  const container = getContainer();

  // Persist the callback receipt before acknowledging the provider. The worker
  // updates this same receipt with its processing outcome.
  const auditId = await persistInboundAuditLog({
    correlationId,
    provider: 'mpesa_daraja',
    operation: 'stk_callback',
    httpMethod: req.method,
    url: req.url,
    headers,
    payload: sanitizePayload(receivedPayload) as Record<string, unknown>,
  });
  const attempt = await container.paymentAttempts.getByCallbackToken(token);
  const receipt = await container.paymentAttempts.recordCallbackEvent({
    paymentAttemptId: attempt?.id ?? null,
    callbackToken: token,
    providerCode: 'mpesa_daraja',
    httpMethod: req.method,
    headers: sanitizeHeaders(headers),
    rawBody: receivedPayload,
    processingStatus: attempt ? 'received' : 'unmatched_token',
    outcome: 'unclassified',
    processingError: attempt ? null : 'No payment attempt for callback token',
  });

  // Only acknowledge after Graphile has durably accepted the job. If enqueueing
  // fails, return a retryable response rather than silently losing the callback.
  try {
    const jobId = await enqueueCallbackProcessor({
      auditId,
      correlationId,
      provider: 'mpesa_daraja',
      callbackToken: token,
      callbackEventId: receipt.id,
      rawPayload: rawBody,
      headers: sanitizeHeaders(headers),
    });
    await getContainer().paymentRecords.updateAuditLog(auditId, {
      queueJobId: jobId,
      statusCode: 200,
      responseReceivedAt: new Date(),
      responsePayload: { accepted: true, queueJobId: jobId, state: 'queued' },
    });
  } catch (err) {
    console.error('[mpesa] failed to enqueue callback:', err);
    await getContainer().paymentRecords.updateAuditLog(auditId, {
      statusCode: 503,
      responseReceivedAt: new Date(),
      errorCode: 'CALLBACK_ENQUEUE_FAILED',
      errorMessage: err instanceof Error ? err.message : 'Could not queue payment callback',
      responsePayload: { accepted: false, state: 'enqueue_failed' },
    });
    return NextResponse.json(
      { ResultCode: 1, ResultDesc: 'Callback could not be queued' },
      { status: 503 },
    );
  }

  return NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}

interface InboundAuditInput {
  correlationId: string;
  provider: string;
  operation: string;
  httpMethod: string;
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

async function persistInboundAuditLog(input: InboundAuditInput): Promise<string> {
  const container = getContainer();
  const audit = await container.paymentRecords.insertAuditLog({
    correlationId: input.correlationId,
    direction: 'inbound',
    provider: input.provider,
    operation: input.operation,
    httpMethod: input.httpMethod,
    url: input.url,
    callbackPayload: input.payload,
    requestHeaders: sanitizeHeaders(input.headers),
    callbackReceivedAt: new Date(),
    retentionUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year for payments
  });

  return audit.id;
}

async function enqueueCallbackProcessor(input: {
  auditId: string;
  correlationId: string;
  provider: string;
  callbackToken: string;
  callbackEventId: string;
  rawPayload: string;
  headers: Record<string, string>;
}): Promise<string> {
  const { enqueuePaymentCallback } = await import('@/server/queue/worker');
  return enqueuePaymentCallback({
    auditId: input.auditId,
    correlationId: input.correlationId,
    provider: input.provider,
    callbackToken: input.callbackToken,
    callbackEventId: input.callbackEventId,
    rawPayload: input.rawPayload,
    headers: input.headers,
  });
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sanitizePayload(value: unknown, parent?: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const isPhoneValue = String(record.Name ?? parent?.Name ?? '').toLowerCase() === 'phonenumber';
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      const sensitiveKey = /phone(number)?|password|secret|token/i.test(key);
      return [
        key,
        (isPhoneValue && key === 'Value') || sensitiveKey
          ? '[REDACTED]'
          : sanitizePayload(item, record),
      ];
    }),
  );
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const redact = new Set(['authorization', 'cookie', 'x-api-key', 'api-key']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = redact.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}
