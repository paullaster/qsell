'use client';

import React from 'react';
import { Truck, Receipt, Phone, Mail } from 'lucide-react';
import { CompanyBrand } from '@/components/ui/CompanyBrand';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

interface FooterProps {
  company: Pick<
    CompanySettingsRow,
    | 'tradingName'
    | 'legalName'
    | 'tagline'
    | 'logoUrl'
    | 'accentColor'
    | 'phone'
    | 'email'
    | 'streetAddress'
    | 'city'
    | 'country'
  >;
  onOpenTrackOrder?: () => void;
  onOpenHelp?: () => void;
}

export function Footer({ company, onOpenTrackOrder, onOpenHelp }: FooterProps) {
  return (
    <footer className="mt-16 w-full border-t border-zinc-800 bg-zinc-950 py-10 text-xs text-zinc-400">
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
            <p className="max-w-sm text-xs leading-relaxed text-zinc-400">
              {company.tagline
                ? `${company.legalName} — ${company.tagline}.`
                : company.legalName}
              {company.streetAddress ? ` ${company.streetAddress}, ${company.city}, ${company.country}.` : ''}
            </p>
          </div>

          <div className="space-y-3">
            <h4 className="text-[10px] font-bold tracking-wider text-white uppercase">
              Customer Support
            </h4>
            <ul className="space-y-2 text-xs text-zinc-400">
              <li>
                <button
                  onClick={onOpenTrackOrder}
                  className="flex cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-white"
                >
                  <Truck className="h-3.5 w-3.5 text-indigo-400" /> Track My Order
                </button>
              </li>
              <li>
                <button
                  onClick={onOpenHelp}
                  className="flex cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-white"
                >
                  <Receipt className="h-3.5 w-3.5 text-emerald-400" /> Help, Shipping & Returns
                </button>
              </li>
            </ul>
          </div>

          <div className="space-y-3">
            <h4 className="text-[10px] font-bold tracking-wider text-white uppercase">
              Contact & Inquiries
            </h4>
            <div className="space-y-2 text-xs text-zinc-400">
              <div className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span className="text-zinc-300">{company.phone}</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                <span className="text-zinc-300">{company.email}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-3 border-t border-zinc-900 pt-6 text-[11px] text-zinc-500 sm:flex-row">
          <div>
            © {new Date().getFullYear()} {company.tradingName}. All Rights Reserved.
          </div>
          <div className="flex items-center gap-4">
            <span className="text-zinc-400">Privacy Policy</span>
            <span className="text-zinc-700">•</span>
            <span className="text-zinc-400">Terms of Service</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
