'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Copy, Plus, X } from 'lucide-react';
import { buildCatalogueIndex, type CatalogueProduct } from '@/lib/catalogue-entry';
import { addCatalogueEntry, lastIndexOfProduct, type CatalogueEntry } from '@/lib/quote-layout';
import type {
  SectionTemplate,
  SectionTemplateInput,
} from '@/server/domains/quotes/section-template-service';
import {
  archiveSectionTemplateAction,
  duplicateSectionTemplateAction,
  saveSectionTemplateAction,
} from '@/server/domains/quotes/actions';
import { unwrapQuoteAction } from '@/server/domains/quotes/action-result';
import { QuoteLayoutBoard } from './quote-layout/QuoteLayoutBoard';
import { CataloguePicker } from './quote-layout/CataloguePicker';
import { QuickAdd } from './quote-layout/QuickAdd';
import { BulkAddDialog } from './quote-layout/BulkAddDialog';
import { QuantityInput } from './quote-layout/QuantityInput';
import { useModalKeys } from './quote-layout/useModalKeys';

type Item = SectionTemplateInput['lines'][number];
/** The board lays out items by place; a section template has just the one list. */
type BoardItem = Item & { sectionId?: null };

const CURRENCY = 'KES';
const amount = (n: number) =>
  `${CURRENCY} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const field =
  'mt-1 block min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500';

/** The template's category and description in one line, or a placeholder. */
function describe(template: SectionTemplate): string {
  const parts = [template.category, template.description].filter(
    (part): part is string => part !== null && part !== '',
  );
  return parts.length === 0 ? 'No description' : parts.join(' · ');
}

const emptyInput = (): SectionTemplateInput => ({
  name: '',
  category: '',
  description: '',
  sectionTitle: '',
  sectionDescription: '',
  showLines: false,
  lines: [],
});

const inputOf = (template: SectionTemplate): SectionTemplateInput => ({
  name: template.name,
  category: template.category,
  description: template.description,
  sectionTitle: template.sectionTitle,
  sectionDescription: template.sectionDescription,
  showLines: template.showLines,
  lines: template.lines.map((line) => ({
    productId: line.productId ?? '',
    quantity: Number(line.quantity),
    priceMode: line.priceMode as 'catalog' | 'fixed',
    unitPrice: line.unitPrice == null ? null : Number(line.unitPrice),
    discountPercent: Number(line.discountPercent),
  })),
});

/** Reusable sections: a titled group of items a quote can add as a section in one step. */
export function AdminSectionTemplates({
  templates,
  products,
  canCreate,
  canUpdate,
  canDelete,
  onRefresh,
  onMessage,
  onError,
  startWithEditor = false,
  onEditorClose,
}: {
  templates: SectionTemplate[];
  products: CatalogueProduct[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onRefresh: () => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  /** Opens the editor for a new section template at once, as the "create" route does. */
  startWithEditor?: boolean;
  /** Called when the editor closes, saved or not, so a route can return to where it came from. */
  onEditorClose?: (saved: boolean) => void;
}) {
  const [editing, setEditing] = useState<SectionTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(startWithEditor);
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, action: () => Promise<unknown>, message: string) => {
    try {
      setBusyId(id);
      onError('');
      await action();
      onMessage(message);
      onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Section template action failed.');
    } finally {
      setBusyId(null);
    }
  };

  const open = (template: SectionTemplate | null) => {
    setEditing(template);
    setEditorOpen(true);
  };

  return (
    <>
      <section className="rounded-xl border border-line bg-surface-raised">
        <header className="flex flex-col justify-between gap-3 border-b border-line p-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-semibold text-fg-strong">Section templates</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Save a titled group of items once, then add it to any quote as a section. A quote gets
              its own copy, so changing a template later does not change quotes already made.
            </p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => open(null)}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-300"
            >
              <Plus className="h-4 w-4" aria-hidden /> New section template
            </button>
          )}
        </header>

        {templates.length === 0 ? (
          <p className="p-12 text-center text-fg-muted">
            No section templates yet. Create one from a group of items you quote together.
          </p>
        ) : (
          <>
            {/* Phones: cards. md and up: a table. */}
            <ul className="divide-y divide-line md:hidden">
              {templates.map((template) => (
                <li key={template.id} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-fg-strong">{template.name}</p>
                      <p className="text-xs text-fg-muted">
                        Section “{template.sectionTitle}” · {template.lines.length}{' '}
                        {template.lines.length === 1 ? 'item' : 'items'} · used{' '}
                        {template.usageCount}
                      </p>
                    </div>
                    <StatusBadge status={template.status} />
                  </div>
                  <Actions
                    template={template}
                    busy={busyId === template.id}
                    {...{ canCreate, canUpdate, canDelete }}
                    onEdit={() => open(template)}
                    onDuplicate={() =>
                      void run(
                        template.id,
                        () => duplicateSectionTemplateAction(template.id).then(unwrapQuoteAction),
                        `${template.name} duplicated.`,
                      )
                    }
                    onArchive={() =>
                      void run(
                        template.id,
                        () => archiveSectionTemplateAction(template.id).then(unwrapQuoteAction),
                        `${template.name} archived.`,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface text-xs text-fg-muted">
                  <tr>
                    <th className="px-4 py-3">Section template</th>
                    <th className="px-4 py-3">Section title</th>
                    <th className="px-4 py-3 text-right">Items</th>
                    <th className="px-4 py-3 text-right">Used</th>
                    <th className="px-4 py-3">State</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {templates.map((template) => (
                    <tr key={template.id} className="hover:bg-hover/50">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-fg-strong">{template.name}</p>
                        <p className="mt-0.5 text-xs text-fg-muted">{describe(template)}</p>
                      </td>
                      <td className="px-4 py-3 text-fg-muted">{template.sectionTitle}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{template.lines.length}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{template.usageCount}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={template.status} />
                      </td>
                      <td className="px-4 py-3">
                        <Actions
                          template={template}
                          busy={busyId === template.id}
                          {...{ canCreate, canUpdate, canDelete }}
                          onEdit={() => open(template)}
                          onDuplicate={() =>
                            void run(
                              template.id,
                              () =>
                                duplicateSectionTemplateAction(template.id).then(unwrapQuoteAction),
                              `${template.name} duplicated.`,
                            )
                          }
                          onArchive={() =>
                            void run(
                              template.id,
                              () =>
                                archiveSectionTemplateAction(template.id).then(unwrapQuoteAction),
                              `${template.name} archived.`,
                            )
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {editorOpen && (
        <SectionTemplateEditor
          initial={editing ? inputOf(editing) : emptyInput()}
          products={products}
          onClose={() => {
            setEditorOpen(false);
            onEditorClose?.(false);
          }}
          onSave={async (input) => {
            unwrapQuoteAction(await saveSectionTemplateAction(editing?.id ?? null, input));
            setEditorOpen(false);
            onMessage(`${input.name} section template saved.`);
            onRefresh();
            onEditorClose?.(true);
          }}
        />
      )}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-semibold ${status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-sunken text-fg-muted'}`}
    >
      {status === 'active' ? 'Active' : 'Archived'}
    </span>
  );
}

