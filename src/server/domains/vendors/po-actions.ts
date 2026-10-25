'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { emptyPoHeader, emptyPoLine, type PoHeaderForm, type PoLineForm } from '@/lib/purchase-order';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const headerOf = (raw: unknown): PoHeaderForm => {
  const f = obj(raw);
  const base = emptyPoHeader(businessDate());
  return {
    vendorId: str(f.vendorId, 40) === '' ? '' : id(f.vendorId),
    categoryId: str(f.categoryId, 40) === '' ? '' : id(f.categoryId),
    orderDate: str(f.orderDate, 12) === '' ? base.orderDate : str(f.orderDate, 12),
    expectedDate: str(f.expectedDate, 12),
    currency: str(f.currency, 5),
    paymentTerms: str(f.paymentTerms, 500),
    deliveryTerms: str(f.deliveryTerms, 500),
    notesToVendor: str(f.notesToVendor, 3000),
    internalNotes: str(f.internalNotes, 3000),
    requiresAdvancePayment: f.requiresAdvancePayment === true,
    noRfqReason: str(f.noRfqReason, 500),
  };
};

const linesOf = (raw: unknown): (PoLineForm & { id?: string })[] =>
  (Array.isArray(raw) ? raw.slice(0, 300) : []).map((x) => {
    const l = obj(x);
    const base = emptyPoLine();
    const line: PoLineForm & { id?: string } = {
      productId: str(l.productId, 80),
      description: str(l.description, 400),
      specification: str(l.specification, 2000),
      quantity: str(l.quantity, 20),
      unit: str(l.unit, 30) === '' ? base.unit : str(l.unit, 30),
      unitPrice: str(l.unitPrice, 20),
      discountPercent: str(l.discountPercent, 8),
      taxRate: str(l.taxRate, 8),
      expectedDate: str(l.expectedDate, 12),
    };
    if (typeof l.id === 'string' && UUID.test(l.id)) line.id = l.id;
    return line;
  });

export async function poListAction(filter: { status?: string; before?: { createdAt: string; id: string } | null } = {}) {
  return await run('purchase_orders:read', { surface: 'po/list', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.createdAt.length <= 40 ? filter.before : null;
    const page = await getContainer().purchaseOrders.list(ctx.companyId, { status: has(filter.status) ? str(filter.status, 30) : undefined, before });
    return {
      rows: page.rows.map((r) => ({ id: r.id, number: r.number, status: r.status, vendorName: r.vendorName, total: r.total, currency: r.currency, version: r.version, createdAt: r.createdAt.toISOString() })),
      next: page.next,
      can: { create: await canPermission('purchase_orders:create') },
    };
  });
}

export async function poAction(poId: string) {
  return await run('purchase_orders:read', { surface: 'po/view', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const got = await container.purchaseOrders.get(ctx.companyId, id(poId));
    if (got === null) throw new FinanceError('NOT_FOUND', 'That purchase order does not exist.');
    const [create, approve, release, amend, flag, cancel, skip, override, advCreate, advApprove, settings] = await Promise.all([
      canPermission('purchase_orders:create'), canPermission('purchase_orders:approve'), canPermission('purchase_orders:release'), canPermission('purchase_orders:amend'), canPermission('purchase_orders:flag_advance'),
      canPermission('purchase_orders:cancel'), canPermission('purchase_orders:skip_rfq'), canPermission('purchase_orders:override_qualification'), canPermission('vendor_advance:create'), canPermission('vendor_advance:approve'),
      container.purchaseOrders.settings(ctx.companyId),
    ]);
    const p = got.po;
    const qualified = (await container.prequalLifecycle.qualificationOf(ctx.companyId, p.vendorId, p.categoryId, businessDate())) !== null;
    return {
      id: p.id,
      number: p.number,
      version: p.version,
      status: p.status,
      vendor: { id: p.vendorId, label: got.vendorName },
      vendorNumber: got.vendorNumber,
      category: { id: p.categoryId, label: got.categoryName },
      rfqId: p.rfqId,
      rfqNumber: got.rfqNumber,
      noRfq: p.noRfq,
      qualified,
      qualificationOverrideReason: p.qualificationOverrideReason,
      createdByMe: p.createdBy === ctx.actor.id,
      form: {
        vendorId: p.vendorId,
        categoryId: p.categoryId,
        orderDate: p.orderDate,
        expectedDate: p.expectedDate ?? '',
        currency: p.currency,
        paymentTerms: p.paymentTerms ?? '',
        deliveryTerms: p.deliveryTerms ?? '',
        notesToVendor: p.notesToVendor ?? '',
        internalNotes: p.internalNotes ?? '',
        requiresAdvancePayment: p.requiresAdvancePayment,
        noRfqReason: p.noRfqReason ?? '',
      } satisfies PoHeaderForm,
      totals: { subtotal: p.subtotal, tax: p.taxTotal, total: p.total },
      lines: got.lines.map((l) => ({ id: l.id, productId: l.productId ?? '', productLabel: l.productName ?? undefined, description: l.description, specification: l.specification ?? '', quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRate: l.taxRate, expectedDate: l.expectedDate ?? '', received: l.receivedQuantity, invoiced: l.invoicedQuantity })),
      versions: got.versions.map((v) => ({ version: v.version, reason: v.reason, at: v.createdAt.toISOString() })),
      amendments: got.amendments.map((a) => ({ id: a.id, status: a.status, reason: a.reason, needsApproval: a.needsApproval, mine: a.proposedBy === ctx.actor.id, decisionNote: a.decisionNote, at: a.createdAt.toISOString() })),
      advances: got.advances.map((a) => ({ id: a.id, status: a.status, amount: a.amount, currency: a.currency, dueDate: a.dueDate, reason: a.reason, mine: a.createdBy === ctx.actor.id, decisionNote: a.decisionNote })),
      events: got.events.map((e) => ({ id: String(e.id), event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), actor: e.actorType })),
      cancelReason: p.cancelReason,
      confirmationNote: p.confirmationNote,
      rfqRequiredAbove: settings.rfqRequiredAbove,
      can: { create, approve, release, amend, flag, cancel, skipRfq: skip, overrideQualification: override, advanceCreate: advCreate, advanceApprove: advApprove },
    };
  });
}

