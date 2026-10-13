import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { giftCards, orderTenders, orders } from '@/server/db/drizzle/schema';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import type { Tx } from '@/server/kernel/approvals/engine';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { amountDue } from '@/server/domains/orders/amount-due';
import { PricingConfigError } from './config-service';
import { giftCardApplies, normaliseGiftCardCode } from './domain/giftcard';
import type { GiftCardService } from './giftcard-service';
import type { LoyaltyService } from './loyalty-service';
import type { RebateService } from './rebate-service';
import type { WalletService } from '@/server/domains/finance/receivables/wallet-service';

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface TenderInput {
  giftCards?: Array<{ code: string; amount?: number }>;
  /** Points to spend, or 'all' for as many as can be used. */
  loyaltyPoints?: number | 'all';
  /** Pay from the customer's wallet: an amount, or 'all' that can be used. */
  wallet?: number | 'all';
}

export interface TenderResult {
  applied: Array<{ kind: 'gift_card' | 'loyalty_points' | 'wallet'; label: string; amount: number; points?: number }>;
  tendered: number;
  due: number;
  paid: boolean;
  /** Set when the order was paid in full but something after that could not be finished. */
  warning?: string;
}

/**
 * Paying part or all of an order with gift cards and loyalty points. A tender is a payment, not a
 * price change: the order's total stays, `tendered_amount` grows, and what is left is what a
 * payment gateway is asked for. When nothing is left the order is paid.
 */
