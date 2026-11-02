/** The raw sums kept for a provider over a period, as the database adds them up. */
export interface UsageSums {
  provider: string;
  calls: number;
  failures: number;
  fallbacks: number;
  totalMs: number;
  maxMs: number;
  under500: number;
  under1000: number;
  under2500: number;
}

export interface ProviderMetrics {
  provider: string;
  calls: number;
  /** Share of calls that worked, 0 to 100, one decimal. */
  successPercent: number;
  /** Share of calls that fell back to the built-in estimate, 0 to 100. */
  fallbackPercent: number;
  averageMs: number;
  maxMs: number;
  /** Share of calls that answered inside half a second, one second and two and a half seconds (the longest a shopper is made to wait). */
  within500Percent: number;
  within1000Percent: number;
  within2500Percent: number;
}

const percent = (part: number, whole: number): number => (whole <= 0 ? 0 : Math.round((part / whole) * 1000) / 10);

export function summariseUsage(rows: readonly UsageSums[]): ProviderMetrics[] {
  return rows
    .filter((r) => r.calls > 0)
    .map((r) => ({
      provider: r.provider,
      calls: r.calls,
      successPercent: percent(r.calls - r.failures, r.calls),
      fallbackPercent: percent(r.fallbacks, r.calls),
      averageMs: Math.round(r.totalMs / r.calls),
      maxMs: r.maxMs,
      within500Percent: percent(r.under500, r.calls),
      within1000Percent: percent(r.under1000, r.calls),
      within2500Percent: percent(r.under2500, r.calls),
    }))
    .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider));
}

/** Which of the speed counters one call belongs to. Counters are cumulative: a call under 500 ms is also under 1000 and 2500. */
export function speedBuckets(ms: number): { under500: number; under1000: number; under2500: number } {
  return { under500: ms < 500 ? 1 : 0, under1000: ms < 1000 ? 1 : 0, under2500: ms < 2500 ? 1 : 0 };
}

/** The start of the hour a moment falls in. */
export const hourOf = (at: Date): Date => new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
