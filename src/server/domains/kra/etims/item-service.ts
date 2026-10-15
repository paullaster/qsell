import { and, eq, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  etimsItems,
  itemTypes,
  products,
  taxCategories,
  type EtimsItemRow,
} from '@/server/db/drizzle/schema';
import { isValidEtimsCode } from '@/lib/kraTaxCodes';
import type { KraBranchLookup, KraConfigResolver } from '../resolver';
import { KraConfigError, type ResolvedEtimsConfig } from '../types';
import { EtimsApiError, EtimsClient, type EtimsItem, type EtimsItemWrite } from './client';

import { has } from '@/lib/values';

/** A `pending` row older than this is assumed abandoned and may be retried. */
const STALE_PENDING_MS = 5 * 60_000;
const ELIGIBLE_ITEM_TYPE_CODES = ['1', '2', '3'];

export type EtimsItemErrorCode =
  | 'PRODUCT_NOT_FOUND'
  | 'TAX_CODE_MISSING'
  | 'ITEM_TYPE_INVALID'
  | 'INVALID_INPUT'
  | 'ALREADY_REGISTERED'
  | 'NOT_REGISTERED'
  | 'NOT_CONFIRMED'
  | 'BRANCH_NOT_INDEPENDENT';

export class EtimsItemError extends Error {
  constructor(
    readonly code: EtimsItemErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EtimsItemError';
  }
}

/**
 * Who owns an item. Mirrors the KRA mode configuration:
 *  - no branch  → the company; used by every branch that does NOT act independently.
 *  - a branch   → only valid for a branch that acts independently; used by that branch alone.
 */
export interface EtimsScopeTarget {
  companyId: string;
  /** Null/undefined registers against the company. */
  branchId?: string | null;
}

export interface EtimsItemTarget extends EtimsScopeTarget {
  productId: string;
}

export interface RegisterEtimsItemInput extends EtimsItemTarget {
  qtyUnitCode: string;
  pkgUnitCode: string;
  itemClassCode: string;
  orgCountryCode?: string;
  /** Defaults to the product's current on-hand stock. */
  initialStock?: number;
}

export interface UpdateEtimsItemInput extends EtimsItemTarget {
  qtyUnitCode?: string;
  pkgUnitCode?: string;
  itemClassCode?: string;
  orgCountryCode?: string;
  /** New quantity to report. Omitted: keep the last quantity sent. */
  stock?: number;
}

export interface RemoteEtimsItem extends EtimsItem {
  /** Local row for the same KRA code in this scope, if any. */
  localItemId: string | null;
  localProductId: string | null;
}

export interface RegistrableProduct {
  id: string;
  name: string;
  sku: string;
  stock: number;
  hasEtimsTaxCode: boolean;
  qtyUnitCode: string;
  pkgUnitCode: string;
  itemClassCode: string;
}

/** A place eTIMS items can be managed: the company, or one independently-acting branch. */
export interface EtimsTargetView {
  scope: 'company' | 'branch';
  branchId: string | null;
  label: string;
  /** Branch code; null for the company. */
  code: string | null;
  /** False when the eTIMS configuration is unusable; `reason` is the hard-fail message. */
  usable: boolean;
  reason: string | null;
}

export interface ProductEtimsItemView {
  id: string;
  status: EtimsItemRow['status'];
  kraItemCode: string | null;
  taxCode: string;
  qtyUnitCode: string;
  pkgUnitCode: string;
  itemClassCode: string;
  stockQuantity: number;
  errorMessage: string | null;
  /** Product fields that no longer match what KRA was last sent. Empty when in sync. */
  drift: ('name' | 'price' | 'taxCode' | 'itemType')[];
}

export interface ProductEtimsTargetView extends EtimsTargetView {
  item: ProductEtimsItemView | null;
  /** Codes to pre-fill: reused from the product's latest registration anywhere. */
  suggested: { qtyUnitCode: string; pkgUnitCode: string; itemClassCode: string };
}

export interface ProductEtimsOverview {
  /** Why the product cannot be registered yet (e.g. no eTIMS tax code), if so. */
  productIssue: string | null;
  stock: number | null;
  /** Only targets whose mode is eTIMS. TIMS and unconfigured targets are absent. */
  targets: ProductEtimsTargetView[];
}

