'use client';

import React, { use, useState } from 'react';
import {
  CreditCard,
  Smartphone,
  ShieldCheck,
  Save,
  CheckCircle2,
  AlertCircle,
  Sliders,
  Key,
  Eye,
  EyeOff,
  Radio,
  ExternalLink,
} from 'lucide-react';
import { type PaymentGatewayConfig } from '@/types/index';
import { updateGatewayConfigAction } from '@/server/actions';

interface AdminPaymentConfigProps {
  gatewaysPromise: Promise<PaymentGatewayConfig[]>;
  onRefresh: () => void;
}

export function AdminPaymentConfig({ gatewaysPromise, onRefresh }: AdminPaymentConfigProps) {
  const gateways = use(gatewaysPromise);

  const [editingGateway, setEditingGateway] = useState<PaymentGatewayConfig | null>(null);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const toggleSecret = (field: string) => {
    setShowSecrets((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const handleToggleEnable = async (gateway: PaymentGatewayConfig) => {
    try {
      await updateGatewayConfigAction(gateway.id, { isEnabled: !gateway.isEnabled });
      onRefresh();
    } catch (err: any) {
      alert(`Update error: ${err.message}`);
    }
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingGateway) return;

    try {
      setIsSaving(true);
      await updateGatewayConfigAction(editingGateway.id, editingGateway);
      setSuccessMessage(`${editingGateway.name} configuration saved successfully!`);
      setEditingGateway(null);
      onRefresh();
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      alert(`Save error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col items-start justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong">
            <Sliders className="h-5 w-5 text-indigo-400" />
            Payment Methods & Checkout Channels
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Configure M-Pesa (Buy Goods Till / Paybill) and Card / Bank payment channels for your
            online customer checkout.
          </p>
        </div>
        {successMessage && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-50/80 px-3 py-1.5 text-xs text-emerald-700">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            {successMessage}
          </div>
        )}
      </div>

      {/* Gateway Cards Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {gateways.map((gw) => {
          const isMpesa = gw.provider === 'mpesa_daraja';
          const isPesapal = gw.provider === 'pesapal_v3';
          const Icon = isMpesa ? Smartphone : isPesapal ? CreditCard : ShieldCheck;
          const themeBorder = gw.isEnabled
            ? isMpesa
              ? 'border-emerald-500/30 bg-surface-raised'
              : 'border-indigo-500/30 bg-surface-raised'
            : 'border-line bg-surface-sunken/40 opacity-75';

          return (
            <div
              key={gw.id}
              className={`flex flex-col justify-between space-y-6 rounded-xl border p-6 transition-all ${themeBorder}`}
            >
              <div className="space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-12 w-12 items-center justify-center rounded-xl border shadow-md ${
                        isMpesa
                          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                          : 'border-indigo-500/20 bg-indigo-500/10 text-indigo-400'
                      }`}
                    >
                      <Icon className="h-6 w-6" />
                    </div>
                    <div>
                      <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
                        {gw.name}
                      </h3>
                      <span className="block font-mono text-[11px] text-fg-subtle">
                        Provider: {gw.provider}
                      </span>
                    </div>
                  </div>

                  {/* Toggle Switch */}
                  <label className="relative inline-flex cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={gw.isEnabled}
                      onChange={() => handleToggleEnable(gw)}
                      className="peer sr-only"
                    />
                    <div className="peer h-6 w-11 rounded-full bg-surface-sunken peer-checked:bg-indigo-600 peer-focus:outline-none after:absolute after:top-[2px] after:left-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-line-strong after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white" />
                  </label>
                </div>

                <p className="text-xs leading-relaxed text-fg-muted">{gw.description}</p>

                {/* Parameters Pill Matrix */}
                <div className="space-y-2.5 rounded-lg border border-line bg-surface p-4 text-xs">
                  <div className="flex items-center justify-between text-fg-muted">
                    <span>Active Environment:</span>
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
                        gw.environment === 'production'
                          ? 'bg-emerald-500/20 text-emerald-700'
                          : 'bg-amber-500/20 text-amber-700'
                      }`}
                    >
                      {gw.environment}
                    </span>
                  </div>

                  {isMpesa && (
                    <>
                      <div className="flex justify-between text-fg-muted">
                        <span>Shortcode / Till:</span>
                        <span className="font-mono font-semibold text-fg-strong">
                          {gw.credentials.shortcode || '174379'}
                        </span>
                      </div>
                      <div className="flex justify-between text-fg-muted">
                        <span>Consumer Key:</span>
                        <span className="max-w-[160px] truncate font-mono text-[11px] text-fg">
                          {gw.credentials.consumerKey
                            ? `${gw.credentials.consumerKey.slice(0, 10)}...`
                            : 'Not configured'}
                        </span>
                      </div>
                      <div className="flex justify-between text-fg-muted">
                        <span>Daraja LNMO Passkey:</span>
                        <span className="max-w-[160px] truncate font-mono text-[11px] text-fg">
                          {gw.credentials.passkey
                            ? `${gw.credentials.passkey.slice(0, 12)}...`
                            : 'Default Sandbox'}
                        </span>
                      </div>
                    </>
                  )}

                  {isPesapal && (
                    <>
                      <div className="flex justify-between text-fg-muted">
                        <span>Pesapal IPN ID:</span>
                        <span className="max-w-[160px] truncate font-mono text-[11px] text-fg-strong">
                          {gw.credentials.ipnId || 'ipn_88fa7b49-default'}
                        </span>
                      </div>
                      <div className="flex justify-between text-fg-muted">
                        <span>Consumer Key:</span>
                        <span className="max-w-[160px] truncate font-mono text-[11px] text-fg">
                          {gw.credentials.consumerKey
                            ? `${gw.credentials.consumerKey.slice(0, 12)}...`
                            : 'Configured'}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Configure credentials trigger */}
              <button
                onClick={() => setEditingGateway(JSON.parse(JSON.stringify(gw)))}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong/50 bg-surface-sunken px-4 py-2.5 text-xs font-semibold text-fg-strong transition-colors hover:bg-hover"
              >
                <Key className="h-3.5 w-3.5" />
                Configure API Keys & Endpoints
              </button>
            </div>
          );
        })}
      </div>

      {/* Edit Credentials Modal */}
      {editingGateway && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-md sm:p-6">
          <div className="relative my-8 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
            <div className="flex items-center justify-between border-b border-line bg-surface p-5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
                <Key className="h-4 w-4 text-indigo-400" />
                Configure {editingGateway.name}
              </h3>
              <button
                onClick={() => setEditingGateway(null)}
                className="cursor-pointer text-fg-muted hover:text-fg-strong"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveCredentials} className="space-y-4 p-6 text-xs">
              <div>
                <label className="mb-1 block font-medium text-fg">Target Environment</label>
                <select
                  value={editingGateway.environment}
                  onChange={(e: any) =>
                    setEditingGateway({ ...editingGateway, environment: e.target.value })
                  }
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-fg-strong focus:border-indigo-500 focus:outline-none"
                >
                  <option value="sandbox">Sandbox (Development / Simulation)</option>
                  <option value="production">Production (Live Safaricom / Pesapal)</option>
                </select>
              </div>

              {editingGateway.provider === 'mpesa_daraja' && (
                <>
                  <div>
                    <label className="mb-1 block font-medium text-fg">
                      Business ShortCode / Paybill / Till
                    </label>
                    <input
                      type="text"
                      value={editingGateway.credentials.shortcode || ''}
                      onChange={(e) =>
                        setEditingGateway({
                          ...editingGateway,
                          credentials: { ...editingGateway.credentials, shortcode: e.target.value },
                        })
                      }
                      required
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
                      placeholder="174379"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block font-medium text-fg">Daraja Consumer Key</label>
                    <input
                      type="text"
                      value={editingGateway.credentials.consumerKey || ''}
                      onChange={(e) =>
                        setEditingGateway({
                          ...editingGateway,
                          credentials: {
                            ...editingGateway.credentials,
                            consumerKey: e.target.value,
                          },
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
                      placeholder="cNd3A8vK4jQ1LzX..."
                    />
                  </div>

                  <div>
                    <label className="mb-1 block font-medium text-fg">Daraja Consumer Secret</label>
                    <input
                      type={showSecrets.mpesaSecret ? 'text' : 'password'}
                      value={editingGateway.credentials.consumerSecret || ''}
                      onChange={(e) =>
                        setEditingGateway({
                          ...editingGateway,
                          credentials: {
                            ...editingGateway.credentials,
                            consumerSecret: e.target.value,
                          },
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block font-medium text-fg">
                      Lipa Na M-Pesa Online Passkey
                    </label>
                    <textarea
                      rows={2}
                      value={editingGateway.credentials.passkey || ''}
                      onChange={(e) =>
                        setEditingGateway({
                          ...editingGateway,
                          credentials: { ...editingGateway.credentials, passkey: e.target.value },
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
                      placeholder="bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
                    />
                  </div>
                </>
              )}

              {editingGateway.provider === 'pesapal_v3' && (
                <>
                  <div>
                    <label className="mb-1 block font-medium text-fg">
                      Pesapal v3 Consumer Key
                    </label>
                    <input
                      type="text"
                      value={editingGateway.credentials.consumerKey || ''}
                      onChange={(e) =>
                        setEditingGateway({
                          ...editingGateway,
                          credentials: {
                            ...editingGateway.credentials,
                            consumerKey: e.target.value,
                          },
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block font-medium text-fg">
                      Pesapal v3 Consumer Secret
                    </label>
                    <input
                      type={showSecrets.pesapalSecret ? 'text' : 'password'}
                      value={editingGateway.credentials.consumerSecret || ''}
                      onChange={(e) =>
                        setEditingGateway({
                          ...editingGateway,
                          credentials: {
                            ...editingGateway.credentials,
                            consumerSecret: e.target.value,
                          },
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block font-medium text-fg">
                      Registered IPN Notification ID
                    </label>
                    <input
                      type="text"
                      value={editingGateway.credentials.ipnId || ''}
                      onChange={(e) =>
                        setEditingGateway({
                          ...editingGateway,
                          credentials: { ...editingGateway.credentials, ipnId: e.target.value },
                        })
                      }
                      className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-fg-strong placeholder-fg-faint focus:border-indigo-500 focus:outline-none"
                      placeholder="ipn_88fa7b49-..."
                    />
                  </div>
                </>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => setEditingGateway(null)}
                  className="cursor-pointer rounded-lg bg-surface-sunken px-4 py-2 text-fg-muted hover:text-fg-strong"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500"
                >
                  <Save className="h-3.5 w-3.5" />
                  {isSaving ? 'Saving...' : 'Save Configuration'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
