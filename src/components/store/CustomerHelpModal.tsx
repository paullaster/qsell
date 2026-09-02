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
  ChevronDown
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
      a: 'When you select M-Pesa and click "Place Order", you will receive an instant pop-up prompt on your mobile phone. Simply enter your 4-digit M-Pesa PIN on your phone to complete payment. Your order and receipt are confirmed immediately.'
    },
    {
      q: 'What are the delivery timelines across Kenya?',
      a: 'Nairobi Metropolitan orders placed before 3:00 PM are dispatched same-day within 2 to 4 hours. Countrywide deliveries (Mombasa, Kisumu, Nakuru, Eldoret, Thika, etc.) are fulfilled via secure courier within 24 to 48 hours. Orders over KES 100,000 qualify for 100% Free Express Delivery.'
    },
    {
      q: 'Can I pay with Visa, Mastercard, or Airtel Money?',
      a: 'Yes! Select Pesapal v3.0 at checkout. You can securely pay with any Kenyan or International Visa, Mastercard, Airtel Money, or direct Bank transfer. Transactions are protected by 3D Secure 2.0 bank OTP verification.'
    },
    {
      q: 'Do you provide official KRA eTIMS Tax Invoices?',
      a: 'Yes. Every completed order automatically generates an electronic tax invoice compliant with Kenya Revenue Authority (KRA) eTIMS requirements with our PIN: P051892011Z, suitable for business expense deductions.'
    },
    {
      q: 'What is your warranty and returns policy?',
      a: 'All brand-new laptops, smartphones, audio gear, and accessories include a 1-Year Official Manufacturer Warranty. We offer a 7-day hassle-free replacement guarantee for any factory-sealed or transit-damaged items.'
    }
  ];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/85 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center animate-fade-in">
      <div className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8 max-h-[90vh]">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <HelpCircle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-white">Customer Support & FAQs</h2>
              <p className="text-xs text-zinc-400">Delivery details, payment instructions & warranties</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
          {/* Quick Contact Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <Phone className="w-3.5 h-3.5 text-emerald-400" /> Phone & WhatsApp
              </div>
              <p className="text-zinc-400 text-xs font-mono">+254 712 345 678</p>
              <span className="text-[10px] text-zinc-500 block">Mon-Sat 8AM - 8PM</span>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <Mail className="w-3.5 h-3.5 text-indigo-400" /> Email Support
              </div>
              <p className="text-zinc-400 text-xs font-mono">support@corecommerce.co.ke</p>
              <span className="text-[10px] text-zinc-500 block">Fast 15-min response</span>
            </div>

            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <Truck className="w-3.5 h-3.5 text-amber-400" /> Nairobi Hub
              </div>
              <p className="text-zinc-400 text-xs">Delta Corner, Westlands</p>
              <span className="text-[10px] text-zinc-500 block">Express Dispatch Center</span>
            </div>
          </div>

          {/* Delivery & Assurance Pills */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" /> Our Customer Guarantees
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-zinc-300">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>100% Genuine brand-new hardware with 1-Year Official Warranty</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>Instant M-Pesa STK PIN reconciliation with zero delays</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>eTIMS compliant electronic receipt emailed immediately</span>
              </div>
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                <span>Dedicated customer courier tracking from hub to door</span>
              </div>
            </div>
          </div>

          {/* Accordion FAQs */}
          <div className="space-y-2.5">
            <h4 className="text-xs font-bold uppercase tracking-wider text-indigo-400">
              Frequently Asked Questions
            </h4>
            <div className="space-y-2">
              {faqs.map((faq, index) => {
                const isOpen = openFaq === index;
                return (
                  <div 
                    key={index}
                    className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden transition-colors"
                  >
                    <button
                      onClick={() => setOpenFaq(isOpen ? null : index)}
                      className="w-full p-3.5 text-left flex items-center justify-between gap-3 text-xs font-semibold text-white hover:text-indigo-300 cursor-pointer"
                    >
                      <span>{faq.q}</span>
                      <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${isOpen ? 'rotate-180 text-indigo-400' : ''}`} />
                    </button>
                    {isOpen && (
                      <div className="px-3.5 pb-3.5 text-xs text-zinc-400 leading-relaxed border-t border-zinc-800/80 pt-2.5">
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
        <div className="p-4 sm:p-5 border-t border-zinc-800 bg-zinc-950 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition-colors cursor-pointer"
          >
            Got It, Thanks!
          </button>
        </div>
      </div>
    </div>
  );
}
