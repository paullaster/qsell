'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type { DimensionRow, DimensionValueRow } from '@/server/db/drizzle/schema';
import { DimensionWriteService } from './write-service';
import {
  DIMENSION_OPTION_STRINGS,
  DIMENSION_OPTION_STRING_LABELS,
  type DimensionOptionString,
} from './option-strings';

async function companyId(): Promise<string> {
  const company = await getContainer().companySettings.ensureSeeded();
  return company.id;
}

function writeService() {
  const c = getContainer();
  return new DimensionWriteService(c.dimensions, c.branches, c.db);
}

export async function listDimensionOptionStringsAction(): Promise<
  { value: DimensionOptionString; label: string }[]
> {
  await requirePermission('settings:read');
  return DIMENSION_OPTION_STRINGS.map((value) => ({
    value,
    label: DIMENSION_OPTION_STRING_LABELS[value],
  }));
}

export async function listDimensionsAction(): Promise<DimensionRow[]> {
  await requirePermission('settings:read');
  const { dimensions } = getContainer();
  return dimensions.listByCompany(await companyId());
}

export async function getDimensionAction(id: string): Promise<DimensionRow | null> {
  await requirePermission('settings:read');
  return getContainer().dimensions.getById(id);
}

export async function listDimensionValuesAction(
  dimensionId: string,
): Promise<DimensionValueRow[]> {
  await requirePermission('settings:read');
  return getContainer().dimensions.listValues(dimensionId);
}

export async function listDimensionFieldContractAction() {
  await requirePermission('settings:read');
  const id = await companyId();
  return getContainer().dimensionSets.listFieldContract(id);
}

export async function createDimensionAction(input: {
  code: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
  dimensionNo?: number | null;
  isGlobal?: boolean;
  isDefault?: boolean;
  isShortcut?: boolean;
  optionString?: string | null;
}): Promise<DimensionRow> {
  await requirePermission('dimensions:manage');
  const row = await writeService().createDimension({
    companyId: await companyId(),
    ...input,
  });
  revalidatePath('/admin/settings/dimensions');
  return row;
}

export async function updateDimensionAction(
  id: string,
  patch: {
    code?: string;
    name?: string;
    description?: string | null;
    parentId?: string | null;
    dimensionNo?: number | null;
    isGlobal?: boolean;
    isDefault?: boolean;
    isShortcut?: boolean;
    optionString?: string | null;
    isActive?: boolean;
    blocked?: boolean;
  },
): Promise<DimensionRow> {
  await requirePermission('dimensions:manage');
  const row = await writeService().updateDimension(id, patch);
  revalidatePath('/admin/settings/dimensions');
  revalidatePath(`/admin/settings/dimensions/${id}`);
  revalidatePath('/admin/settings/branches');
  return row;
}

export async function deleteDimensionAction(id: string): Promise<void> {
  await requirePermission('dimensions:manage');
  await writeService().deleteDimension(id);
  revalidatePath('/admin/settings/dimensions');
  revalidatePath('/admin/settings/branches');
}

export async function createDimensionValueAction(input: {
  dimensionId: string;
  code: string;
  name: string;
  description?: string | null;
  parentId?: string | null;
}): Promise<DimensionValueRow> {
  await requirePermission('dimensions:manage');
  const row = await writeService().createValue(input);
  revalidatePath(`/admin/settings/dimensions/${input.dimensionId}`);
  revalidatePath('/admin/settings/branches');
  return row;
}

export async function updateDimensionValueAction(
  id: string,
  patch: {
    code?: string;
    name?: string;
    description?: string | null;
    parentId?: string | null;
    isActive?: boolean;
    blocked?: boolean;
  },
): Promise<DimensionValueRow> {
  await requirePermission('dimensions:manage');
  const row = await writeService().updateValue(id, patch);
  revalidatePath(`/admin/settings/dimensions/${row.dimensionId}`);
  revalidatePath('/admin/settings/branches');
  return row;
}

export async function deleteDimensionValueAction(id: string): Promise<void> {
  await requirePermission('dimensions:manage');
  const existing = await getContainer().dimensions.getValueById(id);
  await writeService().deleteValue(id);
  if (existing) {
    revalidatePath(`/admin/settings/dimensions/${existing.dimensionId}`);
  }
  revalidatePath('/admin/settings/branches');
}
