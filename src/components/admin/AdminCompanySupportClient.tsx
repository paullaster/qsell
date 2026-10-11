'use client';

import { use, useId, useState, useTransition } from 'react';
import { ArrowDown, ArrowUp, LifeBuoy, Plus, Save, Trash2 } from 'lucide-react';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import { updateCompanySupportAction } from '@/server/domains/company/actions';
import {
  SUPPORT_CHANNEL_KINDS,
  SUPPORT_LIMITS,
  resolveSupportConfig,
  type CompanySupportConfig,
  type SupportChannel,
  type SupportChannelKind,
} from '@/config/company-ui';

const KIND_META: Record<
  SupportChannelKind,
  { label: string; valueLabel: string; placeholder: string; showUrl: boolean }
> = {
  phone: {
    label: 'Phone call',
    valueLabel: 'Phone number',
    placeholder: '+254 700 000 000',
    showUrl: false,
  },
  whatsapp: {
    label: 'WhatsApp',
    valueLabel: 'WhatsApp number',
    placeholder: '+254 700 000 000',
    showUrl: false,
  },
  sms: { label: 'SMS', valueLabel: 'SMS number', placeholder: '+254 700 000 000', showUrl: false },
  email: {
    label: 'Email',
    valueLabel: 'Email address',
    placeholder: 'help@yourcompany.com',
    showUrl: false,
  },
  location: {
    label: 'Location / branch',
    valueLabel: 'Address',
    placeholder: 'Street, building, town',
    showUrl: true,
  },
  website: {
    label: 'Website / chat page',
    valueLabel: 'Page URL',
    placeholder: 'https://',
    showUrl: true,
  },
  telegram: {
    label: 'Telegram',
    valueLabel: 'Username',
    placeholder: '@yourcompany',
    showUrl: false,
  },
  other: { label: 'Other', valueLabel: 'Details', placeholder: '', showUrl: true },
};

const fieldClass =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';
const labelClass = 'mb-1 block text-[11px] font-semibold uppercase tracking-wider text-fg-subtle';
const cardClass = 'space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4 sm:p-5';
const iconBtnClass =
  'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-fg-muted hover:text-fg-strong disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-indigo-500';
