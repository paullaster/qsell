import type { ConsideredLine, LineConfig } from './types';

export interface SelectionRequest {
  branchId: string | null;
  /** ISO business date. */
  date: string;
}

export interface Selection {
  /** Usable lines, best first. The caller takes the first one that still has numbers. */
  ranked: LineConfig[];
  /** Every line and the reason it was or was not usable. */
  considered: ConsideredLine[];
}

/**
 * Chooses which line numbers a document. A line is usable if it is open, has started, has
 * not ended, and is either for this branch or for every branch. Of the usable lines a
 * branch-specific one wins over a general one, then the one that started most recently.
 */
export function selectLines(lines: LineConfig[], req: SelectionRequest): Selection {
  const considered: ConsideredLine[] = [];
  const usable: LineConfig[] = [];

  for (const line of [...lines].sort((a, b) => a.lineNo - b.lineNo)) {
    let reason: string | null = null;
    if (!line.isOpen) reason = 'closed';
    else if (line.startsOn > req.date) reason = `starts on ${line.startsOn}`;
    else if (line.endsOn !== null && line.endsOn < req.date) reason = `ended on ${line.endsOn}`;
    else if (line.branchId !== null && line.branchId !== req.branchId)
      reason = 'for a different branch';

    if (reason) {
      considered.push({ lineNo: line.lineNo, accepted: false, reason });
    } else {
      usable.push(line);
      considered.push({
        lineNo: line.lineNo,
        accepted: true,
        reason: line.branchId ? 'open, for this branch' : 'open, for every branch',
      });
    }
  }

  usable.sort((a, b) => {
    const aSpecific = a.branchId !== null ? 1 : 0;
    const bSpecific = b.branchId !== null ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    if (a.startsOn !== b.startsOn) return a.startsOn < b.startsOn ? 1 : -1;
    return b.lineNo - a.lineNo;
  });
  return { ranked: usable, considered };
}
