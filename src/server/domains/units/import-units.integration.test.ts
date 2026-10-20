import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { AppContainer } from '@/server/di/container';

/**
 * The product CSV import with the Unit column and stock in decimals, and the role grants the migration gives
 * existing roles.   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')(
  'import with units, and the unit permission migration (database)',
  () => {
    let db: typeof Db;
    let schema: typeof Schema;
    let c: AppContainer;
    let categoryName: string;
    const tag = randomUUID().slice(0, 6).toUpperCase();
    let actor = { id: '', email: '' };

    const csv = (rows: string[][]) =>
      new TextEncoder().encode(
        [
          'SKU,Stock_Code,Name,Category,Cost_Price,Price,Stock_Qty,Unit',
          ...rows.map((r) => r.join(',')),
        ].join('\n'),
      );
    const stage = (rows: string[][]) =>
      c.productImports.stage({ fileName: 'units.csv', bytes: csv(rows), actor });
    const productBySku = async (sku: string) =>
      (await db.select().from(schema.products).where(eq(schema.products.sku, sku)))[0];

    beforeAll(async () => {
      const mod = await import('@/server/di/container');
      db = (await import('@/server/db/drizzle/client')).drizzleDb;
      schema = await import('@/server/db/drizzle/schema');
      c = mod.getContainer();
      const company = await c.companySettings.ensureSeeded();
      await c.reasonCodes.ensureSystemReasons(company.id);
      const user = (
        await db
          .insert(schema.users)
          .values({
            email: `imp-${tag}@t.test`,
            passwordHash: 'x',
            name: 'Importer',
            role: 'manager',
          })
          .returning()
      )[0];
      actor = { id: user?.id ?? '', email: user?.email ?? '' };
      categoryName = `Import ${tag}`;
      await db
        .insert(schema.categories)
        .values({ id: `cat_${tag}`, name: categoryName, slug: `import-${tag.toLowerCase()}` });
      const typeId = `it_imp_${tag}`;
      await db
        .insert(schema.itemTypes)
        .values({
          id: typeId,
          code: Math.floor(Math.random() * 1e9),
          name: typeId,
          isDefault: true,
        });
    });

    it('refuses a unit that does not exist, and a fraction of a piece, naming the row and column', async () => {
      const result = await stage([
        [`IMP-${tag}-1`, `IS-${tag}-1`, 'Fish', categoryName, '50', '100', '2.5', 'NOPE'],
        [`IMP-${tag}-2`, `IS-${tag}-2`, 'Phone', categoryName, '50', '100', '2.5', 'pcs'],
      ]);
      expect(result.ok).toBe(false);
      const problems = result.ok ? [] : result.problems;
      expect(problems.find((p) => p.column === 'Unit')?.message).toMatch(/does not exist/);
      expect(problems.find((p) => p.column === 'Stock_Qty')?.message).toMatch(/whole number/);
    });

    it('creates products in the unit named (any letter case), or the default when blank, with decimal stock', async () => {
      const result = await stage([
        [`IMP-${tag}-3`, `IS-${tag}-3`, 'Fish', categoryName, '50', '100', '12.5', 'kg'],
        [`IMP-${tag}-4`, `IS-${tag}-4`, 'Phone', categoryName, '50', '100', '3', ''],
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await c.productImports.process(result.jobId, () => undefined);
      const fish = await productBySku(`IMP-${tag}-3`);
      const phone = await productBySku(`IMP-${tag}-4`);
      expect(fish?.stockQuantity).toBe(12.5);
      expect(fish?.baseUnitId).toBe(
        (
          await db.select().from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.code, 'KG'))
        )[0]?.id,
      );
      expect(phone?.baseUnitId).toBe((await c.units.getDefault())?.id);
      const movement = (
        await db
          .select()
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.productId, fish?.id ?? ''))
      )[0];
      expect(movement?.newStock).toBe(12.5);
    });

    it('exports the unit code', async () => {
      const { buildProductsCsv } = await import('@/lib/productCsv');
      const { CatalogService } = await import('@/server/domains/catalog/service');
      const fish = await productBySku(`IMP-${tag}-3`);
      const product = await CatalogService.getProductById(fish?.id ?? '');
      const text = buildProductsCsv(product === undefined ? [] : [product]);
      expect(text.split('\n')[0]).toContain('Unit');
      expect(text).toContain(',KG,');
    });

    it('gives existing roles the unit permissions by what they may do with products', async () => {
      const { sql } = await import('drizzle-orm');
      const { readFileSync } = await import('node:fs');
      const key = (k: string) => k;
      const ensurePermission = async (k: string) => {
        await db
          .insert(schema.permissions)
          .values({ key: k, resource: k.split(':')[0] ?? k, action: k.split(':')[1] ?? k })
          .onConflictDoNothing();
        return (
          (await db.select().from(schema.permissions).where(eq(schema.permissions.key, k)))[0]
            ?.id ?? ''
        );
      };
      const read = await ensurePermission(key('products:read'));
      const update = await ensurePermission(key('products:update'));
      const makeRole = async (name: string, grants: string[]) => {
        const role = (
          await db
            .insert(schema.roles)
            .values({ key: `um_${name}_${tag}`.toLowerCase(), name: `${name} ${tag}` })
            .returning()
        )[0];
        for (const g of grants)
          await db
            .insert(schema.rolePermissions)
            .values({ roleId: role?.id ?? '', permissionId: g });
        return role?.id ?? '';
      };
      const viewer = await makeRole('viewer', [read]);
      const editor = await makeRole('editor', [read, update]);
      const nothing = await makeRole('nothing', []);
      // The migration is run again: it is written to be safe to repeat.
      for (const statement of readFileSync('drizzle/0066_unit_permissions.sql', 'utf8').split(
        '--> statement-breakpoint',
      )) {
        await db.execute(sql.raw(statement));
      }
      const grantsOf = async (roleId: string) => {
        const rows = await db
          .select({ key: schema.permissions.key })
          .from(schema.rolePermissions)
          .innerJoin(
            schema.permissions,
            eq(schema.permissions.id, schema.rolePermissions.permissionId),
          )
          .where(eq(schema.rolePermissions.roleId, roleId));
        return rows
          .map((r) => r.key)
          .filter((k) => k.startsWith('units:'))
          .sort();
      };
      expect(await grantsOf(viewer)).toEqual(['units:read']);
      expect(await grantsOf(editor)).toEqual(['units:manage', 'units:read']);
      expect(await grantsOf(nothing)).toEqual([]);
    });
  },
);
