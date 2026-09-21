'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Percent, X } from 'lucide-react';
import { createTaxCategoryAction } from '@/server/actions';
import { publishCatalogShortcut } from '@/components/admin/catalog-shortcuts';
import type { TaxType } from '@/types/index';

export function TaxCategoryCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [rate, setRate] = useState('');
  const [type, setType] = useState<TaxType>('vat');
  const [countryCode, setCountryCode] = useState('');
  const [countryName, setCountryName] = useState('');
  const [description, setDescription] = useState('');
  const [isInclusive, setIsInclusive] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/taxes');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Tax category name is required.');
      return;
    }

    const parsedRate = rate.trim() === '' ? NaN : Number(rate);
    if (!Number.isFinite(parsedRate) || parsedRate < 0) {
      setFormError('Tax rate must be 0% or greater.');
      return;
    }

    try {
      setIsSubmitting(true);
      setFormError(null);
      const tax = await createTaxCategoryAction({
        name: name.trim(),
        code: code.trim(),
        rate: parsedRate,
        type,
        countryCode: countryCode.trim().toUpperCase(),
        countryName: countryName.trim(),
        description: description.trim(),
        isInclusive,
        isDefault,
        isActive,
      });

      if (presentation === 'intercepted') {
        publishCatalogShortcut({ kind: 'tax', tax });
        router.back();
      } else {
        router.push('/admin/taxes');
        router.refresh();
      }
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Failed to save tax category');
    } finally {
      setIsSubmitting(false);
    }
  };

  const fieldClass =
    'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Percent className="h-5 w-5 text-indigo-400" />
            <div>
              <h3 className="text-base font-bold text-white">Create Tax Schedule & Category</h3>
              <p className="text-[11px] text-zinc-400">
                Add a tax category, then return to the product form.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="cursor-pointer rounded-lg bg-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-700 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {formError ? (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
              {formError}
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-xs font-semibold text-zinc-300">
              Tax Schedule / Category Name *
            </label>
            <input
              type="text"
              placeholder="Tax rule name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={fieldClass}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-zinc-300">
                Tax Statutory Code
              </label>
              <input
                type="text"
                placeholder="Code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={`${fieldClass} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-zinc-300">
                Tax Rate (%) *
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="16.0"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className={`${fieldClass} font-semibold`}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-zinc-300">
                Fiscal Tax Type
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as TaxType)}
                className={`${fieldClass} cursor-pointer`}
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
              <label className="mb-1 block text-xs font-semibold text-zinc-300">
                Country / Jurisdiction
              </label>
              <div className="grid grid-cols-3 gap-1">
                <input
                  type="text"
                  placeholder="KE"
                  maxLength={2}
                  value={countryCode}
                  onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-2 text-center font-mono text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
                <input
                  type="text"
                  placeholder="Country"
                  value={countryName}
                  onChange={(e) => setCountryName(e.target.value)}
                  className={`col-span-2 ${fieldClass}`}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-zinc-300">
              Pricing Inclusion Model
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 ${
                  isInclusive
                    ? 'border-indigo-500 bg-indigo-600/15 text-white'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
                }`}
              >
                <input
                  type="radio"
                  name="pricingModel"
                  checked={isInclusive}
                  onChange={() => setIsInclusive(true)}
                />
                <div>
                  <div className="text-xs font-semibold">Tax-Inclusive</div>
                  <div className="text-[10px] text-zinc-400">Product price includes tax</div>
                </div>
              </label>
              <label
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 ${
                  !isInclusive
                    ? 'border-indigo-500 bg-indigo-600/15 text-white'
                    : 'border-zinc-700 bg-zinc-800/60 text-zinc-400'
                }`}
              >
                <input
                  type="radio"
                  name="pricingModel"
                  checked={!isInclusive}
                  onChange={() => setIsInclusive(false)}
                />
                <div>
                  <div className="text-xs font-semibold">Tax-Exclusive</div>
                  <div className="text-[10px] text-zinc-400">Tax added on top of price</div>
                </div>
              </label>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-zinc-300">
              Statutory / Legal Note
            </label>
            <textarea
              placeholder="Optional notes"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={fieldClass}
            />
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600"
              />
              <span className="text-xs font-medium text-zinc-300">
                Set as Default Store Tax Rule
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-800 text-indigo-600"
              />
              <span className="text-xs font-medium text-zinc-300">Rule Active</span>
            </label>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-zinc-800 pt-4">
            <button
              type="button"
              onClick={close}
              className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving...' : 'Save Tax Rule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
