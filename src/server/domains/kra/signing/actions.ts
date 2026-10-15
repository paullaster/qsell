'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import type { PageInput } from '@/server/domains/settings/paging';
import type { KraSigningEventRow } from '@/server/db/drizzle/schema';
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

const toView = (r: KraSigningEventRow): SigningEventView => {
  const p = r.payload;
  const decision = p.decision as { gates?: GateTrace[]; settings?: Record<string, unknown> } | undefined;
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
};

/** One page of documents considered for signing, newest first, each shown by its latest event. */
export async function signingDocumentsPageAction(input: PageInput & { outcome?: SigningOutcome }) {
  return runSetting('taxes:manage', async ({ companyId }) => {
    const page = await getContainer().kraSigning.pageDocuments(companyId, input);
    return { rows: page.rows.map(toView), nextCursor: page.nextCursor };
  });
}

/** Everything that happened to one document, oldest first. */
export async function signingFlowAction(documentKey: string) {
  return runSetting('taxes:manage', async ({ companyId }) => (await getContainer().kraSigning.trace(documentKey, companyId)).map(toView));
}