export async function savePoAction(poId: string | null, header: unknown, lines: unknown) {
  return await run('purchase_orders:create', { surface: 'po/edit', action: poId === null ? 'create' : 'update' }, async (ctx) => {
    return await getContainer().purchaseOrders.saveDraft(ctx, poId === null ? null : id(poId), headerOf(header), linesOf(lines), await canPermission('purchase_orders:flag_advance'));
  }, ['/admin/vendors/orders']);
}

export async function toMakeAction(rfqId: string) {
  return await run('purchase_orders:read', { surface: 'po/from-award', action: 'view' }, async (ctx) => await getContainer().purchaseOrders.toMake(ctx.companyId, id(rfqId)));
}

export async function makeOrderFromAwardAction(rfqId: string, vendorId: string) {
  return await run('purchase_orders:create', { surface: 'po/from-award', action: 'make' }, async (ctx) => await getContainer().purchaseOrders.createFromAward(ctx, id(rfqId), id(vendorId)), ['/admin/vendors/orders']);
}

export async function submitPoAction(poId: string, overrideReason: string) {
  return await run('purchase_orders:create', { surface: 'po/edit', action: 'submit' }, async (ctx) => {
    const [maySkipRfq, mayOverrideQualification] = await Promise.all([canPermission('purchase_orders:skip_rfq'), canPermission('purchase_orders:override_qualification')]);
    await getContainer().purchaseOrders.submit(ctx, id(poId), { maySkipRfq, mayOverrideQualification, overrideReason: str(overrideReason) });
  }, ['/admin/vendors/orders']);
}

export async function approvePoAction(poId: string) {
  return await run('purchase_orders:approve', { surface: 'po/edit', action: 'approve' }, async (ctx) => await getContainer().purchaseOrders.approve(ctx, id(poId)), ['/admin/vendors/orders']);
}

export async function rejectPoAction(poId: string, reason: string) {
  return await run('purchase_orders:approve', { surface: 'po/edit', action: 'reject' }, async (ctx) => {
    await getContainer().purchaseOrders.reject(ctx, id(poId), str(reason));
  }, ['/admin/vendors/orders']);
}

export async function reopenPoAction(poId: string, reason: string) {
  return await run('purchase_orders:cancel', { surface: 'po/edit', action: 'reopen' }, async (ctx) => {
    await getContainer().purchaseOrders.reopen(ctx, id(poId), str(reason));
  }, ['/admin/vendors/orders']);
}

export async function sendPoAction(poId: string) {
  return await run('purchase_orders:release', { surface: 'po/edit', action: 'send' }, async (ctx) => {
    await getContainer().purchaseOrders.send(ctx, id(poId));
  }, ['/admin/vendors/orders']);
}

