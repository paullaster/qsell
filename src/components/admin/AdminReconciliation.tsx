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
      <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6 md:flex-row md:items-center">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-indigo-400" />
            <h2 className="text-base font-bold text-white">
              Automated Payment Settlement & Reconciliation
            </h2>
          </div>
          <p className="text-xs text-zinc-400">
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
        <div className="flex items-center justify-between rounded-lg border border-indigo-500/30 bg-indigo-950/40 p-4 text-xs text-indigo-200">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span>
              Batch Complete: Checked <strong>{batchResult.totalChecked}</strong> transactions.
              Matched: <strong>{batchResult.matched}</strong>, Discrepancies:{' '}
              <strong>{batchResult.discrepancies}</strong>
            </span>
          </div>
          <button
            onClick={() => setBatchResult(null)}
            className="cursor-pointer text-indigo-300 hover:text-white"
          >
            ✕
          </button>
        </div>
      )}

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-xs font-semibold text-zinc-400 uppercase">Verified & Matched</div>
          <div className="flex items-center gap-2 font-mono text-2xl font-bold text-emerald-400">
            {matchedCount} <span className="text-xs font-normal text-zinc-500">records</span>
          </div>
          <p className="text-[11px] text-zinc-500">
            Order total equals received amount (0.00 delta)
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-xs font-semibold text-zinc-400 uppercase">Flagged Discrepancies</div>
          <div className="flex items-center gap-2 font-mono text-2xl font-bold text-amber-400">
            {flaggedCount} <span className="text-xs font-normal text-zinc-500">attention</span>
          </div>
          <p className="text-[11px] text-zinc-500">
            Underpaid, overpaid, or unlinked gateway callbacks
          </p>
        </div>

        <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-900 p-5">
          <div className="text-xs font-semibold text-zinc-400 uppercase">
            Corrected & Overridden
          </div>
          <div className="flex items-center gap-2 font-mono text-2xl font-bold text-teal-400">
            {correctedCount} <span className="text-xs font-normal text-zinc-500">resolved</span>
          </div>
          <p className="text-[11px] text-zinc-500">Admin-adjusted and force reconciled</p>
        </div>
      </div>

      {/* Reconciliation Logs Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-lg">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-zinc-800 bg-zinc-950 text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">
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
          <tbody className="divide-y divide-zinc-800">
            {logs.map((log) => {
              const isMatched = log.status === 'matched';
              const isFlagged = log.status === 'flagged_for_review';
              const isMpesa = log.provider === 'mpesa_daraja';

              return (
                <tr key={log.id} className="transition-colors hover:bg-zinc-800/40">
                  <td className="px-4 py-3.5 font-mono text-[11px] text-zinc-500">
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-3.5 font-mono font-semibold text-white">
                    {log.orderNumber}
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="flex items-center gap-1 text-[11px] font-medium text-zinc-300">
                      {isMpesa ? (
                        <Smartphone className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <CreditCard className="h-3.5 w-3.5 text-indigo-400" />
                      )}
                      {isMpesa ? 'M-Pesa' : 'Pesapal'}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 font-mono text-[10px] text-zinc-500 uppercase">
                    {log.reconciliationType}
                  </td>
                  <td className="px-3 py-3.5 font-mono text-white">
                    KES {log.orderTotal.toLocaleString()}
                  </td>
                  <td className="px-3 py-3.5 font-mono font-semibold text-emerald-400">
                    KES {log.receivedAmount.toLocaleString()}
                  </td>
                  <td className="px-3 py-3.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold ${
                        isMatched
                          ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                          : isFlagged
                            ? 'animate-pulse border border-amber-500/20 bg-amber-500/10 text-amber-400'
                            : 'border border-teal-500/20 bg-teal-500/10 text-teal-400'
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
                  <td
                    className="max-w-sm truncate px-4 py-3.5 text-xs text-zinc-300"
                    title={log.details}
                  >
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
                      <span className="font-mono text-[11px] text-zinc-500">Verified</span>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-md sm:p-6">
          <div className="relative my-8 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 p-5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-white">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                Resolve Discrepancy for {selectedLog.orderNumber}
              </h3>
              <button
                onClick={() => setSelectedLog(null)}
                className="cursor-pointer text-zinc-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleResolveSubmit} className="space-y-4 p-6 text-xs">
              <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3.5">
                <div className="text-zinc-400">Current Issue:</div>
                <div className="font-medium text-amber-300">{selectedLog.details}</div>
              </div>

              <div>
                <label className="mb-1 block font-medium text-zinc-300">Resolution Action</label>
                <select
                  value={resolveAction}
                  onChange={(e: any) => setResolveAction(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-white focus:border-indigo-500 focus:outline-none"
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
                <label className="mb-1 block font-medium text-zinc-300">Audit Trail Notes</label>
                <textarea
                  rows={3}
                  value={resolveNotes}
                  onChange={(e) => setResolveNotes(e.target.value)}
                  required
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-zinc-800 pt-3">
                <button
                  type="button"
                  onClick={() => setSelectedLog(null)}
                  className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-zinc-400 hover:text-white"
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
