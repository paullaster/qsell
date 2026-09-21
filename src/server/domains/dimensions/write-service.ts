import type { DimensionRow, DimensionValueRow } from '@/server/db/drizzle/schema';
import { PAYMENT_PROVIDER_META, type PaymentProviderCode } from '@/server/domains/payments/types';
import { PaymentConfigRepository } from '@/server/domains/payments/repository';
import { BranchRepository } from '@/server/domains/branches/repository';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { DimensionRepository } from './repository';
import {
  isDimensionOptionString,
  type DimensionOptionString,
} from './option-strings';

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '_');
}

export type DimensionFlagInput = {
  isGlobal?: boolean;
  isDefault?: boolean;
  isShortcut?: boolean;
};

/** Apply default → global auto, and global XOR shortcut. */
export function resolveDimensionFlags(input: DimensionFlagInput): {
  isGlobal: boolean;
  isDefault: boolean;
  isShortcut: boolean;
} {
  let isDefault = Boolean(input.isDefault);
  let isGlobal = Boolean(input.isGlobal);
  let isShortcut = Boolean(input.isShortcut);

  if (isDefault) {
    isGlobal = true;
    isShortcut = false;
  }

  if (isGlobal && isShortcut) {
    throw new Error('A dimension cannot be both global and shortcut.');
  }

  if (isDefault && isShortcut) {
    throw new Error('A default dimension cannot be a shortcut.');
  }

  return { isGlobal, isDefault, isShortcut };
}

export class DimensionWriteService {
  constructor(
    private readonly repo: DimensionRepository,
    private readonly branches: BranchRepository,
    private readonly db: DrizzleDb,
  ) {}

  async createDimension(input: {
    companyId: string;
    code: string;
    name: string;
    description?: string | null;
    parentId?: string | null;
    dimensionNo?: number | null;
    isGlobal?: boolean;
    isDefault?: boolean;
    isShortcut?: boolean;
    optionString?: string | null;
    isActive?: boolean;
    blocked?: boolean;
  }): Promise<DimensionRow> {
    const code = normalizeCode(input.code);
    if (!code) throw new Error('Dimension code is required.');
    if (!input.name.trim()) throw new Error('Dimension name is required.');

    const existing = await this.repo.getByCode(input.companyId, code);
    if (existing) throw new Error(`Dimension code "${code}" already exists.`);

    const optionString = this.parseOptionString(input.optionString);
    if (optionString) {
      const taken = await this.repo.getByOptionString(input.companyId, optionString);
      if (taken) {
        throw new Error(`Option "${optionString}" is already assigned to another dimension.`);
      }
    }

    await this.assertParentDimension(input.companyId, null, input.parentId ?? null);

    const flags = resolveDimensionFlags({
      isGlobal: input.isGlobal,
      isDefault: input.isDefault,
      isShortcut: input.isShortcut,
    });

    const dimensionNo = await this.resolveDimensionNo(
      input.companyId,
      null,
      input.dimensionNo ?? null,
      flags,
    );

    return this.repo.insert({
      companyId: input.companyId,
      code,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      parentId: input.parentId || null,
      dimensionNo,
      ...flags,
      optionString,
      isActive: input.isActive ?? true,
      blocked: input.blocked ?? false,
    });
  }

  async updateDimension(
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
    const current = await this.repo.getById(id);
    if (!current) throw new Error('Dimension not found.');

    const code =
      patch.code !== undefined ? normalizeCode(patch.code) : current.code;
    if (!code) throw new Error('Dimension code is required.');

    if (code !== current.code) {
      const clash = await this.repo.getByCode(current.companyId, code);
      if (clash && clash.id !== id) {
        throw new Error(`Dimension code "${code}" already exists.`);
      }
    }

    const optionString =
      patch.optionString !== undefined
        ? this.parseOptionString(patch.optionString)
        : current.optionString;

    if (optionString) {
      const taken = await this.repo.getByOptionString(current.companyId, optionString);
      if (taken && taken.id !== id) {
        throw new Error(`Option "${optionString}" is already assigned to another dimension.`);
      }
    }

    const parentId = patch.parentId !== undefined ? patch.parentId : current.parentId;
    await this.assertParentDimension(current.companyId, id, parentId);
    if (await this.repo.wouldCreateDimensionCycle(current.companyId, id, parentId)) {
      throw new Error('Parent would create a cycle.');
    }

    const flags = resolveDimensionFlags({
      isGlobal: patch.isGlobal !== undefined ? patch.isGlobal : current.isGlobal,
      isDefault: patch.isDefault !== undefined ? patch.isDefault : current.isDefault,
      isShortcut: patch.isShortcut !== undefined ? patch.isShortcut : current.isShortcut,
    });

    const dimensionNo = await this.resolveDimensionNo(
      current.companyId,
      id,
      patch.dimensionNo !== undefined ? patch.dimensionNo : current.dimensionNo,
      flags,
    );

    const updated = await this.repo.update(id, {
      code,
      name: patch.name !== undefined ? patch.name.trim() : current.name,
      description:
        patch.description !== undefined
          ? patch.description?.trim() || null
          : current.description,
      parentId: parentId || null,
      dimensionNo,
      ...flags,
      optionString,
      isActive: patch.isActive !== undefined ? patch.isActive : current.isActive,
      blocked: patch.blocked !== undefined ? patch.blocked : current.blocked,
    });

    if (!updated) throw new Error('Dimension not found.');

    if (code !== current.code) {
      await this.repo.syncDimensionCodeOnValues(id, code);
    }

    if (optionString === 'branch' && current.optionString !== 'branch') {
      await this.backfillBranchLinks(updated);
    }

    return updated;
  }

