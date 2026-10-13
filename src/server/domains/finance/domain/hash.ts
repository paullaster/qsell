import { createHash } from 'node:crypto';

export interface RegisterFacts {
  companyId: string;
  chainKey: string;
  seq: number;
  idempotencyKey: string;
  postingDate: string;
  currency: string;
  totalDebit: string;
  totalCredit: string;
  lineCount: number;
  /** The lines in order: account, debit, credit, dimension set. */
  lines: { accountId: string; debit: string; credit: string; dimensionSetId: string | null }[];
  reversalOf: string | null;
}

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Hash of one register, chained to the previous register of the same chain. Any later change to
 * a register, or the removal of one from the middle of a chain, makes the verification job fail.
 * Field order is fixed and values are length-prefixed so two different registers cannot produce
 * the same input text.
 */
export function registerHash(previousHash: string, f: RegisterFacts): string {
  const parts = [
    previousHash,
    f.companyId,
    f.chainKey,
    String(f.seq),
    f.idempotencyKey,
    f.postingDate,
    f.currency,
    f.totalDebit,
    f.totalCredit,
    String(f.lineCount),
    f.reversalOf ?? '',
    ...f.lines.flatMap((l) => [l.accountId, l.debit, l.credit, l.dimensionSetId ?? '']),
  ];
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(`${p.length}:`);
    h.update(p);
  }
  return h.digest('hex');
}
