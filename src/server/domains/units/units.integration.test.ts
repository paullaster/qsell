import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as Sources from '@/server/domains/lookups/sources';
import type * as Request from '@/server/domains/lookups/request';
import type * as Errors from './errors';
import type * as CatalogModule from '@/server/domains/catalog/service';
import type { AppContainer } from '@/server/di/container';
import type { ProductWrite } from '@/types/index';
import { emptyUnitDraft, type UnitDraft } from '@/lib/unit-rules';

/**
 * Units of measure against a real database: the standard units the migration seeds, the rules that keep
 * quantities meaningful (locks, restrictions on removing a unit in use), the product's base unit and
 * alternate units, and the pickers.   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('units of measure (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let sources: typeof Sources;
  let request: typeof Request;
  let errors: typeof Errors;
  let c: AppContainer;
  let itemTypeId: string;
  let CatalogService: (typeof CatalogModule)['CatalogService'];
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const draft = (over: Partial<UnitDraft> = {}): UnitDraft => ({
    ...emptyUnitDraft(),
    kind: 'mass',
    decimals: '3',
    ...over,
  });
  const code = (suffix: string) => `${tag}${suffix}`;
  const byCode = async (unitCode: string) =>
    (
      await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.code, unitCode))
    )[0];
  const idOf = async (unitCode: string) => (await byCode(unitCode))?.id ?? '';

  const search = async (
    key: string,
    over: { query?: string; filters?: Record<string, string> } = {},
  ) => {
    const parsed = request.parseLookupRequest({
      source: key,
      query: over.query,
      filters: over.filters,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const source = sources.getLookupSource(key);
    if (source === undefined) throw new Error(`no source ${key}`);
    const { query, limit, after, filters } = parsed.value;
    return await source.search({ companyId: 'unused', query, limit, after, filters });
  };

  const product = (over: Partial<ProductWrite> = {}): ProductWrite => ({
    sku: `U${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    stockCode: `S${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    name: `Fish ${tag}`,
    slug: `fish-${randomUUID()}`,
    description: '',
    category: '',
    itemTypeId,
    itemTypeName: '',
    itemTypeCode: 0,
    isSellable: true,
    price: 100,
    costPrice: 50,
    stockQuantity: 0,
    lowStockThreshold: 0,
    isActive: true,
    imageUrl: '',
    rating: 0,
    reviewCount: 0,
    tags: [],
    ...over,
  });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    sources = await import('@/server/domains/lookups/sources');
    request = await import('@/server/domains/lookups/request');
    errors = await import('./errors');
    ({ CatalogService } = await import('@/server/domains/catalog/service'));
    c = mod.getContainer();
    itemTypeId = `it_uom_${tag}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  describe('the standard units', () => {
    it('are there after migrating, with exactly one default', async () => {
      const kg = await byCode('KG');
      expect(kg).toMatchObject({
        kind: 'mass',
        baseUnitId: null,
        decimals: 3,
        internationalCode: 'KGM',
      });
      const g = await byCode('G');
      expect(g?.baseUnitId).toBe(kg?.id);
      expect(Number(g?.factorToBase)).toBe(0.001);
      const defaults = await db
        .select()
        .from(schema.unitsOfMeasure)
        .where(eq(schema.unitsOfMeasure.isDefault, true));
      expect(defaults.map((d) => d.code)).toEqual(['PCS']);
    });

    it('give a product written without a unit the default unit', async () => {
      const id = `prod_${randomUUID()}`;
      await db.insert(schema.products).values({
        id,
        sku: `D${tag}1`,
        stockCode: `D${tag}2`,
        name: 'Plain',
        slug: `plain-${id}`,
        itemTypeId,
        price: '1',
      });
      const row = (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0];
      expect(row?.baseUnitId).toBe(await idOf('PCS'));
    });
  });

  describe('making and changing units', () => {
    it('makes a base unit and a multiple of it, and refuses a duplicate with words', async () => {
      const base = await c.unitWriter.create(draft({ code: code('B'), name: `Base ${tag}` }));
      expect(base).toMatchObject({
        code: code('B'),
        kind: 'mass',
        baseUnitId: null,
        factorToBase: '1.0000000000',
        isActive: true,
        isDefault: false,
        version: 1,
      });
      const sub = await c.unitWriter.create(
        draft({
          code: code('S'),
          name: `Sub ${tag}`,
          baseUnitId: base.id,
          factorToBase: '0.001',
          decimals: '0',
        }),
      );
      expect(sub.baseUnitId).toBe(base.id);
      await expect(
        c.unitWriter.create(draft({ code: code('B'), name: 'Other name' })),
      ).rejects.toThrow(/already exists/);
      await expect(
        c.unitWriter.create(draft({ code: code('X'), name: `base ${tag}`.toUpperCase() })),
      ).rejects.toThrow(/already exists/);
      await expect(c.unitWriter.create(draft({ code: code('B') }))).rejects.toBeInstanceOf(
        errors.UnitError,
      );
    });

    it('refuses a base that is missing, of another kind, itself a multiple, or switched off', async () => {
      const base = await idOf(code('B'));
      const sub = await idOf(code('S'));
      await expect(
        c.unitWriter.create(
          draft({
            code: code('N1'),
            name: `n1 ${tag}`,
            baseUnitId: randomUUID(),
            factorToBase: '2',
          }),
        ),
      ).rejects.toThrow(/does not exist/);
      await expect(
        c.unitWriter.create(
          draft({
            code: code('N2'),
            name: `n2 ${tag}`,
            kind: 'volume',
            baseUnitId: base,
            factorToBase: '2',
          }),
        ),
      ).rejects.toThrow(/same kind/);
      await expect(
        c.unitWriter.create(
          draft({ code: code('N3'), name: `n3 ${tag}`, baseUnitId: sub, factorToBase: '2' }),
        ),
      ).rejects.toThrow(/base of the family/);
      const off = await c.unitWriter.create(draft({ code: code('OFF'), name: `off ${tag}` }));
      await c.unitWriter.update(
        off.id,
        off.version,
        draft({ code: code('OFF'), name: `off ${tag}` }),
        false,
      );
      await expect(
        c.unitWriter.create(
          draft({ code: code('N4'), name: `n4 ${tag}`, baseUnitId: off.id, factorToBase: '2' }),
        ),
      ).rejects.toThrow(/switched off/);
    });

    it('refuses what the database also refuses (a unit cannot be its own base)', async () => {
      const base = await byCode(code('B'));
      await expect(
        db
          .update(schema.unitsOfMeasure)
          .set({ baseUnitId: base?.id, factorToBase: '2' })
          .where(eq(schema.unitsOfMeasure.id, base?.id ?? '')),
      ).rejects.toThrow();
    });

    it('saves a change only if the person saw the latest version', async () => {
      const unit = await c.unitWriter.create(draft({ code: code('V'), name: `Version ${tag}` }));
      const next = await c.unitWriter.update(
        unit.id,
        1,
        draft({ code: code('V'), name: `Version ${tag} renamed` }),
        undefined,
      );
      expect(next.version).toBe(2);
      await expect(
        c.unitWriter.update(unit.id, 1, draft({ code: code('V'), name: 'Stale' }), undefined),
      ).rejects.toThrow(/Someone else changed/);
    });
  });

  describe('a unit in use', () => {
    let fishUnit: string;
    let crateUnit: string;
    let productId: string;

    it('is counted for each place it is used, in a batch', async () => {
      fishUnit = await idOf(code('B'));
      crateUnit = (
        await c.unitWriter.create(
          draft({ code: code('CR'), name: `Crate ${tag}`, kind: 'packaging', decimals: '0' }),
        )
      ).id;
      const made = await CatalogService.createProduct(
        product({
          baseUnitId: fishUnit,
          packagings: [
            {
              unitId: crateUnit,
              qtyPerBase: '20',
              weightKg: '21.5',
              isSalesDefault: true,
              isPurchaseDefault: false,
            },
          ],
        }),
      );
      productId = made.id;
      expect(made).toMatchObject({ baseUnitId: fishUnit, baseUnitCode: code('B') });
      const usage = await c.units.usageOf([fishUnit, crateUnit]);
      expect(usage[fishUnit]).toEqual({
        products: 1,
        packagings: 0,
        derivedUnits: 1,
        documentLines: 0,
      });
      expect(usage[crateUnit]).toEqual({
        products: 0,
        packagings: 1,
        derivedUnits: 0,
        documentLines: 0,
      });
    });

    it('cannot be deleted, with the reason in words; an unused unit can', async () => {
      await expect(c.unitWriter.remove(fishUnit)).rejects.toThrow(
        /Used by 1 product, 1 other unit.*cannot be deleted/,
      );
      await expect(c.unitWriter.remove(crateUnit)).rejects.toThrow(/1 product packaging/);
      await expect(c.unitWriter.remove(await idOf('PCS'))).rejects.toThrow(
        /default unit cannot be deleted/,
      );
      const spare = await c.unitWriter.create(draft({ code: code('SP'), name: `Spare ${tag}` }));
      await c.unitWriter.remove(spare.id);
      expect(await byCode(code('SP'))).toBeUndefined();
      await expect(c.unitWriter.remove(spare.id)).rejects.toBeInstanceOf(errors.UnitError);
    });

    it('is kept by the database even if the application check is bypassed', async () => {
      await expect(
        db.delete(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, fishUnit)),
      ).rejects.toThrow();
      expect(await c.units.delete(fishUnit).catch(() => 'refused')).toBe('refused');
    });

    it('keeps its meaning: kind, base and factor are locked, decimals cannot shrink, names can change', async () => {
      const sub = await byCode(code('S'));
      expect(sub).toBeDefined();
      const usedSub = await CatalogService.createProduct(product({ baseUnitId: sub?.id }));
      expect(usedSub.baseUnitId).toBe(sub?.id);
      const current = await byCode(code('S'));
      const same = {
        code: code('S'),
        name: `Sub ${tag}`,
        kind: 'mass',
        baseUnitId: current?.baseUnitId ?? '',
        factorToBase: '0.001',
        decimals: '0',
      };
      await expect(
        c.unitWriter.update(
          current?.id ?? '',
          current?.version ?? 0,
          draft({ ...same, factorToBase: '0.002' }),
          undefined,
        ),
      ).rejects.toThrow(/can no longer change/);
      await expect(
        c.unitWriter.update(
          current?.id ?? '',
          current?.version ?? 0,
          draft({ ...same, kind: 'volume' }),
          undefined,
        ),
      ).rejects.toThrow(/can no longer change/);
      const widened = await c.unitWriter.update(
        current?.id ?? '',
        current?.version ?? 0,
        draft({ ...same, name: `Sub ${tag} renamed`, factorToBase: '0.0010', decimals: '2' }),
        undefined,
      );
      expect(widened).toMatchObject({ name: `Sub ${tag} renamed`, decimals: 2 });
      await expect(
        c.unitWriter.update(
          widened.id,
          widened.version,
          draft({ ...same, name: `Sub ${tag} renamed`, decimals: '1' }),
          undefined,
        ),
      ).rejects.toThrow(/Decimals cannot be lowered/);
    });

    it('can be switched off while in use, and then is no longer offered or accepted for new products', async () => {
      const unit = await byCode(code('CR'));
      const off = await c.unitWriter.update(
        unit?.id ?? '',
        unit?.version ?? 0,
        draft({ code: code('CR'), name: `Crate ${tag}`, kind: 'packaging', decimals: '0' }),
        false,
      );
      expect(off.isActive).toBe(false);
      expect((await search('units-of-measure', { query: code('CR') })).options).toHaveLength(0);
      await expect(CatalogService.createProduct(product({ baseUnitId: off.id }))).rejects.toThrow(
        /exists and is switched on/,
      );
      await expect(
        CatalogService.createProduct(
          product({
            baseUnitId: fishUnit,
            packagings: [
              {
                unitId: off.id,
                qtyPerBase: '5',
                weightKg: '',
                isSalesDefault: false,
                isPurchaseDefault: false,
              },
            ],
          }),
        ),
      ).rejects.toThrow(/switched on/);
      await c.unitWriter.update(
        off.id,
        off.version,
        draft({ code: code('CR'), name: `Crate ${tag}`, kind: 'packaging', decimals: '0' }),
        true,
      );
    });

    it('locks a product’s base unit once it has stock or history, and while alternate units were set against it', async () => {
      await expect(
        CatalogService.updateProduct(productId, { baseUnitId: await idOf('PCS') }),
      ).rejects.toThrow(/Re-enter them/);
      await CatalogService.updateProduct(productId, {
        baseUnitId: await idOf('PCS'),
        packagings: [],
      });
      const back = await CatalogService.getProductById(productId);
      expect(back?.baseUnitCode).toBe('PCS');
      const stocked = await CatalogService.createProduct(product({ stockQuantity: 5 }));
      await expect(
        CatalogService.updateProduct(stocked.id, { baseUnitId: fishUnit }),
      ).rejects.toThrow(/cannot be changed/);
    });

    it('replaces a product’s alternate units as one step, and cascades them away with the product', async () => {
      const made = await CatalogService.createProduct(product({ baseUnitId: fishUnit }));
      const bag = await c.unitWriter.create(
        draft({ code: code('BG'), name: `Bag ${tag}`, kind: 'packaging', decimals: '0' }),
      );
      await CatalogService.updateProduct(made.id, {
        packagings: [
          {
            unitId: bag.id,
            qtyPerBase: '5',
            weightKg: '5.2',
            isSalesDefault: false,
            isPurchaseDefault: true,
          },
        ],
      });
      let rows = await c.units.packagingOf(made.id);
      expect(rows.map((r) => [r.unitCode, Number(r.qtyPerBase), r.isPurchaseDefault])).toEqual([
        [code('BG'), 5, true],
      ]);
      await expect(
        CatalogService.updateProduct(made.id, {
          packagings: [
            {
              unitId: bag.id,
              qtyPerBase: '0',
              weightKg: '',
              isSalesDefault: false,
              isPurchaseDefault: false,
            },
          ],
        }),
      ).rejects.toThrow(/more than zero/);
      rows = await c.units.packagingOf(made.id);
      expect(rows).toHaveLength(1);
      await CatalogService.updateProduct(made.id, { name: 'Renamed' });
      expect(await c.units.packagingOf(made.id)).toHaveLength(1);
      await db.delete(schema.products).where(eq(schema.products.id, made.id));
      expect(await c.units.packagingOf(made.id)).toHaveLength(0);
    });
  });

  describe('the default unit', () => {
    it('moves to another active unit as one step, stays on, and must be switched on first', async () => {
      const pcs = await byCode('PCS');
      const other = await c.unitWriter.create(
        draft({ code: code('DF'), name: `Default ${tag}`, kind: 'count', decimals: '0' }),
      );
      const moved = await c.unitWriter.makeDefault(other.id);
      expect(moved.isDefault).toBe(true);
      expect(
        (
          await db
            .select()
            .from(schema.unitsOfMeasure)
            .where(eq(schema.unitsOfMeasure.isDefault, true))
        ).map((r) => r.code),
      ).toEqual([code('DF')]);
      await expect(
        c.unitWriter.update(
          other.id,
          moved.version,
          draft({ code: code('DF'), name: `Default ${tag}`, kind: 'count', decimals: '0' }),
          false,
        ),
      ).rejects.toThrow(/default unit must stay on/);
      const fresh = await CatalogService.createProduct(product());
      expect(fresh.baseUnitCode).toBe(code('DF'));
      await c.unitWriter.makeDefault(pcs?.id ?? '');
      expect((await c.units.getDefault())?.code).toBe('PCS');
      const off = await byCode(code('OFF'));
      await expect(c.unitWriter.makeDefault(off?.id ?? '')).rejects.toThrow(/Switch the unit on/);
    });
  });

  describe('the pickers and lists', () => {
    it('offers units that are on, searchable by code, name and symbol', async () => {
      expect((await search('units-of-measure', { query: tag })).options.length).toBeGreaterThan(0);
      expect(
        (await search('units-of-measure', { query: 'kilogram' })).options.map((o) => o.label),
      ).toContain('KG · Kilogram');
      expect((await search('units-of-measure', { query: code('OFF') })).options).toHaveLength(0);
      const kg = (await search('units-of-measure', { query: 'KG' })).options.find((o) =>
        o.label.startsWith('KG'),
      );
      expect(kg?.meta).toMatchObject({ code: 'KG', decimals: '3', kind: 'mass' });
    });

    it('narrows by kind, leaves one out, and offers only base units when asked', async () => {
      const mass = await search('units-of-measure', { filters: { kind: 'mass' } });
      expect(mass.options.every((o) => o.meta?.kind === 'mass')).toBe(true);
      const kg = await idOf('KG');
      expect(
        (await search('units-of-measure', { filters: { kind: 'mass', exclude: kg } })).options.map(
          (o) => o.id,
        ),
      ).not.toContain(kg);
      const bases = await search('units-of-measure', { filters: { bases: '1' } });
      const labels = bases.options.map((o) => o.label.split(' · ')[0]);
      expect(labels).toContain('KG');
      expect(labels).not.toContain('G');
      expect(labels).not.toContain('BOX');
    });

    it('refuses filters it does not know or values that are not valid', async () => {
      await expect(search('units-of-measure', { filters: { kind: 'weight' } })).rejects.toThrow();
      await expect(search('units-of-measure', { filters: { exclude: 'nope' } })).rejects.toThrow();
      await expect(search('units-of-measure', { filters: { bases: '2' } })).rejects.toThrow();
      await expect(search('units-of-measure', { filters: { other: 'x' } })).rejects.toThrow();
    });

    it('offers the kinds', async () => {
      expect((await search('unit-kinds')).options.map((o) => o.id).sort()).toEqual([
        'area',
        'count',
        'length',
        'mass',
        'packaging',
        'time',
        'volume',
      ]);
    });

    it('pages by code with a keyset cursor, no repeats, and narrows by kind and state', async () => {
      const first = await c.units.page({});
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.units.page({ cursor: first.nextCursor });
      const ids = [...first.rows, ...second.rows].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(first.rows.map((r) => r.code)).toEqual([...first.rows.map((r) => r.code)].sort());
      const packaging = await c.units.page({ kind: 'packaging', query: tag });
      expect(packaging.rows.every((r) => r.kind === 'packaging')).toBe(true);
      const off = await c.units.page({ status: 'inactive', query: tag });
      expect(off.rows.map((r) => r.code)).toContain(code('OFF'));
      expect((await c.units.page({ cursor: 'not-a-cursor' })).rows[0]?.code).toBe(
        first.rows[0]?.code,
      );
    });
  });
});
