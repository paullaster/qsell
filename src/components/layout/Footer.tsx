'use client';

import Link from 'next/link';
import { CreditCard, Receipt, Truck } from 'lucide-react';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import { useCompanyUiConfig } from '@/components/company/CompanyUiConfigProvider';
import { SUPPORT_CHANNEL_ICONS } from '@/components/store/CustomerHelpModal';
import { NewsletterForm } from '@/components/store/NewsletterForm';
import { useStore } from '@/components/store/StoreContext';
import { policyAddress, supportChannelHref } from '@/config/company-ui';
import { storefrontHref } from '@/lib/storefront-search';
import { has } from '@/lib/values';

const linkClass = 'inline-flex min-h-10 items-center gap-1.5 text-left text-sm text-fg-muted transition-colors hover:text-fg-strong hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500';
const headingClass = 'text-xs font-bold tracking-wider text-fg-strong uppercase';

export function Footer() {
  const { company, categories, paymentLabels, sessionName, year, openTrackOrder, openHelp } = useStore();
  const { support, policies } = useCompanyUiConfig();
  const hasHelp = support.faqs.length > 0 || support.guarantees.length > 0;
  const topCategories = categories.filter((category) => category.depth === 0).slice(0, 6);
  return (
    <footer className="mt-16 w-full border-t border-line bg-surface py-10 text-fg-muted">
      <div className="storefront-shell space-y-8">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-3">
            <CompanyBrand
              tradingName={company.tradingName}
              tagline={company.tagline}
              logoUrl={company.logoUrl}
              accentColor={company.accentColor}
              size="sm"
            />
            <p className="max-w-sm text-sm leading-relaxed text-fg-muted">
              {has(company.tagline) ? `${company.legalName} — ${company.tagline}.` : company.legalName}
              {has(company.streetAddress) ? ` ${company.streetAddress}, ${company.city}, ${company.country}.` : ''}
            </p>
          </div>

          <nav aria-label="Shop" className="space-y-2">
            <h2 className={headingClass}>Shop</h2>
            <ul>
              <li><Link href={storefrontHref({})} className={linkClass}>All products</Link></li>
              {topCategories.map((category) => (
                <li key={category.id}>
                  <Link href={storefrontHref({ category: category.slug })} className={linkClass}>{category.name}</Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Customer care" className="space-y-2">
            <h2 className={headingClass}>{support.name}</h2>
            <ul>
              <li>
                <button type="button" onClick={openTrackOrder} className={`${linkClass} cursor-pointer`}>
                  <Truck className="h-4 w-4 text-indigo-400" aria-hidden="true" /> Track my order
                </button>
              </li>
              <li><Link href="/help" className={linkClass}>{support.name}: contact &amp; FAQs</Link></li>
              {hasHelp ? (
                <li>
                  <button type="button" onClick={openHelp} className={`${linkClass} cursor-pointer`}>
                    <Receipt className="h-4 w-4 text-emerald-600" aria-hidden="true" />{' '}
                    {support.faqs.length > 0 ? support.faqsTitle : support.guaranteesTitle}
                  </button>
                </li>
              ) : null}
              {support.channels.map((channel) => {
                const Icon = SUPPORT_CHANNEL_ICONS[channel.kind];
                const href = supportChannelHref(channel);
                const external = href?.startsWith('http') === true;
                return (
                  <li key={channel.id} className="flex min-h-10 items-start gap-1.5 py-2 text-sm">
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-400" aria-hidden="true" />
                    {href ? (
                      <a
                        href={href}
                        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                        aria-label={has(channel.label) ? `${channel.label}: ${channel.value}` : undefined}
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
          </nav>

          <nav aria-label="Account and policies" className="space-y-2">
            <h2 className={headingClass}>Account</h2>
            <ul>
              {sessionName === null ? (
                <>
                  <li><Link href="/login" className={linkClass}>Sign in</Link></li>
                  <li><Link href="/register" className={linkClass}>Create an account</Link></li>
                </>
              ) : (
                <>
                  <li><Link href="/profile/orders" className={linkClass}>My orders</Link></li>
                  <li><Link href="/profile/addresses" className={linkClass}>My addresses</Link></li>
                </>
              )}
              {policies.map((page) => (
                <li key={page.id}><Link href={policyAddress(page)} className={linkClass}>{page.title}</Link></li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="max-w-md">
          <NewsletterForm />
        </div>

        <div className="flex flex-col gap-4 border-t border-line pt-6 text-sm text-fg-muted sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {company.tradingName}. All rights reserved.{' '}
            <Link href="/platform" className="underline-offset-2 hover:underline">Powered by qsell business software</Link>
          </p>
          {paymentLabels.length > 0 ? (
            <ul aria-label="Payment methods we accept" className="flex flex-wrap items-center gap-2">
              {paymentLabels.map((label) => (
                <li key={label} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-raised px-2.5 py-1 text-xs font-medium text-fg">
                  <CreditCard className="h-3.5 w-3.5 text-indigo-400" aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
