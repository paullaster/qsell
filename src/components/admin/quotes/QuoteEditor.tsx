'use client';

import { useMemo, useRef, useState } from 'react';
import { useCustomerCreated } from '@/components/admin/customer-created';

import { FilePlus2, X } from 'lucide-react';
import { buildCatalogueIndex, type CatalogueProduct } from '@/lib/catalogue-entry';

import type { QuoteInput } from '@/server/domains/quotes/service';

import { QuoteLinePriceNote } from '../pricing/QuoteLinePriceNote';
import { useQuotePricePreview } from '../pricing/useQuotePricePreview';
import { useQuoteGuardPreview } from '../pricing/useQuoteGuardPreview';
import { QuoteCoupons } from '../pricing/QuoteCoupons';

import { QuoteLayoutBoard } from '../quote-layout/QuoteLayoutBoard';
import { CataloguePicker } from '../quote-layout/CataloguePicker';
import { QuickAdd } from '../quote-layout/QuickAdd';
import { BulkAddDialog } from '../quote-layout/BulkAddDialog';
import { QuantityInput } from '../quote-layout/QuantityInput';
import { TemplateSwapDialog } from '../quote-layout/TemplateSwapDialog';
import { LookupAutocomplete } from '@/components/ui/autocomplete/LookupAutocomplete';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import type { Choice } from '@/lib/payment-options';
import type { LookupOption } from '@/lib/lookup';
import { methodLabel } from '@/lib/payment-method-labels';

import { chooseQuoteCustomerAction } from '@/server/domains/quotes/form-actions';
import type { SwapSummary } from '@/server/domains/quotes/template-swap-service';
import {
  addSectionFromTemplateAction,
  planQuoteTemplateSwapAction,
  planSectionTemplateSwapAction,
} from '@/server/domains/quotes/swap-actions';

import { addCatalogueEntry, lastIndexOfProduct, type CatalogueEntry } from '@/lib/quote-layout';

import { Modal } from '@/components/ui/Modal';
import { hasText, money, orElse } from '@/lib/quote-display';
import { useQuoteTotals } from './useQuoteTotals';

type QuoteLineInput = QuoteInput['lines'][number];

/** The line figures shown before the server has answered. */
const NO_TOTALS = {
  net: 0,
  tax: 0,
  total: 0,
  cost: 0,
  grossProfit: 0,
  grossMarginPercent: 0,
  belowFloor: false,
};

