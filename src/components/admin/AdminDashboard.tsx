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
  Activity,
} from 'lucide-react';
import { type DashboardAnalytics } from '@/types/index';

interface AdminDashboardProps {
  analyticsPromise: Promise<DashboardAnalytics>;
  onNavigateTab: (tab: 'inventory' | 'gateways' | 'reconciliation' | 'orders') => void;
}

export function AdminDashboard({ analyticsPromise, onNavigateTab }: AdminDashboardProps) {
  const analytics = use(analyticsPromise);

  return (
    <div className="space-y-6">
      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Total GMV Revenue */}
        <div className="flex flex-col justify-between space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Gross Revenue
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
              <DollarSign className="h-3.5 w-3.5" />
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold text-white">
              KES {analytics.totalRevenue.toLocaleString()}
            </div>
            <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-400">
              <TrendingUp className="h-3 w-3" /> +14.2% vs previous period
            </div>
          </div>
        </div>

        {/* Total Orders */}
        <div className="flex flex-col justify-between space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Orders Processed
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-indigo-500/20 bg-indigo-500/10 text-indigo-400">
              <ShoppingBag className="h-3.5 w-3.5" />
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold text-white">
              {analytics.totalOrders}{' '}
              <span className="text-xs font-normal text-zinc-500">orders</span>
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">
              Avg Order:{' '}
              <span className="font-mono text-zinc-200">
                KES {analytics.averageOrderValue.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Real-time Reconciliation Match Rate */}
        <div className="flex flex-col justify-between space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Reconciliation Rate
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-indigo-500/20 bg-indigo-500/10 text-indigo-400">
              <ShieldCheck className="h-3.5 w-3.5" />
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold text-indigo-400">
              {analytics.reconciliationRate}%
            </div>
            <div className="mt-1 flex items-center gap-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Zero unresolved discrepancies
            </div>
          </div>
        </div>

        {/* Low Stock Alerts */}
        <div
          onClick={() => onNavigateTab('inventory')}
          className="group flex cursor-pointer flex-col justify-between space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-lg transition-colors hover:border-zinc-700"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-zinc-500 uppercase">
              Low Stock SKUs
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-400 transition-transform group-hover:scale-110">
              <AlertTriangle className="h-3.5 w-3.5" />
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold text-amber-400">
              {analytics.lowStockAlertsCount}{' '}
              <span className="text-xs font-normal text-zinc-500">alerts</span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[11px] text-indigo-400 group-hover:underline">
              Manage inventory <ArrowUpRight className="h-3 w-3" />
            </div>
          </div>
        </div>
      </div>

      {/* Analytics Breakdown */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Payment Gateways Performance */}
        <div className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900 p-6 lg:col-span-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white">Payment Method Distribution</h3>
              <p className="text-xs text-zinc-500">
                Daraja LNMO vs Pesapal v3 Settlement Breakdown
              </p>
            </div>
            <button
              onClick={() => onNavigateTab('gateways')}
              className="flex cursor-pointer items-center gap-1 text-xs font-medium text-indigo-400 hover:text-indigo-300"
            >
              Config <ArrowUpRight className="h-3 w-3" />
            </button>
          </div>

          <div className="space-y-4">
            {analytics.salesByPaymentMethod.map((method) => {
              const isMpesa = method.provider === 'mpesa_daraja';
              const isPesapal = method.provider === 'pesapal_v3';
              const Icon = isMpesa ? Smartphone : CreditCard;
              const barColor = isMpesa
                ? 'bg-emerald-500'
                : isPesapal
                  ? 'bg-indigo-600'
                  : 'bg-indigo-400';

              return (
                <div key={method.provider} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Icon
                        className={`h-3.5 w-3.5 ${isMpesa ? 'text-emerald-400' : 'text-indigo-400'}`}
                      />
                      <span className="font-medium text-zinc-200">{method.name}</span>
                      <span className="font-mono text-[10px] text-zinc-500">
                        ({method.count} orders)
                      </span>
                    </div>
                    <div className="font-mono text-zinc-200">
                      KES {method.amount.toLocaleString()} ({method.percentage}%)
                    </div>
                  </div>
                  {/* Progress Bar */}
                  <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
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
        <div className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900 p-6 lg:col-span-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-white">Intraday Sales Velocity</h3>
              <p className="text-xs text-zinc-500">Real-time hourly volume & transaction flow</p>
            </div>
            <div className="flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981]" />{' '}
              LIVE
            </div>
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-6 gap-2 text-center">
              {analytics.recentHourlySales.map((h) => (
                <div
                  key={h.time}
                  className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5"
                >
                  <div className="font-mono text-[10px] text-zinc-500">{h.time}</div>
                  <div className="font-mono text-xs font-bold text-white">
                    KES {(h.sales / 1000).toFixed(0)}k
                  </div>
                  <div className="text-[9px] text-zinc-500">{h.orders} orders</div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3.5 text-xs">
              <span className="flex items-center gap-1.5 text-zinc-400">
                <Zap className="h-3.5 w-3.5 text-amber-400" /> Payment Verification:
              </span>
              <span className="font-mono font-semibold text-emerald-400">
                Active (Automatic Settlement)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
