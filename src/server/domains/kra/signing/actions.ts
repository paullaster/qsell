'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import type { GateTrace, SigningOutcome, SigningReason } from './types';

export interface SigningEventView {
  id: string;
  documentKey: string;
  documentType: string;
  documentId: string;
  documentRef: string | null;
  module: string;
  eventType: 'decision' | 'transmission';
  outcome: SigningOutcome;
  reason: SigningReason;
  scope: 'company' | 'branch' | null;
  mode: 'tims' | 'etims' | null;
  branchId: string | null;
  gates: GateTrace[];
  settings: Record<string, unknown>;
  error: string | null;
  scuReceiptNo: string | null;
  verificationUrl: string | null;
  transmissionId: string | null;
  createdAt: string;
}

/** Newest first. Each document's full flow is these events in reverse. */
export async function listSigningEventsAction(
  input: { outcome?: SigningOutcome; limit?: number } = {},
): Promise<SigningEventView[]> {
  await requirePermission('taxes:manage');
  const rows = await getContainer().kraSigning.recent(input);
  return rows.map((r) => {
    const p = r.payload as Record<string, unknown>;
    const decision = p.decision as
      { gates?: GateTrace[]; settings?: Record<string, unknown> } | undefined;
    return {
      id: r.id,
      documentKey: r.documentKey,
      documentType: r.documentType,
      documentId: r.documentId,
      documentRef: r.documentRef,
      module: r.module,
      eventType: r.eventType,
      outcome: r.outcome,
      reason: r.reason,
      scope: r.scope,
      mode: r.mode,
      branchId: r.branchId,
      gates: (p.gates as GateTrace[] | undefined) ?? decision?.gates ?? [],
      settings: (p.settings as Record<string, unknown> | undefined) ?? decision?.settings ?? {},
      error: typeof p.error === 'string' ? p.error : null,
      scuReceiptNo: typeof p.scuReceiptNo === 'string' ? p.scuReceiptNo : null,
      verificationUrl: typeof p.verificationUrl === 'string' ? p.verificationUrl : null,
      transmissionId: r.transmissionId,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
