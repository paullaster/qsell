'use client';

import Link from 'next/link';
import {
  saveBranchKraConfigAction,
  saveCompanyKraConfigAction,
  type KraBranchSettingsView,
  type KraConfigView,
} from '@/server/domains/kra/actions';
import type { ModuleSigning } from '@/server/domains/kra/signing/types';
import { KraConfigForm } from './KraConfigForm';

interface EmbedProps {
  /** Rendered inside a dialog that already shows the title: skip the page heading. */
  embedded?: boolean;
}

export function KraCompanyModeClient({
  initial,
  embedded = false,
  onSaved,
}: EmbedProps & { initial: KraConfigView | null; onSaved?: () => void }) {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        {embedded ? null : <h2 className="text-xl font-bold text-fg-strong">Company mode</h2>}
        <p className={`${embedded ? '' : 'mt-1'}text-sm text-fg-muted`}>
          Used for every branch that does not act independently. If no company mode is configured
          and enabled, KRA transmission is refused for those branches.
        </p>
      </div>
      <div className={embedded ? '' : 'rounded-xl border border-line bg-surface-raised p-4 sm:p-6'}>
        <KraConfigForm
          scope="company"
          initial={initial}
          label="Company"
          onSave={saveCompanyKraConfigAction}
          onSaved={onSaved}
        />
      </div>
    </div>
  );
}

export function KraBranchModesClient({
  branches,
  companyMode,
  embedded = false,
  onSaved,
  companyModuleSigning,
  branchesHref = '/admin/settings/branches',
}: EmbedProps & {
  /** Where the "Branches" link goes. Inside a dialog this is the dialog version of the screen. */
  branchesHref?: string;
  branches: KraBranchSettingsView[];
  companyMode: 'tims' | 'etims' | null;
  /** The company's module switches: what a branch inherits when it sets none of its own. */
  companyModuleSigning?: ModuleSigning;
  onSaved?: () => void;
}) {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        {embedded ? null : <h2 className="text-xl font-bold text-fg-strong">Branch modes</h2>}
        <p className={`${embedded ? '' : 'mt-1'}text-sm text-fg-muted`}>
          A branch reads its own mode only when it acts independently. There is no fallback: if an
          independent branch has no enabled mode, KRA transmission for it is refused.
        </p>
      </div>

      {branches.length === 0 ? (
        <p className="text-sm text-fg-subtle">No branches yet.</p>
      ) : (
        branches.map((branch) => (
          <section
            key={branch.id}
            aria-labelledby={`kra-branch-${branch.id}`}
            className="rounded-xl border border-line bg-surface-raised p-4 sm:p-6"
          >
            <h3 id={`kra-branch-${branch.id}`} className="text-base font-bold text-fg-strong">
              {branch.name} <span className="font-mono text-xs text-fg-muted">{branch.code}</span>
            </h3>
            {branch.actsIndependently ? (
              <div className="mt-4">
                <KraConfigForm
                  scope="branch"
                  companyModuleSigning={companyModuleSigning}
                  initial={branch.config}
                  label={branch.name}
                  onSave={(input) => saveBranchKraConfigAction(branch.id, input)}
                  onSaved={onSaved}
                />
              </div>
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                Uses the company mode
                {companyMode
                  ? ` (${companyMode === 'etims' ? 'eTIMS' : 'TIMS'})`
                  : ' (not configured)'}
                . To give this branch its own mode, turn on “acts independently” in{' '}
                <Link href={branchesHref} className="font-semibold text-indigo-500 underline">
                  Branches
                </Link>
                .
              </p>
            )}
          </section>
        ))
      )}
    </div>
  );
}
