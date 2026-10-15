'use client';

import { use, useState } from 'react';
import {
  Activity,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  RefreshCw,
  Search,
  ExternalLink,
  X,
} from 'lucide-react';
import { format } from 'date-fns';

interface AuditLogEntry {
  id: string;
  correlationId: string;
  direction: 'outbound' | 'inbound';
  provider: string;
  operation: string;
  httpMethod: string | null;
  url: string | null;
  statusCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  requestSentAt: string | Date | null;
  responseReceivedAt: string | Date | null;
  callbackReceivedAt: string | Date | null;
  createdAt: string | Date;
  retryCount: number;
  queueJobId: string | null;
  requestHeaders: Record<string, string> | null;
  requestPayload: Record<string, unknown> | null;
  responseHeaders: Record<string, string> | null;
  responsePayload: Record<string, unknown> | null;
  callbackPayload: Record<string, unknown> | null;
}

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

const PROVIDERS = [
  'mpesa_daraja',
  'pesapal_v3',
  'jenga_hq',
  'kcb_buni',
  'sendgrid',
  'twilio',
  'stripe',
  'paypal',
] as const;

const OPERATIONS = [
  'stk_push',
  'stk_callback',
  'ipn_callback',
  'payment_initiation',
  'order_submit',
  'send_email',
  'send_sms',
  'webhook_received',
] as const;

