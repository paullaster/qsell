'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { postingPermissions, run } from '../action-runner';
import { FinanceError } from '../errors';
import { PostingError } from '../engine';
import type { BankAccountInput } from './bank-account-service';
import type { PaymentMethodInput } from './payment-method-service';
import type { AllocateMode, ReceiptInput, ReceiptListFilter } from './receipt-service';
import { fromCents } from '../domain/receivables';

import { has } from '@/lib/values';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance';
const BANK = `${ROOT}/bank-accounts`;
const METHODS = '/admin/settings/payments';
const RECEIPTS = `${ROOT}/receipts`;

// ── bank accounts ─────────────────────────────────────────────────────────

export async function listBankAccountsAction() {
  return run('bank_accounts:read', { surface: 'finance/bank-accounts', action: 'list' }, async (ctx) => {
    const rows = await fin().bankAccounts.list(ctx.companyId);
    const settings = await fin().setup.getSettings(ctx.companyId);
    return {
      baseCurrency: settings?.baseCurrency ?? null,
      accounts: rows.map((r) => ({
        id: r.account.id,
        code: r.account.code,
        name: r.account.name,
        kind: r.account.kind,
        currency: r.account.currency,
        glNos: r.glNos,
        feeGlAccountId: r.account.feeGlAccountId,
        feeGlLabel: r.feeGlLabel,
        providerConfigId: r.account.providerConfigId,
        providerLabel: r.providerLabel,
        details: r.account.details,
        blocked: r.account.blocked,
        balance: r.balance,
        methods: r.methods,
      })),
      can: {
        create: await canPermission('bank_accounts:create'),
        edit: await canPermission('bank_accounts:edit'),
        block: await canPermission('bank_accounts:block'),
        delete: await canPermission('bank_accounts:delete'),
        seed: await canPermission('payment_setup:seed'),
        ledger: await canPermission('bank_ledger:read'),
      },
    };
  });
}

export async function createBankAccountAction(input: BankAccountInput) {
  return run('bank_accounts:create', { surface: 'finance/bank-accounts', action: 'create' }, async (ctx) => {
    const row = await fin().bankAccounts.create(ctx, input);
    return { id: row.id };
  }, [BANK]);
}

export async function updateBankAccountAction(id: string, patch: Partial<BankAccountInput>) {
  return run('bank_accounts:edit', { surface: 'finance/bank-accounts', action: 'update' }, async (ctx) => {
    await fin().bankAccounts.update(ctx, id, patch);
  }, [BANK]);
}

export async function blockBankAccountAction(id: string, blocked: boolean, reason?: string) {
  return run('bank_accounts:block', { surface: 'finance/bank-accounts', action: blocked ? 'block' : 'unblock' }, async (ctx) => {
    await fin().bankAccounts.setBlocked(ctx, id, blocked, reason);
  }, [BANK]);
}

export async function deleteBankAccountAction(id: string) {
  return run('bank_accounts:delete', { surface: 'finance/bank-accounts', action: 'delete' }, async (ctx) => {
    await fin().bankAccounts.delete(ctx, id);
  }, [BANK]);
}

export async function bankLedgerAction(id: string) {
  return run('bank_ledger:read', { surface: 'finance/bank-accounts', action: 'ledger' }, async (ctx) => {
    const account = await fin().bankAccounts.get(ctx.companyId, id);
    if (!account) throw new FinanceError('NOT_FOUND', 'That bank account does not exist.');
    const entries = await fin().bankAccounts.ledger(ctx.companyId, id);
    return {
      account: { id: account.id, code: account.code, name: account.name, currency: account.currency },
      entries: entries.map((e) => ({
        id: e.id,
        postingDate: e.posting_date,
        documentType: e.document_type,
        documentNo: e.document_no,
        description: e.description,
        amount: e.amount,
        running: e.running,
      })),
    };
  });
}

// ── payment methods and setup ─────────────────────────────────────────────

export async function createPaymentMethodAction(input: PaymentMethodInput) {
  return run('payment_methods:create', { surface: 'settings/payments', action: 'create' }, async (ctx) => {
    const row = await fin().paymentMethods.create(ctx, input);
    return { id: row.id };
  }, [METHODS]);
}

export async function updatePaymentMethodAction(id: string, patch: Partial<PaymentMethodInput>) {
  return run('payment_methods:edit', { surface: 'settings/payments', action: 'update' }, async (ctx) => {
    await fin().paymentMethods.update(ctx, id, patch);
  }, [METHODS]);
}

export async function setPaymentMethodEnabledAction(id: string, enabled: boolean, reason?: string) {
  return run('payment_methods:disable', { surface: 'settings/payments', action: enabled ? 'enable' : 'disable' }, async (ctx) => {
    await fin().paymentMethods.setEnabled(ctx, id, enabled, reason);
  }, [METHODS]);
}

