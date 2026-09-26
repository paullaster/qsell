import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';
import { encryptCredentials } from '@/server/domains/payments/crypto';

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

  // 1. Persist inbound audit log immediately
  const auditId = await persistInboundAuditLog({
    correlationId,
    provider: 'mpesa_daraja',
    operation: 'stk_callback',
    rawPayload: rawBody,
    headers,
  });

  // 2. Return 200 OK immediately (M-Pesa requires fast response)
  const response = NextResponse.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  // 3. Enqueue async processing with FULL payload
  await enqueueCallbackProcessor({ auditId,
    correlationId,
    provider: 'mpesa_daraja',
    rawPayload: rawBody,
    headers,
  }).catch((err) => console.error('[mpesa] failed to enqueue callback:', err));

  return response;
}

interface InboundAuditInput {
  correlationId: string;
  provider: string;
  operation: string;
  rawPayload: string;
  headers: Record<string, string>;
}

async function persistInboundAuditLog(input: InboundAuditInput): Promise<string> {
  const container = getContainer();
  const parsed = safeJsonParse(input.rawPayload);

  const audit = await container.paymentRecords.insertAuditLog({
    correlationId: input.correlationId,
    direction: 'inbound',
    provider: input.provider,
    operation: input.operation,
    callbackPayload: parsed ? encryptCredentials({ data: parsed }) as any : undefined,
    requestHeaders: sanitizeHeaders(input.headers),
    callbackReceivedAt: new Date(),
    retentionUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year for payments
  });

  return audit.id;
}

async function enqueueCallbackProcessor(input: { auditId: string; correlationId: string; provider: string; rawPayload: string; headers: Record<string, string> }): Promise<string> {
  const { enqueuePaymentCallback } = await import('@/server/queue/worker');
  return enqueuePaymentCallback({
    auditId: input.auditId,
    correlationId: input.correlationId,
    provider: input.provider,
    rawPayload: input.rawPayload,
    headers: input.headers,
  });
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const redact = new Set(['authorization', 'cookie', 'x-api-key', 'api-key']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = redact.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}