export async function recordPoConfirmationAction(poId: string, note: string) {
  return await run('purchase_orders:release', { surface: 'po/edit', action: 'record_confirmation' }, async (ctx) => {
    await getContainer().purchaseOrders.recordConfirmation(ctx, id(poId), str(note));
  }, ['/admin/vendors/orders']);
}

export async function cancelPoAction(poId: string, reason: string) {
  return await run('purchase_orders:cancel', { surface: 'po/edit', action: 'cancel' }, async (ctx) => {
    await getContainer().purchaseOrders.cancel(ctx, id(poId), str(reason));
  }, ['/admin/vendors/orders']);
}

export async function closePoAction(poId: string, reason: string) {
  return await run('purchase_orders:cancel', { surface: 'po/edit', action: 'close' }, async (ctx) => {
    await getContainer().purchaseOrders.close(ctx, id(poId), str(reason));
  }, ['/admin/vendors/orders']);
}

export async function amendPoAction(poId: string, header: unknown, lines: unknown, reason: string) {
  return await run('purchase_orders:amend', { surface: 'po/edit', action: 'amend' }, async (ctx) => {
    const h = headerOf(header);
    return await getContainer().purchaseOrders.amend(ctx, id(poId), { header: { expectedDate: h.expectedDate, paymentTerms: h.paymentTerms, deliveryTerms: h.deliveryTerms, notesToVendor: h.notesToVendor, requiresAdvancePayment: h.requiresAdvancePayment }, lines: linesOf(lines), reason: str(reason) }, await canPermission('purchase_orders:flag_advance'));
  }, ['/admin/vendors/orders']);
}

export async function decideAmendmentAction(amendmentId: string, approve: boolean, note: string) {
  return await run('purchase_orders:approve', { surface: 'po/edit', action: approve ? 'amendment_approve' : 'amendment_refuse' }, async (ctx) => {
    await getContainer().purchaseOrders.decideAmendment(ctx, id(amendmentId), approve, str(note));
  }, ['/admin/vendors/orders']);
}

// ── Advance payment document ──────────────────────────────────────────────────────────────────

export async function createAdvanceAction(poId: string, input: unknown) {
  return await run('vendor_advance:create', { surface: 'po/advance', action: 'create' }, async (ctx) => {
    const i = obj(input);
    return await getContainer().advances.create(ctx, id(poId), { amount: str(i.amount, 20), dueDate: str(i.dueDate, 12), reason: str(i.reason) });
  });
}

export async function submitAdvanceAction(advanceId: string) {
  return await run('vendor_advance:create', { surface: 'po/advance', action: 'submit' }, async (ctx) => {
    await getContainer().advances.submit(ctx, id(advanceId));
  });
}

export async function approveAdvanceAction(advanceId: string) {
  return await run('vendor_advance:approve', { surface: 'po/advance', action: 'approve' }, async (ctx) => {
    await getContainer().advances.approve(ctx, id(advanceId));
  });
}

export async function rejectAdvanceAction(advanceId: string, reason: string) {
  return await run('vendor_advance:approve', { surface: 'po/advance', action: 'reject' }, async (ctx) => {
    await getContainer().advances.reject(ctx, id(advanceId), str(reason));
  });
}

export async function cancelAdvanceAction(advanceId: string, reason: string) {
  return await run('vendor_advance:create', { surface: 'po/advance', action: 'cancel' }, async (ctx) => {
    await getContainer().advances.cancel(ctx, id(advanceId), str(reason));
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────────

export async function vendorSettingsAction() {
  return await run('vendor_settings:manage', { surface: 'vendors/settings', action: 'view' }, async (ctx) => {
    const s = await getContainer().purchaseOrders.settings(ctx.companyId);
    return { rfqRequiredAbove: s.rfqRequiredAbove ?? '', amendmentTolerancePercent: s.amendmentTolerancePercent, receiptTolerancePercent: s.receiptTolerancePercent };
  });
}

export async function saveVendorSettingsAction(input: unknown) {
  return await run('vendor_settings:manage', { surface: 'vendors/settings', action: 'save' }, async (ctx) => {
    const i = obj(input);
    await getContainer().purchaseOrders.saveSettings(ctx, { rfqRequiredAbove: str(i.rfqRequiredAbove, 20), amendmentTolerancePercent: str(i.amendmentTolerancePercent, 8), receiptTolerancePercent: str(i.receiptTolerancePercent, 8) });
  });
}
