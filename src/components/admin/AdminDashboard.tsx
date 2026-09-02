'use client';

import { use } from 'react';
import { 
  TrendingUp, 
  DollarSign, 
  ShoppingBag, 
  AlertTriangle, 
  CheckCircle2, 
  Smartphone, 
  CreditCard, 
  Layers, 
  ArrowUpRight,
  ShieldCheck,
  Zap,
  Activity
} from 'lucide-react';
import { DashboardAnalytics } from '@/types/index';

interface AdminDashboardProps {
  analyticsPromise: Promise<DashboardAnalytics>;
  onNavigateTab: (tab: 'inventory' | 'gateways' | 'reconciliation' | 'orders') => void;
}

export function AdminDashboard({ analyticsPromise, onNavigateTab }: AdminDashboardProps) {
  const analytics = use(analyticsPromise);

  return (
    <div className="space-y-6">
      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total GMV Revenue */}
        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3 shadow-lg flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Gross Revenue</span>
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <DollarSign className="w-3.5 h-3.5" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-white">
              KES {analytics.totalRevenue.toLocaleString()}
            </div>
            <div className="flex items-center gap-1 text-[11px] text-emerald-400 mt-1">
              <TrendingUp className="w-3 h-3" /> +14.2% vs previous period
            </div>
          </div>
        </div>

        {/* Total Orders */}
        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3 shadow-lg flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Orders Processed</span>
            <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <ShoppingBag className="w-3.5 h-3.5" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-white">
              {analytics.totalOrders} <span className="text-xs font-normal text-zinc-500">orders</span>
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">
              Avg Order: <span className="font-mono text-zinc-200">KES {analytics.averageOrderValue.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Real-time Reconciliation Match Rate */}
        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3 shadow-lg flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Reconciliation Rate</span>
            <div className="w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <ShieldCheck className="w-3.5 h-3.5" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-indigo-400">
              {analytics.reconciliationRate}%
            </div>
            <div className="flex items-center gap-1 text-[11px] text-emerald-400 mt-1">
              <CheckCircle2 className="w-3 h-3" /> Zero unresolved discrepancies
            </div>
          </div>
        </div>

        {/* Low Stock Alerts */}
        <div 
          onClick={() => onNavigateTab('inventory')}
          className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-3 shadow-lg cursor-pointer hover:border-zinc-700 transition-colors group flex flex-col justify-between"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Low Stock SKUs</span>
            <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 group-hover:scale-110 transition-transform">
              <AlertTriangle className="w-3.5 h-3.5" />
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-amber-400">
              {analytics.lowStockAlertsCount} <span className="text-xs font-normal text-zinc-500">alerts</span>
            </div>
            <div className="text-[11px] text-indigo-400 mt-1 flex items-center gap-1 group-hover:underline">
              Manage inventory <ArrowUpRight className="w-3 h-3" />
            </div>
          </div>
        </div>
      </div>

      {/* Analytics Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Payment Gateways Performance */}
        <div className="lg:col-span-6 p-6 rounded-xl bg-zinc-900 border border-zinc-800 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-sm text-white">Payment Method Distribution</h3>
              <p className="text-xs text-zinc-500">Daraja LNMO vs Pesapal v3 Settlement Breakdown</p>
            </div>
            <button
              onClick={() => onNavigateTab('gateways')}
              className="text-xs text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1 cursor-pointer"
            >
              Config <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>

          <div className="space-y-4">
            {analytics.salesByPaymentMethod.map((method) => {
              const isMpesa = method.provider === 'mpesa_daraja';
              const isPesapal = method.provider === 'pesapal_v3';
              const Icon = isMpesa ? Smartphone : CreditCard;
              const barColor = isMpesa ? 'bg-emerald-500' : isPesapal ? 'bg-indigo-600' : 'bg-indigo-400';

              return (
                <div key={method.provider} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Icon className={`w-3.5 h-3.5 ${isMpesa ? 'text-emerald-400' : 'text-indigo-400'}`} />
                      <span className="text-zinc-200 font-medium">{method.name}</span>
                      <span className="text-[10px] text-zinc-500 font-mono">({method.count} orders)</span>
                    </div>
                    <div className="font-mono text-zinc-200">
                      KES {method.amount.toLocaleString()} ({method.percentage}%)
                    </div>
                  </div>
                  {/* Progress Bar */}
                  <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: `${Math.max(4, method.percentage)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Real-time Hourly Velocity */}
        <div className="lg:col-span-6 p-6 rounded-xl bg-zinc-900 border border-zinc-800 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-bold text-sm text-white">Intraday Sales Velocity</h3>
              <p className="text-xs text-zinc-500">Real-time hourly volume & transaction flow</p>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 text-[10px] font-mono border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981]"></span> LIVE
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-6 gap-2 text-center">
              {analytics.recentHourlySales.map((h) => (
                <div key={h.time} className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1">
                  <div className="text-[10px] font-mono text-zinc-500">{h.time}</div>
                  <div className="text-xs font-bold text-white font-mono">
                    KES {(h.sales / 1000).toFixed(0)}k
                  </div>
                  <div className="text-[9px] text-zinc-500">{h.orders} orders</div>
                </div>
              ))}
            </div>

            <div className="p-3.5 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between text-xs">
              <span className="text-zinc-400 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" /> Payment Verification:
              </span>
              <span className="font-mono text-emerald-400 font-semibold">Active (Automatic Settlement)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
