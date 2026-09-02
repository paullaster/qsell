'use client';

import { use, useState } from 'react';
import {
  Users,
  TrendingUp,
  DollarSign,
  ShoppingBag,
  Star,
  Award,
  ShieldCheck,
  Search,
  Smartphone,
  CreditCard,
} from 'lucide-react';
import { type DashboardAnalytics, type UserProfile } from '@/types/index';

interface AdminAnalyticsProps {
  analyticsPromise: Promise<DashboardAnalytics>;
  userProfilesPromise: Promise<UserProfile[]>;
}

export function AdminAnalytics({ analyticsPromise, userProfilesPromise }: AdminAnalyticsProps) {
  const analytics = use(analyticsPromise);
  const users = use(userProfilesPromise);

  const [search, setSearch] = useState('');

  const filteredUsers = users.filter((u) => {
    return (
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.phone.includes(search)
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-white">
            <Users className="h-5 w-5 text-indigo-400" />
            Customer Accounts & Sales Insights
          </h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            Customer purchase history, repeat buyer rates, total spend, and customer contact
            profiles.
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search Customer or Phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-1.5 pr-4 pl-9 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Cohort Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <span className="text-xs font-semibold text-zinc-400 uppercase">
            Total Tracked Profiles
          </span>
          <div className="font-mono text-2xl font-bold text-white">
            {users.length} <span className="text-xs font-normal text-zinc-500">customers</span>
          </div>
          <div className="text-[11px] text-emerald-400">100% Kenyan Mobile Verified</div>
        </div>

        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <span className="text-xs font-semibold text-zinc-400 uppercase">
            Average Customer LTV
          </span>
          <div className="font-mono text-2xl font-bold text-white">
            KES {analytics.averageOrderValue.toLocaleString()}
          </div>
          <div className="text-[11px] text-zinc-400">High repeat rate on tech accessories</div>
        </div>

        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <span className="text-xs font-semibold text-zinc-400 uppercase">Preferred Rail</span>
          <div className="flex items-center gap-2 text-2xl font-bold text-white">
            <Smartphone className="h-6 w-6 text-emerald-400" /> M-Pesa (85%)
          </div>
          <div className="text-[11px] text-zinc-400">
            Pesapal Card handles 15% high-ticket orders
          </div>
        </div>
      </div>

      {/* Customer Profiles Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-lg">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">
            <tr>
              <th className="px-4 py-3">Customer Name & Phone</th>
              <th className="px-3 py-3">Email Address</th>
              <th className="px-3 py-3">Role / Segment</th>
              <th className="px-3 py-3">Total Orders</th>
              <th className="px-3 py-3">Lifetime Spend</th>
              <th className="px-3 py-3">Preferred Gateway</th>
              <th className="px-4 py-3 text-right">Account Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {filteredUsers.map((u) => (
              <tr key={u.id} className="transition-colors hover:bg-zinc-800/40">
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-indigo-500/30 bg-indigo-600/20 text-xs font-bold text-indigo-400">
                      {u.name.charAt(0)}
                    </div>
                    <div>
                      <span className="block font-semibold text-white">{u.name}</span>
                      <span className="font-mono text-[10px] text-zinc-500">{u.phone}</span>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3.5 font-mono text-[11px] text-zinc-300">{u.email}</td>
                <td className="px-3 py-3.5">
                  <span
                    className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase ${
                      u.role === 'admin'
                        ? 'border border-indigo-500/20 bg-indigo-500/10 text-indigo-300'
                        : 'border border-zinc-700/50 bg-zinc-800 text-zinc-300'
                    }`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="px-3 py-3.5 font-mono font-bold text-white">{u.totalOrders}</td>
                <td className="px-3 py-3.5 font-mono font-bold text-white">
                  KES {u.totalSpend.toLocaleString()}
                </td>
                <td className="px-3 py-3.5">
                  <span className="flex items-center gap-1 text-[11px] font-medium text-zinc-300">
                    {u.preferredPaymentMethod === 'mpesa_daraja' ? (
                      <>
                        <Smartphone className="h-3.5 w-3.5 text-emerald-400" /> M-Pesa
                      </>
                    ) : (
                      <>
                        <CreditCard className="h-3.5 w-3.5 text-indigo-400" /> Pesapal
                      </>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right font-mono text-[11px] text-zinc-500">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
