import { and, lt, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { rateLimitHits } from '@/server/db/drizzle/schema';
import { RATE_RULES, decide, scaledRule, windowStart, type RateRuleName } from '@/lib/rate-limit';

/**
 * Counts tries per key in fixed windows, in the database so every instance shares the count. One atomic upsert per try. When
 * a key starts a new window, windows older than a day are removed, so the table stays small without a separate job. If the
 * database cannot be reached the try is allowed and the failure logged: the limiter must not take the sign-in page down with it.
 */
export class RateLimitService {
  constructor(private readonly db: DrizzleDb) {}

  async hit(rule: RateRuleName, subject: string, now: Date = new Date()): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const spec = scaledRule(RATE_RULES[rule], process.env.RATE_LIMIT_SCALE, process.env.NODE_ENV === 'production');
    const nowMs = now.getTime();
    const start = new Date(windowStart(nowMs, spec.seconds) * 1000);
    const key = `${rule}:${subject.slice(0, 200)}`;
    try {
      const [row] = await this.db
        .insert(rateLimitHits)
        .values({ key, windowStart: start, hits: 1 })
        .onConflictDoUpdate({ target: [rateLimitHits.key, rateLimitHits.windowStart], set: { hits: sql`${rateLimitHits.hits} + 1` } })
        .returning({ hits: rateLimitHits.hits });
      const hits = row?.hits ?? 1;
      if (hits === 1) {
        await this.db.delete(rateLimitHits).where(and(lt(rateLimitHits.windowStart, new Date(nowMs - 86_400_000))));
      }
      return decide(hits, spec, nowMs);
    } catch (error) {
      console.error('[rate-limit] could not count a try; allowing it', { rule, error });
      return { allowed: true, retryAfterSeconds: 0 };
    }
  }
}
