'use client';

import React, { use, useState, useMemo, useEffect } from 'react';
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
  DollarSign,
} from 'lucide-react';
import { type TaxCategory, type TaxType } from '@/types/index';
import {
  createTaxCategoryAction,
  updateTaxCategoryAction,
  deleteTaxCategoryAction,
  setDefaultTaxCategoryAction,
} from '@/server/actions';

interface AdminTaxesProps {
  taxesPromise: Promise<TaxCategory[]>;
  onRefreshAll: () => void;
}

export function AdminTaxes({ taxesPromise, onRefreshAll }: AdminTaxesProps) {
  const resolvedTaxes = use(taxesPromise);
  const [taxCategories, setTaxCategories] = useState<TaxCategory[]>(resolvedTaxes);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [inclusionFilter, setInclusionFilter] = useState<string>('all');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTax, setEditingTax] = useState<TaxCategory | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Live Simulator State
  const [simAmount, setSimAmount] = useState<number>(0);
  const [simTaxId, setSimTaxId] = useState<string>('');

  // Form State
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    rate: 0,
    type: 'vat' as TaxType,
    countryCode: '',
    countryName: '',
    description: '',
    isInclusive: true,
    isDefault: false,
    isActive: true,
  });

  useEffect(() => {
    setTaxCategories(resolvedTaxes);
  }, [resolvedTaxes]);

  useEffect(() => {
    if (simTaxId) return;
    const def = resolvedTaxes.find((t) => t.isDefault) ?? resolvedTaxes[0];
    if (def) {
      setSimTaxId(def.id);
    }
  }, [resolvedTaxes, simTaxId]);

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
        isActive: tax.isActive,
      });
    } else {
      setEditingTax(null);
      setFormData({
        name: '',
        code: '',
        rate: 0,
        type: 'vat',
        countryCode: '',
        countryName: '',
        description: '',
        isInclusive: true,
        isDefault: taxCategories.length === 0,
        isActive: true,
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
        setTaxCategories((prev) =>
          prev.map((t) =>
            t.id === updated.id ? updated : formData.isDefault ? { ...t, isDefault: false } : t,
          ),
        );
      } else {
        const created = await createTaxCategoryAction(formData);
        setTaxCategories((prev) => [...prev, created]);
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
    if (
      !window.confirm(
        `Are you sure you want to delete "${name}"? Products currently linked will be reassigned.`,
      )
    ) {
      return;
    }

    try {
      await deleteTaxCategoryAction(id);
      setTaxCategories((prev) => prev.filter((t) => t.id !== id));
      onRefreshAll();
    } catch (err: any) {
      alert(err.message || 'Failed to delete tax category');
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultTaxCategoryAction(id);
      setTaxCategories((prev) =>
        prev.map((t) => ({
          ...t,
          isDefault: t.id === id,
        })),
      );
      onRefreshAll();
    } catch (err: any) {
      alert(err.message || 'Failed to set default tax category');
    }
  };

  // Filtered Tax Categories
  const filteredTaxes = useMemo(() => {
    return taxCategories.filter((t) => {
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
  const simTax = taxCategories.find((t) => t.id === simTaxId) || taxCategories[0];

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
        grossPrice: amount,
      };
    } else {
      // Tax is exclusive, added on top
      const tax = amount * rate;
      const gross = amount + tax;
      return {
        netPrice: amount,
        taxAmount: tax,
        grossPrice: gross,
      };
    }
  }, [simTax, simAmount]);

  const defaultCategory = taxCategories.find((t) => t.isDefault);
  const activeRulesCount = taxCategories.filter((t) => t.isActive).length;
  const crossBorderCount = new Set(
    taxCategories.map((t) => t.countryCode).filter((code) => Boolean(code?.trim())),
  ).size;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-6 shadow-xl sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-emerald-600">
              <Percent className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-fg-strong">
                Tax & Compliance Management
              </h1>
              <p className="mt-0.5 text-xs text-fg-muted">
                Define tax rules for catalog pricing and checkout. Add only the schedules your
                business uses.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleOpenModal()}
            id="btn-add-tax-category"
            className="flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-xs font-semibold shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" />
            <span>Add Tax Rule</span>
          </button>
        </div>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface-sunken/80 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">Default Fiscal Rate</span>
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-fg-strong">
              {defaultCategory ? `${defaultCategory.rate}%` : '—'}
            </span>
            <span className="text-xs font-medium text-emerald-600">
              {defaultCategory?.name || 'No default set'}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">
            Applied to standard catalog items automatically
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface-sunken/80 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">Active Tax Schedules</span>
            <FileSpreadsheet className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-fg-strong">{activeRulesCount}</span>
            <span className="text-xs text-fg-muted">/ {taxCategories.length} Total Rules</span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">Configured for statutory compliance</p>
        </div>

        <div className="rounded-xl border border-line bg-surface-sunken/80 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">Price display model</span>
            <Building2 className="h-4 w-4 text-amber-600" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-fg-strong">
              {defaultCategory ? (defaultCategory.isInclusive ? 'Inclusive' : 'Exclusive') : '—'}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">From the default tax rule, when set</p>
        </div>

        <div className="rounded-xl border border-line bg-surface-sunken/80 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">Jurisdictions</span>
            <Globe className="h-4 w-4 text-cyan-600" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-fg-strong">{crossBorderCount}</span>
            <span className="text-xs font-medium text-cyan-600">country codes</span>
          </div>
          <p className="mt-1 text-[11px] text-fg-subtle">Based on rules you configure</p>
        </div>
      </div>

      {taxCategories.length > 0 ? (
        <div className="rounded-xl border border-line bg-surface-raised p-5 shadow-lg">
          <div className="flex flex-col justify-between gap-3 border-b border-line pb-4 md:flex-row md:items-center">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-emerald-600" />
              <h2 className="text-sm font-bold text-fg-strong">Tax calculator</h2>
            </div>
            <span className="text-xs text-fg-muted">
              Preview net / tax / gross for a selected rule
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 items-end gap-4 md:grid-cols-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-fg-muted">Amount</label>
              <div className="relative">
                <span className="absolute top-2.5 left-3 text-xs font-semibold text-fg-subtle">
                  KSh
                </span>
                <input
                  type="number"
                  value={simAmount || ''}
                  onChange={(e) => setSimAmount(Number(e.target.value) || 0)}
                  placeholder="0"
                  className="w-full rounded-lg border border-line-strong bg-surface-sunken py-2 pr-3 pl-12 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-fg-muted">
                Select Tax Schedule
              </label>
              <select
                value={simTaxId}
                onChange={(e) => setSimTaxId(e.target.value)}
                className="w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none"
              >
                {taxCategories.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.rate}%) - {t.isInclusive ? 'Inclusive' : 'Exclusive'}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-2 rounded-lg border border-line bg-surface/60 p-3 md:col-span-2">
              <div>
                <span className="block text-[10px] font-bold tracking-wider text-fg-subtle uppercase">
                  Net Amount
                </span>
                <span className="text-xs font-semibold text-fg-strong">
                  KSh{' '}
                  {simCalculations.netPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </div>
              <div>
                <span className="block text-[10px] font-bold tracking-wider text-emerald-600 uppercase">
                  Tax ({simTax?.rate}%)
                </span>
                <span className="text-xs font-semibold text-emerald-600">
                  KSh{' '}
                  {simCalculations.taxAmount.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div>
                <span className="block text-[10px] font-bold tracking-wider text-indigo-400 uppercase">
                  Gross Total
                </span>
                <span className="text-xs font-bold text-indigo-400">
                  KSh{' '}
                  {simCalculations.grossPrice.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Filter & Search Bar */}
      <div className="flex flex-col items-stretch justify-between gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute top-3 left-3 h-4 w-4 text-fg-subtle" />
          <input
            type="text"
            placeholder="Search by name, code, or country…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-raised py-2 pr-4 pl-9 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-2">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="cursor-pointer rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs text-fg focus:border-indigo-500 focus:outline-none"
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
            className="cursor-pointer rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs text-fg focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">All Pricing Models</option>
            <option value="inclusive">Price Inclusive</option>
            <option value="exclusive">Price Exclusive</option>
          </select>
        </div>
      </div>

      {/* Tax Categories List / Table */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line bg-surface/70 font-semibold tracking-wider text-fg-muted uppercase">
              <tr>
                <th className="px-4 py-3">Tax Schedule & Jurisdiction</th>
                <th className="px-4 py-3">Tax Code</th>
                <th className="px-4 py-3">Rate (%)</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Pricing Model</th>
                <th className="px-4 py-3">Catalog Products</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60 text-fg">
              {filteredTaxes.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-fg-subtle">
                    {taxCategories.length === 0
                      ? 'No tax rules yet. Use Add Tax Rule to create one.'
                      : 'No tax rules match your filters.'}
                  </td>
                </tr>
              ) : (
                filteredTaxes.map((tax) => {
                  return (
                    <tr key={tax.id} className="transition-colors hover:bg-hover">
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-fg-strong">{tax.name}</span>
                              {tax.isDefault && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-600">
                                  <Star className="h-3 w-3 fill-amber-400" />
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-muted">
                              <span>
                                {tax.countryName} ({tax.countryCode})
                              </span>
                              {tax.description && <span>• {tax.description}</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="rounded border border-line-strong/50 bg-surface-sunken px-2 py-0.5 font-mono text-fg">
                          {tax.code}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="text-sm font-bold text-emerald-600">{tax.rate}%</span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="rounded-full border border-line-strong bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-fg capitalize">
                          {tax.type.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            tax.isInclusive
                              ? 'border border-blue-500/20 bg-blue-500/10 text-blue-600'
                              : 'border border-purple-500/20 bg-purple-500/10 text-purple-600'
                          }`}
                        >
                          {tax.isInclusive ? 'Tax-Inclusive' : 'Tax-Exclusive'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="font-medium text-fg-muted">
                          {tax.productCount !== undefined
                            ? `${tax.productCount} products`
                            : 'Standard'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                            tax.isActive ? 'text-emerald-600' : 'text-fg-subtle'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${tax.isActive ? 'bg-emerald-400' : 'bg-fg-subtle'}`}
                          />
                          {tax.isActive ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {!tax.isDefault && (
                            <button
                              onClick={() => handleSetDefault(tax.id)}
                              title="Set as store default tax schedule"
                              className="cursor-pointer rounded border border-line-strong/50 bg-surface-sunken px-2 py-1 text-[11px] font-medium text-fg-muted transition-colors hover:bg-hover hover:text-amber-600"
                            >
                              Make Default
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenModal(tax)}
                            title="Edit tax rule"
                            className="cursor-pointer rounded bg-surface-sunken p-1.5 text-fg transition-colors hover:bg-hover hover:text-fg-strong"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          {!tax.isDefault && (
                            <button
                              onClick={() => handleDeleteTax(tax.id, tax.name)}
                              title="Delete tax rule"
                              className="cursor-pointer rounded bg-surface-sunken p-1.5 text-fg-muted transition-colors hover:bg-red-100 hover:text-red-600"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/80 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-line bg-surface-raised p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-line pb-4">
              <div className="flex items-center gap-2.5">
                <Percent className="h-5 w-5 text-indigo-400" />
                <h3 className="text-base font-bold text-fg-strong">
                  {editingTax ? 'Edit Tax Schedule' : 'Create Tax Schedule & Category'}
                </h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="cursor-pointer rounded-lg bg-surface-sunken p-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg-strong"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {formError && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-600">
                <Info className="h-4 w-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSaveTax} className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-xs font-semibold text-fg">
                  Tax Schedule / Category Name *
                </label>
                <input
                  type="text"
                  placeholder="Tax rule name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-fg">
                    Tax Statutory Code *
                  </label>
                  <input
                    type="text"
                    placeholder="Code"
                    value={formData.code}
                    onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                    className="w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 font-mono text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-fg">Tax Rate (%) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="16.0"
                    value={formData.rate}
                    onChange={(e) =>
                      setFormData({ ...formData, rate: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg-strong focus:border-indigo-500 focus:outline-none"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-fg">
                    Fiscal Tax Type
                  </label>
                  <select
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value as TaxType })}
                    className="w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
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
                  <label className="mb-1 block text-xs font-semibold text-fg">
                    Country / Jurisdiction
                  </label>
                  <div className="grid grid-cols-3 gap-1">
                    <input
                      type="text"
                      placeholder="KE"
                      maxLength={2}
                      value={formData.countryCode}
                      onChange={(e) =>
                        setFormData({ ...formData, countryCode: e.target.value.toUpperCase() })
                      }
                      className="rounded-lg border border-line-strong bg-surface-sunken px-2 py-2 text-center font-mono text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                    />
                    <input
                      type="text"
                      placeholder="Country"
                      value={formData.countryName}
                      onChange={(e) => setFormData({ ...formData, countryName: e.target.value })}
                      className="col-span-2 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-fg">
                  Pricing Inclusion Model
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 transition-colors ${
                      formData.isInclusive
                        ? 'TW border-indigo-500 bg-indigo-600/15'
                        : 'border-line-strong bg-surface-sunken/60 text-fg-muted'
                    }`}
                  >
                    <input
                      type="radio"
                      name="pricingModel"
                      checked={formData.isInclusive}
                      onChange={() => setFormData({ ...formData, isInclusive: true })}
                      className="text-indigo-600"
                    />
                    <div>
                      <div className="text-xs font-semibold">Tax-Inclusive</div>
                      <div className="text-[10px] text-fg-muted">Product price includes tax</div>
                    </div>
                  </label>

                  <label
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 transition-colors ${
                      !formData.isInclusive
                        ? 'TW border-indigo-500 bg-indigo-600/15'
                        : 'border-line-strong bg-surface-sunken/60 text-fg-muted'
                    }`}
                  >
                    <input
                      type="radio"
                      name="pricingModel"
                      checked={!formData.isInclusive}
                      onChange={() => setFormData({ ...formData, isInclusive: false })}
                      className="text-indigo-600"
                    />
                    <div>
                      <div className="text-xs font-semibold">Tax-Exclusive</div>
                      <div className="text-[10px] text-fg-muted">
                        Tax added on top of price at checkout
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-fg">
                  Statutory / Legal Note & Description
                </label>
                <textarea
                  placeholder="Optional notes"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={2}
                  className="w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-4 pt-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.isDefault}
                    onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
                    className="rounded border-line-strong bg-surface-sunken text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs font-medium text-fg">Set as Default Store Tax Rule</span>
                </label>

                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                    className="rounded border-line-strong bg-surface-sunken text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-xs font-medium text-fg">Rule Active</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="cursor-pointer rounded-lg bg-surface-sunken px-4 py-2 text-xs font-medium text-fg transition-colors hover:bg-hover"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-lg shadow-indigo-600/25 transition-all hover:bg-indigo-500 disabled:opacity-50"
                >
                  {isSaving ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
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