export async function deletePaymentMethodAction(id: string) {
  return run('payment_methods:delete', { surface: 'settings/payments', action: 'delete' }, async (ctx) => {
    await fin().paymentMethods.delete(ctx, id);
  }, [METHODS]);
}

export async function seedPaymentSetupAction() {
  return run('payment_setup:seed', { surface: 'finance/payment-setup', action: 'seed' }, async (ctx) => {
    return fin().paymentMethods.seedStandard(ctx);
  }, [BANK, METHODS]);
}

export async function linkOrdersToMethodsAction() {
  return run('payment_setup:link_orders', { surface: 'finance/payment-setup', action: 'link_orders' }, async (ctx) => {
    return { linked: await fin().paymentMethods.backfillOrders(ctx) };
  }, [METHODS]);
}

// ── receipts ──────────────────────────────────────────────────────────────

export async function receiptFormOptionsAction() {
  return run('receipts:create', { surface: 'finance/receipts', action: 'form_options' }, async (ctx) => {
    const settings = await fin().setup.getSettings(ctx.companyId);
    return { baseCurrency: settings?.baseCurrency ?? 'KES' };
  });
}

/** Arriving from a customer's statement (?customer=<their number>): the customer, already chosen. */
export async function receiptPresetCustomerAction(number: string) {
  return run('receipts:create', { surface: 'finance/receipts', action: 'preset_customer' }, async (ctx) => {
    const found = (await fin().receipts.searchCustomers(ctx.companyId, number)).find((c) => c.number === number);
    if (found === undefined) return null;
    return { id: found.id, label: found.name, meta: { number: found.number, phone: found.phone ?? '', accountType: found.accountType, balance: found.balance } };
  });
}

export async function listReceiptsAction(filter: ReceiptListFilter = {}) {
  return run('receipts:read', { surface: 'finance/receipts', action: 'list' }, async (ctx) => {
    const page = await fin().receipts.list(ctx.companyId, filter);
    return {
      nextBefore: page.nextBefore,
      rows: page.rows.map((r) => ({
        id: r.receipt.id,
        number: r.receipt.number,
        status: r.receipt.status,
        chequeStatus: r.receipt.chequeStatus,
        amount: r.receipt.amount,
        currency: r.receipt.currency,
        paymentDate: r.receipt.paymentDate,
        postingDate: r.receipt.postingDate,
        reference: r.receipt.externalReference,
        customerId: r.receipt.customerId,
        customerName: r.customerName,
        customerNumber: r.customerNumber,
        methodName: r.methodName,
        bankCode: r.bankCode,
        source: r.receipt.source,
        createdAt: r.receipt.createdAt.toISOString(),
      })),
      can: {
        create: await canPermission('receipts:create'),
      },
    };
  });
}

export async function receiptDetailAction(id: string) {
  return run('receipts:read', { surface: 'finance/receipts', action: 'view' }, async (ctx) => {
    const d = await fin().receipts.detail(ctx.companyId, id);
    if (!d) throw new FinanceError('NOT_FOUND', 'That receipt does not exist.');
    const media = getContainer().media;
    const attachments = await Promise.all(
      d.attachments.map(async (a) => ({
        id: a.id,
        fileName: a.fileName,
        note: a.note,
        uploadedBy: a.uploadedBy,
        createdAt: a.createdAt.toISOString(),
        url: await media.deliveryUrlById(a.mediaAssetId).catch(() => null),
      })),
    );
    const r = d.receipt;
    return {
      receipt: {
        id: r.id,
        number: r.number,
        status: r.status,
        chequeStatus: r.chequeStatus,
        amount: r.amount,
        currency: r.currency,
        rate: r.rate,
        paymentDate: r.paymentDate,
        postingDate: r.postingDate,
        reference: r.externalReference,
        payerName: r.payerName,
        counterparty: r.counterparty,
        narration: r.narration,
        source: r.source,
        postedAt: r.postedAt ? r.postedAt.toISOString() : null,
        postedBy: has(r.postedBy) ? (d.actors[r.postedBy] ?? r.postedBy) : null,
        createdBy: d.actors[r.createdBy] ?? r.createdBy,
        createdAt: r.createdAt.toISOString(),
        registerId: r.registerId,
      },
      customer: { id: d.customer.id, number: d.customer.number, name: d.customer.name },
      method: { name: d.method.name, kind: d.method.kind, requiresEvidence: d.method.requiresEvidence },
      bank: { id: d.bank.id, code: d.bank.code, name: d.bank.name },
      depositedInto: d.depositedInto,
      unapplied: fromCents(d.unappliedCents),
      isDeposit: d.receipt.isDeposit,
      wallet: await (async () => {
        const p = await getContainer().finance.creditPolicy.forCustomer(getContainer().db, ctx.companyId, d.customer.id, d.receipt.postingDate);
        return { enabled: p.walletEnabled, label: p.label };
      })(),
      applications: d.applications.map((a) => ({
        applicationId: a.application_id,
        invoiceNo: a.document_no,
        amount: a.amount,
        at: a.at,
        undone: a.undone,
      })),
      events: d.events.map((e) => ({
        id: String(e.id),
        event: e.event,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        reasonCode: e.reasonCode,
        reasonText: e.reasonText,
        actorId: has(e.actorId) ? (d.actors[e.actorId] ?? e.actorId) : null,
        actorType: e.actorType,
        surface: (e.origin as { surface?: string }).surface ?? null,
        permission: (e.origin as { permissionUsed?: string }).permissionUsed ?? null,
        at: e.createdAt.toISOString(),
        data: e.data,
      })),
      attachments,
      can: {
        post: await canPermission('receipts:post'),
        cancel: await canPermission('receipts:cancel_draft'),
        apply: await canPermission('receipts:apply'),
        unapply: await canPermission('receipts:unapply'),
        reverse: await canPermission('receipts:reverse'),
        attach: await canPermission('receipts:attach_evidence'),
        giveUpCredit: await canPermission('credit_adjustments:request'),
        deposit: await canPermission('cheques:deposit'),
        clear: await canPermission('cheques:clear'),
        bounce: await canPermission('cheques:bounce'),
        moveToWallet: await canPermission('wallet:move_receipt'),
      },
    };
  });
}

