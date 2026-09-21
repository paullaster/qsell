'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Layers, X } from 'lucide-react';
import { createDimensionValueAction } from '@/server/domains/dimensions/actions';
import { publishCustomerShortcut } from '@/components/admin/customer-shortcuts';

const fieldClass =
  'w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none';

export function DimensionValueCreateModal({
  presentation,
  dimensionId,
  dimensionCode,
  fieldName,
}: {
  presentation: 'intercepted' | 'page';
  dimensionId: string;
  dimensionCode: string;
  fieldName: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push(`/admin/settings/dimensions/${dimensionId}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      setFormError(null);
      const created = await createDimensionValueAction({
        dimensionId,
        code,
        name,
        description: description || null,
      });
      if (presentation === 'intercepted') {
        publishCustomerShortcut({
          kind: 'dimensionValue',
          fieldName,
          value: { code: created.code, name: created.name },
        });
        router.back();
      } else {
        router.push(`/admin/settings/dimensions/${dimensionId}`);
        router.refresh();
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save dimension value');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm">
      <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 p-5">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-indigo-400" />
            <div>
              <h3 className="text-base font-bold text-white">New {dimensionCode} value</h3>
              <p className="text-[11px] text-zinc-400">Add a value, then return to the customer form.</p>
            </div>
          </div>
          <button type="button" onClick={close} className="cursor-pointer rounded-lg p-1 text-zinc-400 hover:text-white" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3 p-5">
          {formError ? <p className="text-xs text-red-300">{formError}</p> : null}
          <label className="block text-xs text-zinc-400">
            Code
            <input className={`${fieldClass} mt-1`} value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <label className="block text-xs text-zinc-400">
            Name
            <input className={`${fieldClass} mt-1`} value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="block text-xs text-zinc-400">
            Description
            <input className={`${fieldClass} mt-1`} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button type="submit" disabled={isSubmitting} className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {isSubmitting ? 'Saving…' : 'Save value'}
          </button>
        </form>
      </div>
    </div>
  );
}
