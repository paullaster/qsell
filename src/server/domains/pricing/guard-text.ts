import type { GuardTrace } from './domain/types';

/** Lines for an approver: which products were flagged by the price checks, and by how much. */
export function guardLines(
  rows: Array<{ name: string; guard: GuardTrace | null | undefined }>,
  max = 6,
): string[] {
  const out: string[] = [];
  for (const { name, guard } of rows) {
    if (!guard) continue;
    if (guard.belowFloor)
      out.push(
        `${name}: ${guard.shortfallPercent}% below its price floor (${guard.floorNet?.toFixed(2)} before tax; ${guard.floorSource ?? 'floor'}).`,
      );
    if (guard.overOverrideLimit)
      out.push(
        `${name}: price taken ${guard.overridePercent}% below list, over the ${guard.overrideLimitPercent}% limit.`,
      );
  }
  return out.length > max ? [...out.slice(0, max), `…and ${out.length - max} more.`] : out;
}