  async deleteDimension(id: string): Promise<void> {
    const current = await this.repo.getById(id);
    if (!current) throw new Error('Dimension not found.');

    const childDims = await this.repo.countChildDimensions(id);
    if (childDims > 0) {
      throw new Error('Remove or re-parent child dimensions before deleting.');
    }

    const setEntries = await this.repo.countSetEntriesForDimension(id);
    if (setEntries > 0) {
      throw new Error('Cannot delete a dimension that is used on records.');
    }

    const values = await this.repo.listValues(id);
    for (const value of values) {
      await this.deactivateLinkedBranch(value);
    }

    await this.repo.delete(id);
  }

  async createValue(input: {
    dimensionId: string;
    code: string;
    name: string;
    description?: string | null;
    parentId?: string | null;
    isActive?: boolean;
    blocked?: boolean;
  }): Promise<DimensionValueRow> {
    const dimension = await this.repo.getById(input.dimensionId);
    if (!dimension) throw new Error('Dimension not found.');

    const code = normalizeCode(input.code);
    if (!code) throw new Error('Value code is required.');
    if (!input.name.trim()) throw new Error('Value name is required.');

    const values = await this.repo.listValues(dimension.id);
    if (values.some((v) => v.code === code)) {
      throw new Error(`Value code "${code}" already exists on this dimension.`);
    }

    await this.assertParentValue(dimension, null, input.parentId ?? null);

    const isActive = input.isActive ?? true;
    const name = input.name.trim();

    let linkedBranchId: string | null = null;
    if (dimension.optionString === 'branch') {
      linkedBranchId = await this.ensureBranchForValue({
        companyId: dimension.companyId,
        code,
        name,
        isActive,
        linkedBranchId: null,
      });
    }

    return this.repo.insertValue({
      dimensionId: dimension.id,
      dimensionCode: dimension.code,
      code,
      name,
      description: input.description?.trim() || null,
      parentId: input.parentId || null,
      linkedBranchId,
      isActive,
      blocked: input.blocked ?? false,
    });
  }

  async updateValue(
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
    const current = await this.repo.getValueById(id);
    if (!current) throw new Error('Dimension value not found.');

    const dimension = await this.repo.getById(current.dimensionId);
    if (!dimension) throw new Error('Dimension not found.');

    const code =
      patch.code !== undefined ? normalizeCode(patch.code) : current.code;
    if (!code) throw new Error('Value code is required.');

    if (code !== current.code) {
      const siblings = await this.repo.listValues(dimension.id);
      if (siblings.some((v) => v.code === code && v.id !== id)) {
        throw new Error(`Value code "${code}" already exists on this dimension.`);
      }
    }

    const parentId = patch.parentId !== undefined ? patch.parentId : current.parentId;
    await this.assertParentValue(dimension, id, parentId);
    if (await this.repo.wouldCreateValueCycle(id, parentId)) {
      throw new Error('Parent would create a cycle.');
    }

    const name = patch.name !== undefined ? patch.name.trim() : current.name;
    const isActive =
      patch.isActive !== undefined ? patch.isActive : current.isActive;

    let linkedBranchId = current.linkedBranchId;
    if (dimension.optionString === 'branch') {
      linkedBranchId = await this.ensureBranchForValue({
        companyId: dimension.companyId,
        code,
        name,
        isActive,
        linkedBranchId: current.linkedBranchId,
      });
    }

    const updated = await this.repo.updateValue(id, {
      code,
      name,
      description:
        patch.description !== undefined
          ? patch.description?.trim() || null
          : current.description,
      parentId: parentId || null,
      dimensionCode: dimension.code,
      linkedBranchId,
      isActive,
      blocked: patch.blocked !== undefined ? patch.blocked : current.blocked,
    });

    if (!updated) throw new Error('Dimension value not found.');
    return updated;
  }

  async deleteValue(id: string): Promise<void> {
    const current = await this.repo.getValueById(id);
    if (!current) throw new Error('Dimension value not found.');

    const childValues = await this.repo.countChildValues(id);
    if (childValues > 0) {
      throw new Error('Remove or re-parent child values before deleting.');
    }

    const setEntries = await this.repo.countSetEntriesForValue(id);
    if (setEntries > 0) {
      throw new Error('Cannot delete a dimension value that is used on records.');
    }

    await this.deactivateLinkedBranch(current);
    await this.repo.deleteValue(id);
  }

