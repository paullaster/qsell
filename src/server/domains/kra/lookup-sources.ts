import { acceptFilters, LookupFilterError, staticSource, type LookupSource } from '@/server/domains/lookups/runner';
import { encodeCursor } from '@/server/domains/lookups/request';
import { getContainer } from '@/server/di/container';
import { CONNECTIONS, ENVIRONMENTS, moduleChoices } from '@/lib/kra-forms';
import { SIGNING_OUTCOME_CHOICES } from '@/lib/kra-signing-log';

const fixed = (key: string, list: readonly { id: string; label: string }[]) =>
  staticSource({
    key,
    permission: 'taxes:manage',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return list.map((c) => ({ ...c, description: null }));
    },
  });

/** A branch's choice for one signing module; `inherited` says what the company has, for the first choice's words. */
const moduleOverride = staticSource({
  key: 'kra-module-signing',
  permission: 'taxes:manage',
  items: ({ filters }) => {
    const { inherited, ...rest } = filters;
    if (Object.keys(rest).length > 0 || (inherited !== 'on' && inherited !== 'off')) throw new LookupFilterError('Choose what the company has set first.');
    return moduleChoices(inherited).map((c) => ({ ...c, description: null }));
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where eTIMS items can be managed: the company and independent branches in eTIMS mode. */
const etimsTargets = staticSource({
  key: 'etims-targets',
  permission: 'taxes:manage',
  items: async ({ companyId, filters }) => {
    acceptFilters(filters, {});
    const { branches, etimsItems } = getContainer();
    const targets = await etimsItems.listTargets({ companyId, branches: await branches.listByCompany(companyId) });
    return targets.map((t) => ({
      id: t.scope === 'company' ? 'company' : (t.branchId ?? ''),
      label: t.scope === 'company' ? 'Company (all branches that do not act independently)' : `${t.label} (${t.code ?? ''}) — independent branch`,
      description: t.usable ? null : `Not usable: ${t.reason ?? ''}`,
      meta: { usable: t.usable ? '1' : '', reason: t.reason ?? '' },
    }));
  },
});

/** Products that can still be registered in a scope (the `scope` filter: "company" or a branch id), found by name or SKU. */
const etimsRegistrable: LookupSource = {
  key: 'etims-registrable-products',
  permission: 'taxes:manage',
  async search({ companyId, query, after, filters }) {
    const { scope, ...rest } = filters;
    if (Object.keys(rest).length > 0 || scope === undefined || (scope !== 'company' && !UUID.test(scope))) throw new LookupFilterError('Choose where the items are registered first.');
    const page = await getContainer().etimsItems.pageRegistrable({ companyId, branchId: scope === 'company' ? null : scope }, { query, cursor: after === null ? null : encodeCursor(after) });
    return {
      options: page.rows.map((p) => ({
        id: p.id,
        label: `${p.name} (${p.sku})`,
        description: p.hasEtimsTaxCode ? null : 'No eTIMS tax code',
        badge: null,
        meta: { stock: String(p.stock), taxCode: p.hasEtimsTaxCode ? '1' : '', qtyUnitCode: p.qtyUnitCode, pkgUnitCode: p.pkgUnitCode, itemClassCode: p.itemClassCode },
      })),
      nextCursor: page.nextCursor,
    };
  },
};

export const KRA_LOOKUP_SOURCES: LookupSource[] = [
  etimsTargets,
  etimsRegistrable,
  fixed('kra-environments', ENVIRONMENTS),
  fixed('kra-connections', CONNECTIONS),
  fixed('kra-signing-outcomes', SIGNING_OUTCOME_CHOICES),
  moduleOverride,
];
