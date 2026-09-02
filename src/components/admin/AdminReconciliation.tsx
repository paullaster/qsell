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
  HelpCircle
} from 'lucide-react';
import { ReconciliationLog } from '../../types/index.js';
import { runBatchReconciliationAction, resolveDiscrepancyAction } from '../../lib/serverActions.js';

interface AdminReconciliationProps {
  reconciliationLogsPromise: Promise<ReconciliationLog[]>;
  onRefresh: () => void;
}

export function AdminReconciliation({
  reconciliationLogsPromise,
  onRefresh
}: AdminReconciliationProps) {
  const logs = use(reconciliationLogsPromise);

  const [isRunningBatch, setIsRunningBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [selectedLog, setSelectedLog] = useState<ReconciliationLog | null>(null);
  const [resolveAction, setResolveAction] = useState<'force_match' | 'mark_refund_required' | 'cancel_order'>('force_match');
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
      <div className="p-6 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-400" />
            <h2 className="font-bold text-base text-white">Automated Payment Settlement & Reconciliation</h2>
          </div>
          <p className="text-xs text-zinc-400">
            Automatically compares customer order amounts against received M-Pesa statements and bank receipts to detect underpayments, excess payments, or unlinked deposits.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleRunBatch}
            disabled={isRunningBatch}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-600/20 transition-all cursor-pointer disabled:opacity-50"
          >
            {isRunningBatch ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            {isRunningBatch ? 'Reconciling Transactions...' : 'Reconcile All Transactions'}
          </button>
        </div>
      </div>

      {batchResult && (
        <div className="p-4 rounded-lg bg-indigo-950/40 border border-indigo-500/30 text-xs text-indigo-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>Batch Complete: Checked <strong>{batchResult.totalChecked}</strong> transactions. Matched: <strong>{batchResult.matched}</strong>, Discrepancies: <strong>{batchResult.discrepancies}</strong></span>
          </div>
          <button onClick={() => setBatchResult(null)} className="text-indigo-300 hover:text-white cursor-pointer">✕</button>
        </div>
      )}

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
          <div className="text-xs font-semibold text-zinc-400 uppercase">Verified & Matched</div>
          <div className="text-2xl font-bold font-mono text-emerald-400 flex items-center gap-2">
            {matchedCount} <span className="text-xs font-normal text-zinc-500">records</span>
          </div>
          <p className="text-[11px] text-zinc-500">Order total equals received amount (0.00 delta)</p>
        </div>

        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
          <div className="text-xs font-semibold text-zinc-400 uppercase">Flagged Discrepancies</div>
          <div className="text-2xl font-bold font-mono text-amber-400 flex items-center gap-2">
            {flaggedCount} <span className="text-xs font-normal text-zinc-500">attention</span>
          </div>
          <p className="text-[11px] text-zinc-500">Underpaid, overpaid, or unlinked gateway callbacks</p>
        </div>

        <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
          <div className="text-xs font-semibold text-zinc-400 uppercase">Corrected & Overridden</div>
          <div className="text-2xl font-bold font-mono text-teal-400 flex items-center gap-2">
            {correctedCount} <span className="text-xs font-normal text-zinc-500">resolved</span>
          </div>
          <p className="text-[11px] text-zinc-500">Admin-adjusted and force reconciled</p>
        </div>
      </div>

      {/* Reconciliation Logs Table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-lg">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-950 text-zinc-400 uppercase font-semibold text-[10px] tracking-wider border-b border-zinc-800">
            <tr>
              <th className="py-3 px-4">Timestamp</th>
              <th className="py-3 px-3">Order Number</th>
              <th className="py-3 px-3">Gateway</th>
              <th className="py-3 px-3">Type</th>
              <th className="py-3 px-3">Order Total</th>
              <th className="py-3 px-3">Received Amount</th>
              <th className="py-3 px-3">Match Status</th>
              <th className="py-3 px-4">Audit Details</th>
              <th className="py-3 px-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {logs.map((log) => {
              const isMatched = log.status === 'matched';
              const isFlagged = log.status === 'flagged_for_review';
              const isMpesa = log.provider === 'mpesa_daraja';

              return (
                <tr key={log.id} className="hover:bg-zinc-800/40 transition-colors">
                  <td className="py-3.5 px-4 font-mono text-zinc-500 text-[11px]">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td className="py-3.5 px-3 font-mono font-semibold text-white">
                    {log.orderNumber}
                  </td>
                  <td className="py-3.5 px-3">
                    <span className="flex items-center gap-1 text-[11px] font-medium text-zinc-300">
                      {isMpesa ? <Smartphone className="w-3.5 h-3.5 text-emerald-400" /> : <CreditCard className="w-3.5 h-3.5 text-indigo-400" />}
                      {isMpesa ? 'M-Pesa' : 'Pesapal'}
                    </span>
                  </td>
                  <td className="py-3.5 px-3 font-mono text-[10px] text-zinc-500 uppercase">
                    {log.reconciliationType}
                  </td>
                  <td className="py-3.5 px-3 font-mono text-white">
                    KES {log.orderTotal.toLocaleString()}
                  </td>
                  <td className="py-3.5 px-3 font-mono text-emerald-400 font-semibold">
                    KES {log.receivedAmount.toLocaleString()}
                  </td>
                  <td className="py-3.5 px-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold ${
                      isMatched
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : isFlagged
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse'
                        : 'bg-teal-500/10 text-teal-400 border border-teal-500/20'
                    }`}>
                      {isMatched ? <Check className="w-3 h-3" /> : isFlagged ? <AlertTriangle className="w-3 h-3" /> : null}
                      {log.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-zinc-300 text-xs max-w-sm truncate" title={log.details}>
                    {log.details}
                  </td>
                  <td className="py-3.5 px-4 text-right">
                    {isFlagged ? (
                      <button
                        onClick={() => setSelectedLog(log)}
                        className="px-2.5 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-bold text-[11px] shadow-sm cursor-pointer"
                      >
                        Resolve...
                      </button>
                    ) : (
                      <span className="text-[11px] text-zinc-500 font-mono">Verified</span>
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
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center">
          <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8">
            <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400" />
                Resolve Discrepancy for {selectedLog.orderNumber}
              </h3>
              <button onClick={() => setSelectedLog(null)} className="text-zinc-400 hover:text-white cursor-pointer">✕</button>
            </div>

            <form onSubmit={handleResolveSubmit} className="p-6 space-y-4 text-xs">
              <div className="p-3.5 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1">
                <div className="text-zinc-400">Current Issue:</div>
                <div className="text-amber-300 font-medium">{selectedLog.details}</div>
              </div>

              <div>
                <label className="block text-zinc-300 font-medium mb-1">Resolution Action</label>
                <select
                  value={resolveAction}
                  onChange={(e: any) => setResolveAction(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="force_match">Force Mark Reconciled (Verified offline or via Safaricom)</option>
                  <option value="mark_refund_required">Flag for Excess Amount Customer Refund</option>
                  <option value="cancel_order">Cancel Order & Release Inventory</option>
                </select>
              </div>

              <div>
                <label className="block text-zinc-300 font-medium mb-1">Audit Trail Notes</label>
                <textarea
                  rows={3}
                  value={resolveNotes}
                  onChange={(e) => setResolveNotes(e.target.value)}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="pt-3 border-t border-zinc-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedLog(null)}
                  className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isResolving}
                  className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-lg shadow-indigo-600/20 cursor-pointer"
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
