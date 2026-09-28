'use client';

import { useState } from 'react';
import { Copy, FileStack, Plus, Star, X } from 'lucide-react';
import type { Product } from '@/types/index';
import type { CustomerRow } from '@/server/db/drizzle/schema';
import type { QuoteTemplateInput, SalesQuoteTemplate } from '@/server/domains/quotes/service';
import {
  archiveSalesQuoteTemplateAction,
  duplicateSalesQuoteTemplateAction,
  saveSalesQuoteTemplateAction,
  setDefaultSalesQuoteTemplateAction,
} from '@/server/domains/quotes/actions';

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
    validityDays: 30,
    quoteDiscountPercent: 0,
    shippingFee: 0,
    billingAddress: {},
    deliveryAddress: {},
    publicNotes: '',
    internalNotes: '',
    tags: [],
    isDefault: false,
    lines: [],
  };
}

function templateInput(template: SalesQuoteTemplate): QuoteTemplateInput {
  return {
    name: template.name,
    category: template.category,
    description: template.description,
    customerId: template.customerId,
    currency: template.currency,
    paymentMethod: template.paymentMethod as QuoteTemplateInput['paymentMethod'],
    paymentTerms: template.paymentTerms,
    validityDays: template.validityDays,
    quoteDiscountPercent: Number(template.quoteDiscountPercent),
    shippingFee: Number(template.shippingFee),
    billingAddress: template.billingAddress,
    deliveryAddress: template.deliveryAddress,
    publicNotes: template.publicNotes,
    internalNotes: template.internalNotes,
    tags: template.tags,
    isDefault: template.isDefault,
    lines: template.lines.map((line) => ({
      productId: line.productId ?? '',
      quantity: Number(line.quantity),
      priceMode: line.priceMode as 'catalog' | 'fixed',
      unitPrice: line.unitPrice == null ? null : Number(line.unitPrice),
      discountPercent: Number(line.discountPercent),
    })),
  };
}

export function AdminSalesQuoteTemplates({
  templates,
  products,
  customers,
  canCreate,
  canUpdate,
  canDelete,
  onRefresh,
  onMessage,
  onError,
}: {
  templates: SalesQuoteTemplate[];
  products: Product[];
  customers: CustomerRow[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onRefresh: () => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState<SalesQuoteTemplate | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runTemplateAction = async (id: string, action: () => Promise<unknown>, message: string) => {
    try {
      setBusyId(id);
      onError('');
      await action();
      onMessage(message);
      onRefresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Template action failed.');
    } finally {
      setBusyId(null);
    }
  };

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
                setEditorOpen(true);
              }}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" /> New template
            </button>
          )}
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-left text-sm">
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
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-12 text-center text-fg-muted">
                    No templates yet. Create one from your common quote bundles and terms.
                  </td>
                </tr>
              ) : (
                templates.map((template) => (
                  <tr key={template.id} className="hover:bg-hover/50">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(template);
                          setEditorOpen(true);
                        }}
                        className="font-semibold text-indigo-700 hover:underline dark:text-indigo-300"
                      >
                        {template.name}
                      </button>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        {[template.category, template.description].filter(Boolean).join(' · ') ||
                          'No description'}
                      </p>
                      {template.tags.length > 0 && (
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          {template.tags.join(' · ')}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {customers.find((customer) => customer.id === template.customerId)?.name ??
                        'Any customer'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{template.lines.length}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{template.usageCount}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${template.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-sunken text-fg-muted'}`}
                      >
                        {template.isDefault && <Star className="h-3 w-3 fill-current" />}
                        {template.status === 'active'
                          ? template.isDefault
                            ? 'Default'
                            : 'Active'
                          : 'Archived'}
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
                            className="rounded-md p-2 text-amber-700 hover:bg-amber-50"
                            title="Set as default"
                          >
                            <Star className="h-4 w-4" />
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
                            className="rounded-md p-2 text-fg-muted hover:bg-hover hover:text-fg-strong"
                            title="Duplicate template"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                        )}
                        {template.status === 'active' && canUpdate && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(template);
                              setEditorOpen(true);
                            }}
                            className="rounded-md px-2 py-1.5 text-xs text-fg-muted hover:bg-hover"
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
                            className="rounded-md px-2 py-1.5 text-xs text-red-700 hover:bg-red-50"
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
      </section>

      {editorOpen && (
        <TemplateEditor
          initial={editing ? templateInput(editing) : emptyTemplate()}
          products={products}
          customers={customers}
          onClose={() => setEditorOpen(false)}
          onSave={async (input) => {
            await saveSalesQuoteTemplateAction(editing?.id ?? null, input);
            setEditorOpen(false);
            onMessage(`${input.name} template saved.`);
            onRefresh();
          }}
        />
      )}
    </>
  );
}

