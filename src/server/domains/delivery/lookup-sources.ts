import { DISPOSITION_WORDS, ISSUE_MOMENTS, ISSUE_MOMENT_WORDS, RETURN_DISPOSITIONS } from '@/lib/stock-issue';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { stockLocations, orders, orderVisits, branches, customerGroups, deliveryRiderSettings, deliveryRiders, bankAccounts, deliveryRuns, deliveryZones, glAccounts, paymentMethods, products, users } from '@/server/db/drizzle/schema';
import { COST_KINDS, COST_WORDS } from '@/lib/delivery-cost';
import { RIDER_KINDS, RIDER_KIND_WORDS, RIDER_STATUSES, RIDER_STATUS_WORDS } from '@/lib/delivery-rider';
import { RUN_STATUSES, RUN_STATUS_WORDS } from '@/lib/dispatch-run';
import { DELIVERY_STATUSES, FAILURE_REASONS, STATUS_WORDS } from '@/lib/delivery-document';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { CHANNELS } from '@/server/domains/pricing/domain/types';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The words for the parts of the business a charge can be limited to. */
export const CHANNEL_WORDS: Record<string, string> = { ecommerce: 'Web shop', sales_order: 'Sales orders', credit_sale: 'Credit sales', pos_cash_sale: 'Point of sale' };

/** The delivery zones, for choosing one in a rate or an area. Stopped zones are not offered. */
const zones = tableSource({
  key: 'delivery-zones',
  permission: 'deliveries:read',
  table: deliveryZones,
  id: deliveryZones.id,
  label: deliveryZones.code,
  searchColumns: [deliveryZones.code, deliveryZones.name],
  select: { name: deliveryZones.name },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(deliveryZones.companyId, companyId), eq(deliveryZones.isActive, true)) ?? sql`false`];
  },
  toOption: (row) => ({
    id: typeof row.id === 'string' ? row.id : '',
    label: `${typeof row.label === 'string' ? row.label : ''} · ${typeof row.name === 'string' ? row.name : ''}`,
    description: null,
    badge: null,
  }),
});

/** The branches, for choosing where a delivery leaves from or who a charge is for. Open branches only. Read with the delivery permission, not the branch one. */
const deliveryBranches = tableSource({
  key: 'delivery-branches',
  permission: 'deliveries:read',
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(branches.companyId, companyId), eq(branches.isActive, true)) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.code)} — ${text(row.label)}`, description: null, badge: null }),
});

/** The customer groups, for limiting a charge to a group. */
const deliveryCustomerGroups = tableSource({
  key: 'delivery-customer-groups',
  permission: 'deliveries:read',
  table: customerGroups,
  id: customerGroups.id,
  label: customerGroups.name,
  searchColumns: [customerGroups.name, customerGroups.code],
  select: { code: customerGroups.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [eq(customerGroups.companyId, companyId)];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} (${text(row.code)})`, description: null, badge: null }),
});

/** The parts of the business that make sales, for limiting a charge to one. */
const deliveryChannels = staticSource({
  key: 'delivery-channels',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return CHANNELS.map((id) => ({ id, label: CHANNEL_WORDS[id] ?? id, description: null }));
  },
});

/** The items that can stand for the delivery service on an invoice: live services only; the tax each carries is shown so a mismatch is seen at once. */
const serviceProducts = tableSource({
  key: 'delivery-service-products',
  permission: 'deliveries:read',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku],
  select: { sku: products.sku, tax: products.taxRate },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(isNull(products.deletedAt), eq(products.isActive, true), eq(products.inventoryKind, 'service')) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} (${text(row.sku)})`, description: row.tax === null || row.tax === undefined ? 'No tax rate set' : `Tax ${text(row.tax)}%`, badge: null }),
});

/** The states a delivery can be in, for filtering the deliveries list. */
const deliveryStatuses = staticSource({
  key: 'delivery-statuses',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return DELIVERY_STATUSES.map((status) => ({ id: status, label: STATUS_WORDS[status], description: null, badge: null }));
  },
});

/** Why a delivery attempt can fail, for the person who records it. */
const deliveryFailureReasons = staticSource({
  key: 'delivery-failure-reasons',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return FAILURE_REASONS.map((r) => ({ id: r.code, label: r.words, description: null, badge: null }));
  },
});

/** When the stock of a delivered order leaves the shelf. */
const stockIssueMoments = staticSource({
  key: 'stock-issue-moments',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return ISSUE_MOMENTS.map((id) => ({ id, label: ISSUE_MOMENT_WORDS[id].name, description: ISSUE_MOMENT_WORDS[id].means, badge: null }));
  },
});

/** What can be done with goods that came back. Which of these fit a product is the server's to say when it is received. */
const returnDispositions = staticSource({
  key: 'delivery-return-dispositions',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return RETURN_DISPOSITIONS.map((id) => ({ id, label: DISPOSITION_WORDS[id].name, description: DISPOSITION_WORDS[id].means, badge: null }));
  },
});

/** Runs still being planned, for putting a delivery on one. Newest day first. */
const openRuns = tableSource({
  key: 'delivery-open-runs',
  permission: 'deliveries:dispatch',
  table: deliveryRuns,
  id: deliveryRuns.id,
  label: deliveryRuns.number,
  searchColumns: [deliveryRuns.number, deliveryRuns.riderName],
  select: { rider: deliveryRuns.riderName, day: deliveryRuns.runDate },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(deliveryRuns.companyId, companyId), eq(deliveryRuns.status, 'planned')) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} · ${text(row.rider)} · ${text(row.day)}`, description: null, badge: null }),
});