const addBtnClass =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-surface px-4 py-2 text-sm font-medium text-fg-strong hover:border-indigo-500 disabled:opacity-50';

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: { id: string; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children({ id, 'aria-describedby': hintId })}
      {hint ? (
        <p id={hintId} className="mt-1 text-[11px] text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function RowControls({
  index,
  count,
  noun,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  noun: string;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <div className="flex gap-2">
      <button
        type="button"
        className={iconBtnClass}
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
        aria-label={`Move ${noun} ${n} up`}
      >
        <ArrowUp className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={iconBtnClass}
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
        aria-label={`Move ${noun} ${n} down`}
      >
        <ArrowDown className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${iconBtnClass} hover:text-red-600`}
        onClick={onRemove}
        aria-label={`Remove ${noun} ${n}`}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function AdminCompanySupportClient({
  settingsPromise,
}: {
  settingsPromise: Promise<CompanySettingsRow>;
}) {
  const initial = use(settingsPromise);
  const [support, setSupport] = useState<CompanySupportConfig>(() =>
    resolveSupportConfig(initial.uiConfig?.support),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const patch = (next: Partial<CompanySupportConfig>) =>
    setSupport((prev) => ({ ...prev, ...next }));

  const updateChannel = (id: string, changes: Partial<SupportChannel>) =>
    patch({ channels: support.channels.map((c) => (c.id === id ? { ...c, ...changes } : c)) });

  const onSave = () => {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const updated = await updateCompanySupportAction(support);
        // Show exactly what was stored (incomplete rows are dropped server-side).
        setSupport(resolveSupportConfig(updated.uiConfig?.support));
        setMessage('Support settings saved. The storefront now shows the changes.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save support settings');
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-fg-strong">
            <LifeBuoy className="h-5 w-5 text-indigo-400" aria-hidden="true" />
            Customer support
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Everything customers see in the storefront help section. Nothing is pre-filled — add
            only what applies to your business. If nothing is added, the help entry is hidden.
          </p>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          <Save className="h-4 w-4" aria-hidden="true" />
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div aria-live="polite">
        {message ? (
          <div
            role="status"
            className="rounded-lg border border-emerald-800 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
          >
            {message}
          </div>
        ) : null}
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-800 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      ) : null}

      <section className={cardClass} aria-labelledby="support-names">
        <h3 id="support-names" className="text-sm font-bold text-fg-strong">
          Section names
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Support section name"
            hint="Used for the storefront menu, footer and help window title."
          >
            {(p) => (
              <input
                {...p}
                className={fieldClass}
                maxLength={SUPPORT_LIMITS.name}
                value={support.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            )}
          </Field>
          <Field label="Subtitle (optional)">
            {(p) => (
              <input
                {...p}
                className={fieldClass}
                maxLength={SUPPORT_LIMITS.subtitle}
                value={support.subtitle}
                onChange={(e) => patch({ subtitle: e.target.value })}
              />
            )}
          </Field>
          <Field label="Guarantees heading">
            {(p) => (
              <input
                {...p}
                className={fieldClass}
                maxLength={SUPPORT_LIMITS.title}
                value={support.guaranteesTitle}
                onChange={(e) => patch({ guaranteesTitle: e.target.value })}
              />
            )}
          </Field>
          <Field label="FAQs heading">
            {(p) => (
              <input
                {...p}
                className={fieldClass}
                maxLength={SUPPORT_LIMITS.title}
                value={support.faqsTitle}
                onChange={(e) => patch({ faqsTitle: e.target.value })}
              />
            )}
          </Field>
        </div>
      </section>

      <section className={cardClass} aria-labelledby="support-channels">
        <h3 id="support-channels" className="text-sm font-bold text-fg-strong">
          Contact channels
        </h3>
        <p className="text-xs text-fg-muted">
          Phone, WhatsApp, email, branch locations — add as many as you need (up to{' '}
          {SUPPORT_LIMITS.channels}). Rows without a value are discarded on save.
        </p>
        <ul className="space-y-3">
          {support.channels.map((channel, index) => {
            const meta = KIND_META[channel.kind];
            return (
              <li
                key={channel.id}
                className="space-y-3 rounded-lg border border-line bg-surface p-3 sm:p-4"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Type">
                    {(p) => (
                      <select
                        {...p}
                        className={fieldClass}
                        value={channel.kind}
                        onChange={(e) =>
                          updateChannel(channel.id, { kind: e.target.value as SupportChannelKind })
                        }
                      >
                        {SUPPORT_CHANNEL_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {KIND_META[k].label}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label="Heading shown to customers">
                    {(p) => (
                      <input
                        {...p}
                        className={fieldClass}
                        maxLength={SUPPORT_LIMITS.label}
                        placeholder={meta.label}
                        value={channel.label}
                        onChange={(e) => updateChannel(channel.id, { label: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label={meta.valueLabel}>
                    {(p) => (
                      <input
                        {...p}
                        className={fieldClass}
                        maxLength={SUPPORT_LIMITS.value}
                        placeholder={meta.placeholder}
                        value={channel.value}
                        onChange={(e) => updateChannel(channel.id, { value: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Note, e.g. opening hours (optional)">
                    {(p) => (
                      <input
                        {...p}
                        className={fieldClass}
                        maxLength={SUPPORT_LIMITS.detail}
                        value={channel.detail}
                        onChange={(e) => updateChannel(channel.id, { detail: e.target.value })}
                      />
                    )}
                  </Field>
                  {meta.showUrl ? (
                    <div className="sm:col-span-2">
                      <Field
                        label="Link (optional)"
                        hint="Must start with http:// or https://, e.g. a map pin."
                      >
                        {(p) => (
                          <input
                            {...p}
                            type="url"
                            inputMode="url"
                            className={fieldClass}
                            maxLength={SUPPORT_LIMITS.url}
                            placeholder="https://"
                            value={channel.url}
                            onChange={(e) => updateChannel(channel.id, { url: e.target.value })}
                          />
                        )}
                      </Field>
                    </div>
                  ) : null}
                </div>
                <RowControls
                  index={index}
                  count={support.channels.length}
                  noun="channel"
                  onMove={(to) => patch({ channels: move(support.channels, index, to) })}
                  onRemove={() =>
                    patch({ channels: support.channels.filter((c) => c.id !== channel.id) })
                  }
                />
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className={addBtnClass}
          disabled={support.channels.length >= SUPPORT_LIMITS.channels}
          onClick={() =>
            patch({
              channels: [
                ...support.channels,
                { id: newId(), kind: 'phone', label: '', value: '', detail: '', url: '' },
              ],
            })
          }
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Add channel
        </button>
      </section>

      <section className={cardClass} aria-labelledby="support-guarantees">
        <h3 id="support-guarantees" className="text-sm font-bold text-fg-strong">
          {support.guaranteesTitle || 'Guarantees'}
        </h3>
        <ul className="space-y-3">
          {support.guarantees.map((g, index) => (
            <li
              key={g.id}
              className="space-y-3 rounded-lg border border-line bg-surface p-3 sm:p-4"
            >
              <Field label={`Guarantee ${index + 1}`}>
                {(p) => (
                  <input
                    {...p}
                    className={fieldClass}
                    maxLength={SUPPORT_LIMITS.guarantee}
                    value={g.text}
                    onChange={(e) =>
                      patch({
                        guarantees: support.guarantees.map((x) =>
                          x.id === g.id ? { ...x, text: e.target.value } : x,
                        ),
                      })
                    }
                  />
                )}
              </Field>
              <RowControls
                index={index}
                count={support.guarantees.length}
                noun="guarantee"
                onMove={(to) => patch({ guarantees: move(support.guarantees, index, to) })}
                onRemove={() =>
                  patch({ guarantees: support.guarantees.filter((x) => x.id !== g.id) })
                }
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={addBtnClass}
          disabled={support.guarantees.length >= SUPPORT_LIMITS.guarantees}
          onClick={() => patch({ guarantees: [...support.guarantees, { id: newId(), text: '' }] })}
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Add guarantee
        </button>
      </section>

      <section className={cardClass} aria-labelledby="support-faqs">
        <h3 id="support-faqs" className="text-sm font-bold text-fg-strong">
          {support.faqsTitle || 'FAQs'}
        </h3>
        <p className="text-xs text-fg-muted">
          Both question and answer are required; incomplete rows are discarded on save.
        </p>
        <ul className="space-y-3">
          {support.faqs.map((faq, index) => (
            <li
              key={faq.id}
              className="space-y-3 rounded-lg border border-line bg-surface p-3 sm:p-4"
            >
              <Field label={`Question ${index + 1}`}>
                {(p) => (
                  <input
                    {...p}
                    className={fieldClass}
                    maxLength={SUPPORT_LIMITS.question}
                    value={faq.question}
                    onChange={(e) =>
                      patch({
                        faqs: support.faqs.map((x) =>
                          x.id === faq.id ? { ...x, question: e.target.value } : x,
                        ),
                      })
                    }
                  />
                )}
              </Field>
              <Field label={`Answer ${index + 1}`}>
                {(p) => (
                  <textarea
                    {...p}
                    rows={3}
                    className={fieldClass}
                    maxLength={SUPPORT_LIMITS.answer}
                    value={faq.answer}
                    onChange={(e) =>
                      patch({
                        faqs: support.faqs.map((x) =>
                          x.id === faq.id ? { ...x, answer: e.target.value } : x,
                        ),
                      })
                    }
                  />
                )}
              </Field>
              <RowControls
                index={index}
                count={support.faqs.length}
                noun="FAQ"
                onMove={(to) => patch({ faqs: move(support.faqs, index, to) })}
                onRemove={() => patch({ faqs: support.faqs.filter((x) => x.id !== faq.id) })}
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={addBtnClass}
          disabled={support.faqs.length >= SUPPORT_LIMITS.faqs}
          onClick={() =>
            patch({ faqs: [...support.faqs, { id: newId(), question: '', answer: '' }] })
          }
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Add FAQ
        </button>
      </section>
    </div>
  );
}
