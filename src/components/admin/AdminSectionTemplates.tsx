'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Copy, Plus, X } from 'lucide-react';
import { buildCatalogueIndex, type CatalogueProduct } from '@/lib/catalogue-entry';
import { addCatalogueEntry, lastIndexOfProduct, type CatalogueEntry } from '@/lib/quote-layout';
import type {
  SectionTemplate,
  SectionTemplateInput,
  SectionTemplateListRow,
} from '@/server/domains/quotes/section-template-service';
import { usePagedList, type PageResult } from '@/components/ui/usePagedList';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import type { TemplateStatusFilter } from '@/lib/template-statuses';
import { ListFilters, ListFooter } from './quote-templates/ListControls';
import {
  archiveSectionTemplateAction,
  duplicateSectionTemplateAction,
  getSectionTemplateAction,
  listSectionTemplatesPageAction,
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

/** How an item in a section template is priced. */
const PRICE_SOURCES = [
  { value: 'catalog', label: 'Catalog' },
  { value: 'fixed', label: 'Fixed' },
] as const;

const CURRENCY = 'KES';
const amount = (n: number) =>
  `${CURRENCY} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const field =
  'mt-1 block min-h-10 w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong focus-visible:outline-2 focus-visible:outline-indigo-500';

/** The template's category and description in one line, or a placeholder. */
function describe(template: { category: string | null; description: string | null }): string {
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
  products,
  canCreate,
  canUpdate,
  canDelete,
  onMessage,
  onError,
  startWithEditor = false,
  onEditorClose,
  initialPage,
}: {
  products: CatalogueProduct[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  /** Opens the editor for a new section template at once, as the "create" route does. */
  startWithEditor?: boolean;
  /** Called when the editor closes, saved or not, so a route can return to where it came from. */
  onEditorClose?: (saved: boolean) => void;
  /** The first page, when the server sent it with the screen. */
  initialPage?: PageResult<SectionTemplateListRow>;
}) {
  const [filters, setFilters] = useState<{ query: string; status: TemplateStatusFilter }>({
    query: '',
    status: 'all',
  });
  const list = usePagedList<SectionTemplateListRow, typeof filters>({
    load: (current, cursor) => listSectionTemplatesPageAction({ ...current, cursor }),
    filters,
    initialPage,
  });
  const [editing, setEditing] = useState<SectionTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(startWithEditor);
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, action: () => Promise<unknown>, message: string) => {
    try {
      setBusyId(id);
      onError('');
      await action();
      onMessage(message);
      list.reload();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Section template action failed.');
    } finally {
      setBusyId(null);
    }
  };

  /** Opens a template's editor: the list holds summaries, so the full template is fetched now. */
  const openEditor = async (row: SectionTemplateListRow) => {
    try {
      setBusyId(row.id);
      onError('');
      setEditing(unwrapQuoteAction(await getSectionTemplateAction(row.id)));
      setEditorOpen(true);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not open that template.');
    } finally {
      setBusyId(null);
    }
  };

  const rowActions = (template: SectionTemplateListRow) => (
    <Actions
      template={template}
      busy={busyId === template.id}
      {...{ canCreate, canUpdate, canDelete }}
      onEdit={() => void openEditor(template)}
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
  );

  const filtered = filters.query !== '' || filters.status !== 'all';
  const empty = filtered
    ? 'No section templates match those filters.'
    : 'No section templates yet. Create one from a group of items you quote together.';

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
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-300"
            >
              <Plus className="h-4 w-4" aria-hidden /> New section template
            </button>
          )}
        </header>
        <ListFilters noun="section templates" onChange={setFilters} />

        {list.rows.length === 0 ? (
          <p className="p-12 text-center text-fg-muted">
            {list.phase === 'loading' ? 'Loading…' : empty}
          </p>
        ) : (
          <div className={list.phase === 'loading' ? 'opacity-60' : ''}>
            {/* Phones: cards. md and up: a table. */}
            <ul className="divide-y divide-line md:hidden">
              {list.rows.map((template) => (
                <li key={template.id} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-fg-strong">{template.name}</p>
                      <p className="text-xs text-fg-muted">
                        Section “{template.sectionTitle}” · {template.lineCount}{' '}
                        {template.lineCount === 1 ? 'item' : 'items'} · used {template.usageCount}
                      </p>
                    </div>
                    <StatusBadge status={template.status} />
                  </div>
                  {rowActions(template)}
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
                  {list.rows.map((template) => (
                    <tr key={template.id} className="hover:bg-hover/50">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-fg-strong">{template.name}</p>
                        <p className="mt-0.5 text-xs text-fg-muted">{describe(template)}</p>
                      </td>
                      <td className="px-4 py-3 text-fg-muted">{template.sectionTitle}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{template.lineCount}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{template.usageCount}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={template.status} />
                      </td>
                      <td className="px-4 py-3">{rowActions(template)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <ListFooter
          shown={list.rows.length}
          noun="section templates"
          hasMore={list.cursor !== null}
          loadingMore={list.phase === 'more'}
          error={list.error}
          onLoadMore={list.loadMore}
          onRetry={list.retry}
        />
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
            list.reload();
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
  template: SectionTemplateListRow;
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
        <button
          type="button"
          disabled={busy}
          onClick={onEdit}
          className={`${actionButton} text-fg`}
        >
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
    const unpriced = input.lines.findIndex(
      (line) => line.priceMode === 'fixed' && line.unitPrice === null,
    );
    if (unpriced >= 0) {
      const name = productById.get(input.lines[unpriced].productId)?.name ?? 'An item';
      setError(
        `${name} is set to a fixed price but has none. Type its price or use the catalog price.`,
      );
      return;
    }
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
                        {product?.sku} ·{' '}
                        {product?.price == null ? 'Price list' : amount(product.price)}
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
                      <SegmentedChoice
                        label={`Price source of ${name}`}
                        hideLabel
                        value={line.priceMode}
                        options={PRICE_SOURCES}
                        onChange={(mode) =>
                          patchLine(index, {
                            priceMode: mode,
                            unitPrice:
                              mode === 'catalog'
                                ? null
                                : (line.unitPrice ?? product?.price ?? null),
                          })
                        }
                      />
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
                          patchLine(index, {
                            unitPrice:
                              event.target.value === '' ? null : Number(event.target.value),
                          })
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
