import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { priceLists } from '@/server/db/drizzle/schema';
import { describeScopes } from './domain/rules';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';
import type { ParkedExecutor } from '@/server/kernel/approvals/parked-actions';
import type { LineInput } from './config-service';

type Tx = Parameters<DocumentHandler['onReleased']>[1];

/**
 * What a price list's approvals do to the list. A draft list asked to go live is held
 * (`approval_status = pending`) and prices nothing. Releasing it puts it in force in the approver's
 * own transaction; refusing, reopening or withdrawing leaves it a draft.
 */
export function priceListApprovalHandler(db: DrizzleDb): DocumentHandler {
  const service = async () => {
    const { getContainer } = await import('@/server/di/container');
    return getContainer().pricingConfig;
  };

  return {
    // The facts approvers were shown: if the number of prices moves, the approval no longer applies.
    snapshot: async (id, tx) => {
      const config = await service();
      return { changedLines: await config.openLineCountIn(tx, id) };
    },
    onReleased: async (id, tx) => {
      const config = await service();
      const [list] = await tx
        .select({ companyId: priceLists.companyId, status: priceLists.status })
        .from(priceLists)
        .where(eq(priceLists.id, id))
        .for('update');
      if (!list || list.status !== 'draft') return;
      const asked = await config.requestedWith(tx, id);
      // Recorded as the requester's decision, with the reason they gave; the approval itself is
      // logged by the approvals engine. If the list can no longer go live (a tie appeared since it
      // was asked for) this throws, the approval is not recorded, and the approver sees why.
      await config.activate(
        list.companyId,
        id,
        { type: 'user', id: asked?.actorId ?? 'approvals' },
        {
          code: asked?.code ?? 'OTHER',
          text: asked?.text ?? 'Approved through the approval workflow.',
        },
        tx,
      );
    },
    onRejected: async (id, tx) => (await service()).setApprovalState(tx, id, 'rejected'),
    onReopened: async (id, tx) => (await service()).setApprovalState(tx, id, 'none'),
    onCanceled: async (id, tx) => (await service()).setApprovalState(tx, id, 'none'),
    describe: async (id) => {
      const [l] = await db.select().from(priceLists).where(eq(priceLists.id, id)).limit(1);
      if (!l) return null;
      const config = await service();
      const lines = await config.openLineCountIn(db, id);
      return {
        title: `Put price list ${l.code} (${l.name}) in force: ${lines.toLocaleString('en-KE')} price${lines === 1 ? '' : 's'}, ${l.currency}.`,
        lines: [`Applies to: ${describeScopes(l.scopes, await config.scopeNames([l]))}`],
      };
    },
  };
}

/** A price may start now, not before; one whose start has passed while it waited starts at approval. */
const CLOCK_GRACE_MS = 60_000;
const asDate = (v: unknown) => (typeof v === 'string' ? new Date(v) : null);

/**
 * Applies a held change to a list in force, in the approver's transaction and as the person who
 * asked for it. Every check (locks, ties, a retired list) is made again against the list as it is
 * now, so a change that no longer fits is not applied and the approver sees why.
 */
export function priceChangeExecutors(): Record<string, ParkedExecutor> {
  const config = async () => (await import('@/server/di/container')).getContainer().pricingConfig;
  const who = (requestedBy: string) => ({ type: 'user' as const, id: requestedBy });
  return {
    set_lines: {
      async execute(tx, row) {
        const p = row.payload as {
          listId: string;
          rows: Array<Omit<LineInput, 'lockedUntil'> & { lockedUntil: string | null }>;
          reason: { code: string; text: string | null };
          validFrom: string | null;
          overrideLock: boolean;
        };
        const from = asDate(p.validFrom);
        const result = await (
          await config()
        ).setLines(
          row.companyId,
          p.listId,
          p.rows.map((r) => ({ ...r, lockedUntil: asDate(r.lockedUntil) })),
          who(row.requestedBy),
          p.reason,
          {
            validFrom: from && from.getTime() >= Date.now() - CLOCK_GRACE_MS ? from : undefined,
            overrideLock: p.overrideLock,
            writer: tx,
          },
        );
        return { ...result };
      },
    },
    remove_lines: {
      async execute(tx, row) {
        const p = row.payload as {
          listId: string;
          productIds: string[];
          reason: { code: string; text: string | null };
          overrideLock: boolean;
        };
        const result = await (
          await config()
        ).removeLines(row.companyId, p.listId, p.productIds, who(row.requestedBy), p.reason, {
          overrideLock: p.overrideLock,
          writer: tx,
        });
        return { ...result };
      },
    },
    update_list: {
      async execute(tx, row) {
        const p = row.payload as {
          listId: string;
          patch: Record<string, unknown>;
          reason: { code: string; text: string | null };
        };
        const { validFrom, validTo, ...rest } = p.patch;
        const updated = await (
          await config()
        ).updateList(
          row.companyId,
          p.listId,
          {
            ...rest,
            ...(validFrom !== undefined ? { validFrom: asDate(validFrom) } : {}),
            ...(validTo !== undefined ? { validTo: asDate(validTo) } : {}),
          },
          who(row.requestedBy),
          p.reason,
          tx,
        );
        return { version: updated.version };
      },
    },
  };
}
