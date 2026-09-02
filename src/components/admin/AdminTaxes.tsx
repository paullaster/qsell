import React, { useState, useMemo } from 'react';
import { 
  Percent, 
  Plus, 
  Search, 
  CheckCircle, 
  ShieldCheck, 
  Globe, 
  Calculator, 
  Edit2, 
  Trash2, 
  Star, 
  Info, 
  Sparkles,
  ArrowRight,
  FileSpreadsheet,
  Check,
  X,
  RefreshCw,
  Building2,
  DollarSign
} from 'lucide-react';
import { TaxCategory, TaxType } from '../../types/index.js';
import { 
  createTaxCategoryAction, 
  updateTaxCategoryAction, 
  deleteTaxCategoryAction, 
  setDefaultTaxCategoryAction 
} from '../../lib/serverActions.js';

interface AdminTaxesProps {
  taxesPromise: Promise<TaxCategory[]>;
  onRefreshAll: () => void;
}

export function AdminTaxes({ taxesPromise, onRefreshAll }: AdminTaxesProps) {
  const [taxCategories, setTaxCategories] = useState<TaxCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [inclusionFilter, setInclusionFilter] = useState<string>('all');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTax, setEditingTax] = useState<TaxCategory | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Live Simulator State
  const [simAmount, setSimAmount] = useState<number>(25000);
  const [simTaxId, setSimTaxId] = useState<string>('');

  // Form State
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    rate: 16.0,
    type: 'vat' as TaxType,
    countryCode: 'KE',
    countryName: 'Kenya',
    description: '',
    isInclusive: true,
    isDefault: false,
    isActive: true
  });

  // Load Initial Tax Categories
  React.useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    taxesPromise
      .then((data) => {
        if (isMounted) {
          setTaxCategories(data);
          setIsLoading(false);
          const def = data.find(t => t.isDefault) || data[0];
          if (def && !simTaxId) setSimTaxId(def.id);
        }
      })
      .catch((err) => {
        console.error('Failed to load tax categories:', err);
        if (isMounted) setIsLoading(false);
      });
    return () => { isMounted = false; };
  }, [taxesPromise]);

  // Open Modal for Create or Edit
  const handleOpenModal = (tax?: TaxCategory) => {
    setFormError(null);
    if (tax) {
      setEditingTax(tax);
      setFormData({
        name: tax.name,
        code: tax.code,
        rate: tax.rate,
        type: tax.type,
        countryCode: tax.countryCode,
        countryName: tax.countryName,
        description: tax.description || '',
        isInclusive: tax.isInclusive,
        isDefault: tax.isDefault,
        isActive: tax.isActive
      });
    } else {
      setEditingTax(null);
      setFormData({
        name: '',
        code: '',
        rate: 16.0,
        type: 'vat',
        countryCode: 'KE',
        countryName: 'Kenya',
        description: '',
        isInclusive: true,
        isDefault: false,
        isActive: true
      });
    }
    setIsModalOpen(true);
  };

  const handleSaveTax = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formData.name.trim()) {
      setFormError('Tax category name is required.');
      return;
    }
    if (formData.rate === undefined || formData.rate < 0) {
      setFormError('Tax rate must be 0% or greater.');
      return;
    }

    setIsSaving(true);
    try {
      if (editingTax) {
        const updated = await updateTaxCategoryAction(editingTax.id, formData);
        setTaxCategories(prev => prev.map(t => t.id === updated.id ? updated : (formData.isDefault ? { ...t, isDefault: false } : t)));
      } else {
        const created = await createTaxCategoryAction(formData);
        setTaxCategories(prev => [...prev, created]);
      }
      setIsModalOpen(false);
      onRefreshAll();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save tax category');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteTax = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete "${name}"? Products currently linked will be reassigned.`)) {
      return;
    }

    try {
      await deleteTaxCategoryAction(id);
      setTaxCategories(prev => prev.filter(t => t.id !== id));
      onRefreshAll();
    } catch (err: any) {
      alert(err.message || 'Failed to delete tax category');
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultTaxCategoryAction(id);
      setTaxCategories(prev => prev.map(t => ({
        ...t,
        isDefault: t.id === id
      })));
      onRefreshAll();
    } catch (err: any) {
      alert(err.message || 'Failed to set default tax category');
    }
  };

  // Filtered Tax Categories
  const filteredTaxes = useMemo(() => {
    return taxCategories.filter(t => {
      const matchesSearch = 
        t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
        t.countryName.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesType = typeFilter === 'all' || t.type === typeFilter;
      const matchesInclusion = 
        inclusionFilter === 'all' || 
        (inclusionFilter === 'inclusive' && t.isInclusive) ||
        (inclusionFilter === 'exclusive' && !t.isInclusive);

      return matchesSearch && matchesType && matchesInclusion;
    });
  }, [taxCategories, searchQuery, typeFilter, inclusionFilter]);

  // Selected Simulation Tax
  const simTax = taxCategories.find(t => t.id === simTaxId) || taxCategories[0];
  
  // Tax calculations for simulator
  const simCalculations = useMemo(() => {
    if (!simTax) return { netPrice: 0, taxAmount: 0, grossPrice: 0 };
    const amount = Number(simAmount) || 0;
    const rate = simTax.rate / 100;

    if (simTax.isInclusive) {
      // Selling price includes tax: Net = Price / (1 + rate)
      const net = rate > 0 ? amount / (1 + rate) : amount;
      const tax = amount - net;
      return {
        netPrice: net,
        taxAmount: tax,
        grossPrice: amount
      };
    } else {
      // Tax is exclusive, added on top
      const tax = amount * rate;
      const gross = amount + tax;
      return {
        netPrice: amount,
        taxAmount: tax,
        grossPrice: gross
      };
    }
  }, [simTax, simAmount]);

  const defaultCategory = taxCategories.find(t => t.isDefault);
  const activeRulesCount = taxCategories.filter(t => t.isActive).length;
  const crossBorderCount = taxCategories.filter(t => t.countryCode !== 'KE').length;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-xl">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Percent className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">Tax & Compliance Management</h1>
              <p className="text-xs text-zinc-400 mt-0.5">
                Configure dynamic VAT schedules, digital services levies, and international cross-border tax jurisdictions.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleOpenModal()}
            id="btn-add-tax-category"
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Tax Rule</span>
          </button>
        </div>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Default Fiscal Rate</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {defaultCategory ? `${defaultCategory.rate}%` : '16%'}
            </span>
            <span className="text-xs text-emerald-400 font-medium">
              {defaultCategory?.name || 'KRA Standard VAT'}
            </span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Applied to standard catalog items automatically</p>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Active Tax Schedules</span>
            <FileSpreadsheet className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">{activeRulesCount}</span>
            <span className="text-xs text-zinc-400">/ {taxCategories.length} Total Rules</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Configured for statutory compliance</p>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Price Display Model</span>
            <Building2 className="w-4 h-4 text-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">Tax-Inclusive</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Standard retail pricing includes fiscal VAT</p>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Cross-Border Jurisdictions</span>
            <Globe className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">{crossBorderCount}</span>
            <span className="text-xs text-cyan-400 font-medium">International Markets</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Export, US Sales Tax & EU OSS VAT ready</p>
        </div>
      </div>

      {/* Live Interactive Tax Calculator / Simulator */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-lg">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Calculator className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-white">Live Retail Tax Computation Simulator</h2>
          </div>
          <span className="text-xs text-zinc-400">
            Verify fiscal math before setting product selling prices
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-4 items-end">
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Sample Retail Price (KES)</label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-xs text-zinc-500 font-semibold">KSh</span>
              <input
                type="number"
                value={simAmount}
                onChange={(e) => setSimAmount(Number(e.target.value) || 0)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-12 pr-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">Select Tax Schedule</label>
            <select
              value={simTaxId}
              onChange={(e) => setSimTaxId(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              {taxCategories.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.rate}%) - {t.isInclusive ? 'Inclusive' : 'Exclusive'}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2 grid grid-cols-3 gap-2 bg-zinc-950/60 p-3 rounded-lg border border-zinc-800">
            <div>
              <span className="block text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Net Amount</span>
              <span className="text-xs font-semibold text-zinc-200">
                KSh {simCalculations.netPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
            <div>
              <span className="block text-[10px] uppercase font-bold text-emerald-400 tracking-wider">Tax ({simTax?.rate}%)</span>
              <span className="text-xs font-semibold text-emerald-400">
                KSh {simCalculations.taxAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
            <div>
              <span className="block text-[10px] uppercase font-bold text-indigo-400 tracking-wider">Gross Total</span>
              <span className="text-xs font-bold text-indigo-400">
                KSh {simCalculations.grossPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Search by tax rule name, statutory code (e.g. VAT_16), or jurisdiction..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-4 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="all">All Tax Types</option>
            <option value="vat">Value Added Tax (VAT)</option>
            <option value="sales_tax">Sales Tax</option>
            <option value="digital_service">Digital Services Tax (DST)</option>
            <option value="exempt">Zero Rated / Exempt</option>
          </select>

          <select
            value={inclusionFilter}
            onChange={(e) => setInclusionFilter(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500 cursor-pointer"
          >
            <option value="all">All Pricing Models</option>
            <option value="inclusive">Price Inclusive</option>
            <option value="exclusive">Price Exclusive</option>
          </select>
        </div>
      </div>

      {/* Tax Categories List / Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950/70 border-b border-zinc-800 text-zinc-400 uppercase tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Tax Schedule & Jurisdiction</th>
                <th className="py-3 px-4">Tax Code</th>
                <th className="py-3 px-4">Rate (%)</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Pricing Model</th>
                <th className="py-3 px-4">Catalog Products</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
              {filteredTaxes.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-zinc-500">
                    No tax categories found matching your criteria.
                  </td>
                </tr>
              ) : (
                filteredTaxes.map((tax) => {
                  return (
                    <tr key={tax.id} className="hover:bg-zinc-800/40 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-white">{tax.name}</span>
                              {tax.isDefault && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                  <Star className="w-3 h-3 fill-amber-400" />
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-zinc-400 text-[11px]">
                              <span>{tax.countryName} ({tax.countryCode})</span>
                              {tax.description && <span>• {tax.description}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700/50">
                          {tax.code}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="text-sm font-bold text-emerald-400">
                          {tax.rate}%
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="capitalize px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-300 border border-zinc-700">
                          {tax.type.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          tax.isInclusive 
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' 
                            : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                        }`}>
                          {tax.isInclusive ? 'Tax-Inclusive' : 'Tax-Exclusive'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className="text-zinc-400 font-medium">
                          {tax.productCount !== undefined ? `${tax.productCount} products` : 'Standard'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                          tax.isActive ? 'text-emerald-400' : 'text-zinc-500'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${tax.isActive ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
                          {tax.isActive ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {!tax.isDefault && (
                            <button
                              onClick={() => handleSetDefault(tax.id)}
                              title="Set as store default tax schedule"
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-amber-400 text-[11px] font-medium transition-colors cursor-pointer border border-zinc-700/50"
                            >
                              Make Default
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenModal(tax)}
                            title="Edit tax rule"
                            className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {!tax.isDefault && (
                            <button
                              onClick={() => handleDeleteTax(tax.id, tax.name)}
                              title="Delete tax rule"
                              className="p-1.5 rounded bg-zinc-800 hover:bg-red-900/40 text-zinc-400 hover:text-red-400 transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tax Category Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-xl w-full p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <Percent className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">
                  {editingTax ? 'Edit Tax Schedule' : 'Create Tax Schedule & Category'}
                </h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                <Info className="w-4 h-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSaveTax} className="space-y-4 mt-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Tax Schedule / Category Name *
                </label>
                <input
                  type="text"
                  placeholder="e.g. Standard VAT (16%), Zero Rated Exports, Digital Services Tax"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Tax Statutory Code *
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. VAT_16, ZERO_0, DST_1_5"
                    value={formData.code}
                    onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Tax Rate (%) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="16.0"
                    value={formData.rate}
                    onChange={(e) => setFormData({ ...formData, rate: parseFloat(e.target.value) || 0 })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-semibold focus:outline-none focus:border-indigo-500"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Fiscal Tax Type
                  </label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value as TaxType })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="vat">Value Added Tax (VAT)</option>
                    <option value="sales_tax">Sales Tax</option>
                    <option value="gst">Goods & Services Tax (GST)</option>
                    <option value="digital_service">Digital Services Tax (DST)</option>
                    <option value="exempt">Zero Rated / Exempt</option>
                    <option value="excise">Excise Duty</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Country / Jurisdiction
                  </label>
                  <div className="grid grid-cols-3 gap-1">
                    <input
                      type="text"
                      placeholder="KE"
                      maxLength={2}
                      value={formData.countryCode}
                      onChange={(e) => setFormData({ ...formData, countryCode: e.target.value.toUpperCase() })}
                      className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-white font-mono text-center focus:outline-none focus:border-indigo-500"
                    />
                    <input
                      type="text"
                      placeholder="Kenya"
                      value={formData.countryName}
                      onChange={(e) => setFormData({ ...formData, countryName: e.target.value })}
                      className="col-span-2 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Pricing Inclusion Model
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                    formData.isInclusive 
                      ? 'bg-indigo-600/15 border-indigo-500 text-white' 
                      : 'bg-zinc-800/60 border-zinc-700 text-zinc-400'
                  }`}>
                    <input
                      type="radio"
                      name="pricingModel"
                      checked={formData.isInclusive}
                      onChange={() => setFormData({ ...formData, isInclusive: true })}
                      className="text-indigo-600"
                    />
                    <div>
                      <div className="text-xs font-semibold">Tax-Inclusive</div>
                      <div className="text-[10px] text-zinc-400">Product price includes tax (e.g. Kenya standard)</div>
                    </div>
                  </label>

                  <label className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                    !formData.isInclusive 
                      ? 'bg-indigo-600/15 border-indigo-500 text-white' 
                      : 'bg-zinc-800/60 border-zinc-700 text-zinc-400'
                  }`}>
                    <input
                      type="radio"
                      name="pricingModel"
                      checked={!formData.isInclusive}
                      onChange={() => setFormData({ ...formData, isInclusive: false })}
                      className="text-indigo-600"
                    />
                    <div>
                      <div className="text-xs font-semibold">Tax-Exclusive</div>
                      <div className="text-[10px] text-zinc-400">Tax added on top of price at checkout (e.g. US/EU export)</div>
                    </div>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Statutory / Legal Note & Description
                </label>
                <textarea
                  placeholder="e.g. Complies with Kenya Revenue Authority (KRA) eTIMS 16% Standard VAT Schedule 1"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={2}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center gap-4 pt-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isDefault}
                    onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                    className="rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-zinc-300 font-medium">Set as Default Store Tax Rule</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                    className="rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs text-zinc-300 font-medium">Rule Active</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/25 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isSaving ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  <span>{editingTax ? 'Update Tax Rule' : 'Save Tax Rule'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
