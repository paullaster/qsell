'use client';

import { use, useId, useMemo, useState } from 'react';
import { Save, Tags } from 'lucide-react';
import { type companyModulesAction, saveCompanyModulesAction } from '@/server/domains/company/actions';
import { attempt, LoadFailed, Message, primaryClass, Field, fieldClass, type Notice } from '@/components/ui/screen-kit';
import { getAdminNav } from '@/config/admin-nav';
import { flattenModuleLabelOptions } from '@/config/company-ui';
import { MODULE_LABEL_MAX } from '@/lib/company-forms';
import { Section } from './fields';

export function CompanyModulesClient({ labelsPromise }: { labelsPromise: ReturnType<typeof companyModulesAction> }) {
  const loaded = use(labelsPromise);
  if (!loaded.ok) return <LoadFailed error={loaded.error} />;
  return <ModulesScreen initial={loaded.data} />;
}

function ModuleRow({ id, title, href, depth, value, onChange }: { id: string; title: string; href: string; depth: number; value: string; onChange: (value: string) => void }) {
  const inputId = useId();
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" style={{ paddingLeft: `${String(depth * 12)}px` }}>
      <div className="min-w-0">
        <p className="truncate text-sm text-fg-strong">{title}</p>
        <p className="truncate font-mono text-[10px] text-fg-muted">
          {id} · {href}
        </p>
      </div>
      <Field id={inputId} label={`Name for ${title}`}>
        <input id={inputId} className={fieldClass} placeholder={title} maxLength={MODULE_LABEL_MAX} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
      </Field>
    </div>
  );
}

function ModulesScreen({ initial }: { initial: Record<string, string> }) {
  const modules = useMemo(() => flattenModuleLabelOptions(getAdminNav()), []);
  const [labels, setLabels] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await attempt(saveCompanyModulesAction(labels));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setLabels(res.data);
    setNotice({ kind: 'ok', text: 'Module names saved.' });
  };

  return (
    <form onSubmit={(e) => void save(e)} noValidate aria-label="Module names" className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
            <Tags className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            Module names
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">Override sidebar and page titles. The addresses stay the same; only the names change.</p>
        </div>
        <button type="submit" disabled={busy} className={`${primaryClass} gap-2`}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Saving…' : 'Save names'}
        </button>
      </div>
      <Message notice={notice} />
      <Section title="Module display names" icon={<Tags className="h-4 w-4 text-indigo-600" aria-hidden="true" />}>
        <p className="text-xs text-fg-muted">Leave a box empty to keep the built-in name.</p>
        <div className="space-y-3">
          {modules.map((mod) => (
            <ModuleRow
              key={mod.id}
              id={mod.id}
              title={mod.defaultTitle}
              href={mod.href}
              depth={mod.depth}
              value={labels[mod.id] ?? ''}
              onChange={(value) => setLabels((prev) => ({ ...prev, [mod.id]: value }))}
            />
          ))}
        </div>
      </Section>
    </form>
  );
}
