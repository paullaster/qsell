import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { deliveries, deliveryDoorPrompts, deliveryRunStops, deliveryRuns, orders, paymentAttempts, paymentMethods, paymentProviderConfigs } from '@/server/db/drizzle/schema';
import { MAX_DOOR_PROMPTS, PROMPT_FAILED_WORDS, promptProblem, promptState, type PromptState } from '@/lib/door-payment';
import { toKenyanMsisdn } from '@/lib/phone';
import type { RateRuleName } from '@/lib/rate-limit';
import type { StartedPayment } from '@/server/domains/payments/start-payment';
import type { DocRefusal, DocResult } from './documents';
import type { RiderSelf } from './riders';

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'That stop could not be found on your run.';

export interface DoorPromptStatus {
  state: PromptState;
  message: string | null;
  /** The last three digits of the number the last prompt went to. */
  phoneEnding: string | null;
  promptsLeft: number;
  attemptId: string | null;
}

export interface DoorMpesaDeps {
  /** Starts the payment (the checkout's own function), given the order, the provider and the number. */
  start: (input: { orderId: string; providerCode: 'mpesa_daraja'; payerPhone: string; source: 'rider_app' }) => Promise<StartedPayment>;
  /** What the order still has to pay, or null when there is no such order. */
  amountDue: (orderId: string) => Promise<number | null>;
  /** A limit hit: null when allowed, else the words to show. */
  limit: (rule: RateRuleName, subject: string) => Promise<string | null>;
}

/**
 * M-Pesa at the door. The rider asks for a prompt to the customer's phone (or another number the customer will pay from) for exactly the
 * amount the delivery is to be paid at the door; the payment engine sends it, and the platform, not the app, confirms it, which pays the
 * order the way any M-Pesa payment does (the money goes to the company's M-Pesa account and never enters the rider's custody). The rider
 * sees only whether it is waiting, paid or did not go through. The number and the amount are never taken from the phone beyond the
 * number the customer says; the amount is the order's, read here.
 */
export class DoorMpesa {
  constructor(
    private readonly db: DrizzleDb,
    private readonly deps: DoorMpesaDeps,
  ) {}

