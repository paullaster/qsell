'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useCustomerCreated } from '@/components/admin/customer-created';
import { Copy, Plus, Star, X } from 'lucide-react';
import { buildCatalogueIndex, type CatalogueProduct } from '@/lib/catalogue-entry';
import { QuoteLayoutBoard } from './quote-layout/QuoteLayoutBoard';
import { CataloguePicker } from './quote-layout/CataloguePicker';
import { QuickAdd } from './quote-layout/QuickAdd';
import { BulkAddDialog } from './quote-layout/BulkAddDialog';
import { QuantityInput } from './quote-layout/QuantityInput';
import { addCatalogueEntry, lastIndexOfProduct, type CatalogueEntry } from '@/lib/quote-layout';
import type {
  QuoteSearchHit,
  QuoteTemplateInput,
  SalesQuoteTemplate,
  TemplateListRow,
} from '@/server/domains/quotes/service';
import { usePagedList, type PageResult } from '@/components/ui/usePagedList';
import { LookupAutocomplete } from '@/components/ui/autocomplete/LookupAutocomplete';
import { SegmentedChoice } from '@/components/ui/SegmentedChoice';
import type { LookupOption } from '@/lib/lookup';
import { methodLabel } from '@/lib/payment-method-labels';
import { chooseTemplateCustomerAction } from '@/server/domains/quotes/form-actions';
import type { TemplateStatusFilter } from '@/lib/template-statuses';
import { unwrapQuoteAction } from '@/server/domains/quotes/action-result';
import { ListFilters, ListFooter } from './quote-templates/ListControls';
import type { TemplateDraft } from '@/server/domains/quotes/template-from-quote';
import {
  archiveSalesQuoteTemplateAction,
  duplicateSalesQuoteTemplateAction,
  getSalesQuoteTemplateAction,
  listSalesQuoteTemplatesPageAction,
  saveSalesQuoteTemplateAction,
  setDefaultSalesQuoteTemplateAction,
  templateDraftFromQuoteAction,
} from '@/server/domains/quotes/actions';
import { QuoteSearchPicker } from './QuoteSearchPicker';

type TemplateLine = QuoteTemplateInput['lines'][number];

/** How an item in a template is priced. */
const PRICE_SOURCES = [
  { value: 'catalog', label: 'Catalog' },
  { value: 'fixed', label: 'Fixed' },
] as const;

