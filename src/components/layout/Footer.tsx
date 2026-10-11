'use client';

import React from 'react';
import { Truck, Receipt } from 'lucide-react';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import { SUPPORT_CHANNEL_ICONS } from '@/components/store/CustomerHelpModal';
import { supportChannelHref } from '@/config/company-ui';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

interface FooterProps {
  company: Pick<
    CompanySettingsRow,
    | 'tradingName'
    | 'legalName'
    | 'tagline'
    | 'logoUrl'
    | 'accentColor'
    | 'streetAddress'
    | 'city'
    | 'country'
  >;
  onOpenTrackOrder?: () => void;
  onOpenHelp?: () => void;
}

export function Footer({ company, onOpenTrackOrder, onOpenHelp }: FooterProps) {
  const { support } = useCompanyUiConfig();
  const hasHelp = support.faqs.length > 0 || support.guarantees.length > 0;
  return (
    <footer className="mt-16 w-full border-t border-line bg-surface py-10 text-xs text-fg-muted">
      <div className="storefront-shell space-y-8">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          <div className="space-y-3 md:col-span-1">
            <CompanyBrand
              tradingName={company.tradingName}
              tagline={company.tagline}
              logoUrl={company.logoUrl}
              accentColor={company.accentColor}
              size="sm"
            />
            <p className="max-w-sm text-xs leading-relaxed text-fg-muted">
              {company.tagline ? `${company.legalName} — ${company.tagline}.` : company.legalName}
              {company.streetAddress
                ? ` ${company.streetAddress}, ${company.city}, ${company.country}.`
                : ''}
            </p>
          </div>

          <div className="space-y-3 md:col-span-2">
            <h4 className="text-[10px] font-bold tracking-wider text-fg-strong uppercase">
              {support.name}
            </h4>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs text-fg-muted sm:grid-cols-2">
              {onOpenTrackOrder ? (
                <li>
                  <button
                    type="button"
                    onClick={onOpenTrackOrder}
                    className="flex min-h-8 cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-fg-strong"
                  >
                    <Truck className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" /> Track My
                    Order
                  </button>
                </li>
              ) : null}
              {onOpenHelp && hasHelp ? (
                <li>
                  <button
                    type="button"
                    onClick={onOpenHelp}
                    className="flex min-h-8 cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-fg-strong"
                  >
                    <Receipt className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />{' '}
                    {support.faqs.length > 0 ? support.faqsTitle : support.guaranteesTitle}
                  </button>
                </li>
              ) : null}
              {support.channels.map((channel) => {
                const Icon = SUPPORT_CHANNEL_ICONS[channel.kind];
                const href = supportChannelHref(channel);
                const external = href?.startsWith('http') === true;
                return (
                  <li key={channel.id} className="flex min-h-8 items-start gap-1.5">
                    <Icon
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400"
                      aria-hidden="true"
                    />
                    {href ? (
                      <a
                        href={href}
                        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                        aria-label={
                          channel.label ? `${channel.label}: ${channel.value}` : undefined
                        }
                        className="break-words text-fg hover:text-fg-strong hover:underline"
                      >
                        {channel.value}
                      </a>
                    ) : (
                      <span className="break-words text-fg">{channel.value}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-3 border-t border-line pt-6 text-[11px] text-fg-subtle sm:flex-row">
          <div>
            © {new Date().getFullYear()} {company.tradingName}. All Rights Reserved.
          </div>
          <div className="flex items-center gap-4">
            <span className="text-fg-muted">Privacy Policy</span>
            <span className="text-fg-faint">•</span>
            <span className="text-fg-muted">Terms of Service</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
