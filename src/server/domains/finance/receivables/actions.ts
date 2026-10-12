'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { PAYMENT_PROVIDER_META, type PaymentProviderCode, type PaymentProviderEnvironment } from '@/server/domains/payments/types';
import { decryptCredentials, encryptCredentials, maskCredentials } from '@/server/domains/payments/crypto';
import { postingPermissions, run } from '../action-runner';
import { FinanceError } from '../errors';
import { PostingError } from '../engine';
import type { BankAccountInput } from './bank-account-service';
import type { PaymentMethodInput } from './payment-method-service';
import type { AllocateMode, ReceiptInput, ReceiptListFilter } from './receipt-service';
import { fromCents } from '../domain/receivables';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance';
const BANK = `${ROOT}/bank-accounts`;
const METHODS = `${ROOT}/payment-methods`;
const RECEIPTS = `${ROOT}/receipts`;

// ── bank accounts ─────────────────────────────────────────────────────────

export async function listBankAccountsAction() {
  return run('bank_accounts:read', { surface: 'finance/bank-accounts', action: 'list' }, async (ctx) => {
    const [rows, glAccounts, providers] = await Promise.all([
      fin().bankAccounts.list(ctx.companyId),
      fin().setup.listAccounts(ctx.companyId),
      fin().paymentMethods.providerChoices(ctx.companyId),
    ]);
    const settings = await fin().setup.getSettings(ctx.companyId);
    return {
      baseCurrency: settings?.baseCurrency ?? null,
      accounts: rows.map((r) => ({
        id: r.account.id,
        code: r.account.code,
        name: r.account.name,
        kind: r.account.kind,
        currency: r.account.currency,
        glAccountId: r.account.glAccountId,
        glNo: r.glNo,
        glName: r.glName,
        feeGlAccountId: r.account.feeGlAccountId,
        providerConfigId: r.account.providerConfigId,
        details: r.account.details,
        blocked: r.account.blocked,
        balance: r.balance,
        methods: r.methods,
      })),
      glChoices: glAccounts
        .filter((a) => a.type === 'posting' && !a.blocked)
        .map((a) => ({ id: a.id, no: a.no, name: a.name, category: a.category })),
      providers: providers.map((p) => ({ id: p.id, label: `${p.displayName} — ${p.branchName}` })),
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

export async function listPaymentMethodsAction() {
  return run('payment_methods:read', { surface: 'finance/payment-methods', action: 'list' }, async (ctx) => {
    const [rows, banks, providers, settings] = await Promise.all([
      fin().paymentMethods.list(ctx.companyId),
      fin().bankAccounts.list(ctx.companyId),
      fin().paymentMethods.providerChoices(ctx.companyId),
      fin().setup.getSettings(ctx.companyId),
    ]);
    return {
      setUp: settings !== null,
      methods: rows.map((r) => ({
        id: r.method.id,
        code: r.method.code,
        name: r.method.name,
        kind: r.method.kind,
        bankAccountId: r.method.balancingBankAccountId,
        bankLabel: `${r.bankCode} — ${r.bankName}`,
        bankBlocked: r.bankBlocked,
        requiresReference: r.method.requiresReference,
        requiresEvidence: r.method.requiresEvidence,
        requiresCounterparty: r.method.requiresCounterparty,
        collectProviderConfigId: r.method.collectProviderConfigId,
        providerLabel: r.providerName,
        providerEnabled: r.providerEnabled,
        usableFor: r.method.usableFor,
        limits: r.method.limits,
        refundDestination: r.method.refundDestination,
        legacyCodes: r.method.legacyCodes,
        enabled: r.method.enabled,
        sortOrder: r.method.sortOrder,
      })),
      banks: banks.map((b) => ({ id: b.account.id, label: `${b.account.code} — ${b.account.name}`, blocked: b.account.blocked })),
      providers: providers.map((p) => ({ id: p.id, label: `${p.displayName} — ${p.branchName}${p.isEnabled ? '' : ' (off)'}` })),
      can: {
        create: await canPermission('payment_methods:create'),
        edit: await canPermission('payment_methods:edit'),
        disable: await canPermission('payment_methods:disable'),
        delete: await canPermission('payment_methods:delete'),
        seed: await canPermission('payment_setup:seed'),
        linkOrders: await canPermission('payment_setup:link_orders'),
      },
    };
  });
}

export async function createPaymentMethodAction(input: PaymentMethodInput) {
  return run('payment_methods:create', { surface: 'finance/payment-methods', action: 'create' }, async (ctx) => {
    const row = await fin().paymentMethods.create(ctx, input);
    return { id: row.id };
  }, [METHODS]);
}

export async function updatePaymentMethodAction(id: string, patch: Partial<PaymentMethodInput>) {
  return run('payment_methods:edit', { surface: 'finance/payment-methods', action: 'update' }, async (ctx) => {
    await fin().paymentMethods.update(ctx, id, patch);
  }, [METHODS]);
}

export async function setPaymentMethodEnabledAction(id: string, enabled: boolean, reason?: string) {
  return run('payment_methods:disable', { surface: 'finance/payment-methods', action: enabled ? 'enable' : 'disable' }, async (ctx) => {
    await fin().paymentMethods.setEnabled(ctx, id, enabled, reason);
  }, [METHODS]);
}

export async function deletePaymentMethodAction(id: string) {
  return run('payment_methods:delete', { surface: 'finance/payment-methods', action: 'delete' }, async (ctx) => {
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

// ── payment providers (connections) ───────────────────────────────────────

export interface ProviderView {
  id: string;
  branchId: string;
  branchName: string;
  providerCode: PaymentProviderCode;
  label: string;
  description: string;
  isEnabled: boolean;
  environment: PaymentProviderEnvironment;
  apiBaseUrl: string;
  hasCredentials: boolean;
  maskedCredentials: Record<string, string> | null;
  capabilities: readonly string[];
  callbackUrl: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  usedByMethods: number;
}

export async function listProvidersAction() {
  return run('payment_providers:read', { surface: 'finance/payment-providers', action: 'list' }, async (ctx) => {
    const c = getContainer();
    const company = await c.companySettings.ensureSeeded();
    // Every branch has a (switched-off) account for every known provider, so there is always
    // something to configure. Creating a missing one is harmless and idempotent.
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(company.id, company.tradingName || company.legalName);
    const branchList = await c.branches.listByCompany(company.id);
    for (const b of branchList.length ? branchList : [branch]) {
      const have = new Set((await c.paymentConfigs.listByBranch(b.id)).map((r) => r.providerCode));
      for (const code of Object.keys(PAYMENT_PROVIDER_META) as PaymentProviderCode[]) {
        if (have.has(code)) continue;
        const meta = PAYMENT_PROVIDER_META[code];
        await c.paymentConfigs.upsert({
          branchId: b.id,
          providerCode: code,
          displayName: meta.label,
          isEnabled: false,
          environment: 'staging',
          apiBaseUrl: meta.defaultStagingBaseUrl,
          replaceCredentials: false,
        });
      }
    }
    const choices = await fin().paymentMethods.providerChoices(ctx.companyId);
    const views: ProviderView[] = [];
    for (const choice of choices) {
      const row = await c.paymentConfigs.getById(choice.id);
      if (!row) continue;
      const code = row.providerCode as PaymentProviderCode;
      const meta = PAYMENT_PROVIDER_META[code];
      let masked: Record<string, string> | null;
      try {
        masked = maskCredentials(decryptCredentials(row.credentialsEncrypted));
      } catch {
        masked = { _error: 'Saved credentials cannot be opened with the current key.' };
      }
      views.push({
        id: row.id,
        branchId: row.branchId,
        branchName: choice.branchName,
        providerCode: code,
        label: row.displayName || meta.label,
        description: meta.description,
        isEnabled: row.isEnabled,
        environment: row.environment as PaymentProviderEnvironment,
        apiBaseUrl: row.apiBaseUrl,
        hasCredentials: Boolean(row.credentialsEncrypted),
        maskedCredentials: masked,
        capabilities: c.payments.capabilitiesOf(code),
        callbackUrl: company.publicBaseUrl ? `${company.publicBaseUrl.replace(/\/$/, '')}${meta.callbackPathPrefix}/<per-payment token>` : null,
        lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
        lastTestOk: row.lastTestOk,
        lastTestMessage: row.lastTestMessage,
        usedByMethods: 0,
      });
    }
    return {
      publicBaseUrl: company.publicBaseUrl ?? null,
      providers: views,
      can: {
        edit: await canPermission('payment_providers:edit'),
        setCredentials: await canPermission('payment_providers:set_credentials'),
        enable: await canPermission('payment_providers:enable'),
        test: await canPermission('payment_providers:test'),
      },
    };
  });
}

export async function saveProviderAction(input: {
  id: string;
  environment?: PaymentProviderEnvironment;
  apiBaseUrl?: string;
  displayName?: string;
}) {
  return run('payment_providers:edit', { surface: 'finance/payment-providers', action: 'save' }, async (ctx) => {
    const c = getContainer();
    const row = await c.paymentConfigs.getById(input.id);
    if (!row) throw new FinanceError('NOT_FOUND', 'That provider account does not exist.');
    const url = (input.apiBaseUrl ?? row.apiBaseUrl).trim().replace(/\/$/, '');
    if (!/^https:\/\//i.test(url)) throw new FinanceError('URL_INVALID', 'The provider address must start with https://.');
    await c.paymentConfigs.upsert({
      branchId: row.branchId,
      providerCode: row.providerCode,
      displayName: input.displayName?.trim() || row.displayName,
      isEnabled: row.isEnabled,
      environment: input.environment ?? row.environment,
      apiBaseUrl: url,
      replaceCredentials: false,
    });
    await c.decisionLog.record({
      companyId: ctx.companyId,
      subject: { type: 'payment_provider', id: row.id },
      action: 'finance.payment_provider_updated',
      actor: ctx.actor,
      inputs: { origin: ctx.origin, environment: input.environment ?? row.environment, apiBaseUrl: url },
    });
  }, [`${ROOT}/payment-providers`]);
}

export async function setProviderCredentialsAction(id: string, credentials: Record<string, string>) {
  return run('payment_providers:set_credentials', { surface: 'finance/payment-providers', action: 'set_credentials' }, async (ctx) => {
    const c = getContainer();
    const row = await c.paymentConfigs.getById(id);
    if (!row) throw new FinanceError('NOT_FOUND', 'That provider account does not exist.');
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(credentials)) {
      if (typeof v === 'string' && v.trim() && !v.includes('•')) cleaned[k] = v.trim();
    }
    if (Object.keys(cleaned).length === 0) throw new FinanceError('NOTHING_TO_SAVE', 'Enter at least one value to save.');
    const previous = decryptCredentials(row.credentialsEncrypted) ?? {};
    await c.paymentConfigs.upsert({
      branchId: row.branchId,
      providerCode: row.providerCode,
      displayName: row.displayName,
      isEnabled: row.isEnabled,
      environment: row.environment,
      apiBaseUrl: row.apiBaseUrl,
      credentialsEncrypted: encryptCredentials({ ...previous, ...cleaned }),
      replaceCredentials: true,
    });
    // Which fields changed is recorded; their values never are.
    await c.decisionLog.record({
      companyId: ctx.companyId,
      subject: { type: 'payment_provider', id },
      action: 'finance.payment_provider_credentials_set',
      actor: ctx.actor,
      inputs: { origin: ctx.origin, fields: Object.keys(cleaned) },
    });
  }, [`${ROOT}/payment-providers`]);
}

export async function setProviderEnabledAction(id: string, enabled: boolean) {
  return run('payment_providers:enable', { surface: 'finance/payment-providers', action: enabled ? 'enable' : 'disable' }, async (ctx) => {
    const c = getContainer();
    const row = await c.paymentConfigs.getById(id);
    if (!row) throw new FinanceError('NOT_FOUND', 'That provider account does not exist.');
    if (enabled && !row.credentialsEncrypted) {
      throw new FinanceError('NO_CREDENTIALS', 'Save the credentials and run "Test connection" before switching it on.');
    }
    if (enabled && row.lastTestOk !== true) {
      throw new FinanceError('NOT_TESTED', 'Run "Test connection" successfully before switching this provider on.');
    }
    await c.paymentConfigs.upsert({
      branchId: row.branchId,
      providerCode: row.providerCode,
      displayName: row.displayName,
      isEnabled: enabled,
      environment: row.environment,
      apiBaseUrl: row.apiBaseUrl,
      replaceCredentials: false,
    });
    await c.decisionLog.record({
      companyId: ctx.companyId,
      subject: { type: 'payment_provider', id },
      action: enabled ? 'finance.payment_provider_enabled' : 'finance.payment_provider_disabled',
      actor: ctx.actor,
      inputs: { origin: ctx.origin },
    });
  }, [`${ROOT}/payment-providers`]);
}

export async function testProviderAction(id: string) {
  return run('payment_providers:test', { surface: 'finance/payment-providers', action: 'test_connection' }, async (ctx) => {
    const c = getContainer();
    const result = await c.payments.testConnection(id);
    await c.decisionLog.record({
      companyId: ctx.companyId,
      subject: { type: 'payment_provider', id },
      action: 'finance.payment_provider_tested',
      actor: ctx.actor,
      inputs: { origin: ctx.origin },
      outcome: { ok: result.ok, message: result.message },
    });
    return { ok: result.ok, message: result.message, at: result.at.toISOString() };
  }, [`${ROOT}/payment-providers`]);
}

// ── receipts ──────────────────────────────────────────────────────────────

export async function receiptFormOptionsAction() {
  return run('receipts:create', { surface: 'finance/receipts', action: 'form_options' }, async (ctx) => {
    const [methods, settings] = await Promise.all([
      fin().paymentMethods.list(ctx.companyId),
      fin().setup.getSettings(ctx.companyId),
    ]);
    return {
      baseCurrency: settings?.baseCurrency ?? 'KES',
      methods: methods
        .filter((m) => m.method.enabled && m.method.usableFor.includes('customer_receipt') && !m.bankBlocked)
        .map((m) => ({
          id: m.method.id,
          code: m.method.code,
          name: m.method.name,
          kind: m.method.kind,
          bankLabel: `${m.bankCode} — ${m.bankName}`,
          currency: m.bankCurrency,
          requiresReference: m.method.requiresReference,
          requiresEvidence: m.method.requiresEvidence,
          requiresCounterparty: m.method.requiresCounterparty,
          limits: m.method.limits,
        })),
    };
  });
}

export async function searchCustomersForReceiptAction(q: string) {
  return run('receipts:create', { surface: 'finance/receipts', action: 'search_customers' }, async (ctx) =>
    fin().receipts.searchCustomers(ctx.companyId, q),
  );
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
    const reasons = (await getContainer().reasonCodes.list(ctx.companyId)).filter((r) => r.isActive);
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
        postedBy: r.postedBy ? (d.actors[r.postedBy] ?? r.postedBy) : null,
        createdBy: d.actors[r.createdBy] ?? r.createdBy,
        createdAt: r.createdAt.toISOString(),
        registerId: r.registerId,
      },
      customer: { id: d.customer.id, number: d.customer.number, name: d.customer.name },
      method: { name: d.method.name, kind: d.method.kind, requiresEvidence: d.method.requiresEvidence },
      bank: { id: d.bank.id, code: d.bank.code, name: d.bank.name },
      depositedInto: d.depositedInto,
      unapplied: fromCents(d.unappliedCents),
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
        actorId: e.actorId ? (d.actors[e.actorId] ?? e.actorId) : null,
        actorType: e.actorType,
        surface: (e.origin as { surface?: string }).surface ?? null,
        permission: (e.origin as { permissionUsed?: string }).permissionUsed ?? null,
        at: e.createdAt.toISOString(),
        data: e.data,
      })),
      attachments,
      reasons: reasons.map((x) => ({ code: x.code, description: x.description, requiresComment: x.requiresComment })),
      can: {
        post: await canPermission('receipts:post'),
        cancel: await canPermission('receipts:cancel_draft'),
        apply: await canPermission('receipts:apply'),
        unapply: await canPermission('receipts:unapply'),
        reverse: await canPermission('receipts:reverse'),
        attach: await canPermission('receipts:attach_evidence'),
        deposit: await canPermission('cheques:deposit'),
        clear: await canPermission('cheques:clear'),
        bounce: await canPermission('cheques:bounce'),
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
          return { ...created, posted: false, postError: error.message as string | null };
        }
        console.error('[finance] posting a new receipt failed', error);
        return { ...created, posted: false, postError: 'Something went wrong while posting. The draft was saved.' as string | null };
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

export async function depositChequeAction(id: string, bankAccountId: string, date?: string) {
  return run('cheques:deposit', { surface: 'finance/receipts/detail', action: 'cheque_deposit' }, async (ctx) => {
    await fin().receipts.depositCheque(ctx, id, { bankAccountId, date });
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

/** Banks that can take a deposited cheque. */
export async function chequeDepositBanksAction() {
  return run('cheques:deposit', { surface: 'finance/receipts/detail', action: 'deposit_banks' }, async (ctx) =>
    (await fin().bankAccounts.list(ctx.companyId))
      .filter((b) => b.account.kind === 'bank' && !b.account.blocked)
      .map((b) => ({ id: b.account.id, label: `${b.account.code} — ${b.account.name}` })),
  );
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
