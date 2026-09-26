'use client';

import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import {
  type Product,
  type Category,
  type ItemType,
  type TaxCategory,
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
import { AppImage, PRODUCT_IMAGE_FALLBACK } from '@/components/ui/AppImage';

type ProductFormTab = 'basics' | 'pricing' | 'inventory' | 'specs' | 'description' | 'media';

const TABS: { id: ProductFormTab; label: string; icon: typeof Package }[] = [
  { id: 'basics', label: 'Basics', icon: Package },
  { id: 'pricing', label: 'Pricing', icon: DollarSign },
  { id: 'inventory', label: 'Stock', icon: Layers },
  { id: 'specs', label: 'Specs', icon: Tag },
  { id: 'description', label: 'Description', icon: AlignLeft },
  { id: 'media', label: 'Media', icon: ImageIcon },
];

interface AdminProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  productToEdit: Product | null;
  categories: Category[];
  itemTypes?: ItemType[];
  taxCategories?: TaxCategory[];
  onSuccess: () => void;
}

export function AdminProductModal({
  isOpen,
  onClose,
  productToEdit,
  categories,
  itemTypes: initialItemTypes,
  taxCategories: initialTaxCategories,
  onSuccess,
}: AdminProductModalProps) {
  const isEditing = Boolean(productToEdit);
  const [tab, setTab] = useState<ProductFormTab>('basics');

  // Basic Information
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [slug, setSlug] = useState('');
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
  const [costPrice, setCostPrice] = useState('');

  // Inventory & Logistics
  const [stockQuantity, setStockQuantity] = useState('');
  const [lowStockThreshold, setLowStockThreshold] = useState('');
  const [weight, setWeight] = useState('');

  // Media & Description
  const [imageUrl, setImageUrl] = useState('');
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

    if (productToEdit) {
      setName(productToEdit.name);
      setSku(productToEdit.sku);
      setSlug(productToEdit.slug);
      setCategory(productToEdit.category);
      setBrand(productToEdit.brand || '');
      setItemTypeId(productToEdit.itemTypeId || '');
      setPrice(productToEdit.price != null ? String(productToEdit.price) : '');
      setCompareAtPrice(
        productToEdit.compareAtPrice != null ? String(productToEdit.compareAtPrice) : '',
      );
      setCostPrice(productToEdit.costPrice != null ? String(productToEdit.costPrice) : '');
      setSelectedTaxId(productToEdit.taxCategoryId || '');
      setStockQuantity(String(productToEdit.stockQuantity));
      setLowStockThreshold(String(productToEdit.lowStockThreshold));
      setWeight(productToEdit.weight != null ? String(productToEdit.weight) : '');
      setImageUrl(productToEdit.imageUrl || '');
      setDescription(productToEdit.description || '');
      setTagsInput(productToEdit.tags?.join(', ') || '');
      setIsActive(productToEdit.isActive);
      setSpecifications(
        productToEdit.specifications && productToEdit.specifications.length > 0
          ? productToEdit.specifications
          : [],
      );
    } else {
      setName('');
      setSku('');
      setSlug('');
      setCategory('');
      setBrand('');
      setItemTypeId('');
      setPrice('');
      setCompareAtPrice('');
      setCostPrice('');
      setSelectedTaxId('');
      setStockQuantity('');
      setLowStockThreshold('');
      setWeight('');
      setImageUrl('');
      setDescription('');
      setTagsInput('');
      setIsActive(true);
      setSpecifications([]);
    }
  }, [productToEdit, isOpen]);

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
    } else if (m.includes('stock') || m.includes('weight')) {
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
    if (!sku.trim()) {
      const msg = 'SKU code is required.';
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

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const autoSlug = slug.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const stock = stockQuantity.trim() === '' ? 0 : Number(stockQuantity);
    const lowThreshold = lowStockThreshold.trim() === '' ? 0 : Number(lowStockThreshold);
    const weightValue = weight.trim() === '' ? undefined : Number(weight);

    try {
      const productPayload = {
        name: name.trim(),
        sku: sku.trim().toUpperCase(),
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
        costPrice: Number(costPrice),
        taxCategoryId: activeTax?.id,
        taxCategoryName: activeTax?.name,
        taxRate: activeTax ? activeTax.rate : 0,
        isTaxInclusive: activeTax ? activeTax.isInclusive : true,
        stockQuantity: Number.isFinite(stock) ? stock : 0,
        lowStockThreshold: Number.isFinite(lowThreshold) ? lowThreshold : 0,
        weight: weightValue != null && Number.isFinite(weightValue) ? weightValue : undefined,
        specifications,
        imageUrl: imageUrl.trim(),
        description: description.trim(),
        tags,
        isActive,
      };

      if (isEditing && productToEdit) {
        await updateProductAction(productToEdit.id, productPayload);
      } else {
        await createProductAction({
          ...productPayload,
          rating: 0,
          reviewCount: 0,
        });
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

  const fieldClass =
    'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none';
  const labelClass = 'mb-1 block text-[11px] font-semibold text-fg-muted';

  const tabIndex = TABS.findIndex((t) => t.id === tab);
  const goNext = () => {
    const next = TABS[tabIndex + 1];
    if (next) setTab(next.id);
  };
  const goPrev = () => {
    const prev = TABS[tabIndex - 1];
    if (prev) setTab(prev.id);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/80 p-3 backdrop-blur-md sm:p-5">
      <div className="relative flex h-[min(720px,90vh)] w-[90vw] max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-500/30 bg-indigo-600/20 text-indigo-400">
              <Package className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h3 className="truncate text-sm font-bold text-fg-strong sm:text-base">
                {isEditing ? `Edit Product: ${productToEdit?.sku ?? ''}` : 'Create New Product'}
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
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-fg-muted hover:text-fg-strong"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-surface/80 px-3 py-2 sm:px-4">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors sm:px-3 ${
                tab === id ? 'bg-indigo-600 text-white' : 'hover:text-fg-muted hover:bg-hover'
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
                      setName(e.target.value);
                      if (!isEditing) {
                        setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
                      }
                    }}
                    placeholder="e.g. Sony WH-1000XM5 Wireless Headphones"
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>SKU Code *</label>
                  <input
                    type="text"
                    value={sku}
                    onChange={(e) => setSku(e.target.value.toUpperCase())}
                    placeholder="e.g. SNY-WH1000XM5"
                    className={`${fieldClass} font-mono`}
                  />
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
                    onChange={(e) => setSlug(e.target.value)}
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
                        Create a tax category under Finance &amp; Compliance first.{' '}
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
                </div>

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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>On-Hand Stock</label>
                  <input
                    type="number"
                    min={0}
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
                    value={lowStockThreshold}
                    onChange={(e) => setLowStockThreshold(e.target.value)}
                    placeholder="e.g. 5"
                    className={`${fieldClass} font-mono`}
                  />
                </div>
                <div>
                  <label className={labelClass}>Shipping Weight (kg)</label>
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
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                  <div className="space-y-3">
                    <div>
                      <label className={labelClass}>Primary Image URL *</label>
                      <input
                        type="url"
                        value={imageUrl}
                        onChange={(e) => setImageUrl(e.target.value)}
                        placeholder="https://..."
                        className={`${fieldClass} font-mono`}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Tags (comma-separated)</label>
                      <input
                        type="text"
                        value={tagsInput}
                        onChange={(e) => setTagsInput(e.target.value)}
                        placeholder="e.g. Apple, ANC, Gaming"
                        className={fieldClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Publishing Status</label>
                      <select
                        value={isActive ? 'active' : 'draft'}
                        onChange={(e) => setIsActive(e.target.value === 'active')}
                        className={`${fieldClass} cursor-pointer sm:max-w-xs`}
                      >
                        <option value="active">Active (Published)</option>
                        <option value="draft">Draft (Hidden)</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex flex-col items-center justify-center rounded-xl border border-line bg-surface p-3 sm:w-32">
                    <span className="mb-2 text-[10px] text-fg-subtle uppercase">Preview</span>
                    {imageUrl ? (
                      <AppImage
                        src={imageUrl}
                        alt="Product preview"
                        width={96}
                        height={96}
                        sizes="96px"
                        fallbackSrc={PRODUCT_IMAGE_FALLBACK}
                        className="h-24 w-24 rounded-lg border border-line object-cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="flex h-24 w-24 items-center justify-center rounded-lg border border-line bg-surface-raised text-fg-faint">
                        No Image
                      </div>
                    )}
                  </div>
                </div>
              </div>
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
                disabled={tabIndex === TABS.length - 1}
                className="cursor-pointer rounded-lg bg-surface-sunken px-3 py-2 text-xs font-medium text-fg hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg bg-surface-sunken px-3 py-2 text-xs font-medium text-fg hover:bg-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {isSubmitting ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Product'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