const actionButton =
  'inline-flex min-h-10 items-center gap-1 rounded-md px-3 py-2 text-xs font-medium hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50';

function Actions({
  template,
  busy,
  canCreate,
  canUpdate,
  canDelete,
  onEdit,
  onDuplicate,
  onArchive,
}: {
  template: SectionTemplate;
  busy: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
}) {
  const active = template.status === 'active';
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {active && canUpdate && (
        <button type="button" onClick={onEdit} className={`${actionButton} text-fg`}>
          Edit
        </button>
      )}
      {canCreate && (
        <button
          type="button"
          disabled={busy}
          onClick={onDuplicate}
          className={`${actionButton} text-fg`}
          aria-label={`Duplicate ${template.name}`}
        >
          <Copy className="h-4 w-4" aria-hidden /> Duplicate
        </button>
      )}
      {active && canDelete && (
        <button
          type="button"
          disabled={busy}
          onClick={onArchive}
          className={`${actionButton} text-red-700 hover:bg-red-50`}
          aria-label={`Archive ${template.name}`}
        >
          Archive
        </button>
      )}
    </div>
  );
}

function SectionTemplateEditor({
  initial,
  products,
  onClose,
  onSave,
}: {
  initial: SectionTemplateInput;
  products: CatalogueProduct[];
  onClose: () => void;
  onSave: (input: SectionTemplateInput) => Promise<void>;
}) {
  const uid = useId();
  const dialogRef = useModalKeys<HTMLElement>(onClose);
  const [input, setInput] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [focusLine, setFocusLine] = useState<{ index: number; nonce: number } | null>(null);
  const lastAdded = useRef<{ productId: string } | null>(null);
  const catalogueIndex = useMemo(() => buildCatalogueIndex(products), [products]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const update = <K extends keyof SectionTemplateInput>(key: K, value: SectionTemplateInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));
  const patchLine = (index: number, patch: Partial<Item>) =>
    update(
      'lines',
      input.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  const heldIn = (productId: string) => {
    const here = input.lines.filter((line) => line.productId === productId);
    return here.length === 0 ? null : here.reduce((sum, line) => sum + line.quantity, 0);
  };
  const addEntries = (entries: CatalogueEntry[]) => {
    if (entries.length === 0) return;
    setInput((current) => {
      let lines = current.lines as BoardItem[];
      for (const entry of entries) {
        lines = addCatalogueEntry<BoardItem>(
          lines,
          { ...entry, sectionId: null },
          (e) => ({
            sectionId: null,
            productId: e.productId,
            quantity: e.quantity,
            priceMode: e.unitPrice === null ? 'catalog' : 'fixed',
            unitPrice: e.unitPrice,
            discountPercent: e.discountPercent,
          }),
          (line) => line.priceMode === 'fixed',
        ).lines;
      }
      return { ...current, lines };
    });
    lastAdded.current = { productId: entries[entries.length - 1].productId };
  };
  const showLastAdded = () => {
    const last = lastAdded.current;
    lastAdded.current = null;
    if (!last) return;
    const index = lastIndexOfProduct(input.lines, last.productId, null);
    if (index >= 0) setFocusLine((current) => ({ index, nonce: (current?.nonce ?? 0) + 1 }));
  };

  const submit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await onSave({
        ...input,
        // The title defaults to the name, so a template never makes an untitled section.
        sectionTitle:
          input.sectionTitle.trim() === '' ? input.name.trim() : input.sectionTitle.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this section template.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/70 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="max-h-[94dvh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-line bg-surface-raised p-4 shadow-2xl sm:p-6"
      >
        <header className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 id={`${uid}-title`} className="text-lg font-bold text-fg-strong">
              {initial.name === '' ? 'New section template' : `Edit ${initial.name}`}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Catalog-price items follow the current prices when the section is added to a quote.
              Fixed-price items keep their selling price.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          {error !== null && (
            <p
              className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
              role="alert"
            >
              {error}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-fg">
              Template name
              <input
                required
                value={input.name}
                onChange={(event) => update('name', event.target.value)}
                className={field}
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Category
              <input
                value={input.category ?? ''}
                onChange={(event) => update('category', event.target.value)}
                className={field}
              />
            </label>
            <label className="text-sm font-medium text-fg sm:col-span-2">
              Description
              <input
                value={input.description ?? ''}
                onChange={(event) => update('description', event.target.value)}
                placeholder="What this group of items is for"
                className={field}
              />
            </label>
          </div>

          <fieldset className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2 sm:p-4">
            <legend className="px-1 text-sm font-semibold text-fg-strong">
              The section on a quote
            </legend>
            <label className="text-sm font-medium text-fg">
              Section title
              <input
                value={input.sectionTitle}
                onChange={(event) => update('sectionTitle', event.target.value)}
                placeholder="Defaults to the template name"
                className={field}
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Section description
              <input
                value={input.sectionDescription ?? ''}
                onChange={(event) => update('sectionDescription', event.target.value)}
                className={field}
              />
            </label>
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg sm:col-span-2">
              <input
                type="checkbox"
                className="size-4"
                checked={input.showLines}
                onChange={(event) => update('showLines', event.target.checked)}
              />
              Keep the section expanded on the printout
            </label>
          </fieldset>

          <section className="space-y-3 rounded-xl border border-line p-3 sm:p-4">
            <h3 className="font-semibold text-fg-strong">Items</h3>
            <QuoteLayoutBoard<BoardItem, never>
              noun="template"
              flat
              sections={[]}
              lines={input.lines}
              onChange={(next) => update('lines', next.lines)}
              focusLine={focusLine}
              onBulkAdd={() => {
                lastAdded.current = null;
                setBulkOpen(true);
              }}
              lineSearchText={(line) => {
                const product = productById.get(line.productId);
                return `${product?.name ?? ''} ${product?.sku ?? ''} ${product?.stockCode ?? ''}`;
              }}
              quickAdd={() => (
                <QuickAdd
                  index={catalogueIndex}
                  currency={CURRENCY}
                  destination="the section"
                  countHere={() => input.lines.length}
                  quantityHere={heldIn}
                  onAdd={(entry) => addEntries([{ ...entry, sectionId: null }])}
                />
              )}
              onBrowse={() => {
                lastAdded.current = null;
                setCatalogOpen(true);
              }}
              lineName={(line) => productById.get(line.productId)?.name ?? 'item'}
              minWidth={760}
              columns={6}
              head={
                <>
                  <th className="p-3 text-left">Product</th>
                  <th className="p-3">Qty</th>
                  <th className="p-3">Price source</th>
                  <th className="p-3">Fixed price</th>
                  <th className="p-3">Discount %</th>
                </>
              }
              renderCells={(line, index) => {
                const product = productById.get(line.productId);
                const name = product?.name ?? line.productId;
                return (
                  <>
                    <td className="p-3">
                      <div className="font-medium text-fg-strong">{name}</div>
                      <div className="text-xs text-fg-muted">
                        {product?.sku} · {amount(product?.price ?? 0)}
                      </div>
                    </td>
                    <td className="p-3">
                      <QuantityInput
                        label={`Quantity of ${name}`}
                        value={line.quantity}
                        onChange={(value) => patchLine(index, { quantity: Number(value) })}
                      />
                    </td>
                    <td className="p-3">
                      <select
                        value={line.priceMode}
                        onChange={(event) =>
                          patchLine(index, {
                            priceMode: event.target.value as 'catalog' | 'fixed',
                            unitPrice:
                              event.target.value === 'catalog'
                                ? null
                                : (line.unitPrice ?? product?.price ?? 0),
                          })
                        }
                        className="min-h-9 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                        aria-label={`Price source of ${name}`}
                      >
                        <option value="catalog">Catalog</option>
                        <option value="fixed">Fixed</option>
                      </select>
                    </td>
                    <td className="p-3">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        disabled={line.priceMode !== 'fixed'}
                        value={
                          line.priceMode === 'fixed'
                            ? (line.unitPrice ?? '')
                            : (product?.price ?? '')
                        }
                        onChange={(event) =>
                          patchLine(index, { unitPrice: Number(event.target.value) })
                        }
                        className="min-h-9 w-28 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong disabled:opacity-50"
                        aria-label={`Fixed price of ${name}`}
                      />
                    </td>
                    <td className="p-3">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={line.discountPercent}
                        onChange={(event) =>
                          patchLine(index, { discountPercent: Number(event.target.value) })
                        }
                        className="min-h-9 w-20 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                        aria-label={`Discount percent of ${name}`}
                      />
                    </td>
                    <td className="p-3">
                      <button
                        type="button"
                        onClick={() =>
                          update(
                            'lines',
                            input.lines.filter((_, i) => i !== index),
                          )
                        }
                        className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded text-red-700 hover:bg-red-50"
                        aria-label={`Remove ${name}`}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </td>
                  </>
                );
              }}
            />
          </section>

          <footer className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="min-h-10 rounded-lg border border-line px-4 py-2 text-sm text-fg hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || input.lines.length === 0}
              className="min-h-10 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save section template'}
            </button>
          </footer>
        </form>
      </section>
      {catalogOpen && (
        <CataloguePicker
          title="Browse product catalogue"
          index={catalogueIndex}
          currency={CURRENCY}
          showCost
          destination="the section"
          priceHint="Leave the price empty to follow the catalogue price when the section is added. A price you type is kept as a fixed price."
          quantityHere={heldIn}
          onAdd={(entries) => addEntries(entries.map((entry) => ({ ...entry, sectionId: null })))}
          onClose={() => {
            setCatalogOpen(false);
            showLastAdded();
          }}
        />
      )}
      {bulkOpen && (
        <BulkAddDialog
          noun="template"
          index={catalogueIndex}
          places={[{ id: null, label: 'The section' }]}
          initialSlot={null}
          onAdd={(entries) => {
            addEntries(entries);
            setBulkOpen(false);
            showLastAdded();
          }}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </div>
  );
}
