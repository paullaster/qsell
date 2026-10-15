import { has, required } from '@/lib/values';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  dimensionSets,
  dimensionSetEntries,
  type DimensionCodesProjection,
  type DimensionRow,
  type DimensionSetRow,
} from '@/server/db/drizzle/schema';
import { type DimensionRepository } from './repository';
import {
  buildProjectionFromEntries,
  emptyDimensionCodes,
  fieldMapToProjection,
  listDimensionFieldDescriptors,
} from './projection';


export class DimensionSetService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly dims: DimensionRepository,
  ) {}

  async listFieldContract(companyId: string) {
    const all = await this.dims.listByCompany(companyId);
    return listDimensionFieldDescriptors(all.filter((d) => d.isActive && !d.blocked));
  }

  /**
   * Resolve field map / projection → get-or-create set + rebuildable projection.
   */
  async resolveAssignment(
    companyId: string,
    fields: Record<string, string | null | undefined> | DimensionCodesProjection,
  ): Promise<{
    dimensionSetId: string | null;
    dimensionCodes: DimensionCodesProjection;
  }> {
    const all = await this.dims.listByCompany(companyId);
    const prominent = all.filter(
      (d) => d.isActive && !d.blocked && (d.isGlobal || d.isShortcut),
    );
    const descriptors = listDimensionFieldDescriptors(prominent);
    const projection = fieldMapToProjection(fields, descriptors);

    const valueIds: {
      dimension: DimensionRow;
      valueId: string;
      valueCode: string;
    }[] = [];

    for (const d of descriptors) {
      const bucket = d.kind === 'global' ? projection.global : projection.shortcut;
      const code = bucket[String(d.dimensionNo)];
      if (!has(code)) continue;

      const values = await this.dims.listValues(d.dimensionId);
      const match = values.find(
        (v) => v.code === code && v.isActive && !v.blocked,
      );
      if (!match) {
        throw new Error(
          `Unknown or inactive value "${code}" for ${d.fieldName} (${d.dimensionCode}).`,
        );
      }
      valueIds.push({
        dimension: required(prominent.find((x) => x.id === d.dimensionId), `dimension ${d.dimensionId}`),
        valueId: match.id,
        valueCode: match.code,
      });
    }

    if (valueIds.length === 0) {
      return { dimensionSetId: null, dimensionCodes: emptyDimensionCodes() };
    }

    const sortedIds = [...valueIds.map((v) => v.valueId)].sort();
    const contentHash = createHash('sha256').update(sortedIds.join('|')).digest('hex');

    const existing = await this.db
      .select()
      .from(dimensionSets)
      .where(
        and(
          eq(dimensionSets.companyId, companyId),
          eq(dimensionSets.contentHash, contentHash),
        ),
      )
      .limit(1);

    let setRow: DimensionSetRow;
    if (existing[0]) {
      setRow = existing[0];
    } else {
      const [created] = await this.db
        .insert(dimensionSets)
        .values({ companyId, contentHash })
        .returning();
      setRow = required(created, 'the saved dimension set');
      await this.db.insert(dimensionSetEntries).values(
        valueIds.map((v) => ({
          dimensionSetId: setRow.id,
          dimensionId: v.dimension.id,
          dimensionValueId: v.valueId,
          dimensionCode: v.dimension.code,
          dimensionValueCode: v.valueCode,
          dimensionNo: v.dimension.dimensionNo,
          isGlobal: v.dimension.isGlobal,
          isShortcut: v.dimension.isShortcut,
        })),
      );
    }

    const entries = await this.db
      .select()
      .from(dimensionSetEntries)
      .where(eq(dimensionSetEntries.dimensionSetId, setRow.id));

    return {
      dimensionSetId: setRow.id,
      dimensionCodes: buildProjectionFromEntries(entries),
    };
  }
}
