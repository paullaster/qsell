import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { providerEvents, type ProviderEventRow, type ProviderEventState } from '@/server/db/drizzle/schema';
import { bodyHash, ipAllowed, redactDeep, redactHeaders } from './redact';
import type { EngineSettings } from './settings';

import { has } from '@/lib/values';

export interface RecordEvent {
  companyId: string;
  providerId: string;
  kind: string;
  sourceIp: string | null;
  headers: Record<string, string>;
  rawText: string;
  operationId?: string | null;
  attemptId?: string | null;
  /** What the body claims, already read (the payer only as a fingerprint). Fixed once written. */
  claim?: Record<string, unknown> | null;
  /** Set when the event was refused before anything was read from it. */
  rejected?: { code: string; reason: string };
}

/**
 * Everything a platform sends us, written down before anything else happens: who sent it, what it
 * said (secrets and phone numbers masked), whether the sender could be trusted, and what was decided.
 */
/** What the body says if it is JSON; nothing when it is empty or not JSON (the raw text is kept either way). */
function parseJsonOrNull(raw: string): unknown {
  if (!has(raw)) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class ProviderEventService {
  constructor(private readonly db: DrizzleDb) {}

  /** Checks that can be made before the body is read. Returns why it must be refused, or null. */
  guard(settings: EngineSettings, input: { sourceIp: string | null; size: number; https: boolean; requireHttps: boolean }): { code: string; reason: string } | null {
    if (input.requireHttps && !input.https) return { code: 'NOT_HTTPS', reason: 'Callbacks must arrive over https.' };
    if (input.size > settings.security.maxBodyBytes) return { code: 'TOO_LARGE', reason: `The body is larger than ${settings.security.maxBodyBytes} bytes.` };
    if (!ipAllowed(input.sourceIp, settings.security.allowedCidrs)) return { code: 'IP_NOT_ALLOWED', reason: `The sender (${input.sourceIp ?? 'unknown'}) is not in the allowed addresses.` };
    return null;
  }

  async record(input: RecordEvent): Promise<{ event: ProviderEventRow; parsed: unknown }> {
    const parsed = parseJsonOrNull(input.rawText);
    const hash = bodyHash(input.rawText);
    const [dup] = await this.db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(and(eq(providerEvents.providerId, input.providerId), eq(providerEvents.bodyHash, hash), eq(providerEvents.kind, input.kind)))
      .orderBy(desc(providerEvents.createdAt))
      .limit(1);
    const stored = parsed !== null ? redactDeep(parsed) : null;
    const [event] = await this.db
      .insert(providerEvents)
      .values({
        companyId: input.companyId,
        providerId: input.providerId,
        kind: input.kind,
        sourceIp: input.sourceIp,
        headers: redactHeaders(input.headers),
        // The text is kept as the platform sent it only when it is not JSON; JSON is kept masked.
        rawText: stored !== null ? JSON.stringify(stored) : input.rawText.slice(0, 8000),
        rawBody: stored,
        bodyHash: hash,
        claim: input.claim ?? null,
        operationId: input.operationId ?? null,
        attemptId: input.attemptId ?? null,
        state: input.rejected ? 'rejected' : 'received',
        failureCode: input.rejected?.code ?? null,
        failureReason: input.rejected?.reason ?? null,
        duplicateOf: dup?.id ?? null,
      })
      .returning();
    return { event, parsed };
  }

  async setState(
    id: string,
    state: ProviderEventState,
    extra: { failureCode?: string | null; failureReason?: string | null; platformReference?: string | null; amount?: string | null; attemptId?: string | null; operationId?: string | null } = {},
  ) {
    await this.db
      .update(providerEvents)
      .set({
        state,
        updatedAt: new Date(),
        ...(extra.failureCode !== undefined ? { failureCode: extra.failureCode, failureReason: extra.failureReason ?? null } : {}),
        ...(extra.platformReference !== undefined ? { platformReference: extra.platformReference } : {}),
        ...(extra.amount !== undefined ? { amount: extra.amount } : {}),
        ...(extra.attemptId !== undefined ? { attemptId: extra.attemptId } : {}),
        ...(extra.operationId !== undefined ? { operationId: extra.operationId } : {}),
        ...(state === 'verified' ? { verifiedAt: new Date() } : {}),
        ...(state === 'consumed' ? { consumedAt: new Date() } : {}),
      })
      .where(eq(providerEvents.id, id));
  }

  async get(id: string) {
    const [row] = await this.db.select().from(providerEvents).where(eq(providerEvents.id, id));
    return row ?? null;
  }

  async forAttempt(attemptId: string) {
    return await this.db.select().from(providerEvents).where(eq(providerEvents.attemptId, attemptId)).orderBy(desc(providerEvents.createdAt));
  }
}
