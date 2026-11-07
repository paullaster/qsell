'use client';

import { useAdminNavAccess } from '@/components/admin/nav/AdminNavAccessProvider';
import { limitsProblem } from '@/lib/quantity-limits';
import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Package,
  DollarSign,
  Image as ImageIcon,
  Tag,
  Save,
  AlertTriangle,
  Layers,
  AlignLeft,
  ShieldCheck,
} from 'lucide-react';
import {
  type Product,
  type Category,
  type ItemType,
  type TaxCategory,
  type ProductMediaItem,
} from '@/types/index';
import {
  createProductAction,
  updateProductAction,
  fetchTaxCategoriesAction,
  listItemTypesAction,
} from '@/server/actions';
import { ProductSpecificationList, type EditableProductSpecification } from '@/components/admin/ProductSpecificationList';
import { ProductDescriptionEditor } from '@/components/admin/ProductDescriptionEditor';
import {
  CATALOG_SHORTCUT_CREATED,
  CatalogCreateShortcut,
  mergeById,
  type CatalogShortcutDetail,
} from '@/components/admin/catalog-shortcuts';
import { discardMediaUploadsAction } from '@/server/domains/media/actions';
import { ProductMediaManager } from '@/components/admin/ProductMediaManager';
import { ProductEtimsPanel } from '@/components/admin/ProductEtimsPanel';
import { useModalKeys } from '@/components/ui/useModalKeys';
import {
  ProductUnitsSection,
  type PackagingRowState,
} from '@/components/admin/ProductUnitsSection';
import { quantityStep } from '@/lib/unit-rules';
import {
  MAX_PRODUCT_SPECIFICATIONS,
  PRODUCT_SPECIFICATION_KEY_MAX_LENGTH,
  PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH,
} from '@/lib/product-specifications';
import { checkProductUnitsAction } from '@/server/domains/units/actions';
import type { Choice } from '@/lib/payment-options';
import { listEtimsTargetsAction } from '@/server/domains/kra/etims/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { INVENTORY_KIND_OPTIONS, isInventoryKind, type InventoryKind } from '@/lib/inventory-kind';
import { productSellability } from '@/lib/product-sellability';

type ProductFormTab =
  'basics' | 'pricing' | 'inventory' | 'handling' | 'packaging' | 'specs' | 'description' | 'media' | 'kra';

const TABS: { id: ProductFormTab; label: string; icon: typeof Package }[] = [
  { id: 'basics', label: 'Basics', icon: Package },
  { id: 'pricing', label: 'Pricing', icon: DollarSign },
  { id: 'inventory', label: 'Stock', icon: Layers },
  { id: 'handling', label: 'Stock behaviour', icon: Layers },
  { id: 'packaging', label: 'Packaging', icon: Package },
  { id: 'specs', label: 'Specs', icon: Tag },
  { id: 'description', label: 'Description', icon: AlignLeft },
  { id: 'media', label: 'Media', icon: ImageIcon },
  // Only meaningful once the product exists: registration needs a saved product.
  { id: 'kra', label: 'KRA eTIMS', icon: ShieldCheck },
];

function slugifyTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function initialProductSlug(
  product: Product | null,
  duplicate: Product | null | undefined,
): string {
  if (product !== null) return product.slug;
  if (duplicate !== null && duplicate !== undefined) return slugifyTitle(duplicate.name);
  return '';
}

interface AdminProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  productToEdit: Product | null;
  /** Unsaved draft prefilled from this product; the modal stays in create mode. */
  duplicateFrom?: Product | null;
  categories: Category[];
  itemTypes?: ItemType[];
  taxCategories?: TaxCategory[];
  onSuccess: () => void;
}

export function AdminProductModal({ isOpen, ...props }: AdminProductModalProps) {
  if (!isOpen) return null;
  return (
    <AdminProductModalForm
      key={props.productToEdit?.id ?? props.duplicateFrom?.id ?? 'new'}
      {...props}
    />
  );
}

interface PackagingFitDraft { key: string; productId: string; choice: Choice | null; capacity: string }
type AdminProductModalFormProps = Omit<AdminProductModalProps, 'isOpen'>;