  /** The delivery, order and run for a stop that is the rider's own and live. */
  private async stop(self: RiderSelf, runId: unknown, deliveryId: unknown) {
    if (typeof runId !== 'string' || !UUID.test(runId) || typeof deliveryId !== 'string' || !UUID.test(deliveryId)) return null;
    const [run] = await this.db.select().from(deliveryRuns).where(and(eq(deliveryRuns.id, runId), eq(deliveryRuns.companyId, self.companyId), eq(deliveryRuns.riderId, self.riderId)));
    if (run === undefined) return null;
    const [live] = await this.db.select({ id: deliveryRunStops.id }).from(deliveryRunStops).where(and(eq(deliveryRunStops.runId, runId), eq(deliveryRunStops.deliveryId, deliveryId), isNull(deliveryRunStops.leftAt)));
    if (live === undefined) return null;
    const [delivery] = await this.db.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, self.companyId)));
    if (delivery === undefined) return null;
    const [order] = await this.db.select().from(orders).where(eq(orders.id, delivery.orderId));
    if (order === undefined) return null;
    return { run, delivery, order };
  }

  private async lastPrompt(deliveryId: string) {
    const [row] = await this.db
      .select({ p: deliveryDoorPrompts, status: paymentAttempts.status, attemptCreated: paymentAttempts.createdAt, error: paymentAttempts.errorMessage })
      .from(deliveryDoorPrompts)
      .innerJoin(paymentAttempts, eq(paymentAttempts.id, deliveryDoorPrompts.attemptId))
      .where(eq(deliveryDoorPrompts.deliveryId, deliveryId))
      .orderBy(desc(deliveryDoorPrompts.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Sends a prompt to the number the customer says, for what is due at this door. */
  async prompt(self: RiderSelf, input: { runId?: unknown; deliveryId?: unknown; phone?: unknown }, now: Date = new Date()): Promise<DocResult<DoorPromptStatus>> {
    const found = await this.stop(self, input.runId, input.deliveryId);
    if (found === null) return fail('not_found', NOT_FOUND);
    const { run, delivery, order } = found;
    const typed = typeof input.phone === 'string' && input.phone.trim() !== '' ? input.phone : (order.paymentPhone ?? delivery.recipientPhone ?? order.customerPhone);
    const phone = toKenyanMsisdn(typed);
    const [{ n: sent } = { n: 0 }] = await this.db.select({ n: count() }).from(deliveryDoorPrompts).where(eq(deliveryDoorPrompts.deliveryId, delivery.id));
    const last = await this.lastPrompt(delivery.id);
    const due = await this.deps.amountDue(order.id);
    const problem = promptProblem({
      runOnTheRoad: run.status === 'started',
      deliveryStatus: delivery.status,
      doorAmount: delivery.doorAmount,
      amountDue: due ?? 0,
      orderPaymentStatus: order.paymentStatus,
      phone,
      promptsSent: sent,
      lastAttempt: last === null ? null : { status: last.status, ageSeconds: Math.max(0, Math.round((now.getTime() - last.attemptCreated.getTime()) / 1000)) },
    });
    if (problem !== null) return fail('not_allowed', problem);
    if (phone === null) return fail('bad_input', 'That is not a Kenyan mobile number.');
    for (const [rule, subject] of [['door_prompt_rider', self.riderId], ['payment_prompt_phone', phone]] as const) {
      const limited = await this.deps.limit(rule, subject);
      if (limited !== null) return fail('not_allowed', limited);
    }
    // The books find the method this is paid through by the order's payment method id: this payment is an M-Pesa one, whatever the order
    // began as. The order's own words ("pay on delivery") are left alone, so the sweep that gives back stock for a payment that failed
    // (it looks at online methods) never touches goods that are still on the rider's truck.
    const [mpesa] = await this.db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, paymentMethods.providerId))
      .where(and(eq(paymentMethods.companyId, self.companyId), eq(paymentMethods.enabled, true), sql`(${paymentMethods.legacyCodes} ? 'mpesa_daraja' OR ${paymentProviderConfigs.providerCode} = 'mpesa_daraja')`))
      .orderBy(asc(paymentMethods.sortOrder))
      .limit(1);
    if (mpesa !== undefined) await this.db.update(orders).set({ paymentMethodId: mpesa.id, updatedAt: new Date() }).where(eq(orders.id, order.id));
    let started: StartedPayment;
    try {
      started = await this.deps.start({ orderId: order.id, providerCode: 'mpesa_daraja', payerPhone: phone, source: 'rider_app' });
    } catch (error) {
      console.error('[door-mpesa] prompt could not be started', error);
      return fail('not_allowed', 'The prompt could not be sent. Take the cash instead, or ask the office.');
    }
    await this.db.insert(deliveryDoorPrompts).values({ companyId: self.companyId, deliveryId: delivery.id, orderId: order.id, riderId: self.riderId, attemptId: started.attemptId, phoneEnding: phone.slice(-3), amount: delivery.doorAmount ?? '0' });
    if (started.status === 'failed') return { ok: true, data: { state: 'failed', message: started.errorMessage ?? 'The prompt could not be sent.', phoneEnding: phone.slice(-3), promptsLeft: Math.max(0, MAX_DOOR_PROMPTS - sent - 1), attemptId: started.attemptId } };
    return { ok: true, data: { state: 'waiting', message: started.customerMessage ?? 'Ask the customer to enter their M-Pesa PIN.', phoneEnding: phone.slice(-3), promptsLeft: Math.max(0, MAX_DOOR_PROMPTS - sent - 1), attemptId: started.attemptId } };
  }

  /** Where the prompt at this door stands. The order being paid is what counts, whoever confirmed it. */
  async status(self: RiderSelf, input: { runId?: unknown; deliveryId?: unknown }): Promise<DocResult<DoorPromptStatus>> {
    const found = await this.stop(self, input.runId, input.deliveryId);
    if (found === null) return fail('not_found', NOT_FOUND);
    const { delivery, order } = found;
    const last = await this.lastPrompt(delivery.id);
    const [{ n: sent } = { n: 0 }] = await this.db.select({ n: count() }).from(deliveryDoorPrompts).where(eq(deliveryDoorPrompts.deliveryId, delivery.id));
    const state = promptState(order.paymentStatus === 'paid', last === null ? null : { status: last.status });
    const message = state === 'failed' && last !== null ? (PROMPT_FAILED_WORDS[last.status] ?? last.error ?? 'The payment did not go through.') : null;
    return { ok: true, data: { state, message, phoneEnding: last?.p.phoneEnding ?? null, promptsLeft: Math.max(0, MAX_DOOR_PROMPTS - sent), attemptId: last?.p.attemptId ?? null } };
  }
}

