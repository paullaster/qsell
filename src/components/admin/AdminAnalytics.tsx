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
  CreditCard
} from 'lucide-react';
import { DashboardAnalytics, UserProfile } from '@/types/index';

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
      <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-bold text-base text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-400" />
            Customer Accounts & Sales Insights
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Customer purchase history, repeat buyer rates, total spend, and customer contact profiles.
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search Customer or Phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-4 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Cohort Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
          <span className="text-xs text-zinc-400 font-semibold uppercase">Total Tracked Profiles</span>
          <div className="text-2xl font-bold font-mono text-white">
            {users.length} <span className="text-xs font-normal text-zinc-500">customers</span>
          </div>
          <div className="text-[11px] text-emerald-400">
            100% Kenyan Mobile Verified
          </div>
        </div>

        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
          <span className="text-xs text-zinc-400 font-semibold uppercase">Average Customer LTV</span>
          <div className="text-2xl font-bold font-mono text-white">
            KES {analytics.averageOrderValue.toLocaleString()}
          </div>
          <div className="text-[11px] text-zinc-400">
            High repeat rate on tech accessories
          </div>
        </div>

        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
          <span className="text-xs text-zinc-400 font-semibold uppercase">Preferred Rail</span>
          <div className="text-2xl font-bold text-white flex items-center gap-2">
            <Smartphone className="w-6 h-6 text-emerald-400" /> M-Pesa (85%)
          </div>
          <div className="text-[11px] text-zinc-400">
            Pesapal Card handles 15% high-ticket orders
          </div>
        </div>
      </div>

      {/* Customer Profiles Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-lg">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-950 text-zinc-400 uppercase font-semibold text-[10px] tracking-wider border-b border-zinc-800">
            <tr>
              <th className="py-3 px-4">Customer Name & Phone</th>
              <th className="py-3 px-3">Email Address</th>
              <th className="py-3 px-3">Role / Segment</th>
              <th className="py-3 px-3">Total Orders</th>
              <th className="py-3 px-3">Lifetime Spend</th>
              <th className="py-3 px-3">Preferred Gateway</th>
              <th className="py-3 px-4 text-right">Account Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {filteredUsers.map((u) => (
              <tr key={u.id} className="hover:bg-zinc-800/40 transition-colors">
                <td className="py-3.5 px-4">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-xs">
                      {u.name.charAt(0)}
                    </div>
                    <div>
                      <span className="font-semibold text-white block">{u.name}</span>
                      <span className="text-[10px] font-mono text-zinc-500">{u.phone}</span>
                    </div>
                  </div>
                </td>
                <td className="py-3.5 px-3 text-zinc-300 font-mono text-[11px]">{u.email}</td>
                <td className="py-3.5 px-3">
                  <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${
                    u.role === 'admin'
                      ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/20'
                      : 'bg-zinc-800 text-zinc-300 border border-zinc-700/50'
                  }`}>
                    {u.role}
                  </span>
                </td>
                <td className="py-3.5 px-3 font-mono text-white font-bold">{u.totalOrders}</td>
                <td className="py-3.5 px-3 font-mono font-bold text-white">
                  KES {u.totalSpend.toLocaleString()}
                </td>
                <td className="py-3.5 px-3">
                  <span className="flex items-center gap-1 text-[11px] font-medium text-zinc-300">
                    {u.preferredPaymentMethod === 'mpesa_daraja' ? (
                      <>
                        <Smartphone className="w-3.5 h-3.5 text-emerald-400" /> M-Pesa
                      </>
                    ) : (
                      <>
                        <CreditCard className="w-3.5 h-3.5 text-indigo-400" /> Pesapal
                      </>
                    )}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right font-mono text-zinc-500 text-[11px]">
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
