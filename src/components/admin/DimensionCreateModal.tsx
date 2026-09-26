'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Layers, X } from 'lucide-react';
import { createDimensionAction } from '@/server/domains/dimensions/actions';
import {
  globalDimensionFieldName,
  shortcutDimensionFieldName,
} from '@/server/domains/dimensions/projection';
import { publishCustomerShortcut } from '@/components/admin/customer-shortcuts';

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

export function DimensionCreateModal({ presentation }: { presentation: 'intercepted' | 'page' }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dimensionNo, setDimensionNo] = useState('1');
  const [kind, setKind] = useState<'global' | 'shortcut'>('global');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/settings/dimensions');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const number = Number(dimensionNo);
    if (!Number.isInteger(number) || number < 1) {
      setFormError('Dimension number must be 1 or greater.');
      return;
    }
    try {
      setIsSubmitting(true);
      setFormError(null);
      const created = await createDimensionAction({
        code,
        name,
        dimensionNo: number,
        isGlobal: kind === 'global',
        isShortcut: kind === 'shortcut',
      });
      const resolvedNo = created.dimensionNo ?? number;
      if (presentation === 'intercepted') {
        publishCustomerShortcut({
          kind: 'dimension',
          field: {
            fieldName:
              kind === 'global'
                ? globalDimensionFieldName(resolvedNo)
                : shortcutDimensionFieldName(resolvedNo),
            dimensionId: created.id,
            dimensionCode: created.code,
            kind,
            values: [],
          },
        });
        router.back();
      } else {
        router.push(`/admin/settings/dimensions/${created.id}`);
        router.refresh();
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save dimension');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-sm">
      <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
        <div className="flex items-center justify-between border-b border-line bg-surface p-5">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-indigo-400" />
            <div>
              <h3 className="text-base font-bold text-fg-strong">Create dimension</h3>
              <p className="text-[11px] text-fg-muted">
                Add a dimension, then return to the customer form.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="cursor-pointer rounded-lg p-1 text-fg-muted hover:text-fg-strong"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3 p-5">
          {formError ? <p className="text-xs text-red-700">{formError}</p> : null}
          <label className="block text-xs text-fg-muted">
            Code
            <input
              className={`${fieldClass} mt-1`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Name
            <input
              className={`${fieldClass} mt-1`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Number
            <input
              className={`${fieldClass} mt-1`}
              type="number"
              min={1}
              value={dimensionNo}
              onChange={(e) => setDimensionNo(e.target.value)}
              required
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Use on customers as
            <select
              className={`${fieldClass} mt-1`}
              value={kind}
              onChange={(e) => setKind(e.target.value as 'global' | 'shortcut')}
            >
              <option value="global">Global dimension</option>
              <option value="shortcut">Shortcut dimension</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : 'Save dimension'}
          </button>
        </form>
      </div>
    </div>
  );
}