const amount = (n: number, currency: string) =>
  `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function emptyTemplate(): QuoteTemplateInput {
  return {
    name: '',
    category: '',
    description: '',
    currency: 'KES',
    paymentMethod: 'mpesa_daraja',
    paymentTerms: '',
    paymentDetails: '',
    termsAndConditions: '',
    showBillingAddress: false,
    validityDays: 30,
    quoteDiscountPercent: 0,
    shippingFee: 0,
    billingAddress: {},
    deliveryAddress: {},
    publicNotes: '',
    internalNotes: '',
    tags: [],
    isDefault: false,
    sections: [],
    lines: [],
  };
}

function templateInput(template: SalesQuoteTemplate): QuoteTemplateInput {
  const sectionIdMap = new Map(
    template.sections.map((section) => [section.id, crypto.randomUUID()]),
  );
  return {
    name: template.name,
    category: template.category,
    description: template.description,
    customerId: template.customerId,
    customerName: template.customerName,
    currency: template.currency,
    paymentMethod: template.paymentMethod as QuoteTemplateInput['paymentMethod'],
    paymentTerms: template.paymentTerms,
    paymentDetails: template.paymentDetails,
    termsAndConditions: template.termsAndConditions,
    validityDays: template.validityDays,
    quoteDiscountPercent: Number(template.quoteDiscountPercent),
    shippingFee: Number(template.shippingFee),
    billingAddress: template.billingAddress,
    deliveryAddress: template.deliveryAddress,
    publicNotes: template.publicNotes,
    internalNotes: template.internalNotes,
    tags: template.tags,
    isDefault: template.isDefault,
    showBillingAddress: template.showBillingAddress,
    sections: template.sections.map((section) => ({
      id: sectionIdMap.get(section.id) ?? section.id,
      title: section.title,
      description: section.description,
      showLines: section.showLines,
    })),
    lines: template.lines.map((line) => ({
      sectionId: line.sectionId === null ? null : (sectionIdMap.get(line.sectionId) ?? null),
      productId: line.productId ?? '',
      quantity: Number(line.quantity),
      priceMode: line.priceMode as 'catalog' | 'fixed',
      unitPrice: line.unitPrice == null ? null : Number(line.unitPrice),
      discountPercent: Number(line.discountPercent),
    })),
  };
}

export function AdminSalesQuoteTemplates({
  products,
  canCreate,
  canUpdate,
  canDelete,
  onMessage,
  onError,
  fromQuote = null,
  onFromQuoteHandled,
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
  /** A quote someone chose to make a template from, on a quote screen: the editor opens on it. */
  fromQuote?: QuoteSearchHit | null;
  onFromQuoteHandled?: () => void;
  /** Opens the editor for a new template at once, as the "create" route does. */
  startWithEditor?: boolean;
  /** Called when the editor closes, saved or not, so a route can return to where it came from. */
  onEditorClose?: (saved: boolean) => void;
  /** The first page, when the server sent it with the screen. */
  initialPage?: PageResult<TemplateListRow>;
}) {
  const [filters, setFilters] = useState<{ query: string; status: TemplateStatusFilter }>({
    query: '',
    status: 'all',
  });
  const list = usePagedList<TemplateListRow, typeof filters>({
    load: (current, cursor) => listSalesQuoteTemplatesPageAction({ ...current, cursor }),
    filters,
    initialPage,
  });
  const [editing, setEditing] = useState<SalesQuoteTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(startWithEditor);
  const [base, setBase] = useState<TemplateBase | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!fromQuote) return;
    let live = true;
    void templateDraftFromQuoteAction(fromQuote.id, false)
      .then((draft) => {
        if (!live) return;
        setEditing(null);
        setBase({ hit: fromQuote, draft, keepCustomer: false });
        setEditorOpen(true);
        onFromQuoteHandled?.();
      })
      .catch((error: unknown) => {
        if (!live) return;
        onError(
          error instanceof Error ? error.message : 'Could not start a template from that quote.',
        );
        onFromQuoteHandled?.();
      });
    return () => {
      live = false;
    };
    // Only a different quote starts it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromQuote?.id]);

  const runTemplateAction = async (id: string, action: () => Promise<unknown>, message: string) => {
    try {
      setBusyId(id);
      onError('');
      await action();
      onMessage(message);
      list.reload();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Template action failed.');
    } finally {
      setBusyId(null);
    }
  };

  /** Opens a template's editor: the list holds summaries, so the full template is fetched now. */
  const openEditor = async (row: TemplateListRow) => {
    try {
      setBusyId(row.id);
      onError('');
      setEditing(unwrapQuoteAction(await getSalesQuoteTemplateAction(row.id)));
      setEditorOpen(true);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not open that template.');
    } finally {
      setBusyId(null);
    }
  };

  const filtered = filters.query !== '' || filters.status !== 'all';
  const emptyText = emptyListText(list.phase === 'loading', filtered);

  return (
    <>
      <section className="rounded-xl border border-line bg-surface-raised">
        <header className="flex flex-col justify-between gap-3 border-b border-line p-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-semibold text-fg-strong">Quote templates</h2>
            <p className="mt-1 text-xs text-fg-muted">
              Save reusable item bundles and business defaults. Catalog prices and costs refresh
              when a template is used unless a line is fixed-price.
            </p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setBase(null);
                setEditorOpen(true);
              }}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-300"
            >
              <Plus className="h-4 w-4" aria-hidden /> New template
            </button>
          )}
        </header>
        <ListFilters noun="templates" onChange={setFilters} />
        <div className={`overflow-x-auto ${list.phase === 'loading' ? 'opacity-60' : ''}`}>
          <table
            className="w-full min-w-[800px] text-left text-sm"
            aria-busy={list.phase === 'loading'}
          >
            <thead className="bg-surface text-xs text-fg-muted">
              <tr>
                <th className="px-4 py-3">Template</th>
                <th className="px-4 py-3">Default customer</th>
                <th className="px-4 py-3 text-right">Items</th>
                <th className="px-4 py-3 text-right">Used</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-12 text-center text-fg-muted">
                    {emptyText}
                  </td>
                </tr>
              ) : (
                list.rows.map((template) => (
                  <tr key={template.id} className="hover:bg-hover/50">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => void openEditor(template)}
                        className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300"
                      >
                        {template.name}
                      </button>
                      <p className="mt-0.5 text-xs text-fg-muted">{describeTemplate(template)}</p>
                      {template.tags.length > 0 && (
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          {template.tags.join(' · ')}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {template.customerName ?? 'Any customer'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{template.lineCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{template.usageCount}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${template.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-sunken text-fg-muted'}`}
                      >
                        {template.isDefault && (
                          <Star className="h-3 w-3 fill-current" aria-hidden />
                        )}
                        {templateStateLabel(template)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {template.status === 'active' && canUpdate && !template.isDefault && (
                          <button
                            type="button"
                            disabled={busyId === template.id}
                            onClick={() =>
                              void runTemplateAction(
                                template.id,
                                () => setDefaultSalesQuoteTemplateAction(template.id),
                                `${template.name} is now the default.`,
                              )
                            }
                            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-amber-700 hover:bg-amber-50"
                            title="Set as default"
                            aria-label={`Make ${template.name} the default`}
                          >
                            <Star className="h-4 w-4" aria-hidden />
                          </button>
                        )}
                        {canCreate && (
                          <button
                            type="button"
                            disabled={busyId === template.id}
                            onClick={() =>
                              void runTemplateAction(
                                template.id,
                                () => duplicateSalesQuoteTemplateAction(template.id),
                                `${template.name} duplicated.`,
                              )
                            }
                            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg-strong"
                            title="Duplicate template"
                            aria-label={`Duplicate ${template.name}`}
                          >
                            <Copy className="h-4 w-4" aria-hidden />
                          </button>
                        )}
                        {template.status === 'active' && canUpdate && (
                          <button
                            type="button"
                            disabled={busyId === template.id}
                            onClick={() => void openEditor(template)}
                            className="min-h-10 rounded-md px-2 text-xs text-fg-muted hover:bg-hover"
                          >
                            Edit
                          </button>
                        )}
                        {template.status === 'active' && canDelete && (
                          <button
                            type="button"
                            disabled={busyId === template.id}
                            onClick={() =>
                              void runTemplateAction(
                                template.id,
                                () => archiveSalesQuoteTemplateAction(template.id),
                                `${template.name} archived.`,
                              )
                            }
                            className="min-h-10 rounded-md px-2 text-xs text-red-700 hover:bg-red-50"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <ListFooter
          shown={list.rows.length}
          noun="templates"
          hasMore={list.cursor !== null}
          loadingMore={list.phase === 'more'}
          error={list.error}
          onLoadMore={list.loadMore}
          onRetry={list.retry}
        />
      </section>

      {editorOpen && (
        <TemplateEditor
          initial={editing ? templateInput(editing) : (base?.draft.input ?? emptyTemplate())}
          base={editing ? null : base}
          canBase={!editing}
          products={products}
          onClose={() => {
            setEditorOpen(false);
            setBase(null);
            onEditorClose?.(false);
          }}
          onSave={async (input) => {
            await saveSalesQuoteTemplateAction(editing?.id ?? null, input);
            setEditorOpen(false);
            setBase(null);
            onMessage(`${input.name} template saved.`);
            list.reload();
            onEditorClose?.(true);
          }}
        />
      )}
    </>
  );
}

/** What the empty table says: loading, nothing matched the filters, or nothing exists yet. */
function emptyListText(loading: boolean, filtered: boolean): string {
  if (loading) return 'Loading…';
  if (filtered) return 'No templates match those filters.';
  return 'No templates yet. Create one from your common quote bundles and terms.';
}

/** A template's category and description in one line, or a placeholder. */
function describeTemplate(template: TemplateListRow): string {
  const parts = [template.category, template.description].filter(
    (part): part is string => part !== null && part !== '',
  );
  return parts.length === 0 ? 'No description' : parts.join(' · ');
}

/** The state shown on a row: Default, Active or Archived. */
function templateStateLabel(template: TemplateListRow): string {
  if (template.status !== 'active') return 'Archived';
  return template.isDefault ? 'Default' : 'Active';
}

/** The quote a template is being based on, and what making a template from it found. */
interface TemplateBase {
  hit: QuoteSearchHit;
  draft: TemplateDraft;
  keepCustomer: boolean;
}

function TemplateEditor({
  initial,
  base: initialBase,
  canBase,
  products,
  onClose,
  onSave,
}: {
  initial: QuoteTemplateInput;
  base: TemplateBase | null;
  /** Only a new template can be based on a quote. */
  canBase: boolean;
  products: CatalogueProduct[];
  onClose: () => void;
  onSave: (input: QuoteTemplateInput) => Promise<void>;
}) {
  const [input, setInput] = useState(initial);
  const [tagsText, setTagsText] = useState(initial.tags.join(', '));
  const [customerLabel, setCustomerLabel] = useState<string | null>(initial.customerName ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogSectionId, setCatalogSectionId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalogueIndex = useMemo(() => buildCatalogueIndex(products), [products]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const lastAdded = useRef<{ productId: string; sectionId: string | null } | null>(null);
  const [focusLine, setFocusLine] = useState<{ index: number; nonce: number } | null>(null);
  const [startFrom, setStartFrom] = useState<'blank' | 'quote'>(initialBase ? 'quote' : 'blank');
  const [base, setBase] = useState<TemplateBase | null>(initialBase);
  /** A quote just chosen, waiting for a yes before it replaces items already added. */
  const [pending, setPending] = useState<TemplateBase | null>(null);
  const [baseBusy, setBaseBusy] = useState(false);
  const [baseError, setBaseError] = useState<string | null>(null);

  /** Fills the editor from a quote. What was typed as the name stays. */
  const applyDraft = (next: TemplateBase) => {
    setBase(next);
    setPending(null);
    setInput((current) => ({
      ...next.draft.input,
      name:
        current.name.trim() !== '' && current.name !== base?.draft.input.name
          ? current.name
          : next.draft.input.name,
    }));
    setTagsText('');
  };
  const chooseQuote = async (hit: QuoteSearchHit, keepCustomer: boolean) => {
    try {
      setBaseBusy(true);
      setBaseError(null);
      const draft = await templateDraftFromQuoteAction(hit.id, keepCustomer);
      const next = { hit, draft, keepCustomer };
      // Items already added are not lost without asking.
      if (!base && input.lines.length > 0) setPending(next);
      else applyDraft(next);
    } catch (err) {
      setBaseError(err instanceof Error ? err.message : 'Could not read that quote.');
    } finally {
      setBaseBusy(false);
    }
  };
  const update = <K extends keyof QuoteTemplateInput>(key: K, value: QuoteTemplateInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));
  /** Adds items in one change, merging into lines that already hold the same item. */
  const addEntries = (entries: CatalogueEntry[]) => {
    if (entries.length === 0) return;
    setInput((current) => {
      let lines = current.lines;
      for (const entry of entries) {
        lines = addCatalogueEntry<TemplateLine>(
          lines,
          entry,
          (e) => ({
            sectionId: e.sectionId,
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
    const last = entries[entries.length - 1];
    lastAdded.current = { productId: last.productId, sectionId: last.sectionId };
  };
  /** After the catalogue closes, takes the person to the last item they added. */
  const showLastAdded = () => {
    const last = lastAdded.current;
    lastAdded.current = null;
    if (!last) return;
    const index = lastIndexOfProduct(input.lines, last.productId, last.sectionId);
    if (index >= 0) setFocusLine((current) => ({ index, nonce: (current?.nonce ?? 0) + 1 }));
  };
  /** How much of a product a place already holds, or null. */
  const heldIn = (productId: string, slot: string | null) => {
    const here = input.lines.filter(
      (line) => line.productId === productId && (line.sectionId ?? null) === slot,
    );
    return here.length === 0 ? null : here.reduce((sum, line) => sum + line.quantity, 0);
  };
  const placeName = (slot: string | null) =>
    slot === null
      ? 'the individual items'
      : `section ${input.sections.find((x) => x.id === slot)?.title ?? ''}`.trim();
  const patchLine = (index: number, patch: Partial<QuoteTemplateInput['lines'][number]>) =>
    update(
      'lines',
      input.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  /** The server fills the template's defaults from the customer chosen (or clears them). */
  const chooseCustomer = async (option: LookupOption | null) => {
    try {
      setError(null);
      const result = await chooseTemplateCustomerAction(input, option === null ? null : option.id);
      if (!result.ok) throw new Error(result.error);
      setInput(result.data);
      setCustomerLabel(option === null ? null : option.label);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not choose that customer.');
    }
  };
  useCustomerCreated((created) => void chooseCustomer({ id: created.id, label: created.label }));
  const submit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await onSave({
        ...input,
        tags: tagsText
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this template.');
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
        role="dialog"
        aria-modal="true"
        aria-label="Quote template editor"
        className="max-h-[94dvh] w-full max-w-6xl overflow-y-auto rounded-2xl border border-line bg-surface-raised p-4 shadow-2xl sm:p-6"
      >
        <header className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-fg-strong">
              {initial.name === '' ? 'New quote template' : `Edit ${initial.name}`}
            </h2>
            <p className="mt-1 text-xs text-fg-muted">
              Catalog-price lines refresh from current prices and costs each time you use the
              template. Fixed-price lines keep their selling price; cost always refreshes for margin
              approval.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-fg-muted hover:bg-hover"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
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
          {canBase && (
            <fieldset className="space-y-3 rounded-xl border border-line p-3 sm:p-4">
              <legend className="px-1 text-sm font-semibold text-fg-strong">Start from</legend>
              <div className="flex flex-wrap gap-4">
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                  <input
                    type="radio"
                    name="template-start"
                    className="size-4"
                    checked={startFrom === 'blank'}
                    onChange={() => setStartFrom('blank')}
                  />
                  A blank template
                </label>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                  <input
                    type="radio"
                    name="template-start"
                    className="size-4"
                    checked={startFrom === 'quote'}
                    onChange={() => setStartFrom('quote')}
                  />
                  An existing quote (any status)
                </label>
              </div>
              {startFrom === 'quote' && (
                <div className="space-y-3">
                  <QuoteSearchPicker
                    value={base?.hit ?? null}
                    onSelect={(hit) => void chooseQuote(hit, base?.keepCustomer ?? false)}
                    onClear={() => {
                      setBase(null);
                      setPending(null);
                    }}
                    label="Quote to make a template from"
                  />
                  {baseBusy && (
                    <p role="status" className="text-sm text-fg-muted">
                      Reading the quote…
                    </p>
                  )}
                  {baseError !== null && (
                    <p role="alert" className="text-sm text-red-700">
                      {baseError}
                    </p>
                  )}
                  {pending && (
                    <div
                      role="alert"
                      className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                    >
                      <p>
                        Replace the items already in this template with the ones from{' '}
                        <strong>{pending.hit.quoteNumber}</strong>?
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => applyDraft(pending)}
                          className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white hover:bg-indigo-500"
                        >
                          Replace them
                        </button>
                        <button
                          type="button"
                          onClick={() => setPending(null)}
                          className="min-h-10 cursor-pointer rounded-lg border border-line bg-surface px-3 text-sm text-fg hover:bg-hover"
                        >
                          Keep what I have
                        </button>
                      </div>
                    </div>
                  )}
                  {base && !pending && (
                    <div className="space-y-2" role="status">
                      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={base.keepCustomer}
                          disabled={baseBusy}
                          onChange={(e) => void chooseQuote(base.hit, e.target.checked)}
                        />
                        Keep the quote&apos;s customer and addresses
                      </label>
                      <p className="text-xs text-fg-muted">
                        Made from {base.draft.quoteNumber}: {input.lines.length} item
                        {input.lines.length === 1 ? '' : 's'} in {input.sections.length} section
                        {input.sections.length === 1 ? '' : 's'}, kept in the same order. Prices
                        from the price lists stay catalog prices, so the template follows
                        today&apos;s prices; typed prices stay fixed. Review and change anything
                        below, then save.
                      </p>
                      {base.draft.gifts > 0 && (
                        <p className="text-xs text-fg-muted">
                          {base.draft.gifts} free gift{base.draft.gifts === 1 ? '' : 's'} on the
                          quote {base.draft.gifts === 1 ? 'was' : 'were'} not copied: they are
                          worked out again for each new quote.
                        </p>
                      )}
                      {base.draft.skipped.length > 0 && (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                          <p className="font-semibold">Left out of the template:</p>
                          <ul className="list-disc pl-5">
                            {base.draft.skipped.map((x) => (
                              <li key={`${x.name}:${x.reason}`}>
                                {x.name}: {x.reason}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="text-sm font-medium text-fg">
              Template name
              <input
                required
                value={input.name}
                onChange={(event) => update('name', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Category
              <input
                value={input.category ?? ''}
                onChange={(event) => update('category', event.target.value)}
                placeholder="e.g. Solar packages"
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <LookupAutocomplete
              source="trade-customers"
              label="Default customer"
              value={input.customerId ?? null}
              valueLabel={customerLabel}
              placeholder="Any customer"
              createHref="/admin/customers/new"
              createLabel="+ Create a customer"
              onChange={(option) => void chooseCustomer(option)}
            />
            <LookupAutocomplete
              source="currencies"
              label="Currency"
              value={input.currency}
              valueLabel={input.currency}
              clearable={false}
              onChange={(option) => {
                if (option !== null) update('currency', option.id);
              }}
            />
            <LookupAutocomplete
              source="payment-methods"
              filters={{ customer: input.customerId ?? '' }}
              label="Payment method"
              value={input.paymentMethod}
              valueLabel={methodLabel(input.paymentMethod)}
              clearable={false}
              onChange={(option) => {
                if (option !== null) {
                  update('paymentMethod', option.id as QuoteTemplateInput['paymentMethod']);
                }
              }}
            />
            <label className="text-sm font-medium text-fg">
              Validity (days)
              <input
                type="number"
                min={1}
                max={3650}
                value={input.validityDays}
                onChange={(event) => update('validityDays', Number(event.target.value))}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Quote discount %
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={input.quoteDiscountPercent}
                onChange={(event) => update('quoteDiscountPercent', Number(event.target.value))}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Default shipping
              <input
                type="number"
                min={0}
                step={0.01}
                value={input.shippingFee}
                onChange={(event) => update('shippingFee', Number(event.target.value))}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Payment terms
              <input
                value={input.paymentTerms ?? ''}
                onChange={(event) => update('paymentTerms', event.target.value)}
                placeholder="e.g. 50% deposit, balance on delivery"
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg sm:col-span-2 lg:col-span-3">
              Template description
              <input
                value={input.description ?? ''}
                onChange={(event) => update('description', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg sm:col-span-2 lg:col-span-3">
              Tags
              <input
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
                placeholder="solar, installation, residential"
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
          </div>
          <section className="space-y-3 rounded-xl border border-line p-3 sm:p-4">
            <header>
              <h3 className="font-semibold text-fg-strong">Reusable item bundle</h3>
              <p className="text-xs text-fg-muted">
                Use catalog price to refresh selling price when applied, or fixed price to keep a
                negotiated rate. Items in a section stay in it when a quote is made from the
                template.
              </p>
            </header>
            <QuoteLayoutBoard
              noun="template"
              sections={input.sections}
              lines={input.lines}
              onChange={(next) => setInput((current) => ({ ...current, ...next }))}
              focusLine={focusLine}
              onBulkAdd={() => {
                lastAdded.current = null;
                setBulkOpen(true);
              }}
              lineSearchText={(line) => {
                const product = productById.get(line.productId);
                return `${product?.name ?? ''} ${product?.sku ?? ''} ${product?.stockCode ?? ''}`;
              }}
              quickAdd={(slot) => (
                <QuickAdd
                  index={catalogueIndex}
                  currency={input.currency}
                  destination={placeName(slot)}
                  countHere={() => input.lines.filter((l) => (l.sectionId ?? null) === slot).length}
                  quantityHere={(productId) => heldIn(productId, slot)}
                  onAdd={(entry) => addEntries([{ ...entry, sectionId: slot }])}
                />
              )}
              onBrowse={(sectionId) => {
                lastAdded.current = null;
                setCatalogSectionId(sectionId);
                setCatalogOpen(true);
              }}
              lineName={(line) => productById.get(line.productId)?.name ?? 'item'}
              minWidth={900}
              columns={7}
              head={
                <>
                  <th className="p-3 text-left">Product</th>
                  <th className="p-3">Qty</th>
                  <th className="p-3">Price source</th>
                  <th className="p-3">Fixed price</th>
                  <th className="p-3">Discount %</th>
                  <th className="p-3 text-right">Current estimated margin</th>
                </>
              }
              renderCells={(line, index) => {
                const product = productById.get(line.productId);
                const sell =
                  line.priceMode === 'fixed' ? (line.unitPrice ?? 0) : (product?.price ?? 0);
                const revenue =
                  sell *
                  line.quantity *
                  (1 - line.discountPercent / 100) *
                  (1 - input.quoteDiscountPercent / 100);
                const cost = (product?.costPrice ?? 0) * line.quantity;
                const taxRate = product?.taxRate ?? 0;
                const net =
                  product?.isTaxInclusive !== false && taxRate > 0
                    ? revenue / (1 + taxRate / 100)
                    : revenue;
                const margin = net > 0 ? ((net - cost) / net) * 100 : 0;
                const name = product?.name ?? line.productId;
                return (
                  <>
                    <td className="p-3">
                      <div className="font-medium text-fg-strong">{name}</div>
                      <div className="text-xs text-fg-muted">
                        {product?.sku} · current cost{' '}
                        {amount(product?.costPrice ?? 0, input.currency)}
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
                              mode === 'catalog' ? null : (line.unitPrice ?? product?.price ?? 0),
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
                          patchLine(index, { unitPrice: Number(event.target.value) })
                        }
                        className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong disabled:opacity-50"
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
                        className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                        aria-label={`Discount percent of ${name}`}
                      />
                    </td>
                    <td
                      className={`p-3 text-right text-xs font-semibold ${margin < 0 ? 'text-red-700' : 'text-emerald-700'}`}
                    >
                      {margin.toFixed(1)}%
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
                        <X className="h-4 w-4" />
                      </button>
                    </td>
                  </>
                );
              }}
            />
          </section>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-fg">
              Customer-facing quote text
              <textarea
                rows={3}
                value={input.publicNotes ?? ''}
                onChange={(event) => update('publicNotes', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Internal sales notes
              <textarea
                rows={3}
                value={input.internalNotes ?? ''}
                onChange={(event) => update('internalNotes', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-fg">
              Payment details
              <textarea
                rows={3}
                value={input.paymentDetails ?? ''}
                onChange={(event) => update('paymentDetails', event.target.value)}
                placeholder="Bank / mobile money instructions shown to the customer"
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Terms and conditions
              <textarea
                rows={3}
                value={input.termsAndConditions ?? ''}
                onChange={(event) => update('termsAndConditions', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-fg">
            <input
              type="checkbox"
              checked={input.showBillingAddress}
              onChange={(event) => update('showBillingAddress', event.target.checked)}
            />
            Include Bill To information on customer quote documents by default
          </label>
          <div className="grid gap-4 lg:grid-cols-2">
            {(['billingAddress', 'deliveryAddress'] as const).map((kind) => (
              <fieldset key={kind} className="rounded-xl border border-line p-3">
                <legend className="px-1 text-sm font-semibold text-fg-strong">
                  Default {kind === 'billingAddress' ? 'billing' : 'delivery'} address
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['street', 'city', 'countyOrState', 'postalCode', 'country'] as const).map(
                    (field) => (
                      <input
                        key={field}
                        placeholder={
                          field === 'countyOrState'
                            ? 'County / State'
                            : field[0].toUpperCase() + field.slice(1)
                        }
                        value={input[kind]?.[field] ?? ''}
                        onChange={(event) =>
                          update(kind, { ...input[kind], [field]: event.target.value })
                        }
                        className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
                      />
                    ),
                  )}
                </div>
              </fieldset>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-fg">
            <input
              type="checkbox"
              checked={input.isDefault}
              onChange={(event) => update('isDefault', event.target.checked)}
            />
            Use as company default for new quotes
          </label>
          <footer className="flex justify-end gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-2 text-sm text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || input.lines.length === 0}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save template'}
            </button>
          </footer>
        </form>
      </section>
      {catalogOpen && (
        <CataloguePicker
          title="Browse product catalogue"
          index={catalogueIndex}
          currency={input.currency}
          showCost
          destination={placeName(catalogSectionId)}
          priceHint="Leave the price empty to follow the catalogue price when the template is used. A price you type is kept as a fixed price."
          quantityHere={(productId) => heldIn(productId, catalogSectionId)}
          onAdd={(entries) =>
            addEntries(entries.map((entry) => ({ ...entry, sectionId: catalogSectionId })))
          }
          onClose={() => {
            setCatalogOpen(false);
            setCatalogSectionId(null);
            showLastAdded();
          }}
        />
      )}
      {bulkOpen && (
        <BulkAddDialog
          noun="template"
          index={catalogueIndex}
          places={[
            { id: null, label: 'The individual items' },
            ...input.sections.map((x) => ({ id: x.id, label: `Section ${x.title}` })),
          ]}
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
