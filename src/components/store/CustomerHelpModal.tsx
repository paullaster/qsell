'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import {
  X,
  HelpCircle,
  Phone,
  Mail,
  MapPin,
  MessageCircle,
  Globe,
  Send,
  CheckCircle2,
  ChevronDown,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import { supportChannelHref, type SupportChannelKind } from '@/config/company-ui';

interface CustomerHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SUPPORT_CHANNEL_ICONS: Record<SupportChannelKind, LucideIcon> = {
  phone: Phone,
  whatsapp: MessageCircle,
  sms: MessageCircle,
  email: Mail,
  location: MapPin,
  website: Globe,
  telegram: Send,
  other: HelpCircle,
};

export function CustomerHelpModal({ isOpen, onClose }: CustomerHelpModalProps) {
  const { support } = useCompanyUiConfig();
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-backdrop/85 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex min-h-dvh w-full max-w-2xl flex-col overflow-hidden border border-line bg-surface-raised shadow-2xl sm:my-4 sm:max-h-[calc(100dvh-2rem)] sm:min-h-0 sm:rounded-2xl lg:max-h-[90vh]"
      >
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface p-4 sm:p-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-600/10 text-indigo-400 sm:h-10 sm:w-10">
              <HelpCircle className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id={titleId} className="text-sm font-bold text-fg-strong sm:text-base">
                {support.name}
              </h2>
              {support.subtitle ? (
                <p className="text-xs text-fg-muted sm:text-xs">{support.subtitle}</p>
              ) : null}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface-raised text-fg-muted transition-colors hover:text-fg-strong"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:space-y-6 sm:p-6">
          {support.channels.length > 0 ? (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {support.channels.map((channel) => {
                const Icon = SUPPORT_CHANNEL_ICONS[channel.kind];
                const href = supportChannelHref(channel);
                const external = href?.startsWith('http') === true;
                return (
                  <li
                    key={channel.id}
                    className="space-y-1 rounded-xl border border-line bg-surface p-3.5"
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-fg-strong">
                      <Icon className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                      {channel.label || channel.kind}
                    </div>
                    {href ? (
                      <a
                        href={href}
                        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                        className="block min-h-6 text-xs break-words text-indigo-400 underline-offset-2 hover:underline"
                      >
                        {channel.value}
                      </a>
                    ) : (
                      <p className="text-xs break-words text-fg-muted">{channel.value}</p>
                    )}
                    {channel.detail ? (
                      <span className="block text-xs text-fg-subtle">{channel.detail}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {support.guarantees.length > 0 ? (
            <section className="space-y-3 rounded-xl border border-line bg-surface p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
                <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                {support.guaranteesTitle}
              </h3>
              <ul className="grid grid-cols-1 gap-2 text-xs text-fg sm:grid-cols-2">
                {support.guarantees.map((g) => (
                  <li key={g.id} className="flex items-start gap-2">
                    <CheckCircle2
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600"
                      aria-hidden="true"
                    />
                    <span>{g.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {support.faqs.length > 0 ? (
            <section className="space-y-2.5">
              <h3 className="text-xs font-bold tracking-wider text-indigo-400 uppercase">
                {support.faqsTitle}
              </h3>
              <div className="space-y-2">
                {support.faqs.map((faq) => {
                  const open = openFaq === faq.id;
                  const panelId = `${titleId}-faq-${faq.id}`;
                  return (
                    <div
                      key={faq.id}
                      className="overflow-hidden rounded-xl border border-line bg-surface transition-colors"
                    >
                      <h4>
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={panelId}
                          onClick={() => setOpenFaq(open ? null : faq.id)}
                          className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 p-3.5 text-left text-xs font-semibold text-fg-strong hover:text-indigo-300"
                        >
                          <span>{faq.question}</span>
                          <ChevronDown
                            aria-hidden="true"
                            className={`h-4 w-4 shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180 text-indigo-400' : ''}`}
                          />
                        </button>
                      </h4>
                      {open ? (
                        <div
                          id={panelId}
                          className="border-t border-line/80 px-3.5 pt-2.5 pb-3.5 text-xs leading-relaxed whitespace-pre-line text-fg-muted"
                        >
                          {faq.answer}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>

        <div className="flex items-center justify-end border-t border-line bg-surface p-4 sm:p-5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
