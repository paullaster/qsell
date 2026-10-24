'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { fromCents } from '@/server/domains/finance/domain/receivables';
import { checkVendorCreation, type VendorCreation } from '@/lib/vendor-forms';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  createdAt: string;
  id: string;
}

const cursorOf = (value: unknown): Cursor | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { createdAt, id } = value as Record<string, unknown>;
  return typeof createdAt === 'string' && typeof id === 'string' && UUID.test(id) && createdAt.length <= 40 ? { createdAt, id } : null;
};

export async function listVendorsAction(filter: { q?: string; status?: string; before?: Cursor | null } = {}) {
  return run('vendors:read', { surface: 'vendors', action: 'list' }, async (ctx) => {
    const page = await getContainer().vendors.list(ctx.companyId, {
      q: typeof filter.q === 'string' ? filter.q.slice(0, 100) : undefined,
      status: typeof filter.status === 'string' ? filter.status : undefined,
      before: cursorOf(filter.before),
    });
    return {
      rows: page.rows.map((v) => ({
        id: v.id,
        number: v.number,
        legalName: v.legalName,
        tradingName: v.tradingName,
        email: v.email,
        phone: v.phone,
        status: v.status,
        block: v.block,
        createdByStaff: v.createdByStaff,
        createdAt: v.createdAt.toISOString(),
      })),
      next: page.next,
      can: { create: await canPermission('vendors:create') },
    };
  });
}

export async function vendorDetailAction(id: string) {
  return run('vendors:read', { surface: 'vendors', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const found = await container.vendors.get(ctx.companyId, id);
    if (found === null) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    await container.vendorLifecycle.ensureReasons(ctx.companyId);
    const canLedger = await canPermission('vendor_ledger:read');
    const balances = canLedger ? await container.finance.vendorLedger.balances(ctx.companyId, id) : [];
    const v = found.vendor;
    const [standing, canSuspend, canBlock, canArchive, canInvite] = await Promise.all([
      container.vendorLifecycle.standing(ctx.companyId, id),
      canPermission('vendors:suspend'),
      canPermission('vendors:block'),
      canPermission('vendors:archive'),
      canPermission('vendors:invite'),
    ]);
    return {
      standing,
      can: { suspend: canSuspend, block: canBlock, archive: canArchive, invite: canInvite },
      vendor: {
        id: v.id,
        number: v.number,
        status: v.status,
        block: v.block,
        vendorType: v.vendorType,
        legalName: v.legalName,
        tradingName: v.tradingName,
        taxId: v.taxId,
        vatNo: v.vatNo,
        registrationNo: v.registrationNo,
        country: v.country,
        email: v.email,
        phone: v.phone,
        paymentTermDays: v.paymentTermDays,
        currency: v.currency,
        approvedExpenseVendor: v.approvedExpenseVendor,
        createdByStaff: v.createdByStaff,
        notes: v.notes,
        createdAt: v.createdAt.toISOString(),
      },
      postingGroup: found.postingGroup,
      portalUsers: found.portalUsers.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.portal_role, status: u.status, lastLoginAt: u.last_login_at, joined: u.joined })),
      balances: balances.map((b) => ({ currency: b.currency, owed: fromCents(b.cents) })),
      canSeeLedger: canLedger,
      events: found.events.map((e) => ({
        id: String(e.id),
        event: e.event,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        reasonText: e.reasonText,
        actorType: e.actorType,
        at: e.createdAt.toISOString(),
      })),
    };
  });
}

/** Adds a vendor on the company's behalf. It is active at once only for a person who may do that and asked for it. */
export async function createVendorAction(form: VendorCreation, activate: boolean) {
  return run('vendors:create', { surface: 'vendors/new', action: 'create' }, async (ctx) => {
    const problems = checkVendorCreation(form);
    const first = Object.values(problems)[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    const mayActivate = activate && (await canPermission('vendors:create_active'));
    if (activate && !mayActivate) throw new FinanceError('NOT_ALLOWED', 'You may add a vendor, but not make it active without the vendor review.');
    return await getContainer().vendors.createByStaff(ctx, form, mayActivate);
  }, ['/admin/vendors']);
}