/** The states a run can be in, for filtering the list of runs. */
const runStatuses = staticSource({
  key: 'delivery-run-statuses',
  permission: 'deliveries:dispatch',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return RUN_STATUSES.map((id) => ({ id, label: RUN_STATUS_WORDS[id], description: null, badge: null }));
  },
});

/** What a courier can report about a parcel. */
const courierNews = staticSource({
  key: 'courier-news',
  permission: 'deliveries:dispatch',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return [
      { id: 'in_transit', label: 'Still with the courier', description: 'Add a note or the courier’s tracking number', badge: null },
      { id: 'delivered', label: 'Delivered', description: 'The courier says the customer has it', badge: null },
      { id: 'exception', label: 'A problem', description: 'The courier could not deliver it', badge: null },
    ];
  },
});

// The zone picker stays first: other code (and its test) reaches it by position.
/** Riders who can be given a run now: riding, and of a kind the company uses (staff until it says otherwise). */
const riders = tableSource({
  key: 'delivery-riders',
  permission: 'deliveries:dispatch',
  table: deliveryRiders,
  id: deliveryRiders.id,
  label: deliveryRiders.name,
  searchColumns: [deliveryRiders.name, deliveryRiders.phone],
  select: { kind: deliveryRiders.kind, phone: deliveryRiders.phone },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    const kindUsed = sql`CASE ${deliveryRiders.kind}
      WHEN 'staff' THEN COALESCE((SELECT s.allow_staff FROM ${deliveryRiderSettings} s WHERE s.company_id = ${companyId}::uuid), true)
      ELSE COALESCE((SELECT s.allow_separate FROM ${deliveryRiderSettings} s WHERE s.company_id = ${companyId}::uuid), false) END`;
    return [and(eq(deliveryRiders.companyId, companyId), eq(deliveryRiders.status, 'active'), kindUsed) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: `${RIDER_KIND_WORDS[row.kind === 'separate' ? 'separate' : 'staff']}${typeof row.phone === 'string' && row.phone !== '' ? ` · ${row.phone}` : ''}`, badge: null }),
});

/** Members of staff who are not riders yet, for making one a rider. */
const staffToRide = tableSource({
  key: 'delivery-staff',
  permission: 'riders:manage',
  table: users,
  id: users.id,
  label: users.name,
  searchColumns: [users.name, users.email],
  select: { email: users.email },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [
      and(
        eq(users.status, 'active'),
        eq(users.isActive, true),
        sql`(${users.role} = 'super_admin' OR EXISTS (SELECT 1 FROM roles r WHERE r.key = ${users.role} AND r.is_staff AND r.is_active))`,
        sql`NOT EXISTS (SELECT 1 FROM ${deliveryRiders} dr WHERE dr.user_id = ${users.id} AND dr.company_id = ${companyId}::uuid)`,
      ) ?? sql`false`,
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.email), badge: null }),
});

const riderKinds = staticSource({
  key: 'delivery-rider-kinds',
  permission: 'riders:manage',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return RIDER_KINDS.map((id) => ({ id, label: RIDER_KIND_WORDS[id], description: null, badge: null }));
  },
});

const riderStatuses = staticSource({
  key: 'delivery-rider-statuses',
  permission: 'riders:manage',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return RIDER_STATUSES.map((id) => ({ id, label: RIDER_STATUS_WORDS[id], description: null, badge: null }));
  },
});

/** The payment methods of kind cash that are switched on: what cash taken at the door can be received through. */
const doorCashMethods = tableSource({
  key: 'door-cash-methods',
  permission: 'door_payments:manage',
  table: paymentMethods,
  id: paymentMethods.id,
  label: paymentMethods.name,
  searchColumns: [paymentMethods.name, paymentMethods.code],
  select: { code: paymentMethods.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.kind, 'cash'), eq(paymentMethods.enabled, true)) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: null }),
});

/** Till and bank accounts a rider's cash can be handed in to. Blocked accounts are not offered. */
const handInAccounts = tableSource({
  key: 'door-hand-in-accounts',
  permission: 'door_payments:handin',
  table: bankAccounts,
  id: bankAccounts.id,
  label: bankAccounts.name,
  searchColumns: [bankAccounts.name, bankAccounts.code],
  select: { code: bankAccounts.code, kind: bankAccounts.kind },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.blocked, false), sql`${bankAccounts.kind} IN ('cash','bank')`) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: text(row.kind) }),
});