  private async backfillBranchLinks(dimension: DimensionRow): Promise<void> {
    const values = await this.repo.listValues(dimension.id);
    for (const value of values) {
      if (value.linkedBranchId) continue;
      const linkedBranchId = await this.ensureBranchForValue({
        companyId: dimension.companyId,
        code: value.code,
        name: value.name,
        isActive: value.isActive,
        linkedBranchId: null,
      });
      await this.repo.updateValue(value.id, { linkedBranchId });
    }
  }

  private async ensureBranchForValue(input: {
    companyId: string;
    code: string;
    name: string;
    isActive: boolean;
    linkedBranchId: string | null;
  }): Promise<string> {
    if (input.linkedBranchId) {
      const existing = await this.branches.getById(input.linkedBranchId);
      if (existing) {
        const codeClash = await this.branches.getByCode(input.companyId, input.code);
        if (codeClash && codeClash.id !== existing.id) {
          throw new Error(`Branch code "${input.code}" already exists.`);
        }
        await this.branches.update(existing.id, {
          code: input.code,
          name: input.name,
          isActive: input.isActive,
        });
        return existing.id;
      }
    }

    const byCode = await this.branches.getByCode(input.companyId, input.code);
    if (byCode) {
      await this.branches.update(byCode.id, {
        name: input.name,
        isActive: input.isActive,
      });
      return byCode.id;
    }

    const created = await this.branches.create({
      companyId: input.companyId,
      code: input.code,
      name: input.name,
      isDefault: false,
      isActive: input.isActive,
      actsIndependently: false,
    });

    const configRepo = new PaymentConfigRepository(this.db);
    for (const providerCode of Object.keys(PAYMENT_PROVIDER_META) as PaymentProviderCode[]) {
      const meta = PAYMENT_PROVIDER_META[providerCode];
      await configRepo.upsert({
        branchId: created.id,
        providerCode,
        displayName: meta.label,
        isEnabled: false,
        environment: 'staging',
        apiBaseUrl: meta.defaultStagingBaseUrl,
        credentialsEncrypted: null,
        settings: {},
        replaceCredentials: true,
      });
    }

    return created.id;
  }

  private async deactivateLinkedBranch(value: DimensionValueRow): Promise<void> {
    if (!value.linkedBranchId) return;
    const branch = await this.branches.getById(value.linkedBranchId);
    if (!branch) return;
    if (branch.isDefault) {
      throw new Error(
        'Cannot delete this value: it is linked to the default branch. Change the default branch first.',
      );
    }
    await this.branches.update(branch.id, { isActive: false });
  }

  private async resolveDimensionNo(
    companyId: string,
    selfId: string | null,
    dimensionNo: number | null,
    flags: { isGlobal: boolean; isShortcut: boolean },
  ): Promise<number | null> {
    const prominent = flags.isGlobal || flags.isShortcut;
    if (prominent) {
      if (dimensionNo == null || !Number.isFinite(dimensionNo) || dimensionNo < 1) {
        throw new Error('dimension_no is required for global and shortcut dimensions (integer ≥ 1).');
      }
      const taken = await this.repo.getByDimensionNo(companyId, dimensionNo);
      if (taken && taken.id !== selfId) {
        throw new Error(`dimension_no ${dimensionNo} is already used by ${taken.code}.`);
      }
      return Math.floor(dimensionNo);
    }
    if (dimensionNo != null) {
      const taken = await this.repo.getByDimensionNo(companyId, dimensionNo);
      if (taken && taken.id !== selfId) {
        throw new Error(`dimension_no ${dimensionNo} is already used by ${taken.code}.`);
      }
      return Math.floor(dimensionNo);
    }
    return null;
  }

  private parseOptionString(
    raw: string | null | undefined,
  ): DimensionOptionString | null {
    if (raw == null || raw === '') return null;
    if (!isDimensionOptionString(raw)) {
      throw new Error(`Unknown option string "${raw}".`);
    }
    return raw;
  }

  private async assertParentDimension(
    companyId: string,
    selfId: string | null,
    parentId: string | null,
  ): Promise<void> {
    if (!parentId) return;
    const parent = await this.repo.getById(parentId);
    if (!parent || parent.companyId !== companyId) {
      throw new Error('Parent dimension not found in this company.');
    }
    if (selfId && parentId === selfId) {
      throw new Error('A dimension cannot be its own parent.');
    }
  }

  private async assertParentValue(
    dimension: DimensionRow,
    selfId: string | null,
    parentId: string | null,
  ): Promise<void> {
    if (!parentId) return;
    const parent = await this.repo.getValueById(parentId);
    if (!parent) throw new Error('Parent value not found.');

    if (dimension.parentId) {
      if (parent.dimensionId !== dimension.parentId) {
        throw new Error(
          'Parent value must belong to this dimension’s parent dimension.',
        );
      }
    } else if (parent.dimensionId !== dimension.id) {
      throw new Error(
        'Without a parent dimension, value parents must be on the same dimension.',
      );
    }

    if (selfId && parentId === selfId) {
      throw new Error('A value cannot be its own parent.');
    }
  }
}
