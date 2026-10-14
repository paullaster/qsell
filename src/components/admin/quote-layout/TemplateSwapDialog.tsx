'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import type { SwapSummary } from '@/server/domains/quotes/template-swap-service';
import { useModalKeys } from './useModalKeys';

/** What the quote ends up on: the template's name, or none. */
function targetOf(toName: string | null, section: boolean): string {
  if (toName !== null && toName !== '') return `“${toName}”`;
  return section ? 'no section template' : 'no template';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Asks before a quote's template is switched, because the switch replaces items. Nothing is changed
 * until the person confirms, and nothing is saved until they save the quote.
 */
export function TemplateSwapDialog({
  summary,
  scope = 'quote',
  sectionName,
  onConfirm,
  onClose,
}: {
  /** What the server worked out: what would be replaced and what was added by hand. */
  summary: SwapSummary;
  /** `section`: only one section of the quote is switched to another section template. */
  scope?: 'quote' | 'section';
  /** The section being switched, when `scope` is `section`. */
  sectionName?: string;
  onConfirm: (keepAdditions: boolean) => void;
  onClose: () => void;
}) {
  const uid = useId();
  const dialogRef = useModalKeys<HTMLElement>(onClose);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [keep, setKeep] = useState(true);
  const titleId = `${uid}-title`;
  const section = scope === 'section';
  const { toName, fromName, kind, additions, edited } = summary;
  const target = targetOf(toName, section);
  const named = toName !== null && toName !== '';
  const headline = section
    ? `Switch section${sectionName !== undefined && sectionName !== '' ? ` “${sectionName}”` : ''} to ${target}?`
    : `Switch to ${target}?`;
  const addedCount = additions.items.length + additions.sections.length;

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-backdrop/70 p-2 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[96dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-line p-3 sm:p-4">
          <h2 id={titleId} className="flex items-center gap-2 font-semibold text-fg-strong">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden />
            {headline}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm text-fg sm:p-4">
          {kind === 'manual' ? (
            <p>
              {section
                ? 'This section was not made from a section template.'
                : 'This quote was not built from a template.'}{' '}
              Switching replaces its{' '}
              <strong>
                {plural(summary.replacedLines, 'item')}
                {summary.replacedSections > 0
                  ? ` and ${plural(summary.replacedSections, 'section')}`
                  : ''}
              </strong>{' '}
              with what is in {target}
              {section
                ? ', and takes the section’s title and description from it. The rest of the quote stays as it is.'
                : ', and sets the quote’s payment terms, notes, discount and shipping from it. The customer and addresses stay as they are.'}
            </p>
          ) : (
            <p>
              {fromName !== null && fromName !== ''
                ? `The items${section ? '' : ' and sections'} that came from “${fromName}”`
                : 'The template items'}{' '}
              (<strong>{plural(summary.replacedLines, 'item')}</strong>
              {summary.replacedSections > 0
                ? `, ${plural(summary.replacedSections, 'section')}`
                : ''}
              ) are replaced with {named ? `what is in ${target}` : 'nothing'}.{' '}
              {section
                ? 'The section’s title and description change only where you had not edited them. The rest of the quote stays as it is.'
                : 'Payment terms, notes, discount and shipping change only where you had not edited them. The customer and addresses stay as they are.'}
            </p>
          )}

          {edited.length > 0 && (
            <div>
              <p className="font-medium text-fg-strong">
                {plural(edited.length, 'item')} you changed will be replaced too:
              </p>
              <ul className="mt-1 list-inside list-disc text-fg-muted">
                {edited.map((item) => (
                  <li key={item.key}>{item.name}</li>
                ))}
              </ul>
            </div>
          )}

          {kind === 'additions' && (
            <fieldset className="space-y-2 rounded-lg border border-line p-3">
              <legend className="px-1 font-medium text-fg-strong">
                You added {plural(addedCount, 'thing')} that {addedCount === 1 ? 'is' : 'are'} not
                in the {section ? 'section ' : ''}template
              </legend>
              <ul className="list-inside list-disc text-fg-muted">
                {additions.items.map((item) => (
                  <li key={item.key}>{item.name}</li>
                ))}
                {additions.sections.map((row) => (
                  <li key={row.key}>
                    Section: {row.title} ({plural(row.items, 'item')})
                  </li>
                ))}
              </ul>
              <label className="flex min-h-10 cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name={`${uid}-keep`}
                  checked={keep}
                  onChange={() => setKeep(true)}
                  className="h-4 w-4"
                />
                Keep them on the quote
              </label>
              <label className="flex min-h-10 cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name={`${uid}-keep`}
                  checked={!keep}
                  onChange={() => setKeep(false)}
                  className="h-4 w-4"
                />
                Remove them
              </label>
            </fieldset>
          )}

          <p className="text-xs text-fg-muted">
            Nothing is saved until you save the quote. Items are priced again for this customer.
          </p>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-line p-3 sm:flex-row sm:justify-end sm:p-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onConfirm(kind === 'additions' ? keep : false)}
            className="min-h-10 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          >
            Switch template
          </button>
        </footer>
      </section>
    </div>
  );
}