export function AdminIntegrationAudit({
  logsPromise,
  onRefresh,
}: {
  logsPromise: Promise<PaginatedResponse<AuditLogEntry>>;
  onRefresh: () => void;
}) {
  const data = use(logsPromise);
  const logs = data.data;
  const total = data.total;
  const page = data.page;
  const pageSize = data.pageSize;

  const [search, setSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [operationFilter, setOperationFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedLog, setSelectedLog] = useState<AuditLogEntry | null>(null);

  const filteredLogs = logs.filter((log) => {
    const query = search.trim().toLowerCase();
    const searchable = [
      log.correlationId,
      log.url,
      log.errorCode,
      log.errorMessage,
      JSON.stringify(log.callbackPayload ?? {}),
      JSON.stringify(log.responsePayload ?? {}),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const dateValue = log.callbackReceivedAt ?? log.requestSentAt ?? log.createdAt;
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    return (
      (!query || searchable.includes(query)) &&
      (!providerFilter || log.provider === providerFilter) &&
      (!operationFilter || log.operation === operationFilter) &&
      (!directionFilter || log.direction === directionFilter) &&
      (!statusFilter ||
        (statusFilter === 'success' &&
          log.statusCode != null &&
          log.statusCode >= 200 &&
          log.statusCode < 300) ||
        (statusFilter === 'client_error' &&
          log.statusCode != null &&
          log.statusCode >= 400 &&
          log.statusCode < 500) ||
        (statusFilter === 'server_error' && log.statusCode != null && log.statusCode >= 500) ||
        (statusFilter === 'failed' && Boolean(log.errorCode))) &&
      (!dateFrom || date >= new Date(`${dateFrom}T00:00:00`)) &&
      (!dateTo || date <= new Date(`${dateTo}T23:59:59.999`))
    );
  });

  const getStatusBadge = (code: number | null) => {
    if (!code)
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-sunken px-2.5 py-0.5 text-[11px] font-semibold text-fg">
          —
        </span>
      );
    if (code >= 200 && code < 300)
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800 bg-emerald-50/80 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
          {code}
        </span>
      );
    if (code >= 400 && code < 500)
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-800 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
          {code}
        </span>
      );
    if (code >= 500)
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-red-800 bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700">
          {code}
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-sunken px-2.5 py-0.5 text-[11px] font-semibold text-fg">
        {code}
      </span>
    );
  };

  const getDirectionBadge = (dir: 'outbound' | 'inbound') => (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${dir === 'outbound' ? 'bg-indigo-600 text-white' : 'bg-amber-600 text-white'}`}
    >
      {dir === 'outbound' ? '→ Outbound' : '← Inbound'}
    </span>
  );

  const formatDuration = (ms: number | null) => {
    if (!ms) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatTime = (dateStr: string | Date | null) => {
    if (!dateStr) return '—';
    return format(dateStr instanceof Date ? dateStr : new Date(dateStr), 'MMM d, HH:mm:ss');
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong">
            <Activity className="h-5 w-5 text-indigo-400" />
            Integration Audit Log
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            All outbound HTTP calls and inbound webhooks with full payload capture and timing
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onRefresh}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>

          <button className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong">
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="space-y-3 rounded-xl border border-line bg-surface-raised p-4 text-xs">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-6 lg:grid-cols-8">
          {/* Search Input */}
          <div className="relative lg:col-span-2">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input
              type="text"
              placeholder="Search correlation ID, URL, error code, message..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface py-1.5 pr-4 pl-9 text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {/* Provider Filter */}
          <div>
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong focus:border-indigo-500 focus:outline-none"
            >
              <option value="">All Providers</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* Operation Filter */}
          <div>
            <select
              value={operationFilter}
              onChange={(e) => setOperationFilter(e.target.value)}
              className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong focus:border-indigo-500 focus:outline-none"
            >
              <option value="">All Operations</option>
              {OPERATIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>

          {/* Direction Filter */}
          <div>
            <select
              value={directionFilter}
              onChange={(e) => setDirectionFilter(e.target.value)}
              className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong focus:border-indigo-500 focus:outline-none"
            >
              <option value="">All Directions</option>
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong focus:border-indigo-500 focus:outline-none"
            >
              <option value="">All Status</option>
              <option value="success">2xx Success</option>
              <option value="client_error">4xx Client Error</option>
              <option value="server_error">5xx Server Error</option>
              <option value="failed">Failed/Error</option>
            </select>
          </div>

          {/* Date Range */}
          <div className="flex gap-2 lg:col-span-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              placeholder="From"
              className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              placeholder="To"
              className="flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Audit Logs Table */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
              <tr>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Operation</th>
                <th className="px-4 py-3">Method / URL</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-center">Duration</th>
                <th className="px-4 py-3 text-center">Retries</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-fg">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-fg-subtle">
                    No audit logs match the current filter criteria.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="transition-colors hover:bg-hover">
                    <td className="px-4 py-3.5 font-mono text-[11px] text-fg-muted">
                      {log.requestSentAt
                        ? formatTime(log.requestSentAt)
                        : log.callbackReceivedAt
                          ? formatTime(log.callbackReceivedAt)
                          : formatTime(log.createdAt)}
                    </td>
                    <td className="px-4 py-3.5">{getDirectionBadge(log.direction)}</td>
                    <td className="px-4 py-3.5 font-mono text-[11px] capitalize">
                      {log.provider.replace(/_/g, ' ')}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-[11px]">{log.operation}</td>
                    <td className="max-w-[280px] truncate px-4 py-3.5 font-mono text-[11px]">
                      {log.httpMethod} {log.url}
                    </td>
                    <td className="px-4 py-3.5 text-center">{getStatusBadge(log.statusCode)}</td>
                    <td className="px-4 py-3.5 text-center font-mono text-[11px]">
                      {formatDuration(log.durationMs)}
                    </td>
                    <td className="px-4 py-3.5 text-center font-mono text-[11px]">
                      {log.retryCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-800 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                          {log.retryCount}
                        </span>
                      ) : (
                        '0'
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <button
                        type="button"
                        aria-label={`View audit details for ${log.provider} ${log.operation}`}
                        onClick={() => setSelectedLog(log)}
                        className="cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover hover:text-fg-strong"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-line p-4">
          <p className="text-sm text-fg-muted">
            Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() =>
                (window.location.href = `/admin/integration-audit?page=${Math.max(1, page - 1)}`)
              }
              disabled={page === 1}
              className="cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover hover:text-fg-strong disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => (window.location.href = `/admin/integration-audit?page=${page + 1}`)}
              disabled={page * pageSize >= total}
              className="cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover hover:text-fg-strong disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {selectedLog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/70 p-4 backdrop-blur-sm"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedLog(null);
          }}
        >
          <section
            aria-labelledby="audit-detail-title"
            aria-modal="true"
            className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-line bg-surface-raised shadow-2xl"
            role="dialog"
          >
            <header className="sticky top-0 flex items-center justify-between border-b border-line bg-surface-raised p-5">
              <div>
                <h3 id="audit-detail-title" className="font-semibold text-fg-strong">
                  {selectedLog.provider.replace(/_/g, ' ')} · {selectedLog.operation}
                </h3>
                <p className="mt-1 font-mono text-xs text-fg-muted">
                  Correlation ID: {selectedLog.correlationId}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close audit details"
                onClick={() => setSelectedLog(null)}
                className="rounded-lg p-2 text-fg-muted hover:bg-hover hover:text-fg-strong"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-surface p-3 text-xs">
                <div className="font-semibold text-fg-strong">Processing</div>
                <dl className="mt-2 space-y-1.5 text-fg-muted">
                  <div>HTTP status: {selectedLog.statusCode ?? 'Pending'}</div>
                  <div>Queue job: {selectedLog.queueJobId ?? 'Not queued'}</div>
                  <div>Error code: {selectedLog.errorCode ?? '—'}</div>
                  <div>Error message: {selectedLog.errorMessage ?? '—'}</div>
                  <div>Received: {formatTime(selectedLog.callbackReceivedAt)}</div>
                </dl>
              </div>

              <AuditJsonBlock title="Callback payload" value={selectedLog.callbackPayload} />
              <AuditJsonBlock title="Processing result" value={selectedLog.responsePayload} />
              <AuditJsonBlock title="Request headers" value={selectedLog.requestHeaders} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function AuditJsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-3">
      <h4 className="mb-2 text-xs font-semibold text-fg-strong">{title}</h4>
      <pre className="max-h-72 overflow-auto font-mono text-[11px] break-all whitespace-pre-wrap text-fg-muted">
        {value == null ? 'No data recorded' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
