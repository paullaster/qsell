import React, { useState, useMemo } from 'react';
import { 
  Coins, 
  Plus, 
  Search, 
  CheckCircle, 
  Globe, 
  Edit2, 
  Trash2, 
  Star, 
  Info, 
  RefreshCw,
  Check,
  X,
  ArrowRightLeft,
  DollarSign,
  TrendingUp,
  Percent,
  Sliders
} from 'lucide-react';
import { CurrencyConfig } from '../../types/index.js';
import { 
  createCurrencyAction, 
  updateCurrencyAction, 
  deleteCurrencyAction, 
  setBaseCurrencyAction 
} from '../../lib/serverActions.js';
import { formatPriceWithCurrency } from '../../lib/currency.js';

interface AdminCurrenciesProps {
  currenciesPromise: Promise<CurrencyConfig[]>;
  onRefreshAll: () => void;
}

export function AdminCurrencies({ currenciesPromise, onRefreshAll }: AdminCurrenciesProps) {
  const [currencies, setCurrencies] = useState<CurrencyConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  
  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCurrency, setEditingCurrency] = useState<CurrencyConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Live Converter Test State
  const [testAmountKes, setTestAmountKes] = useState<number>(50000);

  // Inverse Rate Helper Mode for editing/creating
  const [useInverseRate, setUseInverseRate] = useState(true);
  const [inverseRateValue, setInverseRateValue] = useState<string>('130');

  // Form State
  const [formData, setFormData] = useState({
    code: '',
    name: '',
    symbol: '',
    exchangeRate: 1.0,
    isBaseCurrency: false,
    decimalDigits: 2,
    symbolPosition: 'prefix' as 'prefix' | 'suffix',
    isEnabled: true,
    flagEmoji: '🌍'
  });

  // Load Currencies
  React.useEffect(() => {
    let isMounted = true;
    setIsLoading(true);
    currenciesPromise
      .then((data) => {
        if (isMounted) {
          setCurrencies(data);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to load currencies:', err);
        if (isMounted) setIsLoading(false);
      });
    return () => { isMounted = false; };
  }, [currenciesPromise]);

  const baseCurrency = currencies.find(c => c.isBaseCurrency) || currencies[0];

  const handleOpenModal = (currency?: CurrencyConfig) => {
    setFormError(null);
    if (currency) {
      setEditingCurrency(currency);
      const invRate = currency.exchangeRate > 0 ? (1 / currency.exchangeRate).toFixed(2) : '1';
      setInverseRateValue(invRate);
      setFormData({
        code: currency.code,
        name: currency.name,
        symbol: currency.symbol,
        exchangeRate: currency.exchangeRate,
        isBaseCurrency: currency.isBaseCurrency,
        decimalDigits: currency.decimalDigits,
        symbolPosition: currency.symbolPosition,
        isEnabled: currency.isEnabled,
        flagEmoji: currency.flagEmoji || '🌍'
      });
    } else {
      setEditingCurrency(null);
      setInverseRateValue('130');
      setFormData({
        code: '',
        name: '',
        symbol: '$',
        exchangeRate: 0.0077,
        isBaseCurrency: false,
        decimalDigits: 2,
        symbolPosition: 'prefix',
        isEnabled: true,
        flagEmoji: '🌐'
      });
    }
    setIsModalOpen(true);
  };

  const handleInverseRateChange = (val: string) => {
    setInverseRateValue(val);
    const num = parseFloat(val);
    if (num > 0) {
      setFormData(prev => ({
        ...prev,
        exchangeRate: 1 / num
      }));
    }
  };

  const handleSaveCurrency = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!formData.code.trim()) {
      setFormError('Currency code (e.g. USD, EUR) is required.');
      return;
    }
    if (!formData.name.trim()) {
      setFormError('Currency name is required.');
      return;
    }
    if (!formData.exchangeRate || formData.exchangeRate <= 0) {
      setFormError('Exchange rate multiplier must be greater than zero.');
      return;
    }

    setIsSaving(true);
    try {
      if (editingCurrency) {
        const updated = await updateCurrencyAction(editingCurrency.code, formData);
        setCurrencies(prev => prev.map(c => c.code === updated.code ? updated : (formData.isBaseCurrency ? { ...c, isBaseCurrency: false } : c)));
      } else {
        const created = await createCurrencyAction(formData as any);
        setCurrencies(prev => [...prev, created]);
      }
      setIsModalOpen(false);
      onRefreshAll();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save currency');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteCurrency = async (code: string) => {
    if (!window.confirm(`Are you sure you want to remove currency "${code}"?`)) {
      return;
    }
    try {
      await deleteCurrencyAction(code);
      setCurrencies(prev => prev.filter(c => c.code !== code));
      onRefreshAll();
    } catch (err: any) {
      alert(err.message || 'Failed to delete currency');
    }
  };

  const handleSetBase = async (code: string) => {
    if (!window.confirm(`Set "${code}" as the primary store accounting base currency?`)) {
      return;
    }
    try {
      await setBaseCurrencyAction(code);
      setCurrencies(prev => prev.map(c => ({
        ...c,
        isBaseCurrency: c.code === code
      })));
      onRefreshAll();
    } catch (err: any) {
      alert(err.message || 'Failed to set base currency');
    }
  };

  const filteredCurrencies = useMemo(() => {
    return currencies.filter(c => 
      c.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.symbol.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [currencies, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-zinc-900 border border-zinc-800 rounded-xl p-6 shadow-xl">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Coins className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">Multi-Market Currency Management</h1>
              <p className="text-xs text-zinc-400 mt-0.5">
                Manage global currencies, live FX exchange rate multipliers, and cross-border customer price displays.
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleOpenModal()}
            id="btn-add-currency"
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Currency</span>
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Primary Base Currency</span>
            <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {baseCurrency?.code || 'KES'}
            </span>
            <span className="text-xs text-amber-400 font-semibold">
              {baseCurrency?.symbol || 'KSh'} • {baseCurrency?.name || 'Kenyan Shilling'}
            </span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Core reference currency for inventory cost & retail</p>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Active FX Markets</span>
            <Globe className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {currencies.filter(c => c.isEnabled).length}
            </span>
            <span className="text-xs text-zinc-400">/ {currencies.length} Configured</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Customer-selectable currencies in storefront</p>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">USD Exchange Benchmark</span>
            <ArrowRightLeft className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">
              {(() => {
                const usd = currencies.find(c => c.code === 'USD');
                if (!usd || usd.exchangeRate === 0) return '130.00';
                return (1 / usd.exchangeRate).toFixed(2);
              })()}
            </span>
            <span className="text-xs text-emerald-400 font-semibold">KES / USD</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">1 US Dollar converts to KES base</p>
        </div>

        <div className="bg-zinc-900/80 border border-zinc-800 p-4 rounded-xl">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Regional East Africa FX</span>
            <TrendingUp className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-bold text-white">UGX & TZS</span>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">Automated zero-decimal cross-border formatting</p>
        </div>
      </div>

      {/* Live Cross-Currency Simulator */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 shadow-lg">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-bold text-white">Live Multi-Market Price Matrix & Rate Checker</h2>
          </div>
          <span className="text-xs text-zinc-400">
            Simulate how a product price translates across active international currencies
          </span>
        </div>

        <div className="mt-4 flex flex-col md:flex-row items-start md:items-center gap-4">
          <div className="w-full md:w-64 shrink-0">
            <label className="block text-xs font-medium text-zinc-400 mb-1.5">
              Input Base Amount ({baseCurrency?.code || 'KES'})
            </label>
            <div className="relative">
              <span className="absolute left-3 top-2.5 text-xs text-zinc-500 font-semibold">
                {baseCurrency?.symbol || 'KSh'}
              </span>
              <input
                type="number"
                value={testAmountKes}
                onChange={(e) => setTestAmountKes(Number(e.target.value) || 0)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-12 pr-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 font-semibold"
              />
            </div>
          </div>

          <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 w-full">
            {currencies.filter(c => c.isEnabled).map(cur => {
              const formatted = formatPriceWithCurrency(testAmountKes, cur, currencies);
              return (
                <div key={cur.code} className="bg-zinc-950/70 border border-zinc-800 p-2.5 rounded-lg flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                      <span>{cur.flagEmoji}</span>
                      <span>{cur.code}</span>
                    </span>
                    {cur.isBaseCurrency && (
                      <span className="text-[9px] uppercase font-bold text-amber-400">Base</span>
                    )}
                  </div>
                  <div className="mt-2 text-xs font-bold text-indigo-400 truncate">
                    {formatted}
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {cur.isBaseCurrency ? '1.0' : `1 ${baseCurrency?.code} = ${cur.exchangeRate.toFixed(4)}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Filter & Search */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Search currencies by code (e.g. USD, EUR), name, or symbol..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-4 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Currencies Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950/70 border-b border-zinc-800 text-zinc-400 uppercase tracking-wider font-semibold">
              <tr>
                <th className="py-3 px-4">Currency</th>
                <th className="py-3 px-4">Symbol</th>
                <th className="py-3 px-4">Exchange Multiplier</th>
                <th className="py-3 px-4">Inverse FX Benchmark</th>
                <th className="py-3 px-4">Formatting Preview</th>
                <th className="py-3 px-4">Store Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
              {filteredCurrencies.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-zinc-500">
                    No currencies found matching your search.
                  </td>
                </tr>
              ) : (
                filteredCurrencies.map((currency) => {
                  const inverse = currency.exchangeRate > 0 ? (1 / currency.exchangeRate).toFixed(2) : '—';
                  const exampleFormatted = formatPriceWithCurrency(12500, currency, currencies);

                  return (
                    <tr key={currency.code} className="hover:bg-zinc-800/40 transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2.5">
                          <span className="text-xl">{currency.flagEmoji || '🌐'}</span>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-white">{currency.code}</span>
                              {currency.isBaseCurrency && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                  <Star className="w-3 h-3 fill-amber-400" />
                                  Base Currency
                                </span>
                              )}
                            </div>
                            <span className="text-zinc-400 text-[11px]">{currency.name}</span>
                          </div>
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <span className="font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 border border-zinc-700/50 font-semibold">
                          {currency.symbol}
                        </span>
                      </td>

                      <td className="py-3.5 px-4">
                        <span className="font-mono text-emerald-400 font-semibold">
                          {currency.exchangeRate}
                        </span>
                        <span className="text-[10px] text-zinc-500 ml-1">
                          (per 1 {baseCurrency?.code || 'KES'})
                        </span>
                      </td>

                      <td className="py-3.5 px-4">
                        {currency.isBaseCurrency ? (
                          <span className="text-zinc-500">1.00 (Base)</span>
                        ) : (
                          <span className="text-zinc-300 font-medium">
                            1 {currency.code} = <span className="text-amber-400 font-bold">{inverse} {baseCurrency?.code || 'KES'}</span>
                          </span>
                        )}
                      </td>

                      <td className="py-3.5 px-4">
                        <span className="font-mono text-indigo-400 font-medium bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">
                          {exampleFormatted}
                        </span>
                      </td>

                      <td className="py-3.5 px-4">
                        <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                          currency.isEnabled ? 'text-emerald-400' : 'text-zinc-500'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${currency.isEnabled ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
                          {currency.isEnabled ? 'Enabled in Store' : 'Disabled'}
                        </span>
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {!currency.isBaseCurrency && (
                            <button
                              onClick={() => handleSetBase(currency.code)}
                              title="Set as store accounting base currency"
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-amber-400 text-[11px] font-medium transition-colors cursor-pointer border border-zinc-700/50"
                            >
                              Set Base
                            </button>
                          )}
                          <button
                            onClick={() => handleOpenModal(currency)}
                            title="Edit currency"
                            className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {!currency.isBaseCurrency && (
                            <button
                              onClick={() => handleDeleteCurrency(currency.code)}
                              title="Remove currency"
                              className="p-1.5 rounded bg-zinc-800 hover:bg-red-900/40 text-zinc-400 hover:text-red-400 transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Currency Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-lg w-full p-6 shadow-2xl overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <Coins className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">
                  {editingCurrency ? `Edit Currency (${editingCurrency.code})` : 'Add New Market Currency'}
                </h3>
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {formError && (
              <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                <Info className="w-4 h-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSaveCurrency} className="space-y-4 mt-4">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Currency ISO Code *
                  </label>
                  <input
                    type="text"
                    placeholder="USD"
                    maxLength={5}
                    disabled={!!editingCurrency}
                    value={formData.code}
                    onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-mono uppercase font-bold focus:outline-none focus:border-indigo-500 disabled:opacity-50"
                    required
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Currency Full Name *
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. US Dollar, Euro, Ugandan Shilling"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Symbol *
                  </label>
                  <input
                    type="text"
                    placeholder="$"
                    value={formData.symbol}
                    onChange={(e) => setFormData({ ...formData, symbol: e.target.value })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white font-semibold focus:outline-none focus:border-indigo-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Flag Emoji
                  </label>
                  <input
                    type="text"
                    placeholder="🇺🇸"
                    value={formData.flagEmoji}
                    onChange={(e) => setFormData({ ...formData, flagEmoji: e.target.value })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white text-center text-base focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Decimals
                  </label>
                  <select
                    value={formData.decimalDigits}
                    onChange={(e) => setFormData({ ...formData, decimalDigits: parseInt(e.target.value) })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value={0}>0 (KES, UGX, TZS)</option>
                    <option value={2}>2 (USD, EUR, GBP)</option>
                    <option value={3}>3 (BHD, KWD)</option>
                  </select>
                </div>
              </div>

              {/* Exchange Rate Configuration with Helper */}
              <div className="bg-zinc-950/70 p-4 rounded-xl border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Exchange Rate Multiplier</span>
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <button
                      type="button"
                      onClick={() => setUseInverseRate(!useInverseRate)}
                      className="text-indigo-400 hover:underline cursor-pointer"
                    >
                      {useInverseRate ? 'Switch to direct multiplier' : 'Switch to inverse (1 foreign = X base)'}
                    </button>
                  </div>
                </div>

                {useInverseRate ? (
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">
                      How many {baseCurrency?.code || 'KES'} equals 1 {formData.code || 'foreign unit'}?
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400 font-mono">1 {formData.code || 'USD'} =</span>
                      <input
                        type="number"
                        step="0.0001"
                        placeholder="130.00"
                        value={inverseRateValue}
                        onChange={(e) => handleInverseRateChange(e.target.value)}
                        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-bold focus:outline-none focus:border-indigo-500"
                      />
                      <span className="text-xs text-zinc-400 font-mono">{baseCurrency?.code || 'KES'}</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-1">
                      Computed multiplier: 1 {baseCurrency?.code || 'KES'} = {formData.exchangeRate.toFixed(6)} {formData.code || 'USD'}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] text-zinc-400 mb-1">
                      Multiplier per 1 {baseCurrency?.code || 'KES'}
                    </label>
                    <input
                      type="number"
                      step="0.000001"
                      placeholder="0.0077"
                      value={formData.exchangeRate}
                      onChange={(e) => setFormData({ ...formData, exchangeRate: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-emerald-400 font-bold focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    Symbol Placement
                  </label>
                  <select
                    value={formData.symbolPosition}
                    onChange={(e) => setFormData({ ...formData, symbolPosition: e.target.value as any })}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="prefix">Prefix (e.g. $ 100)</option>
                    <option value="suffix">Suffix (e.g. 100 KSh)</option>
                  </select>
                </div>

                <div className="flex flex-col justify-end space-y-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.isEnabled}
                      onChange={(e) => setFormData({ ...formData, isEnabled: e.target.checked })}
                      className="rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-zinc-300 font-medium">Enabled in Storefront</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.isBaseCurrency}
                      onChange={(e) => setFormData({ ...formData, isBaseCurrency: e.target.checked })}
                      className="rounded bg-zinc-800 border-zinc-700 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-xs text-zinc-300 font-medium">Set as Store Base Currency</span>
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/25 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isSaving ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  <span>{editingCurrency ? 'Update Currency' : 'Save Currency'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
