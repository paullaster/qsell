import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { reasonCodes, type ReasonCodeRow } from '@/server/db/drizzle/schema';

import { has, trimToNull } from '@/lib/values';

export class ReasonError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_REASON'
      | 'REASON_INACTIVE'
      | 'REASON_NOT_APPLICABLE'
      | 'COMMENT_REQUIRED'
      | 'REASON_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'ReasonError';
  }
}

/** Reasons every installation starts with. Businesses add their own; these cannot be deleted. */
export const SYSTEM_REASON_CODES: {
  code: string;
  description: string;
  requiresComment?: boolean;
}[] = [
  { code: 'DATA_ENTRY_ERROR', description: 'Correcting a data entry mistake' },
  { code: 'CUSTOMER_REQUEST', description: 'Requested by the customer' },
  { code: 'POLICY_CHANGE', description: 'Business policy changed' },
  { code: 'PERIOD_ROLLOVER', description: 'Start of a new period (year-end or similar)' },
  { code: 'EXHAUSTED', description: 'The range or limit was used up' },
  {
    code: 'AUDIT_FINDING',
    description: 'Following an audit or review finding',
    requiresComment: true,
  },
  { code: 'CREDIT_LAPSED', description: 'Customer credit nobody used lapsed under the expiry policy' },
  { code: 'OTHER', description: 'Other (explain in the comment)', requiresComment: true },
];

export interface ReasonInput {
  code?: string | null;
  text?: string | null;
}

/** Business Central "Reason Code": a controlled list, so "why" is a value you can report on. */
export class ReasonCodes {
  constructor(private readonly db: DrizzleDb) {}

  /** Creates the system reasons for a company if they are missing. Safe to call repeatedly. */
  async ensureSystemReasons(companyId: string): Promise<void> {
    await this.db
      .insert(reasonCodes)
      .values(
        SYSTEM_REASON_CODES.map((r) => ({
          companyId,
          code: r.code,
          description: r.description,
          requiresComment: r.requiresComment ?? false,
          isSystem: true,
        })),
      )
      .onConflictDoNothing({ target: [reasonCodes.companyId, reasonCodes.code] });
  }

  async list(companyId: string): Promise<ReasonCodeRow[]> {
    return await this.db
      .select()
      .from(reasonCodes)
      .where(eq(reasonCodes.companyId, companyId))
      .orderBy(reasonCodes.code);
  }

  /**
   * Checks a reason against the catalogue and returns it normalised. Throws a ReasonError
   * that says what is wrong: unknown, inactive, not allowed for this action, or missing the
   * comment it requires.
   */
  async require(
    companyId: string,
    input: ReasonInput,
    appliesTo: string,
  ): Promise<{ code: string; text: string | null }> {
    const code = input.code?.trim();
    if (!has(code)) throw new ReasonError('REASON_REQUIRED', 'A reason is required.');
    const [row] = await this.db
      .select()
      .from(reasonCodes)
      .where(and(eq(reasonCodes.companyId, companyId), eq(reasonCodes.code, code)))
      .limit(1);
    if (!row) throw new ReasonError('UNKNOWN_REASON', `Reason "${code}" does not exist.`);
    if (!row.isActive)
      throw new ReasonError('REASON_INACTIVE', `Reason "${code}" is no longer in use.`);
    if (row.appliesTo.length > 0 && !row.appliesTo.includes(appliesTo)) {
      throw new ReasonError(
        'REASON_NOT_APPLICABLE',
        `Reason "${code}" cannot be used for ${appliesTo}.`,
      );
    }
    const text = trimToNull(input.text);
    if (row.requiresComment && !has(text)) {
      throw new ReasonError('COMMENT_REQUIRED', `Reason "${code}" needs a comment explaining it.`);
    }
    return { code, text };
  }
}
