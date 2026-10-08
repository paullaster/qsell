import { randomInt } from 'node:crypto';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, giftCardLedger, giftCards, type GiftCardRow } from '@/server/db/drizzle/schema';
import type { Tx } from '@/server/kernel/approvals/engine';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { PricingConfigError } from './config-service';
import { checkGiftCardIssue, generateGiftCardCode, normaliseGiftCardCode } from './domain/giftcard';

type Why = ReasonInput;
const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface GiftCardView {
  id: string;
  code: string;
  initialValue: number;
  balance: number;
  currency: string;
  status: 'active' | 'blocked';
  /** What the card can be used for right now. */
  usable: boolean;
  unusableReason: string | null;
  expiresAt: string | null;
  customerId: string | null;
  customerName: string | null;
  note: string | null;
  createdAt: string;
}

export interface GiftCardDetail extends GiftCardView {
  ledger: Array<{
    id: string;
    kind: string;
    amount: number;
    orderId: string | null;
    note: string | null;
    actor: string;
    createdAt: string;
  }>;
}

/**
 * Gift cards: prepaid value with a code. Spending one is a payment on an order, so its balance
 * moves with an atomic update that cannot go below zero, and every movement is a ledger row.
 */
export class GiftCardService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
  ) {}

  private view(r: GiftCardRow, customerName: string | null = null, now = new Date()): GiftCardView {
    const expired = r.expiresAt != null && r.expiresAt <= now;
    const empty = Number(r.balance) <= 0;
    const unusableReason =
      r.status === 'blocked'
        ? 'This card is blocked.'
        : expired
          ? 'This card has expired.'
          : empty
            ? 'This card has no balance left.'
            : null;
    return {
      id: r.id,
      code: r.code,
      initialValue: Number(r.initialValue),
      balance: Number(r.balance),
      currency: r.currency,
      status: r.status,
      usable: unusableReason == null,
      unusableReason,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      customerId: r.customerId,
      customerName,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async list(companyId: string, search?: string, limit = 100): Promise<GiftCardView[]> {
    const s = search?.trim();
    const rows = await this.db
      .select({ card: giftCards, customer: customers.name })
      .from(giftCards)
      .leftJoin(customers, eq(customers.id, giftCards.customerId))
      .where(
        and(
          eq(giftCards.companyId, companyId),
          s
            ? or(
                ilike(giftCards.code, `%${normaliseGiftCardCode(s).replace(/[%_]/g, '')}%`),
                ilike(giftCards.note, `%${s.replace(/[%_]/g, '')}%`),
                ilike(customers.name, `%${s.replace(/[%_]/g, '')}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(giftCards.createdAt))
      .limit(Math.min(limit, 500));
    const now = new Date();
    return rows.map((r) => this.view(r.card, r.customer, now));
  }

  /** A card by the code as typed, with its history. */
  async lookup(companyId: string, rawCode: string): Promise<GiftCardDetail> {
    const code = normaliseGiftCardCode(rawCode);
    const [row] = await this.db
      .select({ card: giftCards, customer: customers.name })
      .from(giftCards)
      .leftJoin(customers, eq(customers.id, giftCards.customerId))
      .where(and(eq(giftCards.companyId, companyId), eq(giftCards.code, code)))
      .limit(1);
    if (!row) throw new PricingConfigError('NOT_FOUND', 'That gift card code is not valid.');
    const ledger = await this.db
      .select()
      .from(giftCardLedger)
      .where(eq(giftCardLedger.cardId, row.card.id))
      .orderBy(desc(giftCardLedger.createdAt))
      .limit(100);
    return {
      ...this.view(row.card, row.customer),
      ledger: ledger.map((l) => ({
        id: l.id,
        kind: l.kind,
        amount: Number(l.amount),
        orderId: l.orderId,
        note: l.note,
        actor: l.actor,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /** Makes cards, each with its own code. Returns them so the codes can be printed or sent. */
  async issue(
    companyId: string,
    input: {
      value: number;
      count?: number;
      expiresAt?: Date | null;
      customerId?: string | null;
      note?: string | null;
      currency?: string;
    },
    actor: { type: 'user'; id: string },
    reason: Why,
  ): Promise<GiftCardView[]> {
    const why = await this.reasons.require(companyId, reason, 'pricing_configuration');
    const count = input.count ?? 1;
    const issues = checkGiftCardIssue({
      value: input.value,
      expiresAt: input.expiresAt ?? null,
      count,
    });
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);
    if (input.customerId) {
      const [c] = await this.db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.companyId, companyId)))
        .limit(1);
      if (!c) throw new PricingConfigError('NOT_FOUND', 'That customer does not exist.');
    }
    const value = money(input.value);
    return this.db.transaction(async (tx) => {
      const out: GiftCardRow[] = [];
      for (let i = 0; i < count; i++) {
        // A clash of two random 80-bit codes will not happen; retry anyway rather than fail a batch.
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = generateGiftCardCode((n) => randomInt(n));
          const [row] = await tx
            .insert(giftCards)
            .values({
              companyId,
              code,
              initialValue: value.toFixed(2),
              balance: value.toFixed(2),
              currency: input.currency ?? 'KES',
              expiresAt: input.expiresAt ?? null,
              customerId: input.customerId ?? null,
              note: input.note?.trim() || null,
              issuedBy: actor.id,
            })
            .onConflictDoNothing()
            .returning();
          if (!row) continue;
          await tx.insert(giftCardLedger).values({
            cardId: row.id,
            kind: 'issue',
            amount: value.toFixed(2),
            reasonCode: why.code,
            actor: actor.id,
          });
          await this.decisions.record(
            {
              companyId,
              actor,
              subject: { type: 'gift_card', id: row.id },
              action: 'pricing.gift_card_issued',
              reason: why,
              outcome: { value, expiresAt: input.expiresAt ?? null },
            },
            tx,
          );
          out.push(row);
          break;
        }
      }
      if (out.length !== count)
        throw new PricingConfigError('CONFLICT', 'Could not make unique codes. Try again.');
      return out.map((r) => this.view(r));
    });
  }

  async setBlocked(
    companyId: string,
    id: string,
    blocked: boolean,
    actor: Actor,
    reason: Why,
  ): Promise<void> {
    const why = await this.reasons.require(companyId, reason, 'pricing_configuration');
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(giftCards)
        .set({ status: blocked ? 'blocked' : 'active' })
        .where(and(eq(giftCards.id, id), eq(giftCards.companyId, companyId)))
        .returning({ id: giftCards.id });
      if (!row) throw new PricingConfigError('NOT_FOUND', 'That gift card does not exist.');
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'gift_card', id },
          action: blocked ? 'pricing.gift_card_blocked' : 'pricing.gift_card_unblocked',
          reason: why,
          to: blocked ? 'blocked' : 'active',
        },
        tx,
      );
    });
  }

  /**
   * Spends `amount` from the card against an order. The balance check and the deduction are one
   * statement, so two orders using the same card at once cannot both spend the same money.
   */
  async redeem(
    tx: Tx,
    input: { companyId: string; code: string; amount: number; orderId: string; actor: string },
  ): Promise<{ cardId: string; amount: number }> {
    const code = normaliseGiftCardCode(input.code);
    const amount = money(input.amount);
    if (!(amount > 0)) throw new PricingConfigError('INVALID', 'Nothing to take from the card.');
    const [card] = await tx
      .select()
      .from(giftCards)
      .where(and(eq(giftCards.companyId, input.companyId), eq(giftCards.code, code)))
      .limit(1);
    if (!card) throw new PricingConfigError('NOT_FOUND', 'That gift card code is not valid.');
    const now = new Date();
    const updated = await tx
      .update(giftCards)
      .set({ balance: sql`${giftCards.balance} - ${amount.toFixed(2)}::numeric` })
      .where(
        and(
          eq(giftCards.id, card.id),
          eq(giftCards.status, 'active'),
          sql`${giftCards.balance} >= ${amount.toFixed(2)}::numeric`,
          sql`(${giftCards.expiresAt} is null or ${giftCards.expiresAt} > ${now.toISOString()})`,
        ),
      )
      .returning({ id: giftCards.id });
    if (updated.length === 0) {
      const v = this.view(card, null, now);
      throw new PricingConfigError(
        'INVALID',
        v.unusableReason ?? `The card has only ${v.balance.toFixed(2)} left.`,
      );
    }
    await tx.insert(giftCardLedger).values({
      cardId: card.id,
      kind: 'redeem',
      amount: (-amount).toFixed(2),
      orderId: input.orderId,
      actor: input.actor,
    });
    return { cardId: card.id, amount };
  }

  /** Gives back what an order spent from cards, once per card. */
  async reverseOrder(tx: Tx, orderId: string): Promise<void> {
    const spent = await tx
      .select()
      .from(giftCardLedger)
      .where(and(eq(giftCardLedger.orderId, orderId), eq(giftCardLedger.kind, 'redeem')));
    // A card may have been used twice on one order; give back the total for each card, once.
    const byCard = new Map<string, number>();
    for (const s of spent) byCard.set(s.cardId, (byCard.get(s.cardId) ?? 0) - Number(s.amount));
    for (const [cardId, total] of byCard) {
      // Lock the card so two reversals cannot both see "not yet reversed".
      await tx
        .select({ id: giftCards.id })
        .from(giftCards)
        .where(eq(giftCards.id, cardId))
        .for('update');
      const [done] = await tx
        .select({ id: giftCardLedger.id })
        .from(giftCardLedger)
        .where(
          and(
            eq(giftCardLedger.cardId, cardId),
            eq(giftCardLedger.orderId, orderId),
            eq(giftCardLedger.kind, 'reverse'),
          ),
        )
        .limit(1);
      if (done) continue;
      const back = money(total);
      await tx
        .update(giftCards)
        .set({ balance: sql`${giftCards.balance} + ${back.toFixed(2)}::numeric` })
        .where(eq(giftCards.id, cardId));
      await tx.insert(giftCardLedger).values({
        cardId,
        kind: 'reverse',
        amount: back.toFixed(2),
        orderId,
        note: 'Order cancelled.',
        actor: 'system',
      });
    }
  }
}
