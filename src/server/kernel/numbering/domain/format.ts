import { renderTemplate, type RenderContext } from './template';
import type { LineConfig } from './types';

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

/** The next sequence number after `last` (null: nothing issued yet in this counter). */
export function nextSequence(
  last: number | null,
  line: Pick<LineConfig, 'startNo' | 'increment'>,
): number {
  return last === null ? line.startNo : last + line.increment;
}

/** True when `seq` is beyond the end of the line's range (or no longer fits its digits). */
export function isBeyondEnd(seq: number, line: Pick<LineConfig, 'endNo' | 'digits'>): boolean {
  if (line.endNo !== null && seq > line.endNo) return true;
  return seq >= 10 ** line.digits;
}

export function formatNumber(
  line: Pick<LineConfig, 'prefix' | 'suffix' | 'digits'>,
  seq: number,
  ctx: RenderContext,
): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new FormatError(`Sequence ${seq} is not valid.`);
  if (seq >= 10 ** line.digits) {
    throw new FormatError(`Sequence ${seq} does not fit in ${line.digits} digits.`);
  }
  return (
    renderTemplate(line.prefix, ctx) +
    String(seq).padStart(line.digits, '0') +
    renderTemplate(line.suffix, ctx)
  );
}
