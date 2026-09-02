import React, { useState, useEffect } from 'react';
import { 
  X, 
  Plus, 
  Package, 
  DollarSign, 
  Image as ImageIcon, 
  Tag, 
  Save, 
  AlertTriangle,
  Percent,
  Layers,
  Trash2,
  CheckCircle2
} from 'lucide-react';
import { Product, Category, TaxCategory, ProductSpecification } from '../../types/index.js';
import { createProductAction, updateProductAction, fetchTaxCategoriesAction } from '../../lib/serverActions.js';

interface AdminProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  productToEdit: Product | null;
  categories: Category[];
  taxCategories?: TaxCategory[];
  onSuccess: () => void;
}

export function AdminProductModal({
  isOpen,
  onClose,
  productToEdit,
  categories,
  taxCategories: initialTaxCategories,
  onSuccess
}: AdminProductModalProps) {
  if (!isOpen) return null;

  const isEditing = !!productToEdit;

  // Basic Information
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [slug, setSlug] = useState('');
  const [category, setCategory] = useState('Electronics');
  const [brand, setBrand] = useState('');
  
  // Tax Categories & Selection
  const [taxCategories, setTaxCategories] = useState<TaxCategory[]>(initialTaxCategories || []);
  const [selectedTaxId, setSelectedTaxId] = useState<string>('');

  // Pricing & Financials
  const [price, setPrice] = useState<number>(10000);
  const [compareAtPrice, setCompareAtPrice] = useState<number>(12000);
  const [costPrice, setCostPrice] = useState<number>(7500);
  
  // Inventory & Logistics
  const [stockQuantity, setStockQuantity] = useState<number>(20);
  const [lowStockThreshold, setLowStockThreshold] = useState<number>(5);
  const [weight, setWeight] = useState<number>(1.2);
  
  // Media & Description
  const [imageUrl, setImageUrl] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [isActive, setIsActive] = useState(true);

  // Dynamic Specifications (key-value pairs)
  const [specifications, setSpecifications] = useState<ProductSpecification[]>([
    { key: 'Warranty', value: '1 Year Official Warranty' },
    { key: 'Condition', value: 'Brand New Sealed' }
  ]);
  const [newSpecKey, setNewSpecKey] = useState('');
  const [newSpecValue, setNewSpecValue] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load taxes if not provided
  useEffect(() => {
    if (!initialTaxCategories || initialTaxCategories.length === 0) {
      fetchTaxCategoriesAction()
        .then(taxes => setTaxCategories(taxes))
        .catch(() => {});
    }
  }, [initialTaxCategories]);

  // Initialize form state
  useEffect(() => {
    if (productToEdit) {
      setName(productToEdit.name);
      setSku(productToEdit.sku);
      setSlug(productToEdit.slug);
      setCategory(productToEdit.category);
      setBrand(productToEdit.brand || '');
      setPrice(productToEdit.price);
      setCompareAtPrice(productToEdit.compareAtPrice || 0);
      setCostPrice(productToEdit.costPrice || Math.round(productToEdit.price * 0.75));
      setSelectedTaxId(productToEdit.taxCategoryId || '');
      setStockQuantity(productToEdit.stockQuantity);
      setLowStockThreshold(productToEdit.lowStockThreshold);
      setWeight(productToEdit.weight || 1.0);
      setImageUrl(productToEdit.imageUrl);
      setDescription(productToEdit.description);
      setTagsInput(productToEdit.tags?.join(', ') || '');
      setIsActive(productToEdit.isActive);
      setSpecifications(
        productToEdit.specifications && productToEdit.specifications.length > 0
          ? productToEdit.specifications
          : [
              { key: 'Warranty', value: '1 Year Official Warranty' },
              { key: 'Condition', value: 'Brand New Sealed' }
            ]
      );
    } else {
      const defaultCategory = categories.length > 0 ? categories[0].name : 'Electronics';
      const defaultTax = taxCategories.find(t => t.isDefault) || taxCategories[0];
      setName('');
      setSku(`SKU-${Math.floor(1000 + Math.random() * 9000)}`);
      setSlug('');
      setCategory(defaultCategory);
      setBrand('');
      setPrice(25000);
      setCompareAtPrice(30000);
      setCostPrice(18000);
      if (defaultTax) setSelectedTaxId(defaultTax.id);
      setStockQuantity(15);
      setLowStockThreshold(4);
      setWeight(1.5);
      setImageUrl('https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=1000&q=80');
      setDescription('Premium grade electronic device with exceptional build quality, high reliability, and standard manufacturer support.');
      setTagsInput('Electronics, Flagship, In-Demand');
      setIsActive(true);
      setSpecifications([
        { key: 'Warranty', value: '1 Year Official Warranty' },
        { key: 'Condition', value: 'Brand New Sealed' }
      ]);
    }
  }, [productToEdit, isOpen, categories, taxCategories]);

  // Selected Tax details
  const activeTax = taxCategories.find(t => t.id === selectedTaxId) || taxCategories.find(t => t.isDefault) || taxCategories[0];
  const taxRate = activeTax ? activeTax.rate : 16.0;
  const isTaxInclusive = activeTax ? activeTax.isInclusive : true;

  // Fiscal Calculations
  const effectivePrice = Number(price) || 0;
  const netSellingPrice = isTaxInclusive 
    ? (taxRate > 0 ? effectivePrice / (1 + taxRate / 100) : effectivePrice)
    : effectivePrice;
  const taxAmountPerUnit = isTaxInclusive
    ? (effectivePrice - netSellingPrice)
    : (effectivePrice * (taxRate / 100));
  const grossTotalPerUnit = isTaxInclusive
    ? effectivePrice
    : (effectivePrice + taxAmountPerUnit);

  const unitGrossProfit = netSellingPrice - (costPrice || 0);
  const grossMarginPct = netSellingPrice > 0 ? ((unitGrossProfit / netSellingPrice) * 100).toFixed(1) : '0.0';

  const handleAddSpec = () => {
    if (newSpecKey.trim() && newSpecValue.trim()) {
      setSpecifications([...specifications, { key: newSpecKey.trim(), value: newSpecValue.trim() }]);
      setNewSpecKey('');
      setNewSpecValue('');
    }
  };

  const handleRemoveSpec = (index: number) => {
    setSpecifications(specifications.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Product title is required.');
      return;
    }
    if (!sku.trim()) {
      setError('SKU code is required.');
      return;
    }
    if (price <= 0) {
      setError('Selling price must be greater than 0.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    const autoSlug = slug.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    try {
      const productPayload = {
        name: name.trim(),
        sku: sku.trim().toUpperCase(),
        slug: autoSlug,
        category,
        brand: brand.trim() || undefined,
        price: Number(price),
        compareAtPrice: Number(compareAtPrice) > 0 ? Number(compareAtPrice) : undefined,
        costPrice: Number(costPrice) > 0 ? Number(costPrice) : undefined,
        taxCategoryId: activeTax?.id,
        taxCategoryName: activeTax?.name,
        taxRate: activeTax ? activeTax.rate : 16.0,
        isTaxInclusive: activeTax ? activeTax.isInclusive : true,
        stockQuantity: Number(stockQuantity),
        lowStockThreshold: Number(lowStockThreshold),
        weight: Number(weight) || 1.0,
        specifications,
        imageUrl: imageUrl.trim(),
        description: description.trim(),
        tags,
        isActive
      };

      if (isEditing && productToEdit) {
        await updateProductAction(productToEdit.id, productPayload);
      } else {
        await createProductAction({
          ...productPayload,
          rating: 5.0,
          reviewCount: 0
        });
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Operation failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center">
      <div className="relative w-full max-w-3xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8 max-h-[92vh]">
        {/* Modal Header */}
        <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Package className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-base text-white">
                {isEditing ? `Edit Product: ${productToEdit.sku}` : 'Create New Product Record'}
              </h3>
              <p className="text-[11px] text-zinc-400">
                {isEditing ? 'Update pricing, margins, stock thresholds, and specifications.' : 'Add a new catalog item with complete pricing and inventory tracking.'}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="text-zinc-400 hover:text-white p-1 rounded-lg cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Content */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
          {error && (
            <div className="p-3.5 rounded-lg bg-red-950/80 border border-red-800 text-red-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Section 1: Basic Information */}
          <div className="space-y-4">
            <h4 className="font-bold text-white text-xs uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1.5 flex items-center gap-1.5">
              <Package className="w-3.5 h-3.5 text-indigo-400" />
              General Catalog Information
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <label className="block font-semibold text-zinc-300 mb-1">Product Title *</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!isEditing) {
                      setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
                    }
                  }}
                  required
                  placeholder="e.g. Sony WH-1000XM5 Wireless Headphones"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">SKU Code *</label>
                <input
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value.toUpperCase())}
                  required
                  placeholder="e.g. SNY-WH1000XM5"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white placeholder-zinc-500 font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Category *</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                  {categories.length === 0 && (
                    <>
                      <option value="Electronics">Electronics</option>
                      <option value="Audio">Audio</option>
                      <option value="Phones">Phones</option>
                      <option value="Wearables">Wearables</option>
                      <option value="Accessories">Accessories</option>
                    </>
                  )}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Brand / Manufacturer</label>
                <input
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="e.g. Sony, Apple, Samsung"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">URL Slug</label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="sony-wh-1000xm5"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white placeholder-zinc-500 font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Pricing & Profit Margins */}
          <div className="space-y-4">
            <h4 className="font-bold text-white text-xs uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1.5 flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
              Pricing, Tax Category & Profitability
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Selling Price (KES) *</label>
                <input
                  type="number"
                  min={1}
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono font-bold focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Tax Category *</label>
                <select
                  value={selectedTaxId}
                  onChange={(e) => setSelectedTaxId(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500 cursor-pointer"
                >
                  {taxCategories.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.rate}% - {t.isInclusive ? 'Inclusive' : 'Exclusive'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Compare-at Price (KES)</label>
                <input
                  type="number"
                  min={0}
                  value={compareAtPrice}
                  onChange={(e) => setCompareAtPrice(Number(e.target.value))}
                  placeholder="Original MSRP"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Cost of Goods (KES)</label>
                <input
                  type="number"
                  min={0}
                  value={costPrice}
                  onChange={(e) => setCostPrice(Number(e.target.value))}
                  placeholder="Supplier unit cost"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            {/* Profit & Fiscal Margin Calculator Card */}
            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <span className="text-[10px] text-zinc-500 block uppercase">Net (Excl. Tax)</span>
                <span className="text-xs font-semibold text-zinc-200 font-mono">
                  KES {Math.round(netSellingPrice).toLocaleString()}
                </span>
              </div>

              <div>
                <span className="text-[10px] text-emerald-400 block uppercase">Tax ({taxRate}%)</span>
                <span className="text-xs font-semibold text-emerald-400 font-mono">
                  KES {Math.round(taxAmountPerUnit).toLocaleString()}
                </span>
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 block uppercase">Unit Profit</span>
                <span className={`text-xs font-bold font-mono ${unitGrossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  KES {Math.round(unitGrossProfit).toLocaleString()}
                </span>
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 block uppercase">Profit Margin</span>
                <span className={`text-xs font-bold font-mono ${Number(grossMarginPct) >= 20 ? 'text-indigo-400' : 'text-amber-400'}`}>
                  {grossMarginPct}% ({isTaxInclusive ? 'Inclusive' : 'Exclusive'})
                </span>
              </div>
            </div>
          </div>

          {/* Section 3: Inventory & Logistics */}
          <div className="space-y-4">
            <h4 className="font-bold text-white text-xs uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1.5 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              Inventory & Warehouse Settings
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Current On-Hand Stock *</label>
                <input
                  type="number"
                  min={0}
                  value={stockQuantity}
                  onChange={(e) => setStockQuantity(Number(e.target.value))}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono font-bold focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Low Stock Threshold *</label>
                <input
                  type="number"
                  min={1}
                  value={lowStockThreshold}
                  onChange={(e) => setLowStockThreshold(Number(e.target.value))}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Shipping Weight (kg)</label>
                <input
                  type="number"
                  step="0.1"
                  min={0.1}
                  value={weight}
                  onChange={(e) => setWeight(Number(e.target.value))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Section 4: Specifications */}
          <div className="space-y-3">
            <h4 className="font-bold text-white text-xs uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1.5 flex items-center gap-1.5">
              <Tag className="w-3.5 h-3.5 text-indigo-400" />
              Technical Specifications & Key Attributes
            </h4>

            <div className="space-y-2">
              {specifications.map((spec, idx) => (
                <div key={idx} className="flex items-center gap-2 p-2 rounded-lg bg-zinc-950 border border-zinc-800">
                  <span className="font-semibold text-white w-32 truncate">{spec.key}</span>
                  <span className="text-zinc-400 flex-1 truncate">{spec.value}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveSpec(idx)}
                    className="text-zinc-500 hover:text-red-400 p-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  placeholder="Attribute (e.g. RAM, Storage, Color)"
                  value={newSpecKey}
                  onChange={(e) => setNewSpecKey(e.target.value)}
                  className="w-1/3 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="text"
                  placeholder="Value (e.g. 16GB Unified Memory)"
                  value={newSpecValue}
                  onChange={(e) => setNewSpecValue(e.target.value)}
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={handleAddSpec}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-medium cursor-pointer"
                >
                  Add Spec
                </button>
              </div>
            </div>
          </div>

          {/* Section 5: Media & Details */}
          <div className="space-y-4">
            <h4 className="font-bold text-white text-xs uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-1.5 flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
              Media & Storefront Visibility
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2 space-y-4">
                <div>
                  <label className="block font-semibold text-zinc-300 mb-1">Primary Image URL *</label>
                  <input
                    type="url"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    required
                    placeholder="https://..."
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white placeholder-zinc-500 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-zinc-300 mb-1">Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    placeholder="e.g. Apple, ANC, Gaming, Wireless"
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-[10px] text-zinc-500 mb-2 uppercase">Image Preview</span>
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt="Product Preview"
                    className="w-24 h-24 object-cover rounded-lg border border-zinc-800"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=300&q=80';
                    }}
                  />
                ) : (
                  <div className="w-24 h-24 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600">
                    No Image
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="block font-semibold text-zinc-300 mb-1">Full Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Detailed marketing description, packaging details, and warranty specifications..."
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block font-semibold text-zinc-300 mb-1">Publishing Status</label>
              <select
                value={isActive ? 'active' : 'draft'}
                onChange={(e) => setIsActive(e.target.value === 'active')}
                className="w-full sm:w-60 bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white focus:outline-none focus:border-indigo-500 cursor-pointer"
              >
                <option value="active">Active (Published on Storefront)</option>
                <option value="draft">Draft (Hidden from Catalog)</option>
              </select>
            </div>
          </div>

          {/* Modal Footer */}
          <div className="pt-4 border-t border-zinc-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-lg shadow-indigo-600/20 disabled:opacity-50 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {isSubmitting ? 'Saving...' : isEditing ? 'Save Product Changes' : 'Create Product'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
