import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, orders, users } from '@/server/db/drizzle/schema';
import { OrderWriteService } from '@/server/domains/orders/write-service';
import type { PackageOrderService } from '@/server/domains/pricing/package-order-service';
import { decodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { PAGE_SIZE, pageOf } from '@/server/domains/settings/paging';
import type { CustomerMasterService } from '@/server/domains/customers/master-service';
import type { BranchRepository } from '@/server/domains/branches/repository';
import type { SalesOrderInput } from './domain/sales-order-input';
import type { SellingSettingsService } from './selling-settings-service';

export type PlaceOutcome = { ok: true; orderId: string; orderNumber: string; waitingForApproval: boolean } | { ok: false; error: string };

/** Where a customer stands for credit, for the person about to sell to them. */
export interface CreditPosition {
  customerId: string;
  name: string;
  hasCreditAccount: boolean;
  creditLimit: number;
  balance: number;
  /** What is left of the limit (never below nothing). */
  available: number;
  termDays: number;
  blocked: boolean;
  /** An invoice is overdue by more than the days the kind of sale looks at (only when it looks at overdue invoices). */
  overdue: boolean;
}

export interface SalesOrderRow {
  id: string;
  orderNumber: string;
  customerName: string;
  total: number;
  currency: string;
  status: string;
  paymentStatus: string;
  approvalStatus: string;
  createdAt: string;
}

const text = (value: string | null | undefined, fallback: string): string => (value === null || value === undefined || value.trim() === '' ? fallback : value.trim());

/** The kinds of document this service places: an order for later, or a sale invoiced directly. Each behaves by the company's settings for its kind. */
export type PlacedKind = 'sales_order' | 'sales_invoice';

/** Sales orders taken by staff: placing one (through the order writer, with the company's settings for the kind), the customer's credit position, and the list. */
export class SalesOrderService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly settings: SellingSettingsService,
    private readonly packageOrders: PackageOrderService,
    private readonly customerMaster: CustomerMasterService,
    private readonly branches: BranchRepository,
  ) {}

  /** The branch a member of staff works in, or null (then the company's default branch is used). */
  async branchOf(userId: string): Promise<string | null> {
    const [row] = await this.db.select({ branchId: users.branchId }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.branchId ?? null;
  }

  async creditPosition(companyId: string, customerId: string, kind: PlacedKind = 'sales_order'): Promise<CreditPosition | null> {
    const found = await this.customerMaster.getCustomer(companyId, customerId);
    if (found === null) return null;
    const c = found.customer;
    const settings = await this.settings.get(companyId, kind);
    const hasCreditAccount = c.accountType === 'credit';
    const creditLimit = Number(c.creditLimit);
    const balance = Number(c.balance);
    const overdue = settings.creditCheck === 'limit_and_overdue' && hasCreditAccount && (await this.customerMaster.hasOverdueInvoice(c.id, settings.overdueDays));
    return { customerId: c.id, name: c.name, hasCreditAccount, creditLimit, balance, available: Math.max(0, creditLimit - balance), termDays: c.paymentTermDays, blocked: c.blocked !== 'none', overdue };
  }

  /** Places the order as a sales order, behaving as the company's settings for sales orders say. Nothing here is a price: the writer works them out. */
  async place(companyId: string, who: { userId: string; branchId: string | null }, input: SalesOrderInput, kind: PlacedKind = 'sales_order'): Promise<PlaceOutcome> {
    const [customer] = await this.db.select().from(customers).where(and(eq(customers.id, input.customerId), eq(customers.companyId, companyId), eq(customers.isActive, true))).limit(1);
    if (customer === undefined) return { ok: false, error: 'That customer could not be found.' };
    if (customer.blocked !== 'none') return { ok: false, error: `${customer.name} is blocked from buying (${customer.blocked}).` };

    // A package line was chosen by slot name and part (as a quote keeps it); today's slots and options are found again here.
    const packageLines = input.lines.flatMap((line, index) => (line.package === undefined ? [] : [{ index, productId: line.productId, stored: line.package.picks }]));
    const resolved = await this.packageOrders.resolve(companyId, packageLines);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const branchId = who.branchId ?? (await this.branches.getDefault(companyId))?.id ?? null;
    const selling = await this.settings.get(companyId, kind);
    const result = await OrderWriteService.createOrder({
      branchId,
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email ?? '',
      customerPhone: text(customer.phone, '—'),
      shippingAddress: { street: text(customer.street, 'Not given'), city: text(customer.city, 'Not given'), countyOrState: text(customer.countyOrState, 'Not given'), ...(customer.postalCode === null ? {} : { postalCode: customer.postalCode }), country: text(customer.country, 'Kenya') },
      items: input.lines.map((line, index) => {
        const at = packageLines.findIndex((p) => p.index === index);
        const picks = at < 0 ? undefined : resolved.picks[at];
        return { productId: line.productId, quantity: line.quantity, ...(picks === undefined ? {} : { package: { picks, ...(line.package?.note === undefined || line.package.note === '' ? {} : { note: line.package.note }) } }) };
      }),
      currency: 'KES',
      // How they are expected to pay is a label: money is received by receipt, and a customer's credit comes from their account, not from this.
      paymentMethod: input.paymentMethod,
      salesModule: kind,
      requestedBy: who.userId,
      selling,
      holdUntilPaid: input.holdUntilPaid,
      ...(input.neededOn === '' ? {} : { fulfilmentDate: input.neededOn }),
    });
    if (!result.success || result.order === undefined) return { ok: false, error: result.error ?? 'The order could not be placed.' };
    return { ok: true, orderId: result.order.id, orderNumber: result.order.orderNumber, waitingForApproval: result.order.approvalStatus === 'pending' };
  }

  /** The sales orders staff took, newest first (the next page begins at `cursor`), narrowed by words or by status. */
  async page(companyId: string, input: { query?: string; status?: string; cursor?: string | null }): Promise<{ rows: SalesOrderRow[]; nextCursor: string | null }> {
    const query = (input.query ?? '').trim().slice(0, 100);
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const pattern = `%${escapeLike(query)}%`;
    const rows = await this.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        total: orders.totalAmount,
        currency: orders.currency,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        approvalStatus: orders.approvalStatus,
        key: sql<string>`${orders.createdAt}::text`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.salesModule, 'sales_order'),
          input.status === undefined || input.status === '' ? undefined : eq(orders.status, input.status),
          query === '' ? undefined : sql`(${orders.orderNumber} ILIKE ${pattern} OR ${orders.customerName} ILIKE ${pattern})`,
          after === null ? undefined : sql`(${orders.createdAt}, ${orders.id}) < (${after.k}::timestamptz, ${after.id})`,
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (r) => ({ k: r.key, id: r.id }));
    return { rows: page.rows.map((r) => ({ id: r.id, orderNumber: r.orderNumber, customerName: r.customerName, total: Number(r.total), currency: r.currency, status: r.status, paymentStatus: r.paymentStatus, approvalStatus: r.approvalStatus, createdAt: r.key })), nextCursor: page.nextCursor };
  }
}