function TemplateEditor({
  initial,
  products,
  customers,
  onClose,
  onSave,
}: {
  initial: QuoteTemplateInput;
  products: Product[];
  customers: CustomerRow[];
  onClose: () => void;
  onSave: (input: QuoteTemplateInput) => Promise<void>;
}) {
  const [input, setInput] = useState(initial);
  const [tagsText, setTagsText] = useState(initial.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof QuoteTemplateInput>(key: K, value: QuoteTemplateInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));
  const addLine = (productId: string) => {
    if (!productId || input.lines.some((line) => line.productId === productId)) return;
    update('lines', [
      ...input.lines,
      { productId, quantity: 1, priceMode: 'catalog', unitPrice: null, discountPercent: 0 },
    ]);
  };
  const patchLine = (index: number, patch: Partial<QuoteTemplateInput['lines'][number]>) =>
    update(
      'lines',
      input.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );
  const chooseCustomer = (customerId: string) => {
    const customer = customers.find((row) => row.id === customerId);
    if (!customer) {
      update('customerId', null);
      return;
    }
    const address = {
      street: customer.street ?? '',
      city: customer.city ?? '',
      countyOrState: customer.countyOrState ?? '',
      postalCode: customer.postalCode ?? '',
      country: customer.country ?? 'Kenya',
    };
    setInput((current) => ({
      ...current,
      customerId,
      billingAddress: address,
      deliveryAddress: address,
      paymentMethod: customer.accountType === 'credit' ? 'on_account' : current.paymentMethod,
    }));
  };
  const submit = async (event: React.FormEvent) => {
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
              {initial.name ? `Edit ${initial.name}` : 'New quote template'}
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
          {error && (
            <p
              className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
              role="alert"
            >
              {error}
            </p>
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
            <label className="text-sm font-medium text-fg">
              Default customer
              <select
                value={input.customerId ?? ''}
                onChange={(event) => chooseCustomer(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              >
                <option value="">Any customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.number} · {customer.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-fg">
              Currency
              <select
                value={input.currency}
                onChange={(event) => update('currency', event.target.value)}
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              >
                <option>KES</option>
                <option>USD</option>
              </select>
            </label>
            <label className="text-sm font-medium text-fg">
              Payment method
              <select
                value={input.paymentMethod}
                onChange={(event) =>
                  update('paymentMethod', event.target.value as QuoteTemplateInput['paymentMethod'])
                }
                className="mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong"
              >
                <option value="mpesa_daraja">M-Pesa</option>
                <option value="pesapal_v3">Pesapal</option>
                <option value="jenga_hq">Jenga</option>
                <option value="kcb_buni">KCB Buni</option>
                {input.customerId &&
                  customers.find((customer) => customer.id === input.customerId)?.accountType ===
                    'credit' && <option value="on_account">On account</option>}
              </select>
            </label>
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
          <section className="rounded-xl border border-line">
            <header className="flex flex-col justify-between gap-3 border-b border-line p-3 sm:flex-row sm:items-center">
              <div>
                <h3 className="font-semibold text-fg-strong">Reusable item bundle</h3>
                <p className="text-xs text-fg-muted">
                  Use catalog price to refresh selling price when applied, or fixed price to keep a
                  negotiated rate.
                </p>
              </div>
              <select
                defaultValue=""
                onChange={(event) => {
                  addLine(event.target.value);
                  event.target.value = '';
                }}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong"
              >
                <option value="">Add product…</option>
                {products
                  .filter(
                    (product) =>
                      product.isSellable &&
                      !input.lines.some((line) => line.productId === product.id),
                  )
                  .map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.sku} · {product.name}
                    </option>
                  ))}
              </select>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[850px] text-sm">
                <thead className="bg-surface text-xs text-fg-muted">
                  <tr>
                    <th className="p-3 text-left">Product</th>
                    <th className="p-3">Qty</th>
                    <th className="p-3">Price source</th>
                    <th className="p-3">Fixed price</th>
                    <th className="p-3">Discount %</th>
                    <th className="p-3 text-right">Current estimated margin</th>
                    <th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {input.lines.map((line, index) => {
                    const product = products.find((item) => item.id === line.productId);
                    const sell =
                      line.priceMode === 'fixed'
                        ? Number(line.unitPrice ?? 0)
                        : Number(product?.price ?? 0);
                    const revenue =
                      sell *
                      line.quantity *
                      (1 - line.discountPercent / 100) *
                      (1 - input.quoteDiscountPercent / 100);
                    const cost = Number(product?.costPrice ?? 0) * line.quantity;
                    const taxRate = product?.taxRate ?? 0;
                    const net =
                      product?.isTaxInclusive !== false && taxRate > 0
                        ? revenue / (1 + taxRate / 100)
                        : revenue;
                    const margin = net > 0 ? ((net - cost) / net) * 100 : 0;
                    return (
                      <tr key={line.productId}>
                        <td className="p-3">
                          <div className="font-medium text-fg-strong">
                            {product?.name ?? line.productId}
                          </div>
                          <div className="text-xs text-fg-muted">
                            {product?.sku} · current cost{' '}
                            {amount(Number(product?.costPrice ?? 0), input.currency)}
                          </div>
                        </td>
                        <td className="p-3">
                          <input
                            type="number"
                            min={0.001}
                            step={0.001}
                            value={line.quantity}
                            onChange={(event) =>
                              patchLine(index, { quantity: Number(event.target.value) })
                            }
                            className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
                            aria-label="Template quantity"
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
                            className="rounded-md border border-line bg-surface px-2 py-1 text-fg-strong"
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
                            className="w-28 rounded-md border border-line bg-surface px-2 py-1 text-fg-strong disabled:opacity-50"
                            aria-label="Fixed template price"
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
                            aria-label="Template line discount"
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
                            className="rounded p-1 text-red-700 hover:bg-red-50"
                            aria-label="Remove template product"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {input.lines.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-sm text-fg-muted">
                        Add products to create a reusable bundle.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
                            : field[0]!.toUpperCase() + field.slice(1)
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
    </div>
  );
}
