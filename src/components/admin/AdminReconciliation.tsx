'use client';

import React, { use, useState } from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Play,
  FileText,
  Layers,
  Smartphone,
  CreditCard,
  Check,
  XCircle,
  HelpCircle,
} from 'lucide-react';
import { type ReconciliationLog } from '@/types/index';
import { runBatchReconciliationAction, resolveDiscrepancyAction } from '@/server/actions';

interface AdminReconciliationProps {
  reconciliationLogsPromise: Promise<ReconciliationLog[]>;
  onRefresh: () => void;
}

export function AdminReconciliation({
  reconciliationLogsPromise,
  onRefresh,
}: AdminReconciliationProps) {
  const logs = use(reconciliationLogsPromise);

  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [selectedLog, setSelectedLog] = useState<ReconciliationLog | null>(null);
  const [resolveAction, setResolveAction] = useState<
    'force_match' | 'mark_refund_required' | 'cancel_order'
  >('force_match');
  const [resolveNotes, setResolveNotes] = useState('Audited via Safaricom portal statement');
  const [isResolving, setIsResolving] = useState(false);

  const matchedCount = logs.filter((l) => l.status === 'matched').length;
  const flaggedCount = logs.filter((l) => l.status === 'flagged_for_review').length;
  const correctedCount = logs.filter((l) => l.status === 'corrected').length;

  const handleRunBatch = async () => {
    try {
      setIsRunningBatch(true);
      const res = await runBatchReconciliationAction();
      setBatchResult(res);
      onRefresh();
    } catch (err: any) {
      alert(`Batch run failed: ${err.message}`);
    } finally {
      setIsRunningBatch(false);
    }
  };

  const handleResolveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedLog) return;

    try {
      setIsResolving(true);
      await resolveDiscrepancyAction(selectedLog.id, resolveAction, resolveNotes);
      setSelectedLog(null);
      onRefresh();
    } catch (err: any) {
      alert(`Resolution error: ${err.message}`);
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-line bg-surface-raised p-6 md:flex-row md:items-center">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-indigo-400" />
            <h2 className="text-base font-bold text-fg-strong">
              Automated Payment Settlement & Reconciliation
            </h2>
          </div>
          <p className="text-xs text-fg-muted">
            Automatically compares customer order amounts against received M-Pesa statements and
            bank receipts to detect underpayments, excess payments, or unlinked deposits.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRunBatch}
            disabled={isRunningBatch}
            className="flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 disabled:opacity-50"
          >
            {isRunningBatch ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isRunningBatch ? 'Reconciling Transactions...' : 'Reconcile All Transactions'}
          </button>
        </div>
      </div>

      {batchResult && (
        <div className="flex items-center justify-between rounded-lg border border-indigo-600 bg-indigo-50 p-4 text-xs text-indigo-600 dark:text-indigo-400">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>
              Batch Complete: Checked <strong>{batchResult.totalChecked}</strong> transactions.
              Matched: <strong>{batchResult.matched}</strong>, Discrepancies:{' '}
              <strong>{batchResult.discrepancies}</strong>
            </span>
          </div>
          <button
            onClick={() => setBatchResult(null)}
            className="cursor-pointer text-indigo-300 hover:text-fg-strong"
          >
            ✕
          </button>
        </div>
      )}

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-2 rounded-xl border border-line bg-surface-raised p-5">
          <div className="text-xs font-semibold text-fg-muted uppercase">Verified & Matched</div>
          <div className="flex items-center gap-2 font-mono text-2xl font-bold text-emerald-600">
            {matchedCount} <span className="text-xs font-normal text-fg-subtle">records</span>
          </div>
          <p className="text-[11px] text-fg-subtle">
            Order total equals received amount (0.00 delta)
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-line bg-surface-raised p-5">
          <div className="text-xs font-semibold text-fg-muted uppercase">Flagged Discrepancies</div>
          <div className="flex items-center gap-2 font-mono text-2xl font-bold text-amber-600">
            {flaggedCount} <span className="text-xs font-normal text-fg-subtle">attention</span>
          </div>
          <p className="text-[11px] text-fg-subtle">
            Underpaid, overpaid, or unlinked gateway callbacks
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-line bg-surface-raised p-5">
          <div className="text-xs font-semibold text-fg-muted uppercase">
            Corrected & Overridden
          </div>
          <div className="flex items-center gap-2 font-mono text-2xl font-bold text-teal-600">
            {correctedCount} <span className="text-xs font-normal text-fg-subtle">resolved</span>
          </div>
          <p className="text-[11px] text-fg-subtle">Admin-adjusted and force reconciled</p>
        </div>
      </div>

      {/* Reconciliation Logs Table */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface-raised shadow-lg">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line bg-surface text-[10px] font-semibold tracking-wider text-fg-muted uppercase">
            <tr>
              <th className="px-4 py-3">Timestamp</th>
              <th className="px-3 py-3">Order Number</th>
              <th className="px-3 py-3">Gateway</th>
              <th className="px-3 py-3">Type</th>
              <th className="px-3 py-3">Order Total</th>
              <th className="px-3 py-3">Received Amount</th>
              <th className="px-3 py-3">Match Status</th>
              <th className="px-4 py-3">Audit Details</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {logs.map((log) => {
              const isMatched = log.status === 'matched';
              const isFlagged = log.status === 'flagged_for_review';
              const isMpesa = log.provider === 'mpesa_daraja';

              return (
                <tr key={log.id} className="transition-colors hover:bg-hover">
                  <td className="px-4 py-3.5 font-mono text-[11px] text-fg-subtle">
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-3.5 font-mono font-semibold text-fg-strong">
                    {log.orderNumber}
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="flex items-center gap-1 text-[11px] font-medium text-fg">
                      {isMpesa ? (
                        <Smartphone className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <CreditCard className="h-3.5 w-3.5 text-indigo-400" />
                      )}
                      {isMpesa ? 'M-Pesa' : 'Pesapal'}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 font-mono text-[10px] text-fg-subtle uppercase">
                    {log.reconciliationType}
                  </td>
                  <td className="px-3 py-3.5 font-mono text-fg-strong">
                    KES {log.orderTotal.toLocaleString()}
                  </td>
                  <td className="px-3 py-3.5 font-mono font-semibold text-emerald-600">
                    KES {log.receivedAmount.toLocaleString()}
                  </td>
                  <td className="px-3 py-3.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold ${
                        isMatched
                          ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                          : isFlagged
                            ? 'animate-pulse border border-amber-500/20 bg-amber-500/10 text-amber-600'
                            : 'border border-teal-500/20 bg-teal-500/10 text-teal-600'
                      }`}
                    >
                      {isMatched ? (
                        <Check className="h-3 w-3" />
                      ) : isFlagged ? (
                        <AlertTriangle className="h-3 w-3" />
                      ) : null}
                      {log.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="max-w-sm truncate px-4 py-3.5 text-xs text-fg" title={log.details}>
                    {log.details}
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    {isFlagged ? (
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="cursor-pointer rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm hover:bg-amber-500"
                      >
                        Resolve...
                      </button>
                    ) : (
                      <span className="font-mono text-[11px] text-fg-subtle">Verified</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Discrepancy Resolution Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-md sm:p-6">
          <div className="relative my-8 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
            <div className="flex items-center justify-between border-b border-line bg-surface p-5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                Resolve Discrepancy for {selectedLog.orderNumber}
              </h3>
              <button
                onClick={() => setSelectedLog(null)}
                className="cursor-pointer text-fg-muted hover:text-fg-strong"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleResolveSubmit} className="space-y-4 p-6 text-xs">
              <div className="space-y-1 rounded-lg border border-line bg-surface p-3.5">
                <div className="text-fg-muted">Current Issue:</div>
                <div className="font-medium text-amber-700">{selectedLog.details}</div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-fg">Resolution Action</label>
                <select
                  value={resolveAction}
                  onChange={(e: any) => setResolveAction(e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong focus:border-indigo-500 focus:outline-none"
                >
                  <option value="force_match">
                    Force Mark Reconciled (Verified offline or via Safaricom)
                  </option>
                  <option value="mark_refund_required">
                    Flag for Excess Amount Customer Refund
                  </option>
                  <option value="cancel_order">Cancel Order & Release Inventory</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block font-medium text-fg">Audit Trail Notes</label>
                <textarea
                  rows={3}
                  value={resolveNotes}
                  onChange={(e) => setResolveNotes(e.target.value)}
                  required
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => setSelectedLog(null)}
                  className="cursor-pointer rounded-lg bg-surface-sunken px-4 py-2 text-fg-muted hover:text-fg-strong"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isResolving}
                  className="cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500"
                >
                  {isResolving ? 'Applying...' : 'Apply Resolution & Update Order'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
