export interface StatementRowBalance {
  debitCents: number;
  creditCents: number;
  runningCents: number;
}

export function statementRowBalances(
  amountCents: number[],
  openingCents: number,
): StatementRowBalance[] {
  let runningCents = openingCents;
  return amountCents.map((amountCents) => {
    runningCents += amountCents;
    return {
      debitCents: amountCents > 0 ? amountCents : 0,
      creditCents: amountCents < 0 ? -amountCents : 0,
      runningCents,
    };
  });
}

export function statementSpan(
  rows: readonly { date: string | null }[],
  fallback: { from: string; to: string },
): { from: string; to: string } {
  const dates = rows
    .map((row) => row.date)
    .filter((date): date is string => date !== null && date.trim() !== '')
    .sort();
  if (dates.length === 0) return { from: fallback.from, to: fallback.to };
  return { from: dates[0] ?? fallback.from, to: dates[dates.length - 1] ?? fallback.to };
}

export function statementDocumentNumber(
  type: string,
  documentNo: string,
  invoiceNo: string | null,
): string {
  if (type !== 'invoice') return documentNo;
  return invoiceNo === null || invoiceNo.trim() === '' ? '' : invoiceNo;
}

export function ledgerAppliedTotals(
  history: readonly { appliedToEntryId: string | null; amount: string }[],
  documentType: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of history) {
    if (row.appliedToEntryId === null) continue;
    const cents = Math.round(Number(row.amount) * 100);
    const effect = documentType === 'invoice' ? -cents : cents;
    totals.set(row.appliedToEntryId, (totals.get(row.appliedToEntryId) ?? 0) + effect);
  }
  return totals;
}