export interface BranchForEtims {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  actsIndependently: boolean;
}

interface ProductSnapshot {
  name: string;
  price: number;
  stock: number;
  itemTypeCode: string;
  taxCode: string;
}

type Scope = { kind: 'company' } | { kind: 'branch'; branchId: string };

interface Connection {
  config: ResolvedEtimsConfig;
  scope: Scope;
  client: EtimsClient;
}

export class EtimsItemService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly resolver: KraConfigResolver,
    private readonly branches: KraBranchLookup,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * The places eTIMS items can be managed right now. A target appears only when its mode is
   * eTIMS: the company, plus each active independent branch set to eTIMS. Branches that do
   * not act independently never appear — they use the company's items. Two queries total
   * regardless of branch count.
   */
  async listTargets(input: {
    companyId: string;
    branches: BranchForEtims[];
  }): Promise<EtimsTargetView[]> {
    const independent = input.branches.filter((b) => b.isActive && b.actsIndependently);
    const [company, byBranch] = await Promise.all([
      this.resolver.inspectCompany(input.companyId),
      this.resolver.inspectBranches(independent.map((b) => b.id)),
    ]);
    const targets: EtimsTargetView[] = [];
    if (company.mode === 'etims') {
      targets.push({
        scope: 'company',
        branchId: null,
        label: 'Company',
        code: null,
        usable: company.usable,
        reason: company.reason,
      });
    }
    for (const b of independent) {
      const inspected = byBranch.get(b.id);
      if (inspected?.mode !== 'etims') continue;
      targets.push({
        scope: 'branch',
        branchId: b.id,
        label: b.name,
        code: b.code,
        usable: inspected.usable,
        reason: inspected.reason,
      });
    }
    return targets;
  }

  async listLocal(target: EtimsScopeTarget): Promise<EtimsItemRow[]> {
    const { scope } = await this.connect(target);
    return await this.localItems(target.companyId, scope);
  }

  /** Live list from the gateway for this scope, each entry tagged with our local row. */
  async listRemote(target: EtimsScopeTarget): Promise<RemoteEtimsItem[]> {
    const { client, scope } = await this.connect(target);
    const response = await client.listItems();
    const local = await this.localItems(target.companyId, scope);
    const byCode = new Map(local.flatMap((r) => (has(r.kraItemCode) ? [[r.kraItemCode, r] as const] : [])));
    return (response.data ?? []).map((item) => {
      const row = has(item.itemCode) ? byCode.get(item.itemCode) : undefined;
      return { ...item, localItemId: row?.id ?? null, localProductId: row?.productId ?? null };
    });
  }

  /** Products that can still be registered in this scope, with codes reused from elsewhere. */
  async listRegistrable(target: EtimsScopeTarget): Promise<RegistrableProduct[]> {
    const { scope } = await this.connect(target);
    const rows = await this.db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        stock: products.stockQuantity,
        taxCode: taxCategories.etimsCode,
      })
      .from(products)
      .leftJoin(taxCategories, eq(taxCategories.id, products.taxCategoryId))
      .where(
        and(
          sql`${products.deletedAt} is null`,
          sql`not exists (
            select 1 from ${etimsItems} e
            where e.product_id = ${products.id}
              and e.company_id = ${target.companyId}
              and e.status <> 'deleted'
              and ${scope.kind === 'branch' ? sql`e.branch_id = ${scope.branchId}` : sql`e.branch_id is null`}
          )`,
        ),
      )
      .orderBy(products.name);
    const prior = await this.db
      .selectDistinctOn([etimsItems.productId], {
        productId: etimsItems.productId,
        qtyUnitCode: etimsItems.qtyUnitCode,
        pkgUnitCode: etimsItems.pkgUnitCode,
        itemClassCode: etimsItems.itemClassCode,
      })
      .from(etimsItems)
      .where(eq(etimsItems.companyId, target.companyId))
      .orderBy(etimsItems.productId, sql`${etimsItems.createdAt} desc`);
    const byProduct = new Map(prior.map((p) => [p.productId, p]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      stock: r.stock,
      hasEtimsTaxCode: Boolean(r.taxCode),
      qtyUnitCode: byProduct.get(r.id)?.qtyUnitCode ?? '',
      pkgUnitCode: byProduct.get(r.id)?.pkgUnitCode ?? '',
      itemClassCode: byProduct.get(r.id)?.itemClassCode ?? '',
    }));
  }

  /**
   * Per-target eTIMS state of one product, for the product screen. Only eTIMS targets are
   * returned, so TIMS and unconfigured setups show nothing eTIMS-related at all.
   */
  async overviewForProduct(input: {
    companyId: string;
    productId: string;
    branches: BranchForEtims[];
  }): Promise<ProductEtimsOverview> {
    const targets = await this.listTargets(input);
    if (targets.length === 0) return { productIssue: null, stock: null, targets: [] };

    let snapshot: ProductSnapshot | null = null;
    let productIssue: string | null = null;
    try {
      snapshot = await this.loadProduct(input.productId);
    } catch (error: unknown) {
      if (!(error instanceof EtimsItemError) || error.code === 'PRODUCT_NOT_FOUND') throw error;
      productIssue = error.message;
    }

    const rows = await this.db
      .select()
      .from(etimsItems)
      .where(
        and(eq(etimsItems.productId, input.productId), eq(etimsItems.companyId, input.companyId)),
      )
      .orderBy(sql`${etimsItems.createdAt} desc`);
    const active = rows.filter((r) => r.status !== 'deleted');
    const latest = rows[0];
    const suggested = {
      qtyUnitCode: latest?.qtyUnitCode ?? '',
      pkgUnitCode: latest?.pkgUnitCode ?? '',
      itemClassCode: latest?.itemClassCode ?? '',
    };

    return {
      productIssue,
      stock: snapshot?.stock ?? null,
      targets: targets.map((t) => {
        const row = active.find((r) =>
          t.scope === 'company' ? r.branchId === null : r.branchId === t.branchId,
        );
        return {
          ...t,
          suggested,
          item: row
            ? {
                id: row.id,
                status: row.status,
                kraItemCode: row.kraItemCode,
                taxCode: row.taxCode,
                qtyUnitCode: row.qtyUnitCode,
                pkgUnitCode: row.pkgUnitCode,
                itemClassCode: row.itemClassCode,
                stockQuantity: row.stockQuantity,
                errorMessage: row.errorMessage,
                drift: snapshot ? driftOf(row, snapshot) : [],
              }
            : null,
        };
      }),
    };
  }

  /**
   * Invoicing rule. The invoicing branch resolves to exactly one scope, the same one its KRA
   * mode comes from: an independent branch uses its own items, every other branch (or no
   * branch) uses the company's. Every product must hold a confirmed KRA code in that scope;
   * otherwise this throws naming the offenders. It never looks at the other scope.
   */
  async requireItemCodesForInvoice(input: {
    companyId: string;
    /** The branch the invoice is issued from, if any. */
    branchId?: string | null;
    productIds: string[];
  }): Promise<Map<string, string>> {
    const config = await this.resolver.resolve({
      companyId: input.companyId,
      branchId: input.branchId ?? null,
    });
    if (config.mode !== 'etims') throw modeMismatch(config.source);
    const scope: Scope =
      config.source === 'branch'
        ? { kind: 'branch', branchId: config.branchId! }
        : { kind: 'company' };

    const rows = await this.localItems(input.companyId, scope);
    const codes = new Map(
      rows
        .filter((r) => r.status === 'registered' && r.kraItemCode)
        .map((r) => [r.productId, r.kraItemCode!]),
    );
    const missing = [...new Set(input.productIds)].filter((id) => !codes.has(id));
    if (missing.length > 0) {
      const names = await this.db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(inArray(products.id, missing));
      const label = (id: string) => names.find((n) => n.id === id)?.name ?? id;
      throw new EtimsItemError(
        'NOT_REGISTERED',
        `Not registered with KRA eTIMS for ${scope.kind === 'company' ? 'the company' : 'this branch'}: ${missing.map(label).join(', ')}.`,
      );
    }
    return new Map(input.productIds.map((id) => [id, codes.get(id)!]));
  }

  async register(input: RegisterEtimsItemInput): Promise<EtimsItemRow> {
    const { config, scope, client } = await this.connect(input);
    const product = await this.loadProduct(input.productId);
    const fields = this.buildFields(product, {
      qtyUnitCode: input.qtyUnitCode,
      pkgUnitCode: input.pkgUnitCode,
      itemClassCode: input.itemClassCode,
      orgCountryCode: input.orgCountryCode,
    });
    const initialStock = toStock(input.initialStock ?? product.stock);
    const { row, retryAfterAmbiguousFailure } = await this.claim(
      input,
      scope,
      config,
      fields,
      initialStock,
    );

    try {
      // A previous attempt may have created the item before its response was lost.
      // Adopt it instead of registering a duplicate at KRA.
      if (retryAfterAmbiguousFailure) {
        const existing = await this.findRemoteMatch(client, input.companyId, scope, fields);
        if (has(existing?.itemCode)) {
          return await this.markRegistered(row, existing.itemCode, initialStock);
        }
      }

      const response = await client.createItem({ ...fields, initialStock });
      const code =
        nonEmpty(response.data?.itemCode) ??
        nonEmpty((await this.findRemoteMatch(client, input.companyId, scope, fields))?.itemCode);
      if (has(code)) return await this.markRegistered(row, code, initialStock);

      return await this.patch(row.id, {
        status: 'unconfirmed',
        errorCode: 'NO_ITEM_CODE',
        errorMessage:
          'KRA accepted the item but its code could not be determined. Reconcile to fetch it.',
      });
    } catch (error: unknown) {
      throw await this.recordFailure(row, error, 'failed');
    }
  }

  async update(input: UpdateEtimsItemInput): Promise<EtimsItemRow> {
    const { client, scope } = await this.connect(input);
    const row = await this.requireRegistered(input, scope);
    const product = await this.loadProduct(input.productId);
    const fields = this.buildFields(product, {
      qtyUnitCode: input.qtyUnitCode ?? row.qtyUnitCode,
      pkgUnitCode: input.pkgUnitCode ?? row.pkgUnitCode,
      itemClassCode: input.itemClassCode ?? row.itemClassCode,
      orgCountryCode: input.orgCountryCode ?? row.orgCountryCode,
    });
    const stock = toStock(input.stock ?? row.stockQuantity);

    try {
      await client.updateItem(row.kraItemCode!, { ...fields, stock });
    } catch (error: unknown) {
      throw await this.recordFailure(row, error, row.status);
    }
    return await this.patch(row.id, {
      ...columnsFor(fields),
      stockQuantity: stock,
      status: 'registered',
      errorCode: null,
      errorMessage: null,
      lastSyncedAt: new Date(),
    });
  }

  /** Reports a new quantity for the item, leaving every other field as registered. */
  async updateStock(input: EtimsItemTarget & { quantity: number }): Promise<EtimsItemRow> {
    const { client, scope } = await this.connect(input);
    const row = await this.requireRegistered(input, scope);
    const stock = toStock(input.quantity);
    try {
      await client.updateItem(row.kraItemCode!, { ...fieldsFromRow(row), stock });
    } catch (error: unknown) {
      throw await this.recordFailure(row, error, row.status);
    }
    return await this.patch(row.id, {
      stockQuantity: stock,
      errorCode: null,
      errorMessage: null,
      lastSyncedAt: new Date(),
    });
  }

  async remove(input: EtimsItemTarget): Promise<EtimsItemRow> {
    const { client, scope } = await this.connect(input);
    const row = await this.findActive(input.companyId, scope, input.productId);
    if (!row) throw new EtimsItemError('NOT_REGISTERED', 'This product is not registered here.');

    if (row.status === 'unconfirmed' || (row.status === 'pending' && !this.isStale(row))) {
      throw new EtimsItemError(
        'NOT_CONFIRMED',
        'The KRA item code is not confirmed yet; reconcile before deleting.',
      );
    }
    // Rows with no code were never accepted (failed) — nothing to delete at KRA.
    if (has(row.kraItemCode)) {
      try {
        await client.deleteItem(row.kraItemCode);
      } catch (error: unknown) {
        // Already gone at KRA is the state we wanted.
        if (!(error instanceof EtimsApiError && error.httpStatus === 404)) {
          throw await this.recordFailure(row, error, row.status);
        }
      }
    }
    return await this.patch(row.id, { status: 'deleted', errorCode: null, errorMessage: null });
  }

  /** For `unconfirmed` rows: look the item up at the gateway and adopt its code. */
  async reconcile(input: EtimsItemTarget): Promise<EtimsItemRow> {
    const { client, scope } = await this.connect(input);
    const row = await this.findActive(input.companyId, scope, input.productId);
    if (!row) throw new EtimsItemError('NOT_REGISTERED', 'This product is not registered here.');
    if (has(row.kraItemCode)) return row;
    const match = await this.findRemoteMatch(client, input.companyId, scope, fieldsFromRow(row));
    if (!has(match?.itemCode)) {
      throw new EtimsItemError(
        'NOT_CONFIRMED',
        'KRA has no matching item for this registration yet.',
      );
    }
    return await this.markRegistered(row, match.itemCode, row.stockQuantity);
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Resolves which scope a management call targets and the gateway for it. A branch that
   * does not act independently is refused: its items are the company's, so they must be
   * managed there. Mode must be eTIMS; anything unusable throws.
   */
  private async connect(target: EtimsScopeTarget): Promise<Connection> {
    if (has(target.branchId)) {
      const branch = await this.branches.getById(target.branchId);
      if (!branch || branch.companyId !== target.companyId) {
        throw new KraConfigError('BRANCH_NOT_FOUND', `Branch ${target.branchId} not found.`);
      }
      if (!branch.actsIndependently) {
        throw new EtimsItemError(
          'BRANCH_NOT_INDEPENDENT',
          'This branch does not act independently, so it uses the company items. Manage them at company level.',
        );
      }
    }
    const config = await this.resolver.resolve({
      companyId: target.companyId,
      branchId: target.branchId ?? null,
    });
    if (config.mode !== 'etims') throw modeMismatch(config.source);
    const scope: Scope =
      config.source === 'branch'
        ? { kind: 'branch', branchId: config.branchId! }
        : { kind: 'company' };
    return { config, scope, client: new EtimsClient(config, this.fetchImpl) };
  }

  private scopeWhere(companyId: string, scope: Scope): SQL {
    return scope.kind === 'branch'
      ? and(eq(etimsItems.companyId, companyId), eq(etimsItems.branchId, scope.branchId))!
      : and(eq(etimsItems.companyId, companyId), isNull(etimsItems.branchId))!;
  }

  private localItems(companyId: string, scope: Scope): Promise<EtimsItemRow[]> {
    return this.db
      .select()
      .from(etimsItems)
      .where(and(this.scopeWhere(companyId, scope), ne(etimsItems.status, 'deleted')))
      .orderBy(etimsItems.name);
  }

  private async loadProduct(productId: string): Promise<ProductSnapshot> {
    const [row] = await this.db
      .select({
        name: products.name,
        price: products.price,
        stock: products.stockQuantity,
        itemTypeCode: itemTypes.code,
        taxCode: taxCategories.etimsCode,
        deletedAt: products.deletedAt,
      })
      .from(products)
      .innerJoin(itemTypes, eq(itemTypes.id, products.itemTypeId))
      .leftJoin(taxCategories, eq(taxCategories.id, products.taxCategoryId))
      .where(eq(products.id, productId))
      .limit(1);
    if (!row || row.deletedAt) {
      throw new EtimsItemError('PRODUCT_NOT_FOUND', `Product ${productId} not found.`);
    }
    if (!has(row.taxCode)) {
      throw new EtimsItemError(
        'TAX_CODE_MISSING',
        'The product has no tax category with an eTIMS code. Map one under Tax Classification.',
      );
    }
    const itemTypeCode = String(row.itemTypeCode);
    if (!ELIGIBLE_ITEM_TYPE_CODES.includes(itemTypeCode)) {
      throw new EtimsItemError(
        'ITEM_TYPE_INVALID',
        `Item type code ${itemTypeCode} is not valid for eTIMS (use 1, 2 or 3).`,
      );
    }
    return {
      name: row.name,
      price: row.price === null ? 0 : Number(row.price),
      stock: row.stock,
      itemTypeCode,
      taxCode: row.taxCode,
    };
  }

  private buildFields(
    product: ProductSnapshot,
    codes: {
      qtyUnitCode: string;
      pkgUnitCode: string;
      itemClassCode: string;
      orgCountryCode?: string;
    },
  ): EtimsItemWrite {
    const qtyUnitCode = codes.qtyUnitCode.trim();
    const pkgUnitCode = codes.pkgUnitCode.trim();
    const itemClassCode = codes.itemClassCode.trim();
    const orgCountryCode = (codes.orgCountryCode ?? 'KE').trim().toUpperCase();
    if (!has(qtyUnitCode) || !has(pkgUnitCode) || !has(itemClassCode)) {
      throw new EtimsItemError(
        'INVALID_INPUT',
        'Quantity unit, package unit and item classification codes are required.',
      );
    }
    if (!/^[A-Z]{2}$/.test(orgCountryCode)) {
      throw new EtimsItemError('INVALID_INPUT', 'Country of origin must be a 2-letter code.');
    }
    if (!isValidEtimsCode(product.taxCode)) {
      throw new EtimsItemError('TAX_CODE_MISSING', `Invalid eTIMS tax code "${product.taxCode}".`);
    }
    return {
      name: product.name.trim().slice(0, 200),
      orgCountryCode,
      unitPrice: product.price,
      itemTypeCode: product.itemTypeCode,
      taxCode: product.taxCode,
      qtyUnitCode,
      pkgUnitCode,
      itemClassCode,
    };
  }

  /** Creates the row, or reclaims a failed/abandoned one. Throws if already registered. */
  private async claim(
    target: EtimsItemTarget,
    scope: Scope,
    config: ResolvedEtimsConfig,
    fields: EtimsItemWrite,
    stock: number,
  ): Promise<{ row: EtimsItemRow; retryAfterAmbiguousFailure: boolean }> {
    const values = {
      productId: target.productId,
      companyId: target.companyId,
      scope: config.source,
      branchId: scope.kind === 'branch' ? scope.branchId : null,
      status: 'pending' as const,
      ...columnsFor(fields),
      stockQuantity: stock,
      errorCode: null,
      errorMessage: null,
    };
    const [inserted] = await this.db
      .insert(etimsItems)
      .values(values)
      .onConflictDoNothing()
      .returning();
    if (inserted) return { row: inserted, retryAfterAmbiguousFailure: false };

    const existing = await this.findActive(target.companyId, scope, target.productId);
    if (!existing) throw new Error('Item row vanished during claim.');
    const reclaimable =
      existing.status === 'failed' || (existing.status === 'pending' && this.isStale(existing));
    if (!reclaimable) {
      throw new EtimsItemError(
        'ALREADY_REGISTERED',
        existing.status === 'unconfirmed'
          ? 'Already sent to KRA but unconfirmed; reconcile instead of registering again.'
          : 'This product is already registered here.',
      );
    }
    const ambiguous =
      existing.status === 'pending' ||
      existing.errorCode === 'NETWORK' ||
      (existing.errorCode ?? '').startsWith("HTTP_5");

    const [reclaimed] = await this.db
      .update(etimsItems)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(etimsItems.id, existing.id),
          // Typed comparison (not a raw fragment) so the Date serialises on every driver.
          or(
            eq(etimsItems.status, 'failed'),
            lt(etimsItems.updatedAt, new Date(Date.now() - STALE_PENDING_MS)),
          ),
        ),
      )
      .returning();
    if (!reclaimed) {
      throw new EtimsItemError('ALREADY_REGISTERED', 'Registration is already in progress.');
    }
    return { row: reclaimed, retryAfterAmbiguousFailure: ambiguous };
  }

  /**
   * Finds the gateway item we just created when it did not echo a code. Only an
   * unambiguous match counts, and codes already tracked in this scope are excluded.
   */
  private async findRemoteMatch(
    client: EtimsClient,
    companyId: string,
    scope: Scope,
    fields: EtimsItemWrite,
  ): Promise<EtimsItem | null> {
    const response = await client.listItems();
    const known = new Set(
      (await this.localItems(companyId, scope)).map((r) => r.kraItemCode).filter(Boolean),
    );
    const candidates = (response.data ?? []).filter(
      (i) =>
        i.itemCode &&
        !known.has(i.itemCode) &&
        i.name?.trim() === fields.name &&
        i.qtyUnitCode === fields.qtyUnitCode &&
        i.pkgUnitCode === fields.pkgUnitCode &&
        i.itemClassCode === fields.itemClassCode,
    );
    return candidates.length === 1 ? candidates[0]! : null;
  }

  private async requireRegistered(target: EtimsItemTarget, scope: Scope): Promise<EtimsItemRow> {
    const row = await this.findActive(target.companyId, scope, target.productId);
    if (!row) throw new EtimsItemError('NOT_REGISTERED', 'This product is not registered here.');
    if (!has(row.kraItemCode) || row.status === 'pending' || row.status === 'unconfirmed') {
      throw new EtimsItemError('NOT_CONFIRMED', 'The KRA item code is not confirmed yet.');
    }
    if (row.status === 'failed') {
      throw new EtimsItemError('NOT_REGISTERED', 'Registration failed; register it again first.');
    }
    return row;
  }

  private async findActive(
    companyId: string,
    scope: Scope,
    productId: string,
  ): Promise<EtimsItemRow | null> {
    const [row] = await this.db
      .select()
      .from(etimsItems)
      .where(
        and(
          this.scopeWhere(companyId, scope),
          eq(etimsItems.productId, productId),
          ne(etimsItems.status, 'deleted'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private isStale(row: EtimsItemRow): boolean {
    return Date.now() - row.updatedAt.getTime() > STALE_PENDING_MS;
  }

  private markRegistered(row: EtimsItemRow, code: string, stock: number): Promise<EtimsItemRow> {
    return this.patch(row.id, {
      kraItemCode: code,
      status: 'registered',
      stockQuantity: stock,
      errorCode: null,
      errorMessage: null,
      lastSyncedAt: new Date(),
    });
  }

  /** Stores the failure on the row and returns the error for the caller to throw. */
  private async recordFailure(
    row: EtimsItemRow,
    error: unknown,
    status: EtimsItemRow['status'],
  ): Promise<Error> {
    const api =
      error instanceof EtimsApiError
        ? error
        : new EtimsApiError(error instanceof Error ? error.message : 'Unknown error', null, false);
    await this.patch(row.id, {
      status,
      errorCode: api.httpStatus === null ? 'NETWORK' : `HTTP_${api.httpStatus}`,
      errorMessage: api.message,
    });
    return error instanceof Error ? error : api;
  }

  private async patch(id: string, set: Partial<typeof etimsItems.$inferInsert>) {
    const [row] = await this.db
      .update(etimsItems)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(etimsItems.id, id))
      .returning();
    return row!;
  }
}

function modeMismatch(source: 'company' | 'branch'): KraConfigError {
  return new KraConfigError(
    'MODE_MISMATCH',
    `${source === 'branch' ? 'Branch' : 'Company'} KRA mode is TIMS; eTIMS items are not available.`,
    source,
  );
}

function driftOf(row: EtimsItemRow, product: ProductSnapshot): ProductEtimsItemView['drift'] {
  const drift: ProductEtimsItemView['drift'] = [];
  if (row.name !== product.name.trim().slice(0, 200)) drift.push('name');
  if (Number(row.unitPrice) !== product.price) drift.push('price');
  if (row.taxCode !== product.taxCode) drift.push('taxCode');
  if (row.itemTypeCode !== product.itemTypeCode) drift.push('itemType');
  return drift;
}

function toStock(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new EtimsItemError('INVALID_INPUT', 'Stock must be zero or greater.');
  }
  return Math.floor(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return has(value?.trim()) ? value.trim() : undefined;
}

function columnsFor(f: EtimsItemWrite) {
  return {
    name: f.name,
    orgCountryCode: f.orgCountryCode,
    unitPrice: String(f.unitPrice),
    itemTypeCode: f.itemTypeCode,
    taxCode: f.taxCode,
    qtyUnitCode: f.qtyUnitCode,
    pkgUnitCode: f.pkgUnitCode,
    itemClassCode: f.itemClassCode,
  };
}

function fieldsFromRow(row: EtimsItemRow): EtimsItemWrite {
  return {
    name: row.name,
    orgCountryCode: row.orgCountryCode,
    unitPrice: Number(row.unitPrice),
    itemTypeCode: row.itemTypeCode,
    taxCode: row.taxCode,
    qtyUnitCode: row.qtyUnitCode,
    pkgUnitCode: row.pkgUnitCode,
    itemClassCode: row.itemClassCode,
  };
}