function AdminProductModalForm({
  onClose,
  productToEdit,
  duplicateFrom,
  categories,
  itemTypes: initialItemTypes,
  taxCategories: initialTaxCategories,
  onSuccess,
}: AdminProductModalFormProps) {
  const isEditing = Boolean(productToEdit);
  const template = productToEdit ?? duplicateFrom ?? null;
  const [tab, setTab] = useState<ProductFormTab>('basics');
  // eTIMS UI exists only when the company, or an independent branch, is set to eTIMS.
  const [etimsAvailable, setEtimsAvailable] = useState(false);
  useEffect(() => {
    if (!isEditing) return;
    let cancelled = false;
    void listEtimsTargetsAction().then((res) => {
      if (!cancelled) setEtimsAvailable(res.ok && res.data.length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, [isEditing]);

  // Basic Information
  const [name, setName] = useState(template?.name ?? '');
  const [sku, setSku] = useState(productToEdit?.sku ?? '');
  const [stockCode, setStockCode] = useState(productToEdit?.stockCode ?? '');
  const [slug, setSlug] = useState(() => initialProductSlug(productToEdit, duplicateFrom));
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(productToEdit !== null);
  const [category, setCategory] = useState(template?.category ?? '');
  const [brand, setBrand] = useState(template?.brand ?? '');
  const [itemTypeId, setItemTypeId] = useState(template?.itemTypeId ?? '');

  // Item types & taxes — local copies so a shortcut create can append without resetting the form
  const [categoryOptions, setCategoryOptions] = useState<Category[]>(categories);
  const [itemTypes, setItemTypes] = useState<ItemType[]>(initialItemTypes ?? []);
  const [taxCategories, setTaxCategories] = useState<TaxCategory[]>(initialTaxCategories ?? []);
  const [selectedTaxId, setSelectedTaxId] = useState(template?.taxCategoryId ?? '');

  // Pricing & Financials (strings so create form can stay empty with placeholders)
  const [price, setPrice] = useState(template?.price == null ? '' : String(template.price));
  const [compareAtPrice, setCompareAtPrice] = useState(
    template?.compareAtPrice == null ? '' : String(template.compareAtPrice),
  );
  // Empty means "follow the selling price"; setting it needs its own permission.
  const [standardPrice, setStandardPrice] = useState(
    template?.standardPrice == null ? '' : String(template.standardPrice),
  );
  const [minOrderQty, setMinOrderQty] = useState(
    template?.minOrderQty == null ? '' : String(template.minOrderQty),
  );
  const [maxOrderQty, setMaxOrderQty] = useState(
    template?.maxOrderQty == null ? '' : String(template.maxOrderQty),
  );
  const access = useAdminNavAccess();
  const maySetStandardPrice =
    access !== null &&
    (access.superAdmin || access.permissions.includes('products:set_standard_price'));
  const [costPrice, setCostPrice] = useState(String(template?.costPrice ?? ''));

  // Inventory & Logistics
  const [stockQuantity, setStockQuantity] = useState(
    template === null ? '' : String(template.stockQuantity),
  );
  const [lowStockThreshold, setLowStockThreshold] = useState(
    template === null ? '' : String(template.lowStockThreshold),
  );
  const [weight, setWeight] = useState(template?.weight == null ? '' : String(template.weight));
  const [baseUnit, setBaseUnit] = useState<Choice | null>(() =>
    template === null
      ? null
      : {
          id: template.baseUnitId,
          label: `${template.baseUnitCode} · ${template.baseUnitName}`,
          meta: { code: template.baseUnitCode, decimals: String(template.baseUnitDecimals) },
        },
  );
  const [packagings, setPackagings] = useState<PackagingRowState[]>([]);
  /** False until a saved product's alternate units are read: sending the empty list before that would wipe them. */
  const [packagingsLoaded, setPackagingsLoaded] = useState(productToEdit === null);

  // Media & Description
  const [gallery, setGallery] = useState<ProductMediaItem[]>(template?.media ?? []);
  const [mediaBusy, setMediaBusy] = useState(false);
  /** Guards against a second Cancel/close while the first is still discarding unsaved uploads. */
  const closing = useRef(false);
  const [description, setDescription] = useState(template?.description ?? '');
  const [tagsInput, setTagsInput] = useState(template === null ? '' : template.tags.join(', '));
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const [isCheckoutPackaging, setIsCheckoutPackaging] = useState(template?.isCheckoutPackaging ?? false);
  const [inventoryKindChoice, setInventoryKindChoice] = useState<Choice | null>(() => {
    const id = template?.inventoryKind ?? initialItemTypes?.find((type) => type.isDefault)?.defaultInventoryKind ?? 'inventory';
    const option = INVENTORY_KIND_OPTIONS.find((candidate) => candidate.id === id);
    return { id, label: option?.label ?? 'Inventory item' };
  });
  const [packagingFits, setPackagingFits] = useState<PackagingFitDraft[]>(() => (template?.packagingFits ?? []).map((fit, index) => ({ key: `fit-${String(index)}`, productId: fit.productId, choice: { id: fit.productId, label: fit.productId }, capacity: String(fit.capacity) })));

  // Dynamic Specifications (key-value pairs)
  const [specifications, setSpecifications] = useState<EditableProductSpecification[]>(() =>
    (template?.specifications ?? []).map((spec, index) => ({
      ...spec,
      rowId: `saved-${String(index)}`,
    })),
  );
  const [newSpecKey, setNewSpecKey] = useState('');
  const [newSpecValue, setNewSpecValue] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shortcut-created options are appended in their event handler; the initial lists seed this mounted form.
  useEffect(() => {
    if (initialTaxCategories === undefined || initialTaxCategories.length === 0) {
      fetchTaxCategoriesAction()
        .then((taxes) => setTaxCategories((current) => mergeById(current, taxes)))
        .catch(() => setError('Tax categories could not be loaded. Try again.'));
    }
    if (initialItemTypes === undefined || initialItemTypes.length === 0) {
      listItemTypesAction()
        .then((types) => setItemTypes((current) => mergeById(current, types)))
        .catch(() => setError('Business classifications could not be loaded. Try again.'));
    }
  }, [initialTaxCategories, initialItemTypes]);

  useEffect(() => {
    const onCreated = (event: Event) => {
      const detail = (event as CustomEvent<CatalogShortcutDetail>).detail;
      if (detail.kind === 'category') {
        setCategoryOptions((current) => mergeById(current, [detail.category]));
        setCategory(detail.category.name);
        return;
      }
      if (detail.kind === 'unit') {
        const created: Choice = {
          id: detail.unit.id,
          label: detail.unit.label,
          meta: {
            code: detail.unit.label.split(' · ')[0] ?? '',
            decimals: String(detail.unit.decimals),
          },
        };
        // A new unit goes to the alternate-unit row that was waiting for one, else it becomes the base unit.
        setPackagings((rows) => {
          const waiting = rows.findIndex((r) => r.unitId === '');
          if (waiting === -1) {
            setBaseUnit(created);
            return rows;
          }
          return rows.map((r, i) =>
            i === waiting ? { ...r, unitId: created.id, unitLabel: created.label } : r,
          );
        });
        return;
      }
      if (detail.kind === 'tax') {
        setTaxCategories((current) => {
          const cleared = detail.tax.isDefault
            ? current.map((tax) => ({ ...tax, isDefault: false }))
            : current;
          return mergeById(cleared, [detail.tax]);
        });
        setSelectedTaxId(detail.tax.id);
        return;
      }
      setItemTypes((current) => {
        const cleared = detail.itemType.isDefault
          ? current.map((type) => ({ ...type, isDefault: false }))
          : current;
        return mergeById(cleared, [detail.itemType]);
      });
      chooseItemType(detail.itemType.id, detail.itemType.defaultInventoryKind);
    };
    window.addEventListener(CATALOG_SHORTCUT_CREATED, onCreated);
    return () => window.removeEventListener(CATALOG_SHORTCUT_CREATED, onCreated);
  }, []);

  const isService = inventoryKindChoice?.id === 'service';

  /** A new product starts with how its classification says products are managed; one being edited keeps its own. */
  function chooseItemType(id: string, defaultKind: InventoryKind | undefined) {
    setItemTypeId(id);
    if (isEditing || defaultKind === undefined) return;
    setInventoryKindChoice({ id: defaultKind, label: INVENTORY_KIND_OPTIONS.find((option) => option.id === defaultKind)?.label ?? 'Inventory item' });
    if (defaultKind !== 'inventory') {
      setStockQuantity('0');
      setLowStockThreshold('0');
      setIsCheckoutPackaging(false);
    }
  }

  const activeItemType =
    itemTypes.find((t) => t.id === itemTypeId) ??
    itemTypes.find((t) => t.isDefault && t.isActive) ??
    itemTypes.find((t) => t.isDefault) ??
    itemTypes[0];

  // Selected Tax details
  const activeTax =
    taxCategories.find((t) => t.id === selectedTaxId) ??
    taxCategories.find((t) => t.isDefault) ??
    taxCategories[0];
  const taxRate = activeTax ? activeTax.rate : 0;
  const isTaxInclusive = activeTax ? activeTax.isInclusive : true;

  // Fiscal Calculations
  const parsedPrice = Number(price);
  const effectivePrice = price.trim() === '' || !Number.isFinite(parsedPrice) ? 0 : parsedPrice;
  const costNumber = costPrice.trim() === '' ? NaN : Number(costPrice);
  const netSellingPrice =
    isTaxInclusive && taxRate > 0 ? effectivePrice / (1 + taxRate / 100) : effectivePrice;
  const taxAmountPerUnit = isTaxInclusive
    ? effectivePrice - netSellingPrice
    : effectivePrice * (taxRate / 100);
  const unitGrossProfit = Number.isFinite(costNumber)
    ? netSellingPrice - costNumber
    : netSellingPrice;
  const grossMarginPct =
    netSellingPrice > 0 ? ((unitGrossProfit / netSellingPrice) * 100).toFixed(1) : '0.0';

  const handleAddSpec = () => {
    if (
      newSpecKey.trim() !== '' &&
      newSpecValue.trim() !== '' &&
      specifications.length < MAX_PRODUCT_SPECIFICATIONS
    ) {
      const rowId = `new-${globalThis.crypto.randomUUID()}`;
      setSpecifications((current) => [
        ...current,
        { rowId, key: newSpecKey.trim(), value: newSpecValue.trim() },
      ]);
      setNewSpecKey('');
      setNewSpecValue('');
    }
  };

  const focusTabForError = (message: string) => {
    const m = message.toLowerCase();
    if (
      m.includes('title') ||
      m.includes('sku') ||
      m.includes('category') ||
      m.includes('item type') || m.includes('business classification')
    ) {
      setTab('basics');
    } else if (m.includes('price') || m.includes('selling') || m.includes('cost')) {
      setTab('pricing');
    } else if (
      m.includes('stock') ||
      m.includes('weight') ||
      m.includes('unit') ||
      m.includes('decimal') ||
      m.includes('whole number')
    ) {
      setTab('inventory');
    } else if (m.includes('specification')) {
      setTab('specs');
    }
  };

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (name.trim() === '') {
      const msg = 'Product title is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    // New products are numbered automatically when left blank; an existing one must keep its codes.
    if (isEditing && sku.trim() === '') {
      const msg = 'SKU code is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    if (isEditing && stockCode.trim() === '') {
      const msg = 'Stock code is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    if (category.trim() === '') {
      const msg =
        categoryOptions.length === 0
          ? 'Create a category first, then assign it to this product.'
          : 'Category is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    if (activeItemType === undefined) {
      const msg =
        itemTypes.length === 0
          ? 'Create a business classification first, then assign it to this product.'
          : 'Item type is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }

    // A service with no selling price is not offered for sale, so it does not need one.
    const sellable = productSellability({ classificationSellable: activeItemType.isSellable, kind: isService ? 'service' : 'inventory', price: price.trim() === '' ? undefined : Number(price) });
    if (inventoryKindChoice === null || !isInventoryKind(inventoryKindChoice.id)) {
      setError('Choose how qsell should manage stock for this product.');
      setTab('handling');
      return;
    }
    if (isCheckoutPackaging && inventoryKindChoice.id !== 'inventory') {
      setError('Checkout packaging must use inventory-managed stock.');
      setTab('packaging');
      return;
    }
    if (inventoryKindChoice.id !== 'inventory' && (Number(stockQuantity) !== 0 || Number(lowStockThreshold) !== 0)) {
      setError('Non-inventory items and services cannot have on-hand stock or a reorder threshold.');
      setTab('inventory');
      return;
    }

    if (sellable) {
      if (price.trim() === '' || !Number.isFinite(Number(price)) || Number(price) <= 0) {
        const msg = 'Selling price is required for sellable item types.';
        setError(msg);
        focusTabForError(msg);
        return;
      }
    } else if (price.trim() !== '' && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
      const msg = 'Selling price must be 0 or greater when provided.';
      setError(msg);
      focusTabForError(msg);
      return;
    }

    if ((costPrice.trim() === '' && !isService) || !Number.isFinite(Number(costPrice)) || Number(costPrice) < 0) {
      const msg = isService ? 'Cost of goods must be 0 or greater when given.' : 'Cost of goods is required and must be 0 or greater.';
      setError(msg);
      focusTabForError(msg);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    // The unit rules are checked first and answered in words, because errors thrown by the save are masked in production.
    const sentPackagings = packagings.map(({ key: _key, unitLabel: _label, ...row }) => row);
    const unitsToSave = !isEditing || packagingsLoaded ? sentPackagings : undefined;
    if (baseUnit !== null || unitsToSave !== undefined) {
      const unitCheck = await checkProductUnitsAction({
        productId: productToEdit?.id ?? null,
        baseUnitId: baseUnit?.id ?? productToEdit?.baseUnitId ?? '',
        packagings: unitsToSave ?? [],
      }).catch(() => ({
        ok: false as const,
        error: 'The server could not be reached. Check your connection and try again.',
      }));
      if (!unitCheck.ok) {
        setError(unitCheck.error);
        setTab('inventory');
        setIsSubmitting(false);
        return;
      }
    }

    // Quantity limits and the standard price may each be empty; if given they must make sense for the unit.
    const unitDecimals = Number(baseUnit?.meta?.decimals ?? 0);
    const minNumber = minOrderQty.trim() === '' ? null : Number(minOrderQty);
    const maxNumber = maxOrderQty.trim() === '' ? null : Number(maxOrderQty);
    const limitIssue = limitsProblem(
      minNumber,
      maxNumber,
      Number.isFinite(unitDecimals) ? unitDecimals : 0,
      baseUnit?.meta?.code ?? 'unit',
    );
    if (limitIssue !== null) {
      setTab('pricing');
      setError(limitIssue);
      setIsSubmitting(false);
      return;
    }
    const standardNumber = standardPrice.trim() === '' ? null : Number(standardPrice);
    if (standardNumber !== null && (!Number.isFinite(standardNumber) || standardNumber < 0)) {
      setTab('pricing');
      setError('The standard price must be 0 or more. Leave it empty to use the selling price.');
      setIsSubmitting(false);
      return;
    }

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const brandValue = brand.trim();
    const cleanSlug = slug.trim();
    const autoSlug = cleanSlug === '' ? slugifyTitle(name) : cleanSlug;
    const stock = stockQuantity.trim() === '' ? 0 : Number(stockQuantity);
    const lowThreshold = lowStockThreshold.trim() === '' ? 0 : Number(lowStockThreshold);
    const weightValue = weight.trim() === '' ? undefined : Number(weight);

    try {
      const productPayload = {
        name: name.trim(),
        sku: sku.trim().toUpperCase(),
        stockCode: stockCode.trim().toUpperCase(),
        slug: autoSlug,
        category,
        brand: brandValue === '' ? undefined : brandValue,
        itemTypeId: activeItemType.id,
        itemTypeName: activeItemType.name,
        itemTypeCode: activeItemType.code,
        isSellable: sellable,
        inventoryKind: inventoryKindChoice.id,
        price: price.trim() === '' ? undefined : Number(price),
        compareAtPrice:
          compareAtPrice.trim() !== '' && Number(compareAtPrice) > 0
            ? Number(compareAtPrice)
            : undefined,
        standardPrice: standardNumber,
        minOrderQty: minNumber,
        maxOrderQty: maxNumber,
        costPrice: isService && costPrice.trim() === '' ? 0 : Number(costPrice),
        taxCategoryId: activeTax?.id,
        taxCategoryName: activeTax?.name,
        taxRate: activeTax ? activeTax.rate : 0,
        isTaxInclusive: activeTax ? activeTax.isInclusive : true,
        stockQuantity: Number.isFinite(stock) ? stock : 0,
        lowStockThreshold: Number.isFinite(lowThreshold) ? lowThreshold : 0,
        weight: weightValue !== undefined && Number.isFinite(weightValue) ? weightValue : undefined,
        ...(baseUnit === null ? {} : { baseUnitId: baseUnit.id }),
        ...(unitsToSave === undefined ? {} : { packagings: unitsToSave }),
        specifications: specifications.map(({ key, value }) => ({ key, value })),
        // The server derives the stored image columns from the gallery; this is just the main image.
        imageUrl: gallery[0]?.url ?? '',
        media: gallery.map(({ assetId, altText }) => ({ assetId, altText })),
        description: description.trim(),
        tags,
        isActive,
        isCheckoutPackaging,
        packagingFits: packagingFits.map(({ productId, capacity }) => ({ productId, capacity: Number(capacity) })),
      };

      let saved: { ok: true } | { ok: false; error: string };
      if (isEditing && productToEdit) {
        // Send stock only when the admin changed it: the loaded number goes stale as
        // orders reserve units, and re-sending it would overwrite them.
        const { stockQuantity: editedStock, ...fieldUpdates } = productPayload;
        saved = await updateProductAction(
          productToEdit.id,
          editedStock !== productToEdit.stockQuantity
            ? { ...fieldUpdates, stockQuantity: editedStock }
            : fieldUpdates,
        );
      } else {
        saved = await createProductAction({
          ...productPayload,
          rating: 0,
          reviewCount: 0,
        });
      }
      if (!saved.ok) {
        setError(saved.error);
        focusTabForError(saved.error);
        return;
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Operation failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const unitStep = quantityStep(Number(baseUnit?.meta?.decimals ?? 0));

  const fieldClass =
    'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none';
  const labelClass = 'mb-1 block text-[11px] font-semibold text-fg-muted';

  const visibleTabs = TABS.filter((t) => t.id !== 'kra' || (isEditing && etimsAvailable));
  const tabIndex = visibleTabs.findIndex((t) => t.id === tab);
  // Closing without saving: delete files uploaded in this form that nothing references.
  const handleClose = async () => {
    if (closing.current) return;
    closing.current = true;
    const unsaved = gallery.filter((item) => item.pending === true).map((item) => item.assetId);
    if (unsaved.length > 0) {
      // Wait for the request (briefly): navigating away first can cancel it half-way.
      await Promise.race([
        discardMediaUploadsAction(unsaved).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    closing.current = false;
    onClose();
  };
  // Escape closes the window the way the Close button does (discarding uploads nothing uses), Tab stays inside it, and focus goes back to the opener.
  const dialogRef = useModalKeys<HTMLDivElement>(() => void handleClose());

  const goNext = () => {
    const next = visibleTabs[tabIndex + 1];
    if (next) setTab(next.id);
  };
  const goPrev = () => {
    const prev = visibleTabs[tabIndex - 1];
    if (prev) setTab(prev.id);
  };

  let modalTitle = 'Create New Product';
  if (duplicateFrom !== undefined && duplicateFrom !== null) {
    modalTitle = `Duplicate Product: ${duplicateFrom.sku}`;
  }
  if (productToEdit !== null) modalTitle = `Edit Product: ${productToEdit.sku}`;

  let submitLabel = 'Create Product';
  if (isEditing) submitLabel = 'Save Changes';
  if (mediaBusy) submitLabel = 'Uploading images…';
  if (isSubmitting) submitLabel = 'Saving…';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/80 p-3 backdrop-blur-md sm:p-5">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-modal-title"
        className="relative flex h-[min(720px,90vh)] w-[90vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-600/20 text-indigo-400">
              <Package className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3
                id="product-modal-title"
                className="truncate text-sm font-bold text-fg-strong sm:text-base"
              >
                {modalTitle}
              </h3>
              <p className="truncate text-[11px] text-fg-muted">
                {isEditing
                  ? 'Update catalog, pricing, stock, and media.'
                  : 'Fill each step — save from any tab when ready.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="cursor-pointer rounded-lg p-1 text-fg-muted hover:text-fg-strong"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface/80 px-3 py-2 sm:px-4">
          {visibleTabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 ${
                tab === id ? 'bg-indigo-600 text-white' : 'hover:bg-hover hover:text-fg-muted'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-xs sm:px-5">
            {error !== null ? (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-800 bg-red-50/80 p-3 text-red-800">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
                <span>{error}</span>
              </div>
            ) : null}

            {tab === 'basics' ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className={labelClass}>Product Title *</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => {
                      const nextName = e.target.value;
                      setName(nextName);
                      if (!slugManuallyEdited) setSlug(slugifyTitle(nextName));
                    }}
                    placeholder="e.g. Sony WH-1000XM5 Wireless Headphones"
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>SKU{isEditing ? ' *' : ''}</label>
                  <input
                    type="text"
                    value={sku}
                    onChange={(e) => setSku(e.target.value.toUpperCase())}
                    placeholder={isEditing ? undefined : 'Numbered automatically'}
                    autoComplete="off"
                    className={`${fieldClass} min-h-11 font-mono uppercase`}
                  />
                  {isEditing ? null : (
                    <p className="mt-1 text-[10px] text-fg-subtle">
                      Leave blank to number it automatically when you save.
                    </p>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Stock Code{isEditing ? ' *' : ''}</label>
                  <input
                    type="text"
                    value={stockCode}
                    onChange={(e) => setStockCode(e.target.value.toUpperCase())}
                    placeholder={isEditing ? undefined : 'Numbered automatically'}
                    autoComplete="off"
                    className={`${fieldClass} min-h-11 font-mono uppercase`}
                  />
                  {isEditing ? null : (
                    <p className="mt-1 text-[10px] text-fg-subtle">
                      Leave blank to number it automatically when you save.
                    </p>
                  )}
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="text-[11px] font-semibold text-fg-muted">Business classification *</label>
                    {itemTypes.length > 0 ? (
                      <CatalogCreateShortcut href="/admin/item-types/new">
                        New
                      </CatalogCreateShortcut>
                    ) : null}
                  </div>
                  <ChoicePicker
                    label="Business classification"
                    source="business-item-types"
                    choice={activeItemType === undefined ? null : { id: activeItemType.id, label: `${String(activeItemType.code)} · ${activeItemType.name}` }}
                    onChoice={(choice) => chooseItemType(choice?.id ?? '', itemTypes.find((type) => type.id === choice?.id)?.defaultInventoryKind)}
                    placeholder="Search business classifications…"
                    clearable={false}
                    required
                    disabled={itemTypes.length === 0}
                  />
                  <p className="mt-1 text-[11px] text-fg-subtle">Describes your business category and sellability. Choose stock handling separately on the Stock behaviour tab.</p>
                  {itemTypes.length === 0 ? (
                    <p className="mt-1 text-[11px] text-amber-600">
                      Create a business classification under Products &amp; Inventory first.{' '}
                      <CatalogCreateShortcut href="/admin/item-types/new">
                        New
                      </CatalogCreateShortcut>
                    </p>
                  ) : null}
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="text-[11px] font-semibold text-fg-muted">Category *</label>
                    {categoryOptions.length > 0 ? (
                      <CatalogCreateShortcut href="/admin/categories/new">
                        New
                      </CatalogCreateShortcut>
                    ) : null}
                  </div>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className={`${fieldClass} cursor-pointer`}
                    disabled={categoryOptions.length === 0}
                  >
                    <option value="">
                      {categoryOptions.length === 0 ? 'No categories yet' : 'Select category'}
                    </option>
                    {categoryOptions.map((c) => (
                      <option key={c.id} value={c.name}>
                        {'— '.repeat(c.depth ?? 0)}
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {categoryOptions.length === 0 ? (
                    <p className="mt-1 text-[11px] text-amber-600">
                      Create a category under Catalog before adding products.{' '}
                      <CatalogCreateShortcut href="/admin/categories/new">
                        New
                      </CatalogCreateShortcut>
                    </p>
                  ) : null}
                </div>
                <div>
                  <label className={labelClass}>Brand / Manufacturer</label>
                  <input
                    type="text"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="e.g. Sony, Apple, Samsung"
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>URL Slug</label>
                  <input
                    type="text"
                    value={slug}
                    onChange={(e) => {
                      setSlug(e.target.value);
                      setSlugManuallyEdited(e.target.value.trim() !== '');
                    }}
                    placeholder="sony-wh-1000xm5"
                    className={`${fieldClass} font-mono`}
                  />
                </div>
              </div>
            ) : null}

            {tab === 'pricing' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>
                      Selling Price (KES)
                      {activeItemType?.isSellable !== false && !isService ? ' *' : ''}
                    </label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      placeholder="Leave empty for none"
                      className={`${fieldClass} font-mono font-bold`}
                    />
                    {isService ? (
                      <p className="mt-1 text-[11px] text-fg-subtle">
                        Optional for a service. Without a price it is not sold from the shop, which is what you want for something like delivery, charged from the delivery rates. Give it a price to sell it.
                      </p>
                    ) : null}
                    {!isService && activeItemType && !activeItemType.isSellable ? (
                      <p className="mt-1 text-[11px] text-fg-subtle">Optional for non-sellable item types.</p>
                    ) : null}
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <label className="text-[11px] font-semibold text-fg-muted">
                        Tax Category
                      </label>
                      {taxCategories.length > 0 ? (
                        <CatalogCreateShortcut href="/admin/taxes/new">New</CatalogCreateShortcut>
                      ) : null}
                    </div>
                    <select
                      value={selectedTaxId}
                      onChange={(e) => setSelectedTaxId(e.target.value)}
                      className={`${fieldClass} cursor-pointer`}
                      disabled={taxCategories.length === 0}
                    >
                      <option value="">
                        {taxCategories.length === 0
                          ? 'No tax categories yet'
                          : 'Select tax category'}
                      </option>
                      {taxCategories.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.rate}% - {t.isInclusive ? 'Inclusive' : 'Exclusive'})
                        </option>
                      ))}
                    </select>
                    {taxCategories.length === 0 ? (
                      <p className="mt-1 text-[11px] text-amber-600">
                        Create a tax category under Settings → Tax Compliance → Tax Classification
                        first.{' '}
                        <CatalogCreateShortcut href="/admin/taxes/new">New</CatalogCreateShortcut>
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <label className={labelClass}>Compare-at Price (KES)</label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={compareAtPrice}
                      onChange={(e) => setCompareAtPrice(e.target.value)}
                      placeholder="Leave empty for none"
                      className={`${fieldClass} font-mono`}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>{`Cost of Goods (KES)${isService ? '' : ' *'}`}</label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={costPrice}
                      onChange={(e) => setCostPrice(e.target.value)}
                      placeholder={isService ? 'Leave empty: a service has no goods to cost' : 'e.g. 0 if it costs nothing'}
                      className={`${fieldClass} font-mono`}
                    />
                  </div>
                  <div>
                    <label htmlFor="product-standard-price" className={labelClass}>
                      Standard Price (KES)
                    </label>
                    <input
                      id="product-standard-price"
                      type="number"
                      min={0}
                      step="any"
                      value={standardPrice}
                      onChange={(e) => setStandardPrice(e.target.value)}
                      disabled={!maySetStandardPrice}
                      aria-describedby="product-standard-price-hint"
                      placeholder={
                        price.trim() === ''
                          ? 'Same as the selling price'
                          : `Same as the selling price (${price})`
                      }
                      className={`${fieldClass} font-mono disabled:cursor-not-allowed disabled:opacity-60`}
                    />
                    <p id="product-standard-price-hint" className="mt-1 text-[11px] text-fg-subtle">
                      The price the pricing engine starts from when no price list applies. Leave it
                      empty to follow the selling price.
                      {maySetStandardPrice
                        ? ''
                        : ' Changing it needs the “Set standard price” permission.'}
                    </p>
                  </div>
                </div>

                <fieldset className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2">
                  <legend className="px-1 text-[11px] font-semibold text-fg-muted">
                    Quantity that can be bought at once
                  </legend>
                  <div>
                    <label htmlFor="product-min-qty" className={labelClass}>
                      Minimum quantity
                      {baseUnit?.meta?.code === undefined ? '' : ` (${baseUnit.meta.code})`}
                    </label>
                    <input
                      id="product-min-qty"
                      type="number"
                      min={0}
                      step="any"
                      value={minOrderQty}
                      onChange={(e) => setMinOrderQty(e.target.value)}
                      placeholder="No minimum"
                      className={`${fieldClass} font-mono`}
                    />
                  </div>
                  <div>
                    <label htmlFor="product-max-qty" className={labelClass}>
                      Maximum quantity
                      {baseUnit?.meta?.code === undefined ? '' : ` (${baseUnit.meta.code})`}
                    </label>
                    <input
                      id="product-max-qty"
                      type="number"
                      min={0}
                      step="any"
                      value={maxOrderQty}
                      onChange={(e) => setMaxOrderQty(e.target.value)}
                      placeholder="No maximum"
                      className={`${fieldClass} font-mono`}
                    />
                  </div>
                  <p className="text-[11px] text-fg-subtle sm:col-span-2">
                    Both are empty by default. When set, the shop, orders and quotes all refuse a
                    quantity outside them.
                  </p>
                </fieldset>

                <div className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-4">
                  <div>
                    <span className="block text-[10px] text-fg-subtle uppercase">
                      Net (Excl. Tax)
                    </span>
                    <span className="font-mono text-xs font-semibold text-fg-strong">
                      KES {Math.round(netSellingPrice).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-emerald-600 uppercase">
                      Tax ({taxRate}%)
                    </span>
                    <span className="font-mono text-xs font-semibold text-emerald-600">
                      KES {Math.round(taxAmountPerUnit).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-fg-subtle uppercase">Unit Profit</span>
                    <span
                      className={`font-mono text-xs font-bold ${unitGrossProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}
                    >
                      KES {Math.round(unitGrossProfit).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-fg-subtle uppercase">
                      Profit Margin
                    </span>
                    <span
                      className={`font-mono text-xs font-bold ${Number(grossMarginPct) >= 20 ? 'text-indigo-400' : 'text-amber-600'}`}
                    >
                      {grossMarginPct}% ({isTaxInclusive ? 'Incl.' : 'Excl.'})
                    </span>
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'inventory' ? (
              <div className="space-y-4">
                <ProductUnitsSection
                  productId={productToEdit?.id ?? null}
                  base={baseUnit}
                  onBase={setBaseUnit}
                  rows={packagings}
                  onRows={(next) => {
                    setPackagings(next);
                    setPackagingsLoaded(true);
                  }}
                />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {inventoryKindChoice?.id === 'inventory' ? <>
                    <div>
                      <label className={labelClass}>{`On-Hand Stock${baseUnit?.meta?.code === undefined ? '' : ` (${baseUnit.meta.code})`}`}</label>
                      <input type="number" min={0} step={unitStep} value={stockQuantity} onChange={(e) => setStockQuantity(e.target.value)} placeholder="e.g. 15" className={`${fieldClass} font-mono font-bold`} />
                    </div>
                    <div>
                      <label className={labelClass}>Low Stock Threshold</label>
                      <input type="number" min={0} step={unitStep} value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value)} placeholder="e.g. 5" className={`${fieldClass} font-mono`} />
                    </div>
                  </> : <p className="rounded-lg border border-line bg-surface-raised p-3 text-xs leading-relaxed text-fg-muted sm:col-span-2">This product does not keep stock balances or reorder thresholds. Choose <strong>Inventory item</strong> on the Stock behaviour tab to manage quantities.</p>}
                  <div>
                    <label
                      className={labelClass}
                    >{`Shipping Weight${baseUnit?.meta?.code === undefined ? '' : ` per ${baseUnit.meta.code}`} (kg)`}</label>
                    <input
                      type="number"
                      step="0.1"
                      min={0}
                      value={weight}
                      onChange={(e) => setWeight(e.target.value)}
                      placeholder="e.g. 1.5"
                      className={`${fieldClass} font-mono`}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'handling' ? (
              <section className="max-w-2xl space-y-4" aria-labelledby="inventory-treatment-title">
                <div>
                  <h3 id="inventory-treatment-title" className="text-sm font-semibold text-fg-strong">Inventory treatment</h3>
                  <p className="mt-1 text-xs leading-relaxed text-fg-muted">{isEditing ? 'It controls whether qsell tracks stock, reserves quantities, and sends physical movements through inventory workflows.' : `A new product starts as its business classification says${activeItemType === undefined ? '' : ` (${activeItemType.name}: ${INVENTORY_KIND_OPTIONS.find((option) => option.id === activeItemType.defaultInventoryKind)?.label ?? 'Inventory item'})`}. You can change it here until the product has stock or documents. It controls whether qsell tracks stock, reserves quantities, and sends physical movements through inventory workflows.`}</p>
                </div>
                <ChoicePicker
                  label="How should qsell manage this product?"
                  source="inventory-kinds"
                  choice={inventoryKindChoice}
                  onChoice={(choice) => {
                    setInventoryKindChoice(choice);
                    if (choice?.id !== 'inventory') {
                      setStockQuantity('0');
                      setLowStockThreshold('0');
                      setIsCheckoutPackaging(false);
                    }
                  }}
                  placeholder="Choose an inventory treatment"
                  clearable={false}
                  required
                />
                {inventoryKindChoice === null ? null : <p className="rounded-lg border border-line bg-surface-raised p-3 text-xs leading-relaxed text-fg-muted">{INVENTORY_KIND_OPTIONS.find((option) => option.id === inventoryKindChoice.id)?.description ?? ''}</p>}
                {isEditing ? <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-800">You can change inventory treatment only while the product has no stock or business-document history. After it has been used, create a replacement product so its historical stock and documents keep their original meaning.</p> : null}
                {inventoryKindChoice?.id !== 'inventory' ? <p className="text-xs text-fg-muted">Stock quantity and reorder threshold must both be zero. Sales and purchases can still use the product; they will not create stock reservations.</p> : null}
              </section>
            ) : null}

            {tab === 'packaging' ? (
              <section className="space-y-4" aria-labelledby="packaging-config-title">
                <div>
                  <h3 id="packaging-config-title" className="text-sm font-semibold text-fg-strong">Packaging compatibility and capacity</h3>
                  <p className="mt-1 text-xs text-fg-muted">Configure this from either side: on a regular product, choose packaging that fits it; on a packaging product, choose the products it can hold. Capacity is in the selected product’s base unit per one package.</p>
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-raised p-3">
                  <input id="is-checkout-packaging" type="checkbox" checked={isCheckoutPackaging} disabled={inventoryKindChoice?.id !== 'inventory'} onChange={(event) => setIsCheckoutPackaging(event.target.checked)} className="h-4 w-4 accent-indigo-600 disabled:opacity-50" />
                  <label htmlFor="is-checkout-packaging" className="text-sm font-medium text-fg-strong">This product is packaging offered at checkout</label>
                </div>
                <div className="space-y-3">
                  {packagingFits.map((fit, index) => (
                    <div key={fit.key} className="grid grid-cols-1 items-end gap-2 rounded-lg border border-line p-3 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                      <ChoicePicker
                        label={isCheckoutPackaging ? 'Product this package fits' : 'Suitable packaging'}
                        source={isCheckoutPackaging ? 'catalog-fit-products' : 'packaging-products'}
                        choice={fit.choice}
                        onChoice={(choice) => setPackagingFits((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, choice, productId: choice?.id ?? '' } : row))}
                        placeholder="Search products…"
                      />
                      <div><label htmlFor={`fit-capacity-${fit.key}`} className={labelClass}>Units per package</label><input id={`fit-capacity-${fit.key}`} type="number" min="0.0001" step="any" value={fit.capacity} onChange={(event) => setPackagingFits((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, capacity: event.target.value } : row))} className={fieldClass} /></div>
                      <button type="button" onClick={() => setPackagingFits((rows) => rows.filter((_, rowIndex) => rowIndex !== index))} className="min-h-11 rounded-lg border border-line px-3 text-sm text-fg-muted hover:text-red-600">Remove</button>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => setPackagingFits((rows) => [...rows, { key: globalThis.crypto.randomUUID(), productId: '', choice: null, capacity: '1' }])} className="min-h-11 rounded-lg border border-line-strong px-3 text-sm font-medium text-fg-strong hover:bg-hover">Add compatibility rule</button>
              </section>
            ) : null}

            {tab === 'specs' ? (
              <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="max-h-[280px] min-h-0 space-y-2 overflow-y-auto pr-1">
                  {specifications.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-fg-subtle">
                      No specifications yet. Add key attributes below.
                    </p>
                  ) : (
                    <ProductSpecificationList specifications={specifications} onChange={setSpecifications} />
                  )}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    placeholder="Attribute (e.g. RAM)"
                    value={newSpecKey}
                    onChange={(e) => setNewSpecKey(e.target.value)}
                    maxLength={PRODUCT_SPECIFICATION_KEY_MAX_LENGTH}
                    className={`${fieldClass} sm:w-1/3`}
                  />
                  <input
                    type="text"
                    placeholder="Value (e.g. 16GB)"
                    value={newSpecValue}
                    onChange={(e) => setNewSpecValue(e.target.value)}
                    maxLength={PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH}
                    className={`${fieldClass} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={handleAddSpec}
                    disabled={
                      specifications.length >= MAX_PRODUCT_SPECIFICATIONS ||
                      newSpecKey.trim() === '' ||
                      newSpecValue.trim() === ''
                    }
                    className="min-h-10 cursor-pointer rounded-lg bg-surface-sunken px-3 py-2 font-medium text-fg-strong hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {specifications.length >= MAX_PRODUCT_SPECIFICATIONS
                      ? 'Maximum reached'
                      : 'Add'}
                  </button>
                </div>
              </div>
            ) : null}

            {tab === 'description' ? (
              <ProductDescriptionEditor
                key={productToEdit?.id ?? 'new-product'}
                value={description}
                onChange={setDescription}
              />
            ) : null}

            {tab === 'media' ? (
              <div className="space-y-5">
                <ProductMediaManager
                  value={gallery}
                  onChange={setGallery}
                  onBusyChange={setMediaBusy}
                />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="product-tags" className={labelClass}>
                      Tags (comma-separated)
                    </label>
                    <input
                      id="product-tags"
                      type="text"
                      value={tagsInput}
                      onChange={(e) => setTagsInput(e.target.value)}
                      placeholder="e.g. Apple, ANC, Gaming"
                      className={fieldClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="product-status" className={labelClass}>
                      Publishing Status
                    </label>
                    <select
                      id="product-status"
                      value={isActive ? 'active' : 'draft'}
                      onChange={(e) => setIsActive(e.target.value === 'active')}
                      className={`${fieldClass} cursor-pointer`}
                    >
                      <option value="active">Active (Published)</option>
                      <option value="draft">Draft (Hidden)</option>
                    </select>
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'kra' && productToEdit && etimsAvailable ? (
              <ProductEtimsPanel productId={productToEdit.id} />
            ) : null}
          </div>

          {/* Sticky footer */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goPrev}
                disabled={tabIndex === 0}
                className="cursor-pointer rounded-lg bg-surface-sunken px-3 py-2 text-xs font-medium text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Back
              </button>
              <button
                type="button"
                onClick={goNext}
                disabled={tabIndex === visibleTabs.length - 1}
                className="cursor-pointer rounded-lg bg-surface-sunken px-3 py-2 text-xs font-medium text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleClose()}
                className="cursor-pointer rounded-lg bg-surface-sunken px-3 py-2 text-xs font-medium text-fg hover:bg-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || mediaBusy}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {submitLabel}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
