'use client';

import { use } from 'react';
import {
  DollarSign,
  ShoppingBag,
  AlertTriangle,
  Smartphone,
  CreditCard,
  Layers,
  ArrowUpRight,
  ShieldCheck,
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
        <div className="flex flex-col justify-between space-y-3 rounded-xl border border-line bg-surface-raised p-5 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-fg-subtle uppercase">
              Gross Revenue
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-600">
              <DollarSign className="h-3.5 w-3.5" />
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold text-fg-strong">
              KES {analytics.totalRevenue.toLocaleString()}
            </div>
            <div className="mt-1 text-[11px] text-fg-muted">Collected from paid orders</div>
          </div>
        </div>

        {/* Total Orders */}
        <div className="flex flex-col justify-between space-y-3 rounded-xl border border-line bg-surface-raised p-5 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-fg-subtle uppercase">
              Orders Processed
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-indigo-500/20 bg-indigo-500/10 text-indigo-400">
              <ShoppingBag className="h-3.5 w-3.5" />
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold text-fg-strong">
              {analytics.totalOrders}{' '}
              <span className="text-xs font-normal text-fg-subtle">orders</span>
            </div>
            <div className="mt-1 text-[11px] text-fg-muted">
              Avg Order:{' '}
              <span className="font-mono text-fg-strong">
                KES {analytics.averageOrderValue.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Real-time Reconciliation Match Rate */}
        <div className="flex flex-col justify-between space-y-3 rounded-xl border border-line bg-surface-raised p-5 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-fg-subtle uppercase">
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
            <div className="mt-1 text-[11px] text-fg-muted">Based on recorded reconciliations</div>
          </div>
        </div>

        {/* Low Stock Alerts */}
        <div
          onClick={() => onNavigateTab('inventory')}
          className="group flex cursor-pointer flex-col justify-between space-y-3 rounded-xl border border-line bg-surface-raised p-5 shadow-lg transition-colors hover:border-line-strong"
        >
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold tracking-widest text-fg-subtle uppercase">
              Low Stock SKUs
            </span>
            <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-600 transition-transform group-hover:scale-110">
              <AlertTriangle className="h-3.5 w-3.5" />
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold text-amber-600">
              {analytics.lowStockAlertsCount}{' '}
              <span className="text-xs font-normal text-fg-subtle">alerts</span>
            </div>
            <div className="mt-1 flex items-center gap-1 text-[11px] text-indigo-400 group-hover:underline">
              Manage inventory <ArrowUpRight className="h-3 w-3" />
            </div>
          </div>
        </div>
      </div>

      {/* Analytics Breakdown */}
      <div className="grid grid-cols-1 gap-6">
        {/* Payment Gateways Performance */}
        <div className="space-y-5 rounded-xl border border-line bg-surface-raised p-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-fg-strong">Payment Method Distribution</h3>
              <p className="text-xs text-fg-subtle">
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
                  ? 'bg-indigo-600 text-white'
                  : 'bg-indigo-400';

              return (
                <div key={method.provider} className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Icon
                        className={`h-3.5 w-3.5 ${isMpesa ? 'text-emerald-600' : 'text-indigo-400'}`}
                      />
                      <span className="font-medium text-fg-strong">{method.name}</span>
                      <span className="font-mono text-[10px] text-fg-subtle">
                        ({method.count} orders)
                      </span>
                    </div>
                    <div className="font-mono text-fg-strong">
                      KES {method.amount.toLocaleString()} ({method.percentage}%)
                    </div>
                  </div>
                  {/* Progress Bar */}
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
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
      </div>
    </div>
  );
}
