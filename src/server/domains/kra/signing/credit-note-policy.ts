import type { KraConfigSource, KraMode } from '../types';
import type { GateTrace, SigningDecision } from './types';

/** A line as it was sent to KRA for the original invoice, frozen at signing time. */
export interface FrozenInvoiceLine {
  productId: string;
  itemCode: string;
  qty: number;
  unitPrice: number;
  amount: number;
}

/** What the signing log says happened to the invoice a credit note reverses. */
export type OriginalInvoiceState =
  | {
      kind: 'signed';
      /** The scope that signed it, as recorded then. Not re-derived from today's settings. */
      scope: KraConfigSource;
      branchId: string | null;
      mode: KraMode;
      /** KRA's number for it: the one in the transmission record, not a regenerated PDF's. */
      traderInvoiceNo: string;
      transmissionId: string | null;
      currency: string;
      lines: FrozenInvoiceLine[];
    }
  | { kind: 'not_signed'; reason: string }
  | { kind: 'pending'; detail: string };

/**
 * The credit note signing policy. A credit note does not run the invoice gates again; it
 * follows its original invoice:
 *   signed        → signed, to the same gateway, whatever the switches say now (CN-4/5)
 *   not signed    → skipped: there is nothing at KRA to reverse
 *   pending/failed→ deferred until the original is signed or skipped
 * Whether that gateway can still be used is checked when sending, and a problem there is a
 * recorded failure (CN-6), never a silent fall-back.
 */
export function decideCreditNote(
  original: OriginalInvoiceState,
  extra: { originalDocumentKey: string },
): SigningDecision {
  const gates: GateTrace[] = [];
  const settings: Record<string, unknown> = { originalDocumentKey: extra.originalDocumentKey };

  if (original.kind === 'not_signed') {
    gates.push({
      gate: 'original_invoice',
      result: 'skip',
      value: original.reason,
      source: 'signing_log',
      detail:
        'The original invoice was deliberately not signed, so there is nothing at KRA to reverse.',
    });
    return decision('skip', 'ORIGINAL_NOT_SIGNED', gates, settings);
  }
  if (original.kind === 'pending') {
    gates.push({
      gate: 'original_invoice',
      result: 'skip',
      value: 'pending',
      source: 'signing_log',
      detail: original.detail,
    });
    return decision('defer', 'ORIGINAL_NOT_YET_SIGNED', gates, settings);
  }

  settings.originalTraderInvoiceNo = original.traderInvoiceNo;
  settings.originalTransmissionId = original.transmissionId;
  settings.recordedScope = original.scope;
  settings.recordedBranchId = original.branchId;
  settings.recordedMode = original.mode;
  gates.push({
    gate: 'original_invoice',
    result: 'pass',
    value: original.traderInvoiceNo,
    source: 'signing_log',
    detail: `The original invoice was signed (KRA number ${original.traderInvoiceNo}), so its credit note must be signed.`,
  });
  gates.push({
    gate: 'original_scope',
    result: 'pass',
    value: { scope: original.scope, branchId: original.branchId },
    source: 'original_signing_record',
    detail:
      'Goes to the same gateway that signed the original, using the settings recorded then rather than the branch’s current independence. Module and customer switches do not apply.',
  });
  gates.push({
    gate: 'original_mode',
    result: 'pass',
    value: original.mode,
    source: 'original_signing_record',
    detail: `The original was signed with ${original.mode === 'etims' ? 'eTIMS' : 'TIMS'}; the credit note must use the same mode.`,
  });
  return {
    outcome: 'sign',
    reason: 'SIGN',
    scope: original.scope,
    branchId: original.branchId,
    mode: original.mode,
    gates,
    settings,
  };
}

function decision(
  outcome: SigningDecision['outcome'],
  reason: SigningDecision['reason'],
  gates: GateTrace[],
  settings: Record<string, unknown>,
): SigningDecision {
  return { outcome, reason, scope: null, branchId: null, mode: null, gates, settings };
}
