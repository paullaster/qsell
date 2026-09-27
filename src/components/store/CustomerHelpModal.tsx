'use client';

import React, { useState } from 'react';
import {
  X,
  Truck,
  Smartphone,
  CreditCard,
  ShieldCheck,
  HelpCircle,
  Phone,
  Mail,
  Clock,
  CheckCircle2,
  ChevronDown,
} from 'lucide-react';

interface CustomerHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CustomerHelpModal({ isOpen, onClose }: CustomerHelpModalProps) {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  if (!isOpen) return null;

  const faqs = [
    {
      q: 'How does M-Pesa Express checkout work?',
      a: 'When you select M-Pesa and click "Place Order", you will receive an instant pop-up prompt on your mobile phone. Simply enter your 4-digit M-Pesa PIN on your phone to complete payment. Your order and receipt are confirmed immediately.',
    },
    {
      q: 'What are the delivery timelines across Kenya?',
      a: 'Nairobi Metropolitan orders placed before 3:00 PM are dispatched same-day within 2 to 4 hours. Countrywide deliveries (Mombasa, Kisumu, Nakuru, Eldoret, Thika, etc.) are fulfilled via secure courier within 24 to 48 hours. Orders over KES 100,000 qualify for 100% Free Express Delivery.',
    },
    {
      q: 'Can I pay with Visa, Mastercard, or Airtel Money?',
      a: 'Yes! Select Pesapal v3.0 at checkout. You can securely pay with any Kenyan or International Visa, Mastercard, Airtel Money, or direct Bank transfer. Transactions are protected by 3D Secure 2.0 bank OTP verification.',
    },
    {
      q: 'Do you provide official KRA eTIMS Tax Invoices?',
      a: 'Yes. Every completed order automatically generates an electronic tax invoice compliant with Kenya Revenue Authority (KRA) eTIMS requirements with our PIN: P051892011Z, suitable for business expense deductions.',
    },
    {
      q: 'What is your warranty and returns policy?',
      a: 'All brand-new laptops, smartphones, audio gear, and accessories include a 1-Year Official Manufacturer Warranty. We offer a 7-day hassle-free replacement guarantee for any factory-sealed or transit-damaged items.',
    },
  ];

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-backdrop/85 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <div className="relative flex min-h-dvh w-full max-w-2xl flex-col overflow-hidden border border-line bg-surface-raised shadow-2xl sm:my-4 sm:min-h-0 sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl lg:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface p-4 sm:p-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-600/10 text-indigo-400 sm:h-10 sm:w-10">
              <HelpCircle className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-fg-strong sm:text-base">Customer Support & FAQs</h2>
              <p className="line-clamp-1 text-[11px] text-fg-muted sm:text-xs">
                Delivery details, payment instructions & warranties
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-line bg-surface-raised p-2 text-fg-muted transition-colors hover:text-fg-strong"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:space-y-6 sm:p-6">
          {/* Quick Contact Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1 rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-fg-strong">
                <Phone className="h-3.5 w-3.5 text-emerald-600" /> Phone & WhatsApp
              </div>
              <p className="font-mono text-xs text-fg-muted">+254 712 345 678</p>
              <span className="block text-[10px] text-fg-subtle">Mon-Sat 8AM - 8PM</span>
            </div>

            <div className="space-y-1 rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-fg-strong">
                <Mail className="h-3.5 w-3.5 text-indigo-400" /> Email Support
              </div>
              <p className="font-mono text-xs text-fg-muted">support@corecommerce.co.ke</p>
              <span className="block text-[10px] text-fg-subtle">Fast 15-min response</span>
            </div>

            <div className="space-y-1 rounded-xl border border-line bg-surface p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-fg-strong">
                <Truck className="h-3.5 w-3.5 text-amber-600" /> Nairobi Hub
              </div>
              <p className="text-xs text-fg-muted">Delta Corner, Westlands</p>
              <span className="block text-[10px] text-fg-subtle">Express Dispatch Center</span>
            </div>
          </div>

          {/* Delivery & Assurance Pills */}
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
            <h4 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
              <ShieldCheck className="h-4 w-4 text-emerald-600" /> Our Customer Guarantees
            </h4>
            <div className="grid grid-cols-1 gap-2 text-xs text-fg sm:grid-cols-2">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>100% Genuine brand-new hardware with 1-Year Official Warranty</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>Instant M-Pesa STK PIN reconciliation with zero delays</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>eTIMS compliant electronic receipt emailed immediately</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>Dedicated customer courier tracking from hub to door</span>
              </div>
            </div>
          </div>

          {/* Accordion FAQs */}
          <div className="space-y-2.5">
            <h4 className="text-xs font-bold tracking-wider text-indigo-400 uppercase">
              Frequently Asked Questions
            </h4>
            <div className="space-y-2">
              {faqs.map((faq, index) => {
                const isOpen = openFaq === index;
                return (
                  <div
                    key={index}
                    className="overflow-hidden rounded-xl border border-line bg-surface transition-colors"
                  >
                    <button
                      onClick={() => setOpenFaq(isOpen ? null : index)}
                      className="flex w-full cursor-pointer items-center justify-between gap-3 p-3.5 text-left text-xs font-semibold text-fg-strong hover:text-indigo-300"
                    >
                      <span>{faq.q}</span>
                      <ChevronDown
                        className={`h-4 w-4 text-fg-muted transition-transform ${isOpen ? 'rotate-180 text-indigo-400' : ''}`}
                      />
                    </button>
                    {isOpen && (
                      <div className="border-t border-line/80 px-3.5 pt-2.5 pb-3.5 text-xs leading-relaxed text-fg-muted">
                        {faq.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-line bg-surface p-4 sm:p-5">
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Got It, Thanks!
          </button>
        </div>
      </div>
    </div>
  );
}
