import { NextResponse } from 'next/server';
import { requireUser } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { deliverStopAction, failStopAction, finishRunAction } from '@/server/domains/delivery/rider-app-actions';

const BODY_LIMIT = 64 * 1024;
const KINDS = new Set(['deliver', 'fail', 'finish']);
const NOT_SIGNED_IN = { ok: false, error: 'Sign in to use the rider app.', forbidden: true } as const;

async function sendOne(kind: string, call: Record<string, unknown>, runId: string) {
  if (kind === 'deliver') return await deliverStopAction(call);
  if (kind === 'fail') return await failStopAction(call);
  return await finishRunAction(runId);
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null);

/**
 * POST JSON: one item the rider saved at a door while offline, sent by the rider app's service worker when the phone has signal again
 * (the app itself sends through the server actions). It does exactly what those actions do, with the same answer, so the worker and the
 * app are one path to the shop and a try sent by both is one try. The phone says which rider it saved the item for; if the signed-in
 * account is not that rider the item is not sent and the answer is "sign in", so one rider's work is never sent as another's. The answer
 * is always a 200 with `{ ok, error?, code?, forbidden? }`, the way the app reads it; the status carries only transport faults.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) return NextResponse.json({ ok: false, error: 'Not allowed.' }, { status: 403 });
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) return NextResponse.json({ ok: false, error: 'Send JSON.' }, { status: 415 });
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) return NextResponse.json({ ok: false, error: 'Too large.' }, { status: 413 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Send JSON.' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) return NextResponse.json({ ok: false, error: 'Send an item.' }, { status: 400 });
  const b = body as Record<string, unknown>;
  const id = text(b.id);
  const riderId = text(b.riderId);
  const runId = text(b.runId);
  const kind = typeof b.kind === 'string' && KINDS.has(b.kind) ? b.kind : null;
  if (id === null || riderId === null || runId === null || kind === null) return NextResponse.json({ ok: false, error: 'Send an item.' }, { status: 400 });
  const deliveryId = b.deliveryId === null || b.deliveryId === undefined ? null : text(b.deliveryId);
  const photoId = b.photoId === null || b.photoId === undefined ? null : text(b.photoId);
  const payload = typeof b.payload === 'object' && b.payload !== null && !Array.isArray(b.payload) ? (b.payload as Record<string, unknown>) : {};
  if (kind !== 'finish' && deliveryId === null) return NextResponse.json({ ok: false, error: 'Send an item.' }, { status: 400 });

  try {
    const userId = await requireUser();
    const self = await getContainer().deliveryRiders.forUser(userId);
    if (self?.riderId !== riderId) return NextResponse.json(NOT_SIGNED_IN);
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return NextResponse.json(NOT_SIGNED_IN);
    throw error;
  }

  const call = { ...payload, runId, deliveryId, clientKey: id, photoId };
  const reply = await sendOne(kind, call, runId);
  return NextResponse.json(reply.ok ? { ok: true } : { ok: false, error: reply.error, code: reply.code, forbidden: reply.forbidden });
}
