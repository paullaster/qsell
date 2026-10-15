'use server';

import { getContainer } from '@/server/di/container';
import { runSetting, SettingsError } from '@/server/domains/settings/action-runner';
import { DIMENSION_OPTION_STRING_LABELS, isDimensionOptionString } from './option-strings';
import { DimensionWriteService } from './write-service';
import { dimensionNotFound } from './errors';
import type { PageInput } from '@/server/domains/settings/paging';
import type { DimensionRow, DimensionValueRow } from '@/server/db/drizzle/schema';

const ROOT = '/admin/settings/dimensions';

const writeService = () => {
  const c = getContainer();
  return new DimensionWriteService(c.dimensions, c.branches, c.db);
};

export interface DimensionView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  parentCode: string | null;
  dimensionNo: number | null;
  isGlobal: boolean;
  isDefault: boolean;
  isShortcut: boolean;
  optionString: string | null;
  optionLabel: string | null;
}

export interface DimensionValueView {
  id: string;
  dimensionId: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  parentLabel: string | null;
  isActive: boolean;
  blocked: boolean;
}

const optionLabel = (value: string | null): string | null => (value !== null && isDimensionOptionString(value) ? DIMENSION_OPTION_STRING_LABELS[value] : value);

const toView = (row: DimensionRow, parentCode: string | null): DimensionView => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: row.description,
  parentId: row.parentId,
  parentCode,
  dimensionNo: row.dimensionNo,
  isGlobal: row.isGlobal,
  isDefault: row.isDefault,
  isShortcut: row.isShortcut,
  optionString: row.optionString,
  optionLabel: optionLabel(row.optionString),
});

const toValueView = (row: DimensionValueRow, parentLabel: string | null): DimensionValueView => ({
  id: row.id,
  dimensionId: row.dimensionId,
  code: row.code,
  name: row.name,
  description: row.description,
  parentId: row.parentId,
  parentLabel,
  isActive: row.isActive,
  blocked: row.blocked,
});

/** The dimension, only when it is this company's; anything else is "not found" and says nothing more. */
async function ownDimension(companyId: string, id: string): Promise<DimensionRow> {
  const row = await getContainer().dimensions.getById(id);
  if (row?.companyId !== companyId) throw dimensionNotFound();
  return row;
}

async function ownValue(companyId: string, id: string): Promise<DimensionValueRow> {
  const row = await getContainer().dimensions.getValueById(id);
  if (!row) throw new SettingsError('That value does not exist.', 'NOT_FOUND');
  await ownDimension(companyId, row.dimensionId);
  return row;
}

/** One page of dimensions in code order, each with its parent's code. */
export async function dimensionsPageAction(input: PageInput) {
  return runSetting('settings:read', async ({ companyId }) => {
    const repo = getContainer().dimensions;
    const page = await repo.pageByCompany(companyId, input);
    const codes = await repo.codesOf([...new Set(page.rows.flatMap((r) => (r.parentId === null ? [] : [r.parentId])))]);
    return { rows: page.rows.map((r) => toView(r, r.parentId === null ? null : (codes[r.parentId] ?? null))), nextCursor: page.nextCursor };
  });
}

export async function getDimensionAction(id: string) {
  return runSetting('settings:read', async ({ companyId }) => {
    const row = await ownDimension(companyId, id);
    const parent = row.parentId === null ? null : await getContainer().dimensions.getById(row.parentId);
    return toView(row, parent?.code ?? null);
  });
}

/** One page of a dimension's values in code order, each with its parent value's words. */
export async function dimensionValuesPageAction(dimensionId: string, input: PageInput) {
  return runSetting('settings:read', async ({ companyId }) => {
    await ownDimension(companyId, dimensionId);
    const repo = getContainer().dimensions;
    const page = await repo.pageValues(dimensionId, input);
    const labels = await repo.valueLabels([...new Set(page.rows.flatMap((r) => (r.parentId === null ? [] : [r.parentId])))]);
    return { rows: page.rows.map((r) => toValueView(r, r.parentId === null ? null : (labels[r.parentId] ?? null))), nextCursor: page.nextCursor };
  });
}

export async function listDimensionFieldContractAction() {
  return runSetting('settings:read', ({ companyId }) => getContainer().dimensionSets.listFieldContract(companyId));
}

export interface DimensionInput {
  code: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  dimensionNo?: number | null;
  isGlobal?: boolean;
  isDefault?: boolean;
  isShortcut?: boolean;
  optionString?: string | null;
}

export async function createDimensionAction(input: DimensionInput) {
  return runSetting(
    'dimensions:manage',
    async ({ companyId }) => {
      if (input.parentId !== undefined && input.parentId !== null) await ownDimension(companyId, input.parentId);
      const row = await writeService().createDimension({ companyId, ...input });
      return toView(row, null);
    },
    { paths: [ROOT, '/admin/settings/branches'] },
  );
}

export async function updateDimensionAction(id: string, patch: Partial<DimensionInput> & { isActive?: boolean; blocked?: boolean }) {
  return runSetting(
    'dimensions:manage',
    async ({ companyId }) => {
      await ownDimension(companyId, id);
      if (patch.parentId !== undefined && patch.parentId !== null) await ownDimension(companyId, patch.parentId);
      const row = await writeService().updateDimension(id, patch);
      const parent = row.parentId === null ? null : await getContainer().dimensions.getById(row.parentId);
      return toView(row, parent?.code ?? null);
    },
    { paths: [ROOT, `${ROOT}/${id}`, '/admin/settings/branches'] },
  );
}

export async function deleteDimensionAction(id: string) {
  return runSetting(
    'dimensions:manage',
    async ({ companyId }) => {
      await ownDimension(companyId, id);
      await writeService().deleteDimension(id);
    },
    { paths: [ROOT, '/admin/settings/branches'] },
  );
}

export async function createDimensionValueAction(input: { dimensionId: string; code: string; name: string; description?: string | null; parentId?: string | null }) {
  return runSetting(
    'dimensions:manage',
    async ({ companyId }) => {
      await ownDimension(companyId, input.dimensionId);
      const row = await writeService().createValue(input);
      return toValueView(row, null);
    },
    { paths: [`${ROOT}/${input.dimensionId}`, '/admin/settings/branches'] },
  );
}

export async function updateDimensionValueAction(id: string, patch: { code?: string; name?: string; description?: string | null; parentId?: string | null; isActive?: boolean; blocked?: boolean }) {
  return runSetting(
    'dimensions:manage',
    async ({ companyId }) => {
      await ownValue(companyId, id);
      const row = await writeService().updateValue(id, patch);
      const labels = await getContainer().dimensions.valueLabels(row.parentId === null ? [] : [row.parentId]);
      return toValueView(row, row.parentId === null ? null : (labels[row.parentId] ?? null));
    },
    { paths: [ROOT, '/admin/settings/branches'] },
  );
}

export async function deleteDimensionValueAction(id: string) {
  return runSetting(
    'dimensions:manage',
    async ({ companyId }) => {
      const existing = await ownValue(companyId, id);
      await writeService().deleteValue(id);
      return { dimensionId: existing.dimensionId };
    },
    { paths: [ROOT, '/admin/settings/branches'] },
  );
}
