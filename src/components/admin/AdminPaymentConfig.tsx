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
  ExternalLink
} from 'lucide-react';
import { PaymentGatewayConfig } from '@/types/index';
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
      <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="font-bold text-base text-white flex items-center gap-2">
            <Sliders className="w-5 h-5 text-indigo-400" />
            Payment Methods & Checkout Channels
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Configure M-Pesa (Buy Goods Till / Paybill) and Card / Bank payment channels for your online customer checkout.
          </p>
        </div>
        {successMessage && (
          <div className="px-3 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            {successMessage}
          </div>
        )}
      </div>

      {/* Gateway Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {gateways.map((gw) => {
          const isMpesa = gw.provider === 'mpesa_daraja';
          const isPesapal = gw.provider === 'pesapal_v3';
          const Icon = isMpesa ? Smartphone : isPesapal ? CreditCard : ShieldCheck;
          const themeBorder = gw.isEnabled
            ? isMpesa
              ? 'border-emerald-500/30 bg-zinc-900'
              : 'border-indigo-500/30 bg-zinc-900'
            : 'border-zinc-800 bg-zinc-900/40 opacity-75';

          return (
            <div
              key={gw.id}
              className={`rounded-xl border p-6 flex flex-col justify-between space-y-6 transition-all ${themeBorder}`}
            >
              <div className="space-y-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center border shadow-md ${
                      isMpesa 
                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' 
                        : 'bg-indigo-500/10 border-indigo-500/20 text-indigo-400'
                    }`}>
                      <Icon className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm text-white flex items-center gap-2">
                        {gw.name}
                      </h3>
                      <span className="text-[11px] font-mono text-zinc-500 block">
                        Provider: {gw.provider}
                      </span>
                    </div>
                  </div>

                  {/* Toggle Switch */}
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={gw.isEnabled}
                      onChange={() => handleToggleEnable(gw)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>

                <p className="text-xs text-zinc-400 leading-relaxed">
                  {gw.description}
                </p>

                {/* Parameters Pill Matrix */}
                <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 space-y-2.5 text-xs">
                  <div className="flex justify-between items-center text-zinc-400">
                    <span>Active Environment:</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      gw.environment === 'production' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                    }`}>
                      {gw.environment}
                    </span>
                  </div>

                  {isMpesa && (
                    <>
                      <div className="flex justify-between text-zinc-400">
                        <span>Shortcode / Till:</span>
                        <span className="font-mono text-white font-semibold">{gw.credentials.shortcode || '174379'}</span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Consumer Key:</span>
                        <span className="font-mono text-zinc-300 text-[11px] truncate max-w-[160px]">
                          {gw.credentials.consumerKey ? `${gw.credentials.consumerKey.slice(0, 10)}...` : 'Not configured'}
                        </span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Daraja LNMO Passkey:</span>
                        <span className="font-mono text-zinc-300 text-[11px] truncate max-w-[160px]">
                          {gw.credentials.passkey ? `${gw.credentials.passkey.slice(0, 12)}...` : 'Default Sandbox'}
                        </span>
                      </div>
                    </>
                  )}

                  {isPesapal && (
                    <>
                      <div className="flex justify-between text-zinc-400">
                        <span>Pesapal IPN ID:</span>
                        <span className="font-mono text-white text-[11px] truncate max-w-[160px]">
                          {gw.credentials.ipnId || 'ipn_88fa7b49-default'}
                        </span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Consumer Key:</span>
                        <span className="font-mono text-zinc-300 text-[11px] truncate max-w-[160px]">
                          {gw.credentials.consumerKey ? `${gw.credentials.consumerKey.slice(0, 12)}...` : 'Configured'}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Configure credentials trigger */}
              <button
                onClick={() => setEditingGateway(JSON.parse(JSON.stringify(gw)))}
                className="w-full py-2.5 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer border border-zinc-700/50"
              >
                <Key className="w-3.5 h-3.5" />
                Configure API Keys & Endpoints
              </button>
            </div>
          );
        })}
      </div>

      {/* Edit Credentials Modal */}
      {editingGateway && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center">
          <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8">
            <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                <Key className="w-4 h-4 text-indigo-400" />
                Configure {editingGateway.name}
              </h3>
              <button
                onClick={() => setEditingGateway(null)}
                className="text-zinc-400 hover:text-white cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveCredentials} className="p-6 space-y-4 text-xs">
              <div>
                <label className="block text-zinc-300 font-medium mb-1">Target Environment</label>
                <select
                  value={editingGateway.environment}
                  onChange={(e: any) => setEditingGateway({ ...editingGateway, environment: e.target.value })}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="sandbox">Sandbox (Development / Simulation)</option>
                  <option value="production">Production (Live Safaricom / Pesapal)</option>
                </select>
              </div>

              {editingGateway.provider === 'mpesa_daraja' && (
                <>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">Business ShortCode / Paybill / Till</label>
                    <input
                      type="text"
                      value={editingGateway.credentials.shortcode || ''}
                      onChange={(e) => setEditingGateway({
                        ...editingGateway,
                        credentials: { ...editingGateway.credentials, shortcode: e.target.value }
                      })}
                      required
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                      placeholder="174379"
                    />
                  </div>

                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">Daraja Consumer Key</label>
                    <input
                      type="text"
                      value={editingGateway.credentials.consumerKey || ''}
                      onChange={(e) => setEditingGateway({
                        ...editingGateway,
                        credentials: { ...editingGateway.credentials, consumerKey: e.target.value }
                      })}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                      placeholder="cNd3A8vK4jQ1LzX..."
                    />
                  </div>

                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">Daraja Consumer Secret</label>
                    <input
                      type={showSecrets.mpesaSecret ? 'text' : 'password'}
                      value={editingGateway.credentials.consumerSecret || ''}
                      onChange={(e) => setEditingGateway({
                        ...editingGateway,
                        credentials: { ...editingGateway.credentials, consumerSecret: e.target.value }
                      })}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">Lipa Na M-Pesa Online Passkey</label>
                    <textarea
                      rows={2}
                      value={editingGateway.credentials.passkey || ''}
                      onChange={(e) => setEditingGateway({
                        ...editingGateway,
                        credentials: { ...editingGateway.credentials, passkey: e.target.value }
                      })}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                      placeholder="bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
                    />
                  </div>
                </>
              )}

              {editingGateway.provider === 'pesapal_v3' && (
                <>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">Pesapal v3 Consumer Key</label>
                    <input
                      type="text"
                      value={editingGateway.credentials.consumerKey || ''}
                      onChange={(e) => setEditingGateway({
                        ...editingGateway,
                        credentials: { ...editingGateway.credentials, consumerKey: e.target.value }
                      })}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">Pesapal v3 Consumer Secret</label>
                    <input
                      type={showSecrets.pesapalSecret ? 'text' : 'password'}
                      value={editingGateway.credentials.consumerSecret || ''}
                      onChange={(e) => setEditingGateway({
                        ...editingGateway,
                        credentials: { ...editingGateway.credentials, consumerSecret: e.target.value }
                      })}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">Registered IPN Notification ID</label>
                    <input
                      type="text"
                      value={editingGateway.credentials.ipnId || ''}
                      onChange={(e) => setEditingGateway({
                        ...editingGateway,
                        credentials: { ...editingGateway.credentials, ipnId: e.target.value }
                      })}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
                      placeholder="ipn_88fa7b49-..."
                    />
                  </div>
                </>
              )}

              <div className="pt-4 border-t border-zinc-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditingGateway(null)}
                  className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold flex items-center gap-2 shadow-lg shadow-indigo-600/20 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
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
