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
  Trash2,
  AlignLeft,
  ShieldCheck,
} from 'lucide-react';
import {
  type Product,
  type Category,
  type ItemType,
  type TaxCategory,
  type ProductMediaItem,
  type ProductSpecification,
} from '@/types/index';
import {
  createProductAction,
  updateProductAction,
  fetchTaxCategoriesAction,
  listItemTypesAction,
} from '@/server/actions';
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
import { ProductUnitsSection, type PackagingRowState } from '@/components/admin/ProductUnitsSection';
import { quantityStep } from '@/lib/unit-rules';
import { checkProductUnitsAction } from '@/server/domains/units/actions';
import type { Choice } from '@/lib/payment-options';
import { listEtimsTargetsAction } from '@/server/domains/kra/etims/actions';

type ProductFormTab =
  'basics' | 'pricing' | 'inventory' | 'specs' | 'description' | 'media' | 'kra';

const TABS: { id: ProductFormTab; label: string; icon: typeof Package }[] = [
  { id: 'basics', label: 'Basics', icon: Package },
  { id: 'pricing', label: 'Pricing', icon: DollarSign },
  { id: 'inventory', label: 'Stock', icon: Layers },
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

export function AdminProductModal({
  isOpen,
  onClose,
  productToEdit,
  duplicateFrom,
  categories,
  itemTypes: initialItemTypes,
  taxCategories: initialTaxCategories,
  onSuccess,
}: AdminProductModalProps) {
  const isEditing = Boolean(productToEdit);
  const [tab, setTab] = useState<ProductFormTab>('basics');
  // eTIMS UI exists only when the company, or an independent branch, is set to eTIMS.
  const [etimsAvailable, setEtimsAvailable] = useState(false);
  useEffect(() => {
    if (!isOpen || !isEditing) {
      setEtimsAvailable(false);
      return;
    }
    let cancelled = false;
    void listEtimsTargetsAction().then((res) => {
      if (!cancelled) setEtimsAvailable(res.ok && res.data.length > 0);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, isEditing]);

  // Basic Information
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [stockCode, setStockCode] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [category, setCategory] = useState('');
  const [brand, setBrand] = useState('');
  const [itemTypeId, setItemTypeId] = useState('');

  // Item types & taxes — local copies so a shortcut create can append without resetting the form
  const [categoryOptions, setCategoryOptions] = useState<Category[]>(categories);
  const [itemTypes, setItemTypes] = useState<ItemType[]>(initialItemTypes || []);
  const [taxCategories, setTaxCategories] = useState<TaxCategory[]>(initialTaxCategories || []);
  const [selectedTaxId, setSelectedTaxId] = useState<string>('');

  // Pricing & Financials (strings so create form can stay empty with placeholders)
  const [price, setPrice] = useState('');
  const [compareAtPrice, setCompareAtPrice] = useState('');
  // Empty means "follow the selling price"; setting it needs its own permission.
  const [standardPrice, setStandardPrice] = useState('');
  const [minOrderQty, setMinOrderQty] = useState('');
  const [maxOrderQty, setMaxOrderQty] = useState('');
  const access = useAdminNavAccess();
  const maySetStandardPrice = access !== null && (access.superAdmin || access.permissions.includes('products:set_standard_price'));
  const [costPrice, setCostPrice] = useState('');

  // Inventory & Logistics
  const [stockQuantity, setStockQuantity] = useState('');
  const [lowStockThreshold, setLowStockThreshold] = useState('');
  const [weight, setWeight] = useState('');
  const [baseUnit, setBaseUnit] = useState<Choice | null>(null);
  const [packagings, setPackagings] = useState<PackagingRowState[]>([]);
  /** False until a saved product's alternate units are read: sending the empty list before that would wipe them. */
  const [packagingsLoaded, setPackagingsLoaded] = useState(false);

  // Media & Description
  const [gallery, setGallery] = useState<ProductMediaItem[]>([]);
  const [mediaBusy, setMediaBusy] = useState(false);
  /** Guards against a second Cancel/close while the first is still discarding unsaved uploads. */
  const closing = useRef(false);
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [isActive, setIsActive] = useState(true);

  // Dynamic Specifications (key-value pairs)
  const [specifications, setSpecifications] = useState<ProductSpecification[]>([]);
  const [newSpecKey, setNewSpecKey] = useState('');
  const [newSpecValue, setNewSpecValue] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCategoryOptions((current) => mergeById(current, categories));
  }, [categories]);

  // Load taxes / item types if not provided. Merge so a just-created option is not dropped.
  useEffect(() => {
    if (!isOpen) return;
    if (!initialTaxCategories || initialTaxCategories.length === 0) {
      fetchTaxCategoriesAction()
        .then((taxes) => setTaxCategories((current) => mergeById(current, taxes)))
        .catch(() => {});
    } else {
      setTaxCategories((current) => mergeById(current, initialTaxCategories));
    }
    if (!initialItemTypes || initialItemTypes.length === 0) {
      listItemTypesAction()
        .then((types) => setItemTypes((current) => mergeById(current, types)))
        .catch(() => {});
    } else {
      setItemTypes((current) => mergeById(current, initialItemTypes));
    }
  }, [initialTaxCategories, initialItemTypes, isOpen]);

  useEffect(() => {
    const onCreated = (event: Event) => {
      const detail = (event as CustomEvent<CatalogShortcutDetail>).detail;
      if (!detail) return;
      if (detail.kind === 'category') {
        setCategoryOptions((current) => mergeById(current, [detail.category]));
        setCategory(detail.category.name);
        return;
      }
      if (detail.kind === 'unit') {
        const created: Choice = { id: detail.unit.id, label: detail.unit.label, meta: { code: detail.unit.label.split(' · ')[0] ?? '', decimals: String(detail.unit.decimals) } };
        // A new unit goes to the alternate-unit row that was waiting for one, else it becomes the base unit.
        setPackagings((rows) => {
          const waiting = rows.findIndex((r) => r.unitId === '');
          if (waiting === -1) {
            setBaseUnit(created);
            return rows;
          }
          return rows.map((r, i) => (i === waiting ? { ...r, unitId: created.id, unitLabel: created.label } : r));
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
      setItemTypeId(detail.itemType.id);
    };
    window.addEventListener(CATALOG_SHORTCUT_CREATED, onCreated);
    return () => window.removeEventListener(CATALOG_SHORTCUT_CREATED, onCreated);
  }, []);

  // Initialize form state — create mode uses empty values + placeholders only
  useEffect(() => {
    if (!isOpen) return;
    setTab('basics');
    setError(null);

    const template = productToEdit ?? duplicateFrom;
    if (template) {
      setName(template.name);
      setItemTypeId(template.itemTypeId || '');
      setCategory(template.category);
      setBrand(template.brand || '');
      setPrice(template.price != null ? String(template.price) : '');
      setCompareAtPrice(template.compareAtPrice != null ? String(template.compareAtPrice) : '');
      setStandardPrice(template.standardPrice != null ? String(template.standardPrice) : '');
      setMinOrderQty(template.minOrderQty != null ? String(template.minOrderQty) : '');
      setMaxOrderQty(template.maxOrderQty != null ? String(template.maxOrderQty) : '');
      setCostPrice(template.costPrice != null ? String(template.costPrice) : '');
      setSelectedTaxId(template.taxCategoryId || '');
      setStockQuantity(String(template.stockQuantity));
      setLowStockThreshold(String(template.lowStockThreshold));
      setWeight(template.weight != null ? String(template.weight) : '');
      setBaseUnit({ id: template.baseUnitId, label: `${template.baseUnitCode} · ${template.baseUnitName}`, meta: { code: template.baseUnitCode, decimals: String(template.baseUnitDecimals) } });
      setPackagings([]);
      setPackagingsLoaded(!productToEdit);
      // Edit and duplicate both carry the gallery (assets are shared, so copying is free).
      setGallery(template.media ?? []);
      setDescription(template.description || '');
      setTagsInput(template.tags?.join(', ') || '');
      setIsActive(template.isActive);
      setSpecifications(template.specifications?.map((spec) => ({ ...spec })) ?? []);
      if (productToEdit) {
        setSku(productToEdit.sku);
        setStockCode(productToEdit.stockCode);
        setSlug(productToEdit.slug);
        setSlugManuallyEdited(true);
      } else {
        // A duplicate is a draft with its own identity: its codes are numbered when it is saved,
        // and its slug follows the title.
        setSku('');
        setStockCode('');
        setSlug(slugifyTitle(template.name));
        setSlugManuallyEdited(false);
      }
    } else {
      setName('');
      setSku('');
      setStockCode('');
      setSlugManuallyEdited(false);
      setSlug('');
      setCategory('');
      setBrand('');
      setItemTypeId('');
      setPrice('');
      setCompareAtPrice('');
      setStandardPrice('');
      setMinOrderQty('');
      setMaxOrderQty('');
      setCostPrice('');
      setSelectedTaxId('');
      setStockQuantity('');
      setLowStockThreshold('');
      setWeight('');
      setBaseUnit(null);
      setPackagings([]);
      setPackagingsLoaded(true);
      setGallery([]);
      setDescription('');
      setTagsInput('');
      setIsActive(true);
      setSpecifications([]);
    }
  }, [productToEdit, duplicateFrom, isOpen]);

  useEffect(() => {
    if (!isOpen || productToEdit || itemTypeId) return;
    const defaultType =
      itemTypes.find((t) => t.isDefault && t.isActive) ||
      itemTypes.find((t) => t.isDefault) ||
      itemTypes[0];
    if (defaultType) setItemTypeId(defaultType.id);
  }, [isOpen, productToEdit, itemTypes, itemTypeId]);

  const activeItemType =
    itemTypes.find((t) => t.id === itemTypeId) ||
    itemTypes.find((t) => t.isDefault) ||
    itemTypes[0];

  // Selected Tax details
  const activeTax =
    taxCategories.find((t) => t.id === selectedTaxId) ||
    taxCategories.find((t) => t.isDefault) ||
    taxCategories[0];
  const taxRate = activeTax ? activeTax.rate : 0;
  const isTaxInclusive = activeTax ? activeTax.isInclusive : true;

  // Fiscal Calculations
  const effectivePrice = price.trim() === '' ? 0 : Number(price) || 0;
  const costNumber = costPrice.trim() === '' ? NaN : Number(costPrice);
  const netSellingPrice = isTaxInclusive
    ? taxRate > 0
      ? effectivePrice / (1 + taxRate / 100)
      : effectivePrice
    : effectivePrice;
  const taxAmountPerUnit = isTaxInclusive
    ? effectivePrice - netSellingPrice
    : effectivePrice * (taxRate / 100);
  const unitGrossProfit = Number.isFinite(costNumber)
    ? netSellingPrice - costNumber
    : netSellingPrice;
  const grossMarginPct =
    netSellingPrice > 0 ? ((unitGrossProfit / netSellingPrice) * 100).toFixed(1) : '0.0';

  const handleAddSpec = () => {
    if (newSpecKey.trim() && newSpecValue.trim()) {
      setSpecifications([
        ...specifications,
        { key: newSpecKey.trim(), value: newSpecValue.trim() },
      ]);
      setNewSpecKey('');
      setNewSpecValue('');
    }
  };

  const handleRemoveSpec = (index: number) => {
    setSpecifications(specifications.filter((_, i) => i !== index));
  };

  const focusTabForError = (message: string) => {
    const m = message.toLowerCase();
    if (
      m.includes('title') ||
      m.includes('sku') ||
      m.includes('category') ||
      m.includes('item type')
    ) {
      setTab('basics');
    } else if (m.includes('price') || m.includes('selling') || m.includes('cost')) {
      setTab('pricing');
    } else if (m.includes('stock') || m.includes('weight') || m.includes('unit') || m.includes('decimal') || m.includes('whole number')) {
      setTab('inventory');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      const msg = 'Product title is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    // New products are numbered automatically when left blank; an existing one must keep its codes.
    if (isEditing && !sku.trim()) {
      const msg = 'SKU code is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    if (isEditing && !stockCode.trim()) {
      const msg = 'Stock code is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    if (!category.trim()) {
      const msg =
        categoryOptions.length === 0
          ? 'Create a category first, then assign it to this product.'
          : 'Category is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }
    if (!itemTypeId.trim() || !activeItemType) {
      const msg =
        itemTypes.length === 0
          ? 'Create an item type first, then assign it to this product.'
          : 'Item type is required.';
      setError(msg);
      focusTabForError(msg);
      return;
    }

    const sellable = activeItemType.isSellable;

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

    if (costPrice.trim() === '' || !Number.isFinite(Number(costPrice)) || Number(costPrice) < 0) {
      const msg = 'Cost of goods is required and must be 0 or greater.';
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
      }).catch(() => ({ ok: false as const, error: 'The server could not be reached. Check your connection and try again.' }));
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
    const limitIssue = limitsProblem(minNumber, maxNumber, Number.isFinite(unitDecimals) ? unitDecimals : 0, baseUnit?.meta?.code ?? 'unit');
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
    const autoSlug = slug.trim() || slugifyTitle(name);
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
        brand: brand.trim() || undefined,
        itemTypeId: activeItemType.id,
        itemTypeName: activeItemType.name,
        itemTypeCode: activeItemType.code,
        isSellable: sellable,
        price: price.trim() === '' ? undefined : Number(price),
        compareAtPrice:
          compareAtPrice.trim() !== '' && Number(compareAtPrice) > 0
            ? Number(compareAtPrice)
            : undefined,
        standardPrice: standardNumber,
        minOrderQty: minNumber,
        maxOrderQty: maxNumber,
        costPrice: Number(costPrice),
        taxCategoryId: activeTax?.id,
        taxCategoryName: activeTax?.name,
        taxRate: activeTax ? activeTax.rate : 0,
        isTaxInclusive: activeTax ? activeTax.isInclusive : true,
        stockQuantity: Number.isFinite(stock) ? stock : 0,
        lowStockThreshold: Number.isFinite(lowThreshold) ? lowThreshold : 0,
        weight: weightValue != null && Number.isFinite(weightValue) ? weightValue : undefined,
        ...(baseUnit === null ? {} : { baseUnitId: baseUnit.id }),
        ...(unitsToSave === undefined ? {} : { packagings: unitsToSave }),
        specifications,
        // The server derives the stored image columns from the gallery; this is just the main image.
        imageUrl: gallery[0]?.url ?? '',
        media: gallery.map(({ assetId, altText }) => ({ assetId, altText })),
        description: description.trim(),
        tags,
        isActive,
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

  if (!isOpen) return null;

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

  const goNext = () => {
    const next = visibleTabs[tabIndex + 1];
    if (next) setTab(next.id);
  };
  const goPrev = () => {
    const prev = visibleTabs[tabIndex - 1];
    if (prev) setTab(prev.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/80 p-3 backdrop-blur-md sm:p-5">
      <div
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
                {isEditing
                  ? `Edit Product: ${productToEdit?.sku ?? ''}`
                  : duplicateFrom
                    ? `Duplicate Product: ${duplicateFrom.sku}`
                    : 'Create New Product'}
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
            {error ? (
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
                    <label className="text-[11px] font-semibold text-fg-muted">Item Type *</label>
                    {itemTypes.length > 0 ? (
                      <CatalogCreateShortcut href="/admin/item-types/new">
                        New
                      </CatalogCreateShortcut>
                    ) : null}
                  </div>
                  <select
                    value={itemTypeId}
                    onChange={(e) => setItemTypeId(e.target.value)}
                    className={`${fieldClass} cursor-pointer`}
                    disabled={itemTypes.length === 0}
                  >
                    <option value="">
                      {itemTypes.length === 0 ? 'No item types yet' : 'Select item type'}
                    </option>
                    {itemTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.code} — {t.name}
                        {t.isDefault ? ' (default)' : ''}
                        {!t.isSellable ? ' · not sellable' : ''}
                      </option>
                    ))}
                  </select>
                  {itemTypes.length === 0 ? (
                    <p className="mt-1 text-[11px] text-amber-600">
                      Create an item type under Products &amp; Inventory first.{' '}
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
                      {activeItemType?.isSellable !== false ? ' *' : ''}
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
                    {activeItemType && !activeItemType.isSellable ? (
                      <p className="mt-1 text-[11px] text-fg-subtle">
                        Optional for non-sellable item types.
                      </p>
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
                    <label className={labelClass}>Cost of Goods (KES) *</label>
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={costPrice}
                      onChange={(e) => setCostPrice(e.target.value)}
                      placeholder="Leave empty for none"
                      className={`${fieldClass} font-mono`}
                    />
                  </div>
                  <div>
                    <label htmlFor="product-standard-price" className={labelClass}>Standard Price (KES)</label>
                    <input
                      id="product-standard-price"
                      type="number"
                      min={0}
                      step="any"
                      value={standardPrice}
                      onChange={(e) => setStandardPrice(e.target.value)}
                      disabled={!maySetStandardPrice}
                      aria-describedby="product-standard-price-hint"
                      placeholder={price.trim() === '' ? 'Same as the selling price' : `Same as the selling price (${price})`}
                      className={`${fieldClass} font-mono disabled:cursor-not-allowed disabled:opacity-60`}
                    />
                    <p id="product-standard-price-hint" className="mt-1 text-[11px] text-fg-subtle">
                      The price the pricing engine starts from when no price list applies. Leave it empty to follow the selling price.
                      {maySetStandardPrice ? '' : ' Changing it needs the “Set standard price” permission.'}
                    </p>
                  </div>
                </div>

                <fieldset className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface p-3 sm:grid-cols-2">
                  <legend className="px-1 text-[11px] font-semibold text-fg-muted">Quantity that can be bought at once</legend>
                  <div>
                    <label htmlFor="product-min-qty" className={labelClass}>Minimum quantity{baseUnit?.meta?.code === undefined ? '' : ` (${baseUnit.meta.code})`}</label>
                    <input id="product-min-qty" type="number" min={0} step="any" value={minOrderQty} onChange={(e) => setMinOrderQty(e.target.value)} placeholder="No minimum" className={`${fieldClass} font-mono`} />
                  </div>
                  <div>
                    <label htmlFor="product-max-qty" className={labelClass}>Maximum quantity{baseUnit?.meta?.code === undefined ? '' : ` (${baseUnit.meta.code})`}</label>
                    <input id="product-max-qty" type="number" min={0} step="any" value={maxOrderQty} onChange={(e) => setMaxOrderQty(e.target.value)} placeholder="No maximum" className={`${fieldClass} font-mono`} />
                  </div>
                  <p className="text-[11px] text-fg-subtle sm:col-span-2">
                    Both are empty by default. When set, the shop, orders and quotes all refuse a quantity outside them.
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
                <div>
                  <label className={labelClass}>{`On-Hand Stock${baseUnit?.meta?.code === undefined ? '' : ` (${baseUnit.meta.code})`}`}</label>
                  <input
                    type="number"
                    min={0}
                    step={unitStep}
                    value={stockQuantity}
                    onChange={(e) => setStockQuantity(e.target.value)}
                    placeholder="e.g. 15"
                    className={`${fieldClass} font-mono font-bold`}
                  />
                </div>
                <div>
                  <label className={labelClass}>Low Stock Threshold</label>
                  <input
                    type="number"
                    min={0}
                    step={unitStep}
                    value={lowStockThreshold}
                    onChange={(e) => setLowStockThreshold(e.target.value)}
                    placeholder="e.g. 5"
                    className={`${fieldClass} font-mono`}
                  />
                </div>
                <div>
                  <label className={labelClass}>{`Shipping Weight${baseUnit?.meta?.code === undefined ? '' : ` per ${baseUnit.meta.code}`} (kg)`}</label>
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

            {tab === 'specs' ? (
              <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="max-h-[280px] min-h-0 space-y-2 overflow-y-auto pr-1">
                  {specifications.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-fg-subtle">
                      No specifications yet. Add key attributes below.
                    </p>
                  ) : (
                    specifications.map((spec, idx) => (
                      <div
                        key={`${spec.key}-${idx}`}
                        className="flex items-center gap-2 rounded-lg border border-line bg-surface p-2"
                      >
                        <span className="w-28 truncate font-semibold text-fg-strong sm:w-36">
                          {spec.key}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-fg-muted">{spec.value}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSpec(idx)}
                          className="cursor-pointer p-1 text-fg-subtle hover:text-red-600"
                          aria-label={`Remove ${spec.key}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    placeholder="Attribute (e.g. RAM)"
                    value={newSpecKey}
                    onChange={(e) => setNewSpecKey(e.target.value)}
                    className={`${fieldClass} sm:w-1/3`}
                  />
                  <input
                    type="text"
                    placeholder="Value (e.g. 16GB)"
                    value={newSpecValue}
                    onChange={(e) => setNewSpecValue(e.target.value)}
                    className={`${fieldClass} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={handleAddSpec}
                    className="cursor-pointer rounded-lg bg-surface-sunken px-3 py-2 font-medium text-fg-strong hover:bg-hover"
                  >
                    Add
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
                {isSubmitting
                  ? 'Saving…'
                  : mediaBusy
                    ? 'Uploading images…'
                    : isEditing
                      ? 'Save Changes'
                      : 'Create Product'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