export function QuoteEditor({
  products,
  initial,
  quoteNumber,
  notices = [],
  onClose,
  onSave,
}: {
  products: CatalogueProduct[];
  initial: QuoteInput;
  quoteNumber?: string;
  /** Things changed or worth knowing when the saved quote was opened (a unit its product no longer has). */
  notices?: { line: number; message: string }[];
  onClose: () => void;
  onSave: (input: QuoteInput) => Promise<void>;
}) {
  const [input, setInput] = useState<QuoteInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogSectionId, setCatalogSectionId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalogueIndex = useMemo(() => buildCatalogueIndex(products), [products]);
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const lastAdded = useRef<{ productId: string; sectionId: string | null } | null>(null);
  const [focusLine, setFocusLine] = useState<{ index: number; nonce: number } | null>(null);
  const [draftPreviewOpen, setDraftPreviewOpen] = useState(false);
  // What the quote comes to is worked out on the server; this only shows the answer.
  const { totals } = useQuoteTotals(input);
  const linesPreview = input.lines.map((line, index) => ({
    line,
    product: productById.get(line.productId),
    ...(totals?.lines[index] ?? NO_TOTALS),
  }));
  const subtotal = totals?.subtotal ?? 0;
  const tax = totals?.tax ?? 0;
  const total = totals?.total ?? 0;
  const cost = totals?.cost ?? 0;
  const grossProfit = totals?.grossProfit ?? 0;
  const margin = totals?.marginPercent ?? 0;
  const belowFloor = totals?.belowFloor ?? false;
  const sectionTotal = (sectionId: string) => totals?.sectionTotals[sectionId] ?? 0;

  const setField = <K extends keyof QuoteInput>(key: K, value: QuoteInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));
  /** Adds items in one change, merging into lines that already hold the same item. */
  const addEntries = (entries: CatalogueEntry[]) => {
    if (entries.length === 0) return;
    setInput((current) => {
      let lines = current.lines;
      for (const entry of entries) {
        const product = productById.get(entry.productId);
        if (!product) continue;
        lines = addCatalogueEntry<QuoteLineInput>(
          lines,
          entry,
          (e) => ({
            sectionId: e.sectionId,
            productId: e.productId,
            quantity: e.quantity,
            // The catalogue price shows at once, then the price lists' answer replaces it.
            unitPrice: e.unitPrice ?? product.price,
            priceMode: e.unitPrice === null ? 'catalog' : 'manual',
            discountPercent: e.discountPercent,
          }),
          (line) => line.priceMode === 'manual',
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
  const patchLine = (index: number, patch: Partial<QuoteLineInput>) =>
    setField(
      'lines',
      input.lines.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)),
    );
  /**
   * Changing a line's unit (kg to crate) keeps the quantity typed and puts the line back on the price lists;
   * until the lists answer, the catalogue price for one of the new unit is shown.
   */
  const changeUnit = (index: number, choice: Choice | null) => {
    const line = input.lines[index];
    const product = line === undefined ? undefined : productById.get(line.productId);
    if (line === undefined || product === undefined || choice === null) return;
    const toBase = choice.id === product.baseUnitId;
    const perUnit = toBase ? 1 : Number(choice.meta?.qtyPerUnit ?? 1);
    patchLine(index, {
      unitId: toBase ? null : choice.id,
      unitCode: toBase ? null : (choice.meta?.code ?? choice.label.split(' · ')[0] ?? null),
      priceMode: 'catalog',
      unitPrice: product.price == null ? undefined : Math.round(product.price * perUnit * 1e4) / 1e4,
    });
  };
  const { traces, problems } = useQuotePricePreview(input, setInput);
  const guards = useQuoteGuardPreview(input);
  const [swap, setSwap] = useState<{
    summary: SwapSummary;
    /** Set when only one section is switched to another section template. */
    section?: { title: string };
  } | null>(null);
  const [switching, setSwitching] = useState(false);

  /** Asks the server what a switch would do; the answer is shown, or applied if nothing is asked. */
  const planSwitch = async (
    plan: () => Promise<{ ok: true; data: SwapSummary } | { ok: false; error: string }>,
    section?: { title: string },
  ) => {
    try {
      setSwitching(true);
      setError(null);
      const result = await plan();
      if (!result.ok) throw new Error(result.error);
      if (result.data.kind === 'none') setInput(result.data.drop);
      else setSwap({ summary: result.data, section });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch the template.');
    } finally {
      setSwitching(false);
    }
  };
  const chooseTemplate = (templateId: string | null) => {
    if (templateId === (input.templateId ?? null)) return;
    void planSwitch(() => planQuoteTemplateSwapAction(input, templateId));
  };
  const addSectionTemplate = async (templateId: string) => {
    try {
      setSwitching(true);
      setError(null);
      const result = await addSectionFromTemplateAction(input, templateId);
      if (!result.ok) throw new Error(result.error);
      setInput(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the section.');
    } finally {
      setSwitching(false);
    }
  };
  const switchSectionTemplate = (sectionId: string, templateId: string) => {
    const section = input.sections.find((row) => row.id === sectionId);
    if (!section || (section.sectionTemplateId ?? '') === templateId) return;
    void planSwitch(
      () => planSectionTemplateSwapAction(input, sectionId, templateId === '' ? null : templateId),
      { title: section.title },
    );
  };

  /** The server fills the form from the customer chosen (or clears it) and decides how it is paid. */
  const chooseCustomer = async (option: LookupOption | null) => {
    try {
      setSwitching(true);
      setError(null);
      const result = await chooseQuoteCustomerAction(input, option === null ? null : option.id);
      if (!result.ok) throw new Error(result.error);
      setInput(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not choose that customer.');
    } finally {
      setSwitching(false);
    }
  };

  useCustomerCreated((created) => void chooseCustomer({ id: created.id, label: created.label }));

  const submit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setError(null);
      await onSave(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this quote.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={quoteNumber === undefined ? 'Create sales quote' : `Edit ${quoteNumber}`}
      onClose={onClose}
      wide
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-5">
        {error !== null && (
          <p
            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
            role="alert"
          >
            {error}
          </p>
        )}
        {notices.length > 0 && (
          <div
            role="status"
            aria-label="Changes made when this quote was opened"
            className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <p className="font-semibold">Check these lines before you save</p>
            <ul className="list-disc space-y-1 pl-5">
              {notices.map((n) => (
                <li key={`${String(n.line)}-${n.message}`}>
                  Line {n.line + 1}: {n.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <LookupAutocomplete
          source="quote-templates"
          label={quoteNumber === undefined ? 'Start from a template' : 'Template'}
          value={input.templateId ?? null}
          valueLabel={input.templateName ?? null}
          placeholder={quoteNumber === undefined ? 'Blank quote' : 'No template'}
          disabled={switching}
          onChange={(option) => chooseTemplate(option?.id ?? null)}
          createHref="/admin/quotes/templates/new"
          createLabel="Create a template"
          listHref="/admin/quotes/templates"
          listLabel="View all templates"
        />
        {swap && (
          <TemplateSwapDialog
            summary={swap.summary}
            scope={swap.section ? 'section' : 'quote'}
            sectionName={swap.section?.title}
            onClose={() => setSwap(null)}
            onConfirm={(keepAdditions) => {
              setInput(keepAdditions ? swap.summary.keep : swap.summary.drop);
              setSwap(null);
            }}
          />
        )}
        <section className="grid gap-3 sm:grid-cols-2">
          <LookupAutocomplete
            source="trade-customers"
            label="Trade customer"
            value={input.customerId ?? null}
            valueLabel={
              input.customerId === null || input.customerId === undefined
                ? null
                : input.customerName
            }
            placeholder="New / one-time customer"
            createHref="/admin/customers/new"
            createLabel="+ Create a customer"
            disabled={switching}
            onChange={(option) => void chooseCustomer(option)}
          />
          <label className="text-sm font-medium text-fg">
            Customer name
            <input
              required
              value={input.customerName}
              onChange={(event) => setField('customerName', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Email
            <input
              type="email"
              value={input.customerEmail ?? ''}
              onChange={(event) => setField('customerEmail', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Phone
            <input
              value={input.customerPhone ?? ''}
              onChange={(event) => setField('customerPhone', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Customer reference / PO
            <input
              value={input.customerReference ?? ''}
              onChange={(event) => setField('customerReference', event.target.value)}
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <label className="text-sm font-medium text-fg">
            Valid until
            <input
              type="date"
              value={input.validUntil ?? ''}
              onChange={(event) =>
                setField('validUntil', event.target.value === '' ? null : event.target.value)
              }
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
          <LookupAutocomplete
            source="currencies"
            label="Currency"
            value={input.currency}
            valueLabel={input.currency}
            clearable={false}
            onChange={(option) => {
              if (option !== null) setField('currency', option.id);
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
              if (option !== null)
                setField('paymentMethod', option.id as QuoteInput['paymentMethod']);
            }}
          />
          <label className="text-sm font-medium text-fg">
            Payment terms
            <input
              value={input.paymentTerms ?? ''}
              onChange={(event) => setField('paymentTerms', event.target.value)}
              placeholder="e.g. 50% deposit, balance on delivery"
              className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
            />
          </label>
        </section>

        <section className="space-y-3 rounded-xl border border-line bg-surface-raised p-3 sm:p-4">
          <header>
            <h3 className="font-semibold text-fg-strong">Quote items</h3>
            <p className="text-xs text-fg-muted">
              Individual items print one by one. A section prints as its title with its total, or
              with its items listed under it when you keep it expanded.
            </p>
          </header>
          <QuoteLayoutBoard
            noun="quote"
            sectionTemplateLinks={{
              createHref: '/admin/quotes/section-templates/new',
              listHref: '/admin/quotes/section-templates',
            }}
            onAddSectionFromTemplate={(id) => void addSectionTemplate(id)}
            onSectionTemplateChange={switchSectionTemplate}
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
            sectionTotal={(sectionId) => money(sectionTotal(sectionId), input.currency)}
            minWidth={1040}
            columns={9}
            head={
              <>
                <th className="p-3">Item</th>
                <th className="p-3">Qty</th>
                <th className="p-3">Unit price</th>
                <th className="p-3">Disc %</th>
                <th className="p-3 text-right">Cost</th>
                <th className="p-3 text-right">Gross profit</th>
                <th className="p-3 text-right">Margin</th>
                <th className="p-3 text-right">Amount</th>
              </>
            }
            renderCells={(line, index) => {
              const entry = linesPreview[index];
              return (
                <>
                  <td className="p-3">
                    <div className="font-medium text-fg-strong">{entry.product?.name}</div>
                    <div className="text-xs text-fg-muted">
                      {entry.product?.sku} · tax {entry.product?.taxRate ?? 0}%
                    </div>
                  </td>
                  <td className="p-3">
                    <QuantityInput
                      label={`Quantity of ${entry.product?.name ?? 'item'}`}
                      value={line.quantity}
                      onChange={(value) => patchLine(index, { quantity: Number(value) })}
                    />
                    {entry.product === undefined || entry.product.baseUnitId === '' ? null : (
                      <div className="mt-1">
                        <ChoicePicker
                          label={`Unit of ${entry.product.name}`}
                          hideLabel
                          source="product-units"
                          filters={{ product: line.productId }}
                          choice={{
                            id: line.unitId ?? entry.product.baseUnitId,
                            label: line.unitId == null ? entry.product.baseUnitCode : (line.unitCode ?? '…'),
                          }}
                          onChoice={(choice) => changeUnit(index, choice)}
                          clearable={false}
                          placeholder="Unit"
                        />
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    <input
                      aria-label={`Unit price of ${entry.product?.name ?? 'item'}`}
                      type="number"
                      min="0"
                      step="0.0001"
                      value={line.unitPrice ?? ''}
                      onChange={(event) =>
                        patchLine(index, {
                          unitPrice: Number(event.target.value),
                          priceMode: 'manual',
                        })
                      }
                      className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                    />
                    <QuoteLinePriceNote
                      mode={line.priceMode ?? (line.unitPrice != null ? 'manual' : 'catalog')}
                      trace={traces[index]}
                      problem={problems[index]}
                      guard={guards[index]}
                      onUseLists={() => patchLine(index, { priceMode: 'catalog' })}
                    />
                  </td>
                  <td className="p-3">
                    <input
                      aria-label={`Discount percent of ${entry.product?.name ?? 'item'}`}
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={line.discountPercent}
                      onChange={(event) =>
                        patchLine(index, { discountPercent: Number(event.target.value) })
                      }
                      className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                    />
                  </td>
                  <td className="p-3 text-right text-xs text-fg-muted">
                    {money(entry.cost, input.currency)}
                  </td>
                  <td
                    className={`p-3 text-right text-xs font-semibold ${entry.grossProfit < 0 ? 'text-red-700' : 'text-fg-strong'}`}
                  >
                    {money(entry.grossProfit, input.currency)}
                  </td>
                  <td
                    className={`p-3 text-right text-xs font-semibold ${entry.belowFloor ? 'text-amber-800' : 'text-emerald-700'}`}
                  >
                    {entry.grossMarginPercent.toFixed(1)}%
                  </td>
                  <td className="p-3 text-right font-mono font-semibold text-fg-strong">
                    {money(entry.total, input.currency)}
                  </td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() =>
                        setField(
                          'lines',
                          input.lines.filter((item) => item !== line),
                        )
                      }
                      className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded text-fg-muted hover:bg-red-50 hover:text-red-700"
                      aria-label={`Remove ${entry.product?.name ?? 'item'}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </td>
                </>
              );
            }}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium text-fg">
              Quote discount %
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={input.discountPercent}
                onChange={(event) => setField('discountPercent', Number(event.target.value))}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Shipping
              <input
                type="number"
                min="0"
                step="0.01"
                value={input.shippingFee}
                onChange={(event) => setField('shippingFee', Number(event.target.value))}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <QuoteCoupons input={input} onCodes={(codes) => setField('couponCodes', codes)} />
            <label className="flex items-center gap-2 text-sm font-medium text-fg sm:col-span-2">
              <input
                type="checkbox"
                checked={input.showBillingAddress !== false}
                onChange={(event) => setField('showBillingAddress', event.target.checked)}
              />
              Include Bill To information on the quote document
            </label>
            {input.showBillingAddress !== false && (
              <label className="text-sm font-medium text-fg sm:col-span-2">
                Bill To information
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {(['street', 'city', 'countyOrState', 'postalCode', 'country'] as const).map(
                    (field) => (
                      <input
                        key={field}
                        placeholder={
                          field === 'countyOrState'
                            ? 'County / State'
                            : field[0].toUpperCase() + field.slice(1)
                        }
                        value={input.billingAddress?.[field] ?? ''}
                        onChange={(event) =>
                          setField('billingAddress', {
                            ...input.billingAddress,
                            [field]: event.target.value,
                          })
                        }
                        className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
                      />
                    ),
                  )}
                </div>
              </label>
            )}
            <label className="text-sm font-medium text-fg sm:col-span-2">
              Delivery address
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(['street', 'city', 'countyOrState', 'postalCode', 'country'] as const).map(
                  (field) => (
                    <input
                      key={field}
                      required={field !== 'postalCode'}
                      placeholder={
                        field === 'countyOrState'
                          ? 'County / State'
                          : field[0].toUpperCase() + field.slice(1)
                      }
                      value={input.deliveryAddress?.[field] ?? ''}
                      onChange={(event) =>
                        setField('deliveryAddress', {
                          ...input.deliveryAddress,
                          [field]: event.target.value,
                        })
                      }
                      className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
                    />
                  ),
                )}
              </div>
            </label>
            <label className="text-sm font-medium text-fg">
              Customer-facing notes
              <textarea
                rows={2}
                value={input.publicNotes ?? ''}
                onChange={(event) => setField('publicNotes', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Internal notes
              <textarea
                rows={2}
                value={input.internalNotes ?? ''}
                onChange={(event) => setField('internalNotes', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Payment details for customer document
              <textarea
                rows={3}
                value={input.paymentDetails ?? ''}
                onChange={(event) => setField('paymentDetails', event.target.value)}
                placeholder="Bank transfer, mobile-money, deposit instructions…"
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
            <label className="text-sm font-medium text-fg">
              Terms and conditions
              <textarea
                rows={3}
                value={input.termsAndConditions ?? ''}
                onChange={(event) => setField('termsAndConditions', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              />
            </label>
          </div>
          <aside className="rounded-xl border border-line bg-surface p-4">
            <h3 className="font-semibold text-fg-strong">Internal margin review</h3>
            <p className="mt-1 text-xs text-fg-muted">
              These figures are never included in the customer PDF or email.
            </p>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-fg-muted">Net subtotal</dt>
                <dd className="font-mono text-fg-strong">{money(subtotal, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Tax</dt>
                <dd className="font-mono text-fg-strong">{money(tax, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Shipping</dt>
                <dd className="font-mono text-fg-strong">
                  {money(input.shippingFee, input.currency)}
                </dd>
              </div>
              <div className="flex justify-between border-t border-line pt-2 font-semibold">
                <dt className="text-fg">Quote total</dt>
                <dd className="font-mono text-fg-strong">{money(total, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Cost snapshot</dt>
                <dd className="font-mono text-fg-strong">{money(cost, input.currency)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Gross profit</dt>
                <dd className="font-mono text-fg-strong">{money(grossProfit, input.currency)}</dd>
              </div>
              <div
                className={`flex justify-between rounded-lg px-2 py-1.5 font-bold ${belowFloor ? 'bg-amber-100 text-amber-950' : 'bg-emerald-50 text-emerald-800'}`}
              >
                <dt>Gross margin</dt>
                <dd>{margin.toFixed(1)}%</dd>
              </div>
            </dl>
            {belowFloor && (
              <p className="mt-3 text-xs font-medium text-amber-900">
                Below the {(totals?.minimumMarginPercent ?? 0).toFixed(1)}% approval floor. Saving
                sends this quote to the approval queue.
              </p>
            )}
          </aside>
        </section>

        <footer className="flex justify-end gap-2 border-t border-line pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-4 py-2 text-sm text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={input.lines.length === 0}
            onClick={() => setDraftPreviewOpen(true)}
            className="rounded-lg border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-300"
          >
            Preview quote
          </button>
          <button
            type="submit"
            disabled={busy || input.lines.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? (
              'Saving…'
            ) : (
              <>
                <FilePlus2 className="h-4 w-4" /> Save quote
              </>
            )}
          </button>
        </footer>
      </form>
      {catalogOpen && (
        <CataloguePicker
          title="Product catalogue"
          index={catalogueIndex}
          currency={input.currency}
          destination={placeName(catalogSectionId)}
          priceHint="Leave the price empty to use the price lists. A price you type is kept as a manual price on the line."
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
          noun="quote"
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
      {draftPreviewOpen && (
        <DraftQuotePreview
          input={input}
          lines={linesPreview}
          subtotal={subtotal}
          tax={tax}
          total={total}
          sectionTotal={sectionTotal}
          quoteNumber={quoteNumber}
          onClose={() => setDraftPreviewOpen(false)}
        />
      )}
    </Modal>
  );
}

/** Gives each line a key that stays the same as lines are added: its product and which one of that product it is. */
function keyedByProduct<T extends { line: QuoteLineInput }>(entries: T[]): (T & { key: string })[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const n = (seen.get(entry.line.productId) ?? 0) + 1;
    seen.set(entry.line.productId, n);
    return { ...entry, key: `${entry.line.productId}:${String(n)}` };
  });
}

function DraftQuotePreview({
  input,
  lines,
  subtotal,
  tax,
  total,
  sectionTotal,
  quoteNumber,
  onClose,
}: {
  input: QuoteInput;
  lines: {
    line: QuoteLineInput;
    product: CatalogueProduct | undefined;
    total: number;
  }[];
  subtotal: number;
  tax: number;
  total: number;
  /** What the lines of a section come to. */
  sectionTotal: (sectionId: string) => number;
  quoteNumber?: string;
  onClose: () => void;
}) {
  const keyed = keyedByProduct(lines);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-backdrop/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Customer quote preview"
        className="flex max-h-[94dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="font-semibold text-fg-strong">Customer quote preview</h2>
            <p className="text-xs text-fg-muted">
              Individual items print one by one. A section prints as its title and total, with its
              items listed under it when it is kept expanded. Cost, margins, internal notes, and
              delivery address stay private.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close quote preview"
            className="rounded-lg p-2 text-fg-muted hover:bg-hover"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <article className="overflow-y-auto bg-white p-6 text-slate-900 sm:p-10">
          <header className="flex flex-col justify-between gap-6 border-b-2 border-indigo-700 pb-5 sm:flex-row">
            <div>
              <p className="text-xs font-semibold tracking-[0.2em] text-indigo-700 uppercase">
                Quotation
              </p>
              <h1 className="mt-2 text-2xl font-bold">{quoteNumber ?? 'Draft quote'}</h1>
              <p className="mt-2 text-sm text-slate-600">
                Prepared for {orElse(input.customerName, 'Customer')}
              </p>
              {hasText(input.customerEmail) && (
                <p className="text-sm text-slate-600">{input.customerEmail}</p>
              )}
              {hasText(input.customerReference) && (
                <p className="mt-2 text-xs text-slate-600">Reference: {input.customerReference}</p>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 self-start text-sm">
              <dt className="text-slate-500">Issue date</dt>
              <dd className="text-right">{new Date().toLocaleDateString()}</dd>
              <dt className="text-slate-500">Valid until</dt>
              <dd className="text-right">
                {hasText(input.validUntil)
                  ? new Date(`${input.validUntil}T12:00:00`).toLocaleDateString()
                  : '—'}
              </dd>
              <dt className="text-slate-500">Currency</dt>
              <dd className="text-right">{input.currency}</dd>
            </dl>
          </header>

          {input.showBillingAddress === true &&
            Object.values(input.billingAddress ?? {}).some((value) => value.trim().length > 0) && (
              <section className="py-5">
                <h3 className="text-xs font-bold tracking-wider text-indigo-700 uppercase">
                  Bill to
                </h3>
                <p className="mt-1 font-semibold">{orElse(input.customerName, 'Customer')}</p>
                <p className="text-sm text-slate-600">
                  {[
                    input.billingAddress?.street,
                    input.billingAddress?.city,
                    input.billingAddress?.countyOrState,
                    input.billingAddress?.postalCode,
                    input.billingAddress?.country,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              </section>
            )}

          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="bg-indigo-700 text-white">
                <th className="p-3">Description</th>
                <th className="p-3 text-right">Qty</th>
                <th className="p-3 text-right">Unit price</th>
                <th className="p-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {keyed
                .filter(
                  (entry) => entry.line.sectionId === null || entry.line.sectionId === undefined,
                )
                .map((entry) => (
                  <tr key={entry.key} className="border-b border-slate-200">
                    <td className="p-3">
                      <p className="font-semibold">{entry.product?.name ?? 'Quote item'}</p>
                      <p className="text-xs text-slate-500">{entry.product?.sku ?? ''}</p>
                    </td>
                    <td className="p-3 text-right">{entry.line.quantity}</td>
                    <td className="p-3 text-right">
                      {money(entry.line.unitPrice ?? entry.product?.price ?? 0, input.currency)}
                    </td>
                    <td className="p-3 text-right">{money(entry.total, input.currency)}</td>
                  </tr>
                ))}
              {input.sections.flatMap((section) => {
                return [
                  <tr key={section.id} className="border-b border-slate-200 bg-slate-50">
                    <td className="p-3" colSpan={3}>
                      <p className="font-semibold">{section.title}</p>
                      {hasText(section.description) && (
                        <p className="mt-1 text-xs text-slate-500">{section.description}</p>
                      )}
                    </td>
                    <td className="p-3 text-right font-semibold">
                      {money(sectionTotal(section.id), input.currency)}
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>

          <dl className="mt-6 ml-auto max-w-xs space-y-2 text-sm">
            <PreviewTotal label="Subtotal" value={subtotal} currency={input.currency} />
            <PreviewTotal label="Tax" value={tax} currency={input.currency} />
            <PreviewTotal label="Shipping" value={input.shippingFee} currency={input.currency} />
            <div className="flex justify-between border-t-2 border-indigo-700 pt-3 text-base font-bold">
              <dt>Total</dt>
              <dd>{money(total, input.currency)}</dd>
            </div>
          </dl>

          {hasText(input.publicNotes) && <PreviewText title="Notes" text={input.publicNotes} />}
          {hasText(input.paymentDetails) && (
            <PreviewText title="Payment details" text={input.paymentDetails} />
          )}
          {hasText(input.paymentTerms) && (
            <PreviewText title="Payment terms" text={input.paymentTerms} />
          )}
          {hasText(input.termsAndConditions) && (
            <PreviewText title="Terms and conditions" text={input.termsAndConditions} />
          )}
          <p className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-500">
            This quotation is subject to the stated validity and terms. It is not a tax invoice or
            confirmation of payment.
          </p>
        </article>
      </section>
    </div>
  );
}

function PreviewTotal({
  label,
  value,
  currency,
}: {
  label: string;
  value: number;
  currency: string;
}) {
  return (
    <div className="flex justify-between text-slate-600">
      <dt>{label}</dt>
      <dd>{money(value, currency)}</dd>
    </div>
  );
}

function PreviewText({ title, text }: { title: string; text: string }) {
  return (
    <section className="mt-6 border-t border-slate-200 pt-4">
      <h3 className="text-xs font-bold tracking-wider text-indigo-700 uppercase">{title}</h3>
      <p className="mt-2 text-sm whitespace-pre-wrap text-slate-700">{text}</p>
    </section>
  );
}