/**
 * Records a receipt, and posts it in the same request when asked. Doing both in one call means a
 * lost connection can never leave the form half-done, and the trail shows each step with the
 * permission that allowed it. If posting is refused the draft is kept and the reason is returned.
 */
export async function createReceiptAction(input: ReceiptInput, post?: { allocate: AllocateMode }) {
  return run(
    'receipts:create',
    { surface: 'finance/receipts/new', action: post ? 'create_and_post' : 'create_draft' },
    async (ctx) => {
      if (input.isDeposit === true && !(await canPermission('wallet:deposit'))) {
        throw new FinanceError('CANNOT_DEPOSIT', 'You may not record advance deposits.');
      }
      if (post && !(await canPermission('receipts:post'))) {
        throw new FinanceError('CANNOT_POST', 'You may record receipts but not post them. Save it as a draft instead.');
      }
      const created = await fin().receipts.create(ctx, { ...input, source: 'manual' });
      if (!post) return { ...created, posted: false, postError: null as string | null };
      try {
        await fin().receipts.post(
          { ...ctx, origin: { ...ctx.origin, permissionUsed: 'receipts:post' } },
          created.id,
          { allocate: post.allocate, permissions: await postingPermissions() },
        );
        return { ...created, posted: true, postError: null as string | null };
      } catch (error) {
        if (error instanceof FinanceError || error instanceof PostingError) {
          return { ...created, posted: false, postError: error.message };
        }
        console.error('[finance] posting a new receipt failed', error);
        return { ...created, posted: false, postError: 'Something went wrong while posting. The draft was saved.' };
      }
    },
    [RECEIPTS],
  );
}

export async function postReceiptAction(id: string, allocate: AllocateMode = 'oldest_first') {
  return run('receipts:post', { surface: 'finance/receipts/detail', action: 'post' }, async (ctx) => {
    const out = await fin().receipts.post(ctx, id, { allocate, permissions: await postingPermissions() });
    return { number: out.number, applied: fromCents(out.appliedCents), glPosted: out.glPosted };
  }, [RECEIPTS, `${RECEIPTS}/${id}`]);
}

export async function cancelReceiptAction(id: string, reason: { code: string; text?: string }) {
  return run('receipts:cancel_draft', { surface: 'finance/receipts/detail', action: 'cancel_draft' }, async (ctx) => {
    await fin().receipts.cancelDraft(ctx, id, reason);
  }, [RECEIPTS, `${RECEIPTS}/${id}`]);
}

export async function applyReceiptAction(id: string, applications: { entryId: string; amount: string }[] | 'oldest_first') {
  return run('receipts:apply', { surface: 'finance/receipts/detail', action: 'apply' }, async (ctx) => {
    const { toCents } = await import('../domain/receivables');
    const planned = applications === 'oldest_first' ? 'oldest_first' : applications.map((a) => ({ entryId: a.entryId, amountCents: toCents(a.amount) }));
    const out = await fin().receipts.apply(ctx, id, planned);
    return { applied: fromCents(out.appliedCents) };
  }, [RECEIPTS, `${RECEIPTS}/${id}`]);
}

