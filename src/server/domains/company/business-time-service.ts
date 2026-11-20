import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { companySettings } from '@/server/db/drizzle/schema';
import { BUILT_IN_TIME_ZONE, offsetLabel, readTimeZone } from '@/lib/business-timezone';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { followBusinessTimeZone, formatBusinessTime } from '@/server/kernel/numbering/business-date';

/** A refusal with words for the person. */
export class BusinessTimeError extends Error {}

export interface BusinessTimeView {
  /** The zone now (an IANA name). */
  timeZone: string;
  /** How far it is from UTC today, written as UTC+03:00. */
  offset: string;
  /** What the clock reads there now, so the person can see at once whether the zone is the right one. */
  localNow: string;
  builtIn: string;
}

/**
 * The business's time zone, kept on the company row and changed only here: by someone with the `timezone:manage` permission (the
 * action checks it), with a reason from the list, in one transaction with the entry in the decision log that says who changed it from
 * what to what and why. The zone decides the day a posting, a quiet hour, a delivery window and a report period belong to, so it is
 * never changed by a side door, and a name the system cannot use is refused.
 */
export class BusinessTimeService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async view(companyId: string): Promise<BusinessTimeView> {
    const [row] = await this.db.select({ timeZone: companySettings.timezone }).from(companySettings).where(eq(companySettings.id, companyId));
    if (row === undefined) throw new BusinessTimeError('The company could not be found.');
    return this.viewOf(row.timeZone);
  }

  /** Changes the zone. Returns the screen as it now stands; the process starts using the new zone at once, the others at their next request or job. */
  async set(companyId: string, raw: unknown, actor: Actor, reason: ReasonInput): Promise<BusinessTimeView> {
    const read = readTimeZone(raw);
    if (!read.ok) throw new BusinessTimeError(read.error);
    const why = await this.reasons.require(companyId, reason, 'business_time_configuration');
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ timeZone: companySettings.timezone }).from(companySettings).where(eq(companySettings.id, companyId)).for('update');
      if (row === undefined) throw new BusinessTimeError('The company could not be found.');
      if (row.timeZone === read.timeZone) throw new BusinessTimeError(`The business time zone is already ${read.timeZone}.`);
      await tx.update(companySettings).set({ timezone: read.timeZone, updatedAt: this.clock() }).where(eq(companySettings.id, companyId));
      await this.decisions.record(
        { companyId, actor, subject: { type: 'company', id: companyId }, action: 'company.timezone_changed', from: row.timeZone, to: read.timeZone, reason: why, inputs: { timeZone: read.timeZone }, outcome: {} },
        tx,
      );
    });
    followBusinessTimeZone(read.timeZone);
    return this.viewOf(read.timeZone);
  }

  private viewOf(timeZone: string): BusinessTimeView {
    const now = this.clock();
    return { timeZone, offset: offsetLabel(timeZone, now), localNow: formatBusinessTime(now, timeZone), builtIn: BUILT_IN_TIME_ZONE };
  }
}
