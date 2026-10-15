'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { applyTemplateAction } from '@/server/domains/finance/actions';
import { Message, cardClass, fieldClass, primaryClass, type Notice, Field, attempt } from './ui';

export interface TemplateOption {
  code: string;
  name: string;
  description: string;
  baseCurrency: string;
  accounts: number;
}

/** Shown on every finance screen until a chart of accounts has been imported. */
export function FinanceSetupCard({ templates, canApply }: { templates: TemplateOption[]; canApply: boolean }) {
  const uid = useId();
  const router = useRouter();
  const [code, setCode] = useState(templates.find((t) => t.code === 'kenya')?.code ?? templates[0]?.code ?? '');
  const [start, setStart] = useState(`${new Date().getUTCFullYear()}-01-01`);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(applyTemplateAction(code, start));
    setBusy(false);
    if (!res.ok) { setNotice({ kind: 'error', text: res.error }); return; }
    setNotice({ kind: 'ok', text: `Imported ${res.data.accounts} accounts. Base currency: ${res.data.baseCurrency}.` });
    router.refresh();
  };

  return (
    <form onSubmit={apply} className={`${cardClass} max-w-3xl space-y-4`} aria-label="Set up finance">
      <div>
        <h2 className="text-lg font-bold text-fg-strong">Set up your books</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Choose a chart of accounts to start from. It is imported once and then belongs to your company:
          every account, group and setting can be changed afterwards. A qualified accountant for your
          market should review it before you go live.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-fg">Starting chart</legend>
        {templates.map((t) => (
          <label
            key={t.code}
            className={`flex min-h-10 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              code === t.code ? 'border-indigo-500 bg-indigo-600/15' : 'border-line-strong bg-surface-sunken/60'
            }`}
          >
            <input type="radio" name={`${uid}-tpl`} checked={code === t.code} onChange={() => setCode(t.code)} className="mt-1" />
            <span>
              <span className="block text-sm font-semibold text-fg-strong">
                {t.name} <span className="font-normal text-fg-muted">· {t.accounts} accounts · {t.baseCurrency}</span>
              </span>
              <span className="block text-xs text-fg-muted">{t.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="max-w-xs">
        <Field id={`${uid}-start`} label="First fiscal year starts on" hint="Twelve monthly periods are created; other shapes can be added later.">
          <input id={`${uid}-start`} type="date" value={start} onChange={(e) => setStart(e.target.value)} className={fieldClass} required />
        </Field>
      </div>
      <Message notice={notice} />
      {canApply ? (
        <button type="submit" disabled={busy || code === ''} className={primaryClass}>
          {busy ? 'Importing…' : 'Import this chart'}
        </button>
      ) : (
        <p className="text-sm text-fg-muted">You do not have permission to apply a chart template. Ask someone who does.</p>
      )}
    </form>
  );
}
