import {
  KraConfigError,
  type KraConfigErrorCode,
  type KraConfigSource,
  type KraMode,
  KRA_MODES,
} from '../types';
import type {
  KraBranchLookup,
  KraConfigReader,
  KraConfigRecord,
  KraConfigResolver,
} from '../resolver';
import {
  SIGNING_MODULE_LABELS,
  type GateTrace,
  type SigningDecision,
  type SigningReason,
  type SigningRequest,
} from './types';

import { has } from '@/lib/values';

/**
 * Decides whether a document is signed with KRA, and records why.
 *
 * Gates run in this order and the first that stops the document ends the evaluation:
 *   1. document   — a proforma is never signed.
 *   2. scope      — an independent branch uses its own settings; any other branch, or no
 *                   branch, uses the company's. Only the chosen scope's mode is read.
 *   3. mode       — eTIMS or TIMS must be configured for that scope.
 *   4. mode switch— signing must be explicitly allowed for that mode in that scope.
 *   5. module     — the invoicing module's switch. An independent branch's own value wins;
 *                   if it has none, or the branch is not independent, the company value
 *                   (the global default) applies. Off unless something turned it on.
 *   6. customer   — only an explicit "no" on the customer opts out; no profile signs.
 *   7. readiness  — the chosen config must be enabled and complete.
 *
 * `skip` is a deliberate "do not sign". `fail` means signing was wanted but something it
 * needs is missing or broken. Neither blocks the sale; the caller records the outcome.
 */
export class KraSigningPolicy {
  constructor(
    private readonly branches: KraBranchLookup,
    private readonly configs: KraConfigReader,
    private readonly resolver: KraConfigResolver,
  ) {}

