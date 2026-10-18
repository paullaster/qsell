import { has, trimToNull } from '@/lib/values';
import { randomInt } from 'node:crypto';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, financeSettings, giftCardLedger, giftCards, paymentMethods, type GiftCardRow } from '@/server/db/drizzle/schema';
import type { Tx } from '@/server/kernel/approvals/engine';
import type { Actor } from '@/server/kernel/context';
import type { FxService } from '@/server/domains/finance/fx-service';
import { businessDate } from '@/server/kernel/numbering/business-date';
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
  ledger: {
    id: string;
    kind: string;
    amount: number;
    orderId: string | null;
    note: string | null;
    actor: string;
    createdAt: string;
  }[];
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
    private readonly fx: FxService,
  ) {}

  private view(r: GiftCardRow, customerName: string | null = null, now = new Date()): GiftCardView {
    const expired = r.expiresAt != null && r.expiresAt <= now;
    const empty = Number(r.balance) <= 0;
    const reasons: [boolean, string][] = [
      [r.status === 'blocked', 'This card is blocked.'],
      [expired, 'This card has expired.'],
      [empty, 'This card has no balance left.'],
    ];
    const unusableReason = reasons.find(([applies]) => applies)?.[1] ?? null;
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
          has(s)
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
      /**
       * How the cards came to exist: bought with money (through this payment method) or given free. Needed once the
       * business's books are live, because each card is money owed to its holder and the books must say where it came from.
       */
      funding?: { kind: 'sold'; paymentMethodId: string } | { kind: 'complimentary' };
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
    if (issues.length > 0) throw new PricingConfigError('INVALID', issues[0]?.message ?? 'The card is not valid.', issues);
    if (has(input.customerId)) {
      const [c] = await this.db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.companyId, companyId)))
        .limit(1);
      if (!c) throw new PricingConfigError('NOT_FOUND', 'That customer does not exist.');
    }
    const value = money(input.value);
    const [books] = await this.db.select({ live: financeSettings.salesGlGoLive, base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    // A card in another currency is carried at what that currency is worth the day it is issued.
    const currency = (has(input.currency) ? input.currency : (books?.base ?? 'KES')).toUpperCase();
    let rate = '1';
    if (books !== undefined && currency !== books.base.toUpperCase()) {
      const found = await this.fx.rateOn(this.db, companyId, currency, businessDate());
      if (found === null) throw new PricingConfigError('INVALID', `There is no exchange rate for ${currency} yet. Set it under Finance → Exchange rates before issuing cards in ${currency}.`);
      rate = found;
    }
    if (books?.live != null && input.funding == null) {
      throw new PricingConfigError('INVALID', 'Say how these cards were paid for: sold for money, or given free.');
    }
    if (input.funding?.kind === 'sold') {
      const [method] = await this.db
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(and(eq(paymentMethods.id, input.funding.paymentMethodId), eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true)));
      if (!method) throw new PricingConfigError('NOT_FOUND', 'Choose the payment method the money for the cards came in through.');
    }
    return await this.db.transaction(async (tx) => {
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
              currency,
              rate,
              expiresAt: input.expiresAt ?? null,
              customerId: input.customerId ?? null,
              note: trimToNull(input.note),
              issuedBy: actor.id,
              fundedBy: input.funding?.kind ?? 'unspecified',
              fundingMethodId: input.funding?.kind === 'sold' ? input.funding.paymentMethodId : null,
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

  /**
   * Cards past the date that was set on them lose what is left: the balance is written off with one `adjust` row, which the
   * database queues for the books (value owed becomes income). Safe to run again and again: a card with nothing left is not
   * picked, and one card failing never stops the rest.
   */
  async expireDue(now: Date, limit = 200): Promise<{ expired: number; failed: number }> {
    const due = await this.db
      .select({ id: giftCards.id })
      .from(giftCards)
      .where(and(sql`${giftCards.expiresAt} <= ${now.toISOString()}`, sql`${giftCards.balance} > 0`))
      .orderBy(giftCards.expiresAt)
      .limit(limit);
    let expired = 0;
    let failed = 0;
    for (const { id } of due) {
      try {
        const done = await this.db.transaction(async (tx) => {
          const [card] = await tx.select().from(giftCards).where(eq(giftCards.id, id)).for('update');
          if (card?.expiresAt == null || card.expiresAt > now || !(Number(card.balance) > 0)) return false;
          await tx.update(giftCards).set({ balance: '0.00' }).where(eq(giftCards.id, id));
          await tx.insert(giftCardLedger).values({
            cardId: id,
            kind: 'adjust',
            amount: (-Number(card.balance)).toFixed(2),
            reasonCode: 'GIFT_CARD_EXPIRED',
            note: `Expired on ${card.expiresAt.toISOString().slice(0, 10)}.`,
            actor: 'gift-card-expiry',
          });
          return true;
        });
        if (done) expired += 1;
      } catch (error) {
        failed += 1;
        console.error('[gift card] an expired card could not be written off', id, error instanceof Error ? error.message : error);
      }
    }
    return { expired, failed };
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
