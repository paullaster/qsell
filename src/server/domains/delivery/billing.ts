import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { chargePolicies, deliveryBillingSettings, etimsItems, products } from '@/server/db/drizzle/schema';
import { isDeliveryBillingMode, type DeliveryBillingMode } from '@/lib/delivery-invoicing';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { DeliveryError } from './errors';

export interface ServiceItemView {
  id: string;
  name: string;
  sku: string;
  /** Percent; null when the product has none set. */
  taxRate: number | null;
  /** Registered with KRA eTIMS for the company, so KRA can be sent a line for it. */
  registered: boolean;
  /** Only a service can stand for delivery; an older choice that is not one keeps working but is flagged on the screen. */
  isService: boolean;
}

export interface BillingView {
  mode: DeliveryBillingMode;
  serviceItem: ServiceItemView | null;
  /** Charge policies in force whose tax rate is not the service item's: the invoice line would carry a tax KRA does not expect. */
  taxMismatches: { code: string; name: string; taxRate: number }[];
  /** 0 when nothing has been chosen yet (then delivery is billed with the goods). */
  version: number;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface BillingForInvoicing {
  mode: DeliveryBillingMode;
  serviceProductId: string | null;
}

/**
 * How the company bills delivery on its invoices, and which item stands for the delivery service. It is read when an invoice is
 * made and when it is signed, so both agree; a change is version-checked, needs a reason and goes to the decision log.
 */
export class DeliveryBilling {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
  ) {}

  /** What invoicing needs: the mode (with the goods until someone chooses) and the item. */
  async forInvoicing(companyId: string): Promise<BillingForInvoicing> {
    const [row] = await this.db.select().from(deliveryBillingSettings).where(eq(deliveryBillingSettings.companyId, companyId));
    return { mode: row?.mode ?? 'with_goods', serviceProductId: row?.serviceProductId ?? null };
  }

  async get(companyId: string): Promise<BillingView> {
    const [row] = await this.db.select().from(deliveryBillingSettings).where(eq(deliveryBillingSettings.companyId, companyId));
    const serviceItem = row === undefined || row.serviceProductId === null ? null : await this.item(companyId, row.serviceProductId);
    const policies = await this.db.select({ code: chargePolicies.code, name: chargePolicies.name, taxRate: chargePolicies.taxRate }).from(chargePolicies).where(and(eq(chargePolicies.companyId, companyId), eq(chargePolicies.status, 'in_force')));
    const itemRate = serviceItem?.taxRate ?? null;
    const taxMismatches = itemRate === null ? [] : policies.filter((p) => Math.abs(Number(p.taxRate) - itemRate) > 0.005).map((p) => ({ code: p.code, name: p.name, taxRate: Number(p.taxRate) }));
    return { mode: row?.mode ?? 'with_goods', serviceItem, taxMismatches, version: row?.version ?? 0, updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null };
  }

  async save(companyId: string, actorId: string, input: { mode: unknown; serviceProductId: unknown; expectedVersion: unknown; reason: unknown }): Promise<BillingView> {
    if (!isDeliveryBillingMode(input.mode)) throw new DeliveryError('Choose whether delivery goes on the same invoice or on its own.', 'BAD_INPUT');
    const mode = input.mode;
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 5) throw new DeliveryError('Say why, in a few words. It is kept with the change.', 'BAD_INPUT');
    const expected = input.expectedVersion;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) throw new DeliveryError('Reload the page and try again.', 'BAD_INPUT');
    const productId = typeof input.serviceProductId === 'string' && input.serviceProductId !== '' ? input.serviceProductId : null;
    if (productId !== null) {
      const chosen = productId.length > 100 ? null : await this.item(companyId, productId);
      if (chosen === null) throw new DeliveryError('That item could not be found. Choose the item that stands for the delivery service.', 'NOT_FOUND');
      if (!chosen.isService) throw new DeliveryError(`"${chosen.name}" is a stocked or non-stock good, not a service. Choose a service item, or create one under a classification that behaves as a service.`, 'BAD_INPUT');
    }
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(deliveryBillingSettings).where(eq(deliveryBillingSettings.companyId, companyId)).for('update');
      if ((before?.version ?? 0) !== expected) throw new DeliveryError('Someone else changed how delivery is invoiced while you were looking. Reload the page to see their choice.', 'CONFLICT');
      await tx
        .insert(deliveryBillingSettings)
        .values({ companyId, mode, serviceProductId: productId, version: 1, updatedBy: actorId })
        .onConflictDoUpdate({ target: deliveryBillingSettings.companyId, set: { mode, serviceProductId: productId, version: sql`${deliveryBillingSettings.version} + 1`, updatedBy: actorId, updatedAt: sql`now()` } });
      await this.decisions.record(
        { companyId, subject: { type: 'delivery_billing', id: companyId }, action: 'delivery.billing_changed', actor: { type: 'user', id: actorId }, from: before?.mode ?? 'with_goods', to: mode, reason: { text: reason }, inputs: { serviceProductId: productId, before: before?.serviceProductId ?? null } },
        tx,
      );
    });
    return await this.get(companyId);
  }

  /** The delivery service item with what a reader needs to judge it. Null when it does not exist or has been removed. */
  private async item(companyId: string, productId: string): Promise<ServiceItemView | null> {
    const [p] = await this.db.select({ id: products.id, name: products.name, sku: products.sku, taxRate: products.taxRate, inventoryKind: products.inventoryKind }).from(products).where(and(eq(products.id, productId), isNull(products.deletedAt)));
    if (p === undefined) return null;
    const [registered] = await this.db.select({ id: etimsItems.id }).from(etimsItems).where(and(eq(etimsItems.productId, productId), eq(etimsItems.companyId, companyId), eq(etimsItems.status, 'registered'))).limit(1);
    return { id: p.id, name: p.name, sku: p.sku, taxRate: p.taxRate === null ? null : Number(p.taxRate), registered: registered !== undefined, isService: p.inventoryKind === 'service' };
  }
}
