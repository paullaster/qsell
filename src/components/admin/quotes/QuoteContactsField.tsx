'use client';

import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import type { LabelledSource } from '@/server/domains/email-routing/email-route-service';
import type { RouteSource } from '@/server/domains/email-routing/email-routes';
import { describeQuoteContactsAction } from '@/server/domains/quotes/actions';
import { SourceAdder } from '@/components/admin/settings/email-routing/SourceAdder';

const LISTS = { kinds: 'quote-contact-source-kinds', staff: 'quote-contact-staff', channels: 'quote-contact-channels' };

/**
 * The business emails this quote shows to its customer ("Questions? Contact …"). Left alone, the quote follows the company's setting
 * for its kind of quote (Settings, Email routing); choosing people here gives this quote a list of its own.
 */
export function QuoteContactsField({ value, onChange }: { value: RouteSource[] | null | undefined; onChange: (next: RouteSource[] | null) => void }) {
  const uid = useId();
  const own = value ?? null;
  const [labelled, setLabelled] = useState<LabelledSource[]>([]);
  // The words for what the quote already holds are read from the server, once for each change of the list.
  useEffect(() => {
    let live = true;
    if (own === null || own.length === 0) return;
    void describeQuoteContactsAction(own).then((found) => {
      if (live) setLabelled(found);
    });
    return () => {
      live = false;
    };
  }, [own]);
  // A label is used only while it is for the same person (the list changes under it as people are added and removed).
  const shown = own === null ? [] : own.map((source) => labelled.find((l) => JSON.stringify(l.source) === JSON.stringify(source)) ?? { source, label: '…', address: null, problem: null });
  return (
    <fieldset className="space-y-2 rounded-lg border border-line p-3" data-testid="quote-contacts">
      <legend className="px-1 text-sm font-medium text-fg">Business contacts shown on this quote</legend>
      <p className="text-xs text-fg-muted">{own === null ? 'This quote shows the contacts the company chose for this kind of quote (Settings, Email routing). Add someone to give this quote a list of its own.' : 'This quote shows only the people below.'}</p>
      {shown.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label="Business contacts shown on this quote">
          {shown.map((s, i) => (
            <li key={JSON.stringify(s.source)} className="flex min-h-10 items-center gap-1 rounded-full border border-line bg-surface px-3 text-sm">
              <span className="break-all">{s.label}{s.address !== null && s.address !== s.label ? ` <${s.address}>` : ''}</span>
              <button type="button" className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full hover:bg-hover" aria-label={`Remove ${s.label} from the contacts shown on this quote`} onClick={() => { const rest = (own ?? []).filter((_, n) => n !== i); onChange(rest.length === 0 ? null : rest); }}><X className="size-4" aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      <SourceAdder idBase={uid} title="the contacts shown on this quote" lists={LISTS} onAdd={(next) => { const key = JSON.stringify(next.source); const current = own ?? []; if (!current.some((s) => JSON.stringify(s) === key)) onChange([...current, next.source]); }} />
      {own === null ? null : <button type="button" className="min-h-10 cursor-pointer text-sm font-medium text-fg-muted underline" onClick={() => onChange(null)}>Use the company&apos;s default contacts</button>}
    </fieldset>
  );
}
