import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { decisionLog, type DecisionLogRow } from '@/server/db/drizzle/schema';
import { currentContext, type Actor } from '../context';

/** Anything with `.insert`, so a decision can be written in the caller's own transaction. */
export type DecisionWriter = Pick<DrizzleDb, 'insert'>;

export interface DecisionEntry {
  companyId: string;
  subject: { type: string; id: string };
  /** A verb phrase in `domain.event` form, e.g. "numbering.line_closed". */
  action: string;
  /** Defaults to the ambient actor. */
  actor?: Actor;
  correlationId?: string;
  causationId?: string;
  reason?: { code?: string; text?: string | null };
  policy?: { id: string; version: string };
  from?: string | null;
  to?: string | null;
  /** The values the decision was based on, as they were at the time. */
  inputs?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
}

/**
 * The append-only record of why things happened. Written by the kernel and by application
 * services, never by UI code. Pass the caller's transaction as `writer` so the decision is
 * committed (or rolled back) together with the change it describes.
 */
export class DecisionLog {
  constructor(private readonly db: DrizzleDb) {}

  async record(entry: DecisionEntry, writer: DecisionWriter = this.db): Promise<void> {
    const ctx = currentContext();
    const actor = entry.actor ?? ctx.actor;
    await writer.insert(decisionLog).values({
      companyId: entry.companyId,
      correlationId: entry.correlationId ?? ctx.correlationId,
      causationId: entry.causationId ?? null,
      subjectType: entry.subject.type,
      subjectId: entry.subject.id,
      action: entry.action,
      actorType: actor.type,
      actorId: actor.id,
      reasonCode: entry.reason?.code ?? null,
      reasonText: entry.reason?.text?.trim() || null,
      policyId: entry.policy?.id ?? null,
      policyVersion: entry.policy?.version ?? null,
      fromState: entry.from ?? null,
      toState: entry.to ?? null,
      inputs: entry.inputs ?? {},
      outcome: entry.outcome ?? {},
    });
  }

  /** Everything that happened to one subject, oldest first. */
  async timeline(subjectType: string, subjectId: string, limit = 200): Promise<DecisionLogRow[]> {
    const rows = await this.db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.subjectType, subjectType), eq(decisionLog.subjectId, subjectId)))
      .orderBy(desc(decisionLog.occurredAt))
      .limit(limit);
    return rows.reverse();
  }

  /** Everything done for one request, job or integration call, across subjects. */
  async byCorrelation(correlationId: string): Promise<DecisionLogRow[]> {
    return this.db
      .select()
      .from(decisionLog)
      .where(eq(decisionLog.correlationId, correlationId))
      .orderBy(decisionLog.occurredAt);
  }
}