export async function unapplyReceiptAction(receiptId: string, applicationId: string, reason: { code: string; text?: string }) {
  return run('receipts:unapply', { surface: 'finance/receipts/detail', action: 'unapply' }, async (ctx) => {
    const out = await fin().receipts.unapply(ctx, receiptId, applicationId, reason);
    return { restored: fromCents(out.restoredCents) };
  }, [RECEIPTS, `${RECEIPTS}/${receiptId}`]);
}

export async function reverseReceiptAction(id: string, reason: { code: string; text?: string }) {
  return run('receipts:reverse', { surface: 'finance/receipts/detail', action: 'reverse' }, async (ctx) => {
    await fin().receipts.reverse(ctx, id, reason, { permissions: await postingPermissions() });
  }, [RECEIPTS, `${RECEIPTS}/${id}`]);
}

export async function depositChequeAction(id: string, depositMethodId: string, date?: string) {
  return run('cheques:deposit', { surface: 'finance/receipts/detail', action: 'cheque_deposit' }, async (ctx) => {
    await fin().receipts.depositCheque(ctx, id, { depositMethodId, date });
  }, [RECEIPTS, `${RECEIPTS}/${id}`]);
}

export async function clearChequeAction(id: string, date?: string) {
  return run('cheques:clear', { surface: 'finance/receipts/detail', action: 'cheque_clear' }, async (ctx) => {
    await fin().receipts.clearCheque(ctx, id, { date, permissions: await postingPermissions() });
  }, [RECEIPTS, `${RECEIPTS}/${id}`]);
}

export async function bounceChequeAction(id: string, reason: { code: string; text?: string }) {
  return run('cheques:bounce', { surface: 'finance/receipts/detail', action: 'cheque_bounce' }, async (ctx) => {
    await fin().receipts.bounceCheque(ctx, id, reason, { permissions: await postingPermissions() });
  }, [RECEIPTS, `${RECEIPTS}/${id}`]);
}

/** Open invoices and unapplied credit of one customer, for the "apply" panel. */
export async function receiptApplyOptionsAction(customerId: string) {
  return run('receipts:apply', { surface: 'finance/receipts/detail', action: 'apply_options' }, async (ctx) => {
    const items = await fin().customerLedger.openItems(ctx.companyId, customerId);
    return items
      .filter((i) => Number(i.remainingAmount) > 0 && i.documentType === 'invoice')
      .map((i) => ({
        entryId: i.id,
        documentNo: i.documentNo,
        remaining: i.remainingAmount,
        amount: i.amount,
        currency: i.currency,
        dueDate: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : null,
      }));
  });
}

// ── customer ledger and ageing ────────────────────────────────────────────

export async function customerStatementAction(customerId: string, from?: string, to?: string) {
  return run('customer_ledger:read', { surface: 'finance/customer-ledger', action: 'statement' }, async (ctx) => {
    const found = await getContainer().customers.getCustomer(ctx.companyId, customerId);
    if (!found) throw new FinanceError('NOT_FOUND', 'That customer does not exist.');
    const st = await fin().customerLedger.statement(ctx.companyId, customerId, from ?? null, to ?? null);
    return {
      customer: {
        id: found.customer.id,
        number: found.customer.number,
        name: found.customer.name,
        accountType: found.customer.accountType,
        creditLimit: found.customer.creditLimit,
        blocked: found.customer.blocked,
      },
      owed: fromCents(st.owedCents),
      unapplied: fromCents(st.unappliedCents),
      net: fromCents(st.netCents),
      ageing: st.ageing.map((b) => ({ label: b.label, amount: fromCents(b.cents), count: b.count })),
      lines: st.lines.map((l) => ({
        id: l.id,
        date: l.postingDate,
        type: l.documentType,
        documentNo: l.documentNo,
        description: l.description,
        amount: l.amount,
        remaining: l.remainingAmount,
        currency: l.currency,
        dueDate: l.dueDate ? l.dueDate.toISOString().slice(0, 10) : null,
        documentId: l.documentId,
        orderId: l.orderId,
      })),
    };
  });
}

export async function receivablesAgeingAction() {
  return run('receivables_ageing:read', { surface: 'finance/receivables-ageing', action: 'view' }, async (ctx) =>
    fin().customerLedger.ageingByCustomer(ctx.companyId),
  );
}

export async function customerLedgerIntegrityAction() {
  return run('customer_ledger:read', { surface: 'finance/customer-ledger', action: 'integrity' }, async (ctx) => ({
    drift: (await fin().customerLedger.drift(ctx.companyId)).length,
  }));
}