/** Staff who can witness a count: active members of staff. */
const handInWitnesses = tableSource({
  key: 'door-hand-in-witnesses',
  permission: 'door_payments:handin',
  table: users,
  id: users.id,
  label: users.name,
  searchColumns: [users.name, users.email],
  select: { email: users.email },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(eq(users.status, 'active'), eq(users.isActive, true), sql`(${users.role} = 'super_admin' OR EXISTS (SELECT 1 FROM roles r WHERE r.key = ${users.role} AND r.is_staff AND r.is_active))`) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.email), badge: null }),
});

/** Books accounts a difference at a hand-in can be written to: open accounts that take postings. */
const varianceAccounts = tableSource({
  key: 'door-variance-accounts',
  permission: 'door_payments:manage',
  table: glAccounts,
  id: glAccounts.id,
  label: glAccounts.name,
  searchColumns: [glAccounts.name, glAccounts.no],
  select: { no: glAccounts.no },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false)) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.no)} ${text(row.label)}`.trim(), description: null, badge: null }),
});

/** Books accounts rider pay can be booked to: open accounts that take postings. */
const costAccounts = tableSource({
  key: 'delivery-cost-accounts',
  permission: 'delivery_costs:manage',
  table: glAccounts,
  id: glAccounts.id,
  label: glAccounts.name,
  searchColumns: [glAccounts.name, glAccounts.no],
  select: { no: glAccounts.no },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false)) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.no)} ${text(row.label)}`.trim(), description: null, badge: null }),
});

/** Payment methods a rider can be paid through: cash, mobile money or the bank, switched on. */
const payoutMethods = tableSource({
  key: 'rider-payout-methods',
  permission: 'delivery_costs:manage',
  table: paymentMethods,
  id: paymentMethods.id,
  label: paymentMethods.name,
  searchColumns: [paymentMethods.name, paymentMethods.code],
  select: { code: paymentMethods.code, kind: paymentMethods.kind },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), sql`${paymentMethods.kind} IN ('cash','mobile_money','bank_transfer','bank_deposit')`) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: text(row.kind) }),
});

/** Staff who can go on a visit's crew: active members of staff. */
const visitCrew = tableSource({
  key: 'visit-crew',
  permission: 'visits:manage',
  table: users,
  id: users.id,
  label: users.name,
  searchColumns: [users.name, users.email],
  select: { email: users.email },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(eq(users.status, 'active'), eq(users.isActive, true), sql`(${users.role} = 'super_admin' OR EXISTS (SELECT 1 FROM roles r WHERE r.key = ${users.role} AND r.is_staff AND r.is_active))`) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.email), badge: null }),
});

/** Orders a visit can be booked for: not closed, not delivered, and without a live visit already. */
const visitOrders = tableSource({
  key: 'visit-orders',
  permission: 'visits:manage',
  table: orders,
  id: orders.id,
  label: orders.orderNumber,
  searchColumns: [orders.orderNumber, orders.customerName, orders.customerPhone],
  select: { customer: orders.customerName },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [
      and(
        sql`${orders.status} NOT IN ('cancelled','refunded','failed','delivered','completed')`,
        sql`NOT EXISTS (SELECT 1 FROM ${orderVisits} v WHERE v.order_id = ${orders.id} AND v.status <> 'cancelled')`,
      ) ?? sql`false`,
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.customer), badge: null }),
});

/** Products whose stock a crew can use on a visit: products that hold stock. */
const visitProducts = tableSource({
  key: 'visit-products',
  permission: 'visits:work',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku, products.stockCode],
  select: { sku: products.sku },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(isNull(products.deletedAt), eq(products.inventoryKind, 'inventory')) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.sku) === '' ? null : text(row.sku), badge: null }),
});

/** Where the materials are taken from: the company's open places that hold stock. */
const visitLocations = tableSource({
  key: 'visit-locations',
  permission: 'visits:work',
  table: stockLocations,
  id: stockLocations.id,
  label: stockLocations.name,
  searchColumns: [stockLocations.code, stockLocations.name],
  select: { code: stockLocations.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(stockLocations.companyId, companyId), eq(stockLocations.isActive, true), sql`${stockLocations.kind} NOT IN ('transit','damaged','quarantine')`) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: null }),
});

const costKinds = staticSource({
  key: 'delivery-cost-kinds',
  permission: 'delivery_costs:manage',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return COST_KINDS.map((id) => ({ id, label: COST_WORDS[id], description: null, badge: null }));
  },
});

export const DELIVERY_LOOKUP_SOURCES: LookupSource[] = [zones, deliveryBranches, deliveryCustomerGroups, deliveryChannels, serviceProducts, deliveryStatuses, deliveryFailureReasons, stockIssueMoments, returnDispositions, openRuns, runStatuses, courierNews, riders, staffToRide, riderKinds, riderStatuses, doorCashMethods, handInAccounts, handInWitnesses, varianceAccounts, costKinds, payoutMethods, costAccounts, visitCrew, visitOrders, visitProducts, visitLocations];
