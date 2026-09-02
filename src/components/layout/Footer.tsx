'use client';

import React from 'react';
import { 
  Smartphone, 
  CreditCard, 
  ShieldCheck, 
  Truck, 
  Clock, 
  Lock, 
  Phone, 
  Mail, 
  MapPin, 
  Receipt 
} from 'lucide-react';

interface FooterProps {
  onOpenTrackOrder?: () => void;
  onOpenHelp?: () => void;
}

export function Footer({ onOpenTrackOrder, onOpenHelp }: FooterProps) {
  return (
    <footer className="w-full bg-zinc-950 border-t border-zinc-800 text-zinc-400 text-xs py-10 mt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Brand */}
          <div className="space-y-3 md:col-span-1">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-indigo-600 rounded flex items-center justify-center text-white font-bold text-sm">
                C
              </div>
              <span className="font-bold text-white text-base tracking-tight">CoreCommerce</span>
            </div>
            <p className="text-zinc-400 text-xs leading-relaxed max-w-sm">
              Authentic electronics, hardware, and accessories with instant checkout and fast shipping.
            </p>
          </div>

          {/* Quick Links & Customer Care */}
          <div className="space-y-3">
            <h4 className="font-bold text-white uppercase text-[10px] tracking-wider">
              Customer Support
            </h4>
            <ul className="space-y-2 text-zinc-400 text-xs">
              <li>
                <button 
                  onClick={onOpenTrackOrder}
                  className="hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer text-left"
                >
                  <Truck className="w-3.5 h-3.5 text-indigo-400" /> Track My Order
                </button>
              </li>
              <li>
                <button 
                  onClick={onOpenHelp}
                  className="hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer text-left"
                >
                  <Receipt className="w-3.5 h-3.5 text-emerald-400" /> Help, Shipping & Returns
                </button>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div className="space-y-3">
            <h4 className="font-bold text-white uppercase text-[10px] tracking-wider">
              Contact & Inquiries
            </h4>
            <div className="space-y-2 text-xs text-zinc-400">
              <div className="flex items-center gap-2">
                <Phone className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="text-zinc-300">+254 712 345 678</span>
              </div>
              <div className="flex items-center gap-2">
                <Mail className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <span className="text-zinc-300">support@corecommerce.co.ke</span>
              </div>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-zinc-900 flex flex-col sm:flex-row items-center justify-between gap-3 text-zinc-500 text-[11px]">
          <div>
            © {new Date().getFullYear()} CoreCommerce. All Rights Reserved.
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