  async decide(req: SigningRequest): Promise<SigningDecision> {
    const gates: GateTrace[] = [];
    const settings: Record<string, unknown> = {
      module: req.module,
      documentType: req.documentType,
    };
    const done = (
      outcome: SigningDecision['outcome'],
      reason: SigningReason,
      extra: Partial<Pick<SigningDecision, 'scope' | 'branchId' | 'mode'>> = {},
    ): SigningDecision => ({
      outcome,
      reason,
      scope: extra.scope ?? null,
      branchId: extra.branchId ?? null,
      mode: extra.mode ?? null,
      gates,
      settings,
    });

    // 1. document
    if (req.documentType === 'proforma') {
      gates.push({
        gate: 'document',
        result: 'skip',
        value: req.documentType,
        source: 'document_type',
        detail: 'A proforma invoice is never a tax invoice and is never signed.',
      });
      return done('skip', 'PROFORMA_NEVER_SIGNED');
    }
    gates.push({
      gate: 'document',
      result: 'pass',
      value: req.documentType,
      source: 'document_type',
      detail: 'Document type can be signed.',
    });

    // 2. scope
    let scope: KraConfigSource = 'company';
    let branchId: string | null = null;
    let scopeDetail = 'No branch on the document: company settings apply.';
    if (has(req.branchId)) {
      const branch = await this.branches.getById(req.branchId);
      if (branch?.companyId !== req.companyId) {
        gates.push(
          fail('scope', req.branchId, 'branch_lookup', `Branch ${req.branchId} not found.`),
        );
        return done('fail', 'BRANCH_NOT_FOUND');
      }
      if (!branch.isActive) {
        gates.push(
          fail('scope', req.branchId, 'branch_lookup', `Branch ${branch.id} is inactive.`),
        );
        return done('fail', 'BRANCH_INACTIVE');
      }
      if (branch.actsIndependently) {
        scope = 'branch';
        branchId = branch.id;
        scopeDetail = `Branch ${branch.id} acts independently: its own settings apply.`;
      } else {
        scopeDetail = `Branch ${branch.id} does not act independently: company settings apply.`;
      }
    }
    gates.push({
      gate: 'scope',
      result: 'pass',
      value: { scope, branchId },
      source: has(req.branchId) ? 'branch.acts_independently' : 'no_branch',
      detail: scopeDetail,
    });
    const common = { scope, branchId };

    // Read only what the chosen scope needs. The company row is always needed: it is the
    // global default for module switches and tells us whether KRA is in use at all.
    const company = await this.configs.getCompanyConfig(req.companyId);
    const branchRecord = scope === 'branch' && branchId !== null ? await this.configs.getBranchConfig(branchId) : null;
    const record: KraConfigRecord | null = scope === 'branch' ? branchRecord : company;

    // 3. mode
    if (!record) {
      if (!company) {
        gates.push({
          gate: 'mode',
          result: 'skip',
          value: null,
          source: 'company_config',
          detail: 'No KRA configuration exists, so KRA is not in use.',
        });
        return done('skip', 'KRA_NOT_CONFIGURED', common);
      }
      gates.push(
        fail(
          'mode',
          null,
          'branch_config',
          `Branch ${branchId ?? ''} acts independently but has no KRA configuration.`,
        ),
      );
      return done('fail', 'BRANCH_CONFIG_MISSING', common);
    }
    const source = scope === 'branch' ? 'branch_config' : 'company_config';
    if (!KRA_MODES.includes(record.mode as KraMode)) {
      gates.push(fail('mode', record.mode, source, `KRA mode "${record.mode}" is not valid.`));
      return done('fail', 'CONFIG_INCOMPLETE', common);
    }
    const mode = record.mode as KraMode;
    settings.scope = scope;
    settings.mode = mode;
    settings.configEnabled = record.isEnabled;
    settings.allowEtimsSigning = record.allowEtimsSigning;
    settings.allowTimsSigning = record.allowTimsSigning;
    settings.companyModuleSigning = company?.moduleSigning ?? {};
    if (scope === 'branch') settings.branchModuleSigning = branchRecord?.moduleSigning ?? {};
    gates.push({
      gate: 'mode',
      result: 'pass',
      value: mode,
      source,
      detail: `${scope === 'branch' ? 'Branch' : 'Company'} mode is ${mode === 'etims' ? 'eTIMS' : 'TIMS'}.`,
    });
    const withMode = { ...common, mode };

    // 4. explicit signing switch for that mode
    const allowed = mode === 'etims' ? record.allowEtimsSigning : record.allowTimsSigning;
    if (!allowed) {
      gates.push({
        gate: 'mode_signing_switch',
        result: 'skip',
        value: false,
        source,
        detail: `Signing with ${mode === 'etims' ? 'eTIMS' : 'TIMS'} is not enabled for this ${scope}.`,
      });
      return done('skip', 'SIGNING_NOT_ENABLED_FOR_MODE', withMode);
    }
    gates.push({
      gate: 'mode_signing_switch',
      result: 'pass',
      value: true,
      source,
      detail: `Signing with ${mode === 'etims' ? 'eTIMS' : 'TIMS'} is enabled for this ${scope}.`,
    });

    // 5. module switch
    const own = scope === 'branch' ? branchRecord?.moduleSigning[req.module] : undefined;
    const inherited = company?.moduleSigning[req.module];
    let moduleOn: boolean;
    let moduleSource: string;
    if (typeof own === 'boolean') {
      moduleOn = own;
      moduleSource = 'branch_override';
    } else if (typeof inherited === 'boolean') {
      moduleOn = inherited;
      moduleSource =
        scope === 'branch' ? 'company_default (branch has no override)' : 'company_setting';
    } else {
      moduleOn = false;
      moduleSource = 'default_off (not set anywhere)';
    }
    const label = SIGNING_MODULE_LABELS[req.module];
    if (!moduleOn) {
      gates.push({
        gate: 'module_switch',
        result: 'skip',
        value: false,
        source: moduleSource,
        detail: `Signing is off for ${label}.`,
      });
      return done('skip', 'MODULE_DISABLED', withMode);
    }
    gates.push({
      gate: 'module_switch',
      result: 'pass',
      value: true,
      source: moduleSource,
      detail: `Signing is on for ${label}.`,
    });

    // 6. customer flag
    if (req.customerFlag === false) {
      gates.push({
        gate: 'customer_flag',
        result: 'skip',
        value: false,
        source: 'customer_profile',
        detail: 'The customer is set to not have invoices transmitted to KRA.',
      });
      return done('skip', 'CUSTOMER_OPTED_OUT', withMode);
    }
    gates.push({
      gate: 'customer_flag',
      result: 'pass',
      value: req.customerFlag ?? 'default',
      source: req.customerFlag === null ? 'default_no_profile' : 'customer_profile',
      detail:
        req.customerFlag === null
          ? 'No customer profile: invoices are signed by default.'
          : 'The customer allows invoices to be transmitted to KRA.',
    });

    // 7. readiness
    try {
      this.resolver.validateRecord(record, scope, branchId);
    } catch (error: unknown) {
      if (!(error instanceof KraConfigError)) throw error;
      gates.push(fail('readiness', false, source, error.message));
      return done('fail', toReason(error.code), withMode);
    }
    gates.push({
      gate: 'readiness',
      result: 'pass',
      value: true,
      source,
      detail: 'The configuration is enabled and complete.',
    });
    return done('sign', 'SIGN', withMode);
  }
}

function fail(gate: GateTrace['gate'], value: unknown, source: string, detail: string): GateTrace {
  return { gate, result: 'fail', value, source, detail };
}

function toReason(code: KraConfigErrorCode): SigningReason {
  switch (code) {
    case 'CONFIG_DISABLED':
    case 'CONFIG_INCOMPLETE':
    case 'BRANCH_CONFIG_MISSING':
    case 'COMPANY_CONFIG_MISSING':
    case 'BRANCH_NOT_FOUND':
    case 'BRANCH_INACTIVE':
    case 'MODE_MISMATCH':
      return code;
  }
}
