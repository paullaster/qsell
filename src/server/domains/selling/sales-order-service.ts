import { and, desc, eq, not, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, orders, users } from '@/server/db/drizzle/schema';
import { OrderWriteService } from '@/server/domains/orders/write-service';
import { WEB_SHOP_ORDER } from '@/server/domains/orders/order-origin';
import type { PackageOrderService } from '@/server/domains/pricing/package-order-service';
import { decodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { PAGE_SIZE, pageOf } from '@/server/domains/settings/paging';
import type { CustomerMasterService } from '@/server/domains/customers/master-service';
import type { CustomerCreditSettingsService } from '@/server/domains/customers/customer-credit-settings-service';
import type { CustomerLedgerService } from '@/server/domains/finance/receivables/customer-ledger-service';
import { displayedAvailableCredit, type CreditLimitDisplay } from '@/lib/customer-credit-settings';
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
  creditLimitDisplay: CreditLimitDisplay;
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
export type PlacedKind = 'sales_order' | 'sales_invoice' | 'credit_sale' | 'pos_cash_sale';

/** What only some kinds of order carry: the shift a counter sale is rung up in, the key that makes a retry safe, and a check on the priced total. */
export interface PlaceExtra {
  shiftId?: string;
  idempotencyKey?: string;
  checkTotal?: (totals: { subtotal: number; tax: number; totalAmount: number }) => string | null;
  /** Prices fixed beforehand (a sale rung up offline is accepted at the price the customer paid), and the totals that come of them. */
  quotedItems?: Parameters<typeof OrderWriteService.createOrder>[0]['quotedItems'];
  quotedTotals?: Parameters<typeof OrderWriteService.createOrder>[0]['quotedTotals'];
  skipOfferedCheck?: boolean;
  /** The quote this order came from: the order keeps it, and the quote's own prices stand. */
  sourceQuoteId?: string;
}

/** Sales orders taken by staff: placing one (through the order writer, with the company's settings for the kind), the customer's credit position, and the list. */
export class SalesOrderService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly settings: SellingSettingsService,
    private readonly packageOrders: PackageOrderService,
    private readonly customerMaster: CustomerMasterService,
    private readonly branches: BranchRepository,
    private readonly customerCreditSettings: CustomerCreditSettingsService,
    private readonly customerLedger: CustomerLedgerService,
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
    const display = await this.customerCreditSettings.get(companyId);
    const netOwedCents = hasCreditAccount ? await this.customerLedger.netOwedCents(companyId, c.id) : 0;
    const balance = netOwedCents / 100;
    const available = displayedAvailableCredit(Math.round(creditLimit * 100), netOwedCents, display.creditLimitDisplay) / 100;
    const overdue = settings.creditCheck === 'limit_and_overdue' && hasCreditAccount && (await this.customerMaster.hasOverdueInvoice(c.id, settings.overdueDays));
    return { customerId: c.id, name: c.name, hasCreditAccount, creditLimit, balance, available, creditLimitDisplay: display.creditLimitDisplay, termDays: c.paymentTermDays, blocked: c.blocked !== 'none', overdue };
  }

  /** Everything the writer needs to price or place this order, or why it cannot be (an unknown customer, a blocked one, a package choice that is not real). */
  private async prepare(companyId: string, who: { userId: string; branchId: string | null }, input: SalesOrderInput, kind: PlacedKind): Promise<{ ok: true; params: Parameters<typeof OrderWriteService.createOrder>[0] } | { ok: false; error: string }> {
    const [customer] = await this.db.select().from(customers).where(and(eq(customers.id, input.customerId), eq(customers.companyId, companyId), eq(customers.isActive, true))).limit(1);
    if (customer === undefined) return { ok: false, error: 'That customer could not be found.' };
    if (customer.blocked !== 'none') return { ok: false, error: `${customer.name} is blocked from buying (${customer.blocked}).` };

    // A package line was chosen by slot name and part (as a quote keeps it); today's slots and options are found again here.
    const packageLines = input.lines.flatMap((line, index) => (line.package === undefined ? [] : [{ index, productId: line.productId, stored: line.package.picks }]));
    const resolved = await this.packageOrders.resolve(companyId, packageLines);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const branchId = who.branchId ?? (await this.branches.getDefault(companyId))?.id ?? null;
    const selling = await this.settings.get(companyId, kind);
    return {
      ok: true,
      params: {
        branchId,
        customerId: customer.id,
        customerName: customer.name,
        customerEmail: customer.email ?? '',
        customerPhone: text(customer.phone, '—'),
        shippingAddress: { street: text(customer.street, 'Not given'), city: text(customer.city, 'Not given'), countyOrState: text(customer.countyOrState, 'Not given'), ...(customer.postalCode === null ? {} : { postalCode: customer.postalCode }), country: text(customer.country, 'Kenya') },
        items: input.lines.map((line, index) => {
          const at = packageLines.findIndex((p) => p.index === index);
          const picks = at < 0 ? undefined : resolved.picks[at];
          return { productId: line.productId, quantity: line.quantity, ...(line.unitPrice !== undefined && picks === undefined ? { priceOverride: line.unitPrice } : {}), ...(line.discount !== undefined && picks === undefined ? { manualDiscount: line.discount } : {}), ...(picks === undefined ? {} : { package: { picks, ...(line.package?.note === undefined || line.package.note === '' ? {} : { note: line.package.note }) } }) };
        }),
        currency: 'KES',
        // How they are expected to pay is a label: money is received by receipt, and a customer's credit comes from their account, not from this.
        paymentMethod: kind === 'credit_sale' ? 'on_account' : input.paymentMethod,
        // A credit sale is an order on account, which the writer turns into a credit sale; the staff channel is still named so staff rules apply.
        salesModule: kind === 'credit_sale' ? 'sales_order' : kind,
        requestedBy: who.userId,
        selling,
        holdUntilPaid: input.holdUntilPaid,
        ...(input.neededOn === '' ? {} : { fulfilmentDate: input.neededOn }),
      },
    };
  }

  /** Places the order as the kind of selling document it is, behaving as the company's settings for that kind say. Nothing here is a price: the writer works them out. */
  async place(companyId: string, who: { userId: string; branchId: string | null }, input: SalesOrderInput, kind: PlacedKind = 'sales_order', extra: PlaceExtra = {}): Promise<PlaceOutcome> {
    const prepared = await this.prepare(companyId, who, input, kind);
    if (!prepared.ok) return prepared;
    const result = await OrderWriteService.createOrder({ ...prepared.params, ...extra });
    if (!result.success || result.order === undefined) return { ok: false, error: result.error ?? 'The order could not be placed.' };
    return { ok: true, orderId: result.order.id, orderNumber: result.order.orderNumber, waitingForApproval: result.order.approvalStatus === 'pending' };
  }

  /** What this order would total, worked out by the same pricing as placing it, without placing anything. For the till as lines are added. */
  async price(companyId: string, who: { userId: string; branchId: string | null }, input: SalesOrderInput, kind: PlacedKind): Promise<{ ok: true; subtotal: number; tax: number; total: number; lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number }[] } | { ok: false; error: string }> {
    const prepared = await this.prepare(companyId, who, input, kind);
    if (!prepared.ok) return prepared;
    const result = await OrderWriteService.createOrder({ ...prepared.params, previewOnly: true });
    if (!result.success || result.preview === undefined) return { ok: false, error: result.error ?? 'The total could not be worked out.' };
    return { ok: true, subtotal: result.preview.subtotal, tax: result.preview.tax, total: result.preview.totalAmount, lines: result.preview.lines };
  }

  /** The sales orders staff took, newest first (the next page begins at `cursor`), narrowed by words or by status. */
  async page(companyId: string, input: { query?: string; status?: string; cursor?: string | null }, kind: 'sales_order' | 'credit_sale' = 'sales_order'): Promise<{ rows: SalesOrderRow[]; nextCursor: string | null }> {
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
          eq(orders.salesModule, kind),
          kind === 'credit_sale' ? not(WEB_SHOP_ORDER) : undefined,
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