export class OrderTenderService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly cards: GiftCardService,
    private readonly loyalty: LoyaltyService,
    private readonly rebates: RebateService,
    private readonly wallets: () => WalletService,
  ) {}

  async apply(
    companyId: string,
    orderId: string,
    input: TenderInput,
    actor: { type: 'user'; id: string },
  ): Promise<TenderResult> {
    if ((input.giftCards?.length ?? 0) === 0 && input.loyaltyPoints == null && input.wallet == null)
      throw new PricingConfigError('INVALID', 'Choose a gift card, points or the wallet to use.');
    if ((input.giftCards?.length ?? 0) > 5)
      throw new PricingConfigError('TOO_MANY', 'Use at most 5 gift cards on one order.');

    const out = await this.db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
      if (!order) throw new PricingConfigError('NOT_FOUND', 'That order does not exist.');
      if (['cancelled', 'failed', 'refunded'].includes(order.status))
        throw new PricingConfigError('NOT_EDITABLE', `A ${order.status} order cannot take a payment.`);
      if (['paid', 'reconciled'].includes(order.paymentStatus))
        throw new PricingConfigError('NOT_EDITABLE', 'This order is already paid.');
      if (order.paymentStatus === 'pending_verification')
        throw new PricingConfigError(
          'NOT_EDITABLE',
          'A payment for this order is being confirmed. Wait for it before using a card or points.',
        );
      if (['pending', 'rejected', 'draft'].includes(order.approvalStatus))
        throw new PricingConfigError(
          'NOT_EDITABLE',
          'This order is waiting for approval and cannot take a payment yet.',
        );
      if (order.paymentMethod === 'on_account')
        throw new PricingConfigError(
          'NOT_EDITABLE',
          'This order is on the customer account. Gift cards and points pay orders that are paid now.',
        );

      let due = amountDue({
        totalAmount: Number(order.totalAmount),
        tenderedAmount: Number(order.tenderedAmount),
      });
      if (due <= 0) throw new PricingConfigError('NOT_EDITABLE', 'Nothing is left to pay.');
      const applied: TenderResult['applied'] = [];
      const actorId = actor.id;

      if (input.loyaltyPoints != null) {
        if (!order.tradeCustomerId)
          throw new PricingConfigError('INVALID', 'Points belong to a customer account, and this order has none.');
        const r = await this.loyalty.redeem(tx, {
          companyId,
          customerId: order.tradeCustomerId,
          orderId,
          due,
          points: input.loyaltyPoints === 'all' ? undefined : input.loyaltyPoints,
          actor: actorId,
        });
        await tx.insert(orderTenders).values({
          orderId,
          kind: 'loyalty_points',
          reference: order.tradeCustomerId,
          amount: r.value.toFixed(2),
          points: r.points,
          actor: actorId,
        });
        applied.push({ kind: 'loyalty_points', label: `${r.points} points`, amount: r.value, points: r.points });
        due = money(due - r.value);
      }

      if (input.wallet != null) {
        if (!order.tradeCustomerId)
          throw new PricingConfigError('INVALID', 'A wallet belongs to a customer account, and this order has none.');
        const want = input.wallet === 'all' ? due : money(Number(input.wallet));
        if (!(want > 0)) throw new PricingConfigError('INVALID', 'Enter an amount above zero.');
        try {
          const cents = await this.wallets().tenderIn(tx, {
            companyId,
            customerId: order.tradeCustomerId,
            currency: order.currency.toUpperCase(),
            maxCents: Math.round(Math.min(want, due) * 100),
            orderId,
            actorId,
          });
          await tx.insert(orderTenders).values({
            orderId,
            kind: 'wallet',
            reference: order.tradeCustomerId,
            amount: (cents / 100).toFixed(2),
            actor: actorId,
          });
          applied.push({ kind: 'wallet', label: 'Wallet', amount: cents / 100 });
          due = money(due - cents / 100);
        } catch (error) {
          if (error instanceof Error && 'code' in error && String((error as { code: unknown }).code).startsWith('WALLET'))
            throw new PricingConfigError('INVALID', error.message);
          throw error;
        }
      }

      for (const c of input.giftCards ?? []) {
        if (due <= 0) break;
        const [card] = await tx
          .select()
          .from(giftCards)
          .where(
            and(eq(giftCards.companyId, companyId), eq(giftCards.code, normaliseGiftCardCode(c.code))),
          )
          .limit(1);
        if (!card) throw new PricingConfigError('NOT_FOUND', `Gift card ${c.code} is not valid.`);
        if (c.amount != null && !(c.amount > 0))
          throw new PricingConfigError('INVALID', 'Enter an amount above zero.');
        const want = giftCardApplies(Number(card.balance), due);
        const amount = c.amount != null ? Math.min(money(c.amount), want) : want;
        const spent = await this.cards.redeem(tx, {
          companyId,
          code: card.code,
          amount,
          orderId,
          actor: actorId,
        });
        await tx.insert(orderTenders).values({
          orderId,
          kind: 'gift_card',
          reference: spent.cardId,
          amount: spent.amount.toFixed(2),
          actor: actorId,
        });
        applied.push({ kind: 'gift_card', label: `Card ${card.code}`, amount: spent.amount });
        due = money(due - spent.amount);
      }

      const added = money(applied.reduce((n, a) => n + a.amount, 0));
      const paid = due <= 0.004;
      await tx
        .update(orders)
        .set({
          tenderedAmount: sql`${orders.tenderedAmount} + ${added.toFixed(2)}::numeric`,
          ...(paid
            ? {
                paymentStatus: 'paid',
                status: 'processing',
                transactionReference: `TENDER-${order.orderNumber}`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId));
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'order', id: orderId },
          action: 'orders.tendered',
          from: order.paymentStatus,
          to: paid ? 'paid' : order.paymentStatus,
          outcome: { applied, due },
        },
        tx,
      );
      return { applied, tendered: money(Number(order.tenderedAmount) + added), due: Math.max(0, due), paid };
    });

    let warning: string | undefined;
    if (out.paid) {
      try {
        await InventoryReservationService.fulfilOrder(orderId);
        const { getContainer } = await import('@/server/di/container');
        await getContainer().customers.applyOrderPayment(orderId);
      } catch (error) {
        console.error('[tender] order paid but follow-up failed', orderId, error);
        warning = 'The order is paid, but stock or the customer account could not be updated. Check it.';
      }
    }
    return { ...out, ...(warning ? { warning } : {}) };
  }

  /** Gives back everything a cancelled order had earned, spent or counted. Each part is idempotent. */
  async reverseOrder(tx: Tx, orderId: string): Promise<void> {
    await this.cards.reverseOrder(tx, orderId);
    await this.loyalty.reverseOrder(tx, orderId);
    await this.rebates.reverseOrder(tx, orderId);
    await this.wallets().reverseTenderIn(tx, orderId);
  }
}
