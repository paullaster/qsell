import React, { use, useState } from 'react';
import { 
  Layers, 
  Search, 
  ArrowDownRight, 
  ArrowUpRight, 
  AlertTriangle, 
  Plus, 
  Minus, 
  History, 
  FileText, 
  CheckCircle2, 
  Truck, 
  ShieldAlert, 
  ClipboardCheck, 
  Download,
  Filter,
  RefreshCw,
  DollarSign
} from 'lucide-react';
import { Product, InventoryLedgerEntry, InventoryChangeType } from '../../types/index.js';
import { 
  updateProductStockAction, 
  receiveStockAction, 
  writeOffStockAction, 
  auditStockCountAction 
} from '../../lib/serverActions.js';

interface AdminInventoryProps {
  productsPromise: Promise<Product[]>;
  ledgerPromise: Promise<InventoryLedgerEntry[]>;
  onRefresh: () => void;
}

export function AdminInventory({
  productsPromise,
  ledgerPromise,
  onRefresh
}: AdminInventoryProps) {
  const products = use(productsPromise);
  const ledger = use(ledgerPromise);

  const [activeTab, setActiveTab] = useState<'stock_levels' | 'receive_po' | 'write_off' | 'audit_count' | 'ledger' | 'reorder_plan'>('stock_levels');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  // Modal / Action States
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [modalType, setModalType] = useState<'receive' | 'writeoff' | 'audit' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Form states for Receive PO
  const [receiveQty, setReceiveQty] = useState<number>(10);
  const [supplierName, setSupplierName] = useState('East Africa Electronics Distributors');
  const [poNumber, setPoNumber] = useState(`PO-2026-${Math.floor(100 + Math.random() * 900)}`);
  const [unitCost, setUnitCost] = useState<number>(0);
  const [receiveNotes, setReceiveNotes] = useState('Standard warehouse replenishment');

  // Form states for Write-off
  const [writeOffQty, setWriteOffQty] = useState<number>(1);
  const [writeOffReason, setWriteOffReason] = useState<'damage_transit' | 'defective_return' | 'warehouse_damage' | 'shrinkage_loss' | 'sample_marketing'>('warehouse_damage');
  const [writeOffNotes, setWriteOffNotes] = useState('');

  // Form states for Physical Audit
  const [auditCountedQty, setAuditCountedQty] = useState<number>(0);
  const [auditNotes, setAuditNotes] = useState('Quarterly cycle count verification');

  // Filtered Products
  const filteredProducts = products.filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = categoryFilter === 'all' || p.category.toLowerCase() === categoryFilter.toLowerCase();
    return matchesSearch && matchesCategory;
  });

  const lowStockItems = products.filter((p) => (p.stockQuantity - p.reservedQuantity) <= p.lowStockThreshold);

  // Quick Delta Adjust
  const handleQuickAdjust = async (product: Product, delta: number) => {
    const newQty = Math.max(0, product.stockQuantity + delta);
    try {
      await updateProductStockAction(product.id, newQty, `Quick adjustment by ${delta > 0 ? '+' : ''}${delta}`);
      onRefresh();
    } catch (err: any) {
      alert(`Adjustment error: ${err.message}`);
    }
  };

  // Open Modals
  const openReceiveModal = (product: Product) => {
    setSelectedProduct(product);
    setReceiveQty(10);
    setUnitCost(product.costPrice || Math.round(product.price * 0.75));
    setPoNumber(`PO-2026-${Math.floor(100 + Math.random() * 900)}`);
    setActionError(null);
    setActionSuccess(null);
    setModalType('receive');
  };

  const openWriteOffModal = (product: Product) => {
    setSelectedProduct(product);
    setWriteOffQty(1);
    setWriteOffNotes('');
    setActionError(null);
    setActionSuccess(null);
    setModalType('writeoff');
  };

  const openAuditModal = (product: Product) => {
    setSelectedProduct(product);
    setAuditCountedQty(product.stockQuantity);
    setAuditNotes('Weekly physical cycle count');
    setActionError(null);
    setActionSuccess(null);
    setModalType('audit');
  };

  // Submit Receive PO
  const handleReceiveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct || receiveQty <= 0) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await receiveStockAction({
        productId: selectedProduct.id,
        quantity: Number(receiveQty),
        supplier: supplierName.trim(),
        poNumber: poNumber.trim(),
        unitCost: Number(unitCost),
        notes: receiveNotes.trim()
      });
      setActionSuccess(`Successfully received ${receiveQty} units for ${selectedProduct.sku}`);
      setTimeout(() => {
        setModalType(null);
        onRefresh();
      }, 900);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit Write-Off
  const handleWriteOffSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct || writeOffQty <= 0) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await writeOffStockAction({
        productId: selectedProduct.id,
        quantity: Number(writeOffQty),
        reasonCode: writeOffReason,
        notes: writeOffNotes.trim()
      });
      setActionSuccess(`Successfully written off ${writeOffQty} units for ${selectedProduct.sku}`);
      setTimeout(() => {
        setModalType(null);
        onRefresh();
      }, 900);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit Physical Audit
  const handleAuditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      const res = await auditStockCountAction({
        productId: selectedProduct.id,
        countedQuantity: Number(auditCountedQty),
        notes: auditNotes.trim()
      });
      setActionSuccess(`Audit reconciled. Discrepancy: ${res.discrepancy >= 0 ? '+' : ''}${res.discrepancy} units.`);
      setTimeout(() => {
        setModalType(null);
        onRefresh();
      }, 1000);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-xl bg-zinc-900 border border-zinc-800">
        <div>
          <h2 className="font-bold text-base text-white flex items-center gap-2">
            <Layers className="w-5 h-5 text-indigo-400" />
            Stock Control & Warehouse Management
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Receive supplier goods (PO), record damaged stock write-offs, conduct physical stock audits, and view stock movement history.
          </p>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800 overflow-x-auto">
          <button
            onClick={() => setActiveTab('stock_levels')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
              activeTab === 'stock_levels' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Current Stock Levels
          </button>
          <button
            onClick={() => setActiveTab('reorder_plan')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'reorder_plan' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Low Stock Alerts
            {lowStockItems.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-red-500 text-white text-[10px] font-bold font-mono">
                {lowStockItems.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('ledger')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer flex items-center gap-1.5 ${
              activeTab === 'ledger' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            Stock Movement History ({ledger.length})
          </button>
        </div>
      </div>

      {/* TAB 1: Stock Levels & Quick Operations */}
      {activeTab === 'stock_levels' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-xl bg-zinc-900 border border-zinc-800 text-xs">
            <div className="relative w-full sm:w-80">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <input
                type="text"
                placeholder="Search by SKU or item title..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-4 py-1.5 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
              <span className="text-zinc-400">
                Low Stock Critical: <strong className="text-amber-400">{lowStockItems.length} items</strong>
              </span>
              <button
                onClick={onRefresh}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                Refresh
              </button>
            </div>
          </div>

          {/* Warehouse Table */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-950 text-zinc-400 font-semibold border-b border-zinc-800">
                  <tr>
                    <th className="py-3 px-4">SKU & Item</th>
                    <th className="py-3 px-4 text-center">On-Hand Total</th>
                    <th className="py-3 px-4 text-center">Reserved</th>
                    <th className="py-3 px-4 text-center">Available</th>
                    <th className="py-3 px-4 text-center">Quick Adjust</th>
                    <th className="py-3 px-4 text-right">Warehouse Operations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 text-zinc-300">
                  {filteredProducts.map((p) => {
                    const available = p.stockQuantity - p.reservedQuantity;
                    const isLow = available <= p.lowStockThreshold && available > 0;
                    const isOut = available <= 0;

                    return (
                      <tr key={p.id} className="hover:bg-zinc-800/40 transition-colors">
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-white">{p.name}</div>
                          <div className="text-[11px] text-zinc-400 font-mono flex items-center gap-2 mt-0.5">
                            <span className="text-indigo-400 font-bold">{p.sku}</span>
                            <span>• {p.category}</span>
                            <span>• Threshold: {p.lowStockThreshold}</span>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono font-bold text-white">
                          {p.stockQuantity}
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono text-zinc-400">
                          {p.reservedQuantity}
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <span className={`px-2.5 py-0.5 rounded-full font-mono font-bold text-[11px] ${
                            isOut
                              ? 'bg-red-950 text-red-400 border border-red-800'
                              : isLow
                              ? 'bg-amber-950 text-amber-300 border border-amber-800'
                              : 'bg-emerald-950/80 text-emerald-300 border border-emerald-800'
                          }`}>
                            {available} {isOut ? '(Out of Stock)' : isLow ? '(Low Stock)' : 'Units'}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-center">
                          <div className="inline-flex items-center gap-1 bg-zinc-950 p-1 rounded-lg border border-zinc-800">
                            <button
                              onClick={() => handleQuickAdjust(p, -5)}
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono text-[10px] cursor-pointer"
                              title="Decrease 5"
                            >
                              -5
                            </button>
                            <button
                              onClick={() => handleQuickAdjust(p, -1)}
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono text-[10px] cursor-pointer"
                              title="Decrease 1"
                            >
                              -1
                            </button>
                            <button
                              onClick={() => handleQuickAdjust(p, 1)}
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono text-[10px] cursor-pointer"
                              title="Increase 1"
                            >
                              +1
                            </button>
                            <button
                              onClick={() => handleQuickAdjust(p, 5)}
                              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono text-[10px] cursor-pointer"
                              title="Increase 5"
                            >
                              +5
                            </button>
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => openReceiveModal(p)}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800/80 font-medium text-[11px] cursor-pointer transition-colors"
                              title="Receive Goods from Purchase Order"
                            >
                              <Truck className="w-3 h-3" />
                              Receive PO
                            </button>
                            <button
                              onClick={() => openWriteOffModal(p)}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-950 hover:bg-red-900 text-red-300 border border-red-800/80 font-medium text-[11px] cursor-pointer transition-colors"
                              title="Record Damaged or Lost Stock"
                            >
                              <ShieldAlert className="w-3 h-3" />
                              Write-Off
                            </button>
                            <button
                              onClick={() => openAuditModal(p)}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 font-medium text-[11px] cursor-pointer transition-colors"
                              title="Physical Count Audit"
                            >
                              <ClipboardCheck className="w-3 h-3" />
                              Audit
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Reorder Alerts & Purchase Planning */}
      {activeTab === 'reorder_plan' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div>
              <h3 className="font-bold text-white text-sm">Automated Inventory Replenishment Plan</h3>
              <p className="text-zinc-400">
                Products currently at or below their safety stock threshold requiring immediate purchase orders.
              </p>
            </div>
            <div className="font-mono text-zinc-300 bg-zinc-950 px-3 py-1.5 rounded-lg border border-zinc-800">
              Total Recommended Restock: <strong>{lowStockItems.reduce((acc, p) => acc + (p.lowStockThreshold * 3 - (p.stockQuantity - p.reservedQuantity)), 0)} units</strong>
            </div>
          </div>

          <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-950 text-zinc-400 font-semibold border-b border-zinc-800">
                  <tr>
                    <th className="py-3 px-4">SKU & Item</th>
                    <th className="py-3 px-4 text-center">Available Stock</th>
                    <th className="py-3 px-4 text-center">Safety Threshold</th>
                    <th className="py-3 px-4 text-center">Suggested PO Qty</th>
                    <th className="py-3 px-4 text-right">Est. Cost (KES)</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 text-zinc-300">
                  {lowStockItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-emerald-400 font-medium">
                        All products are currently well above safety stock thresholds!
                      </td>
                    </tr>
                  ) : (
                    lowStockItems.map((p) => {
                      const available = p.stockQuantity - p.reservedQuantity;
                      const suggestedQty = Math.max(10, (p.lowStockThreshold * 3) - available);
                      const unitCostEst = p.costPrice || Math.round(p.price * 0.75);
                      const totalCostEst = suggestedQty * unitCostEst;

                      return (
                        <tr key={p.id} className="hover:bg-zinc-800/40">
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-white">{p.name}</div>
                            <div className="text-[11px] text-zinc-400 font-mono">{p.sku}</div>
                          </td>
                          <td className="py-3.5 px-4 text-center font-mono font-bold text-red-400">
                            {available} units
                          </td>
                          <td className="py-3.5 px-4 text-center font-mono text-zinc-400">
                            {p.lowStockThreshold} units
                          </td>
                          <td className="py-3.5 px-4 text-center font-mono font-bold text-indigo-400">
                            +{suggestedQty} units
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono text-zinc-200">
                            KES {totalCostEst.toLocaleString()}
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <button
                              onClick={() => openReceiveModal(p)}
                              className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-[11px] cursor-pointer"
                            >
                              Draft PO
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Immutable Audit Ledger */}
      {activeTab === 'ledger' && (
        <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-950 text-zinc-400 font-semibold border-b border-zinc-800">
                <tr>
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">SKU / Item</th>
                  <th className="py-3 px-4">Change Type</th>
                  <th className="py-3 px-4 text-center">Delta</th>
                  <th className="py-3 px-4 text-center">Prior &rarr; New</th>
                  <th className="py-3 px-4">Actor</th>
                  <th className="py-3 px-4">Reason / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 text-zinc-300">
                {ledger.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-zinc-500">
                      No ledger entries recorded yet.
                    </td>
                  </tr>
                ) : (
                  ledger.map((entry) => {
                    const isPositive = entry.delta > 0;
                    return (
                      <tr key={entry.id} className="hover:bg-zinc-800/40 font-mono">
                        <td className="py-3 px-4 text-zinc-400 text-[11px]">
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td className="py-3 px-4 font-semibold text-white">
                          {entry.sku}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-sans font-bold uppercase tracking-wider ${
                            entry.changeType === 'STOCK_IN_PO'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : entry.changeType === 'DAMAGE_WRITE_OFF'
                              ? 'bg-red-950 text-red-300 border border-red-800'
                              : entry.changeType === 'ORDER_FULFILLED'
                              ? 'bg-blue-950 text-blue-300 border border-blue-800'
                              : 'bg-zinc-800 text-zinc-300'
                          }`}>
                            {entry.changeType.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className={`py-3 px-4 text-center font-bold ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                          {isPositive ? `+${entry.delta}` : entry.delta}
                        </td>
                        <td className="py-3 px-4 text-center text-zinc-400">
                          {entry.priorStock} &rarr; <strong className="text-white">{entry.newStock}</strong>
                        </td>
                        <td className="py-3 px-4 text-zinc-300">
                          {entry.actor}
                        </td>
                        <td className="py-3 px-4 font-sans text-zinc-400 max-w-xs truncate" title={entry.reason}>
                          {entry.reason}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL 1: Receive Stock from PO */}
      {modalType === 'receive' && selectedProduct && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center">
          <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl my-8">
            <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
              <div className="flex items-center gap-2">
                <Truck className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-base text-white">Receive Goods (Purchase Order Inward)</h3>
              </div>
              <button onClick={() => setModalType(null)} className="text-zinc-400 hover:text-white p-1">
                &times;
              </button>
            </div>

            <form onSubmit={handleReceiveSubmit} className="p-6 space-y-4 text-xs">
              {actionError && (
                <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-200">
                  {actionError}
                </div>
              )}
              {actionSuccess && (
                <div className="p-3 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-200">
                  {actionSuccess}
                </div>
              )}

              <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block text-[10px] uppercase">Product Receiving Into</span>
                <span className="text-white font-bold text-sm">{selectedProduct.name}</span>
                <div className="text-zinc-400 font-mono mt-0.5">
                  SKU: {selectedProduct.sku} | Current On-Hand: {selectedProduct.stockQuantity} units
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-zinc-300 mb-1">Quantity Received *</label>
                  <input
                    type="number"
                    min={1}
                    value={receiveQty}
                    onChange={(e) => setReceiveQty(Number(e.target.value))}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono font-bold focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-zinc-300 mb-1">Unit Cost (KES)</label>
                  <input
                    type="number"
                    min={0}
                    value={unitCost}
                    onChange={(e) => setUnitCost(Number(e.target.value))}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Supplier / Distributor</label>
                <input
                  type="text"
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">PO / Delivery Note Reference #</label>
                <input
                  type="text"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Internal Notes</label>
                <input
                  type="text"
                  value={receiveNotes}
                  onChange={(e) => setReceiveNotes(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white focus:border-emerald-500"
                />
              </div>

              <div className="pt-4 border-t border-zinc-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setModalType(null)}
                  className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold"
                >
                  {isSubmitting ? 'Processing...' : 'Confirm Stock Receipt'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Write-off Damaged / Shrinkage Stock */}
      {modalType === 'writeoff' && selectedProduct && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center">
          <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl my-8">
            <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-red-400" />
                <h3 className="font-bold text-base text-white">Stock Loss & Damage Write-Off</h3>
              </div>
              <button onClick={() => setModalType(null)} className="text-zinc-400 hover:text-white p-1">
                &times;
              </button>
            </div>

            <form onSubmit={handleWriteOffSubmit} className="p-6 space-y-4 text-xs">
              {actionError && (
                <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-200">
                  {actionError}
                </div>
              )}
              {actionSuccess && (
                <div className="p-3 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-200">
                  {actionSuccess}
                </div>
              )}

              <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block text-[10px] uppercase">Selected Product</span>
                <span className="text-white font-bold text-sm">{selectedProduct.name}</span>
                <div className="text-zinc-400 font-mono mt-0.5">
                  SKU: {selectedProduct.sku} | Available: {selectedProduct.stockQuantity - selectedProduct.reservedQuantity} units
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-semibold text-zinc-300 mb-1">Quantity to Write Off *</label>
                  <input
                    type="number"
                    min={1}
                    max={selectedProduct.stockQuantity}
                    value={writeOffQty}
                    onChange={(e) => setWriteOffQty(Number(e.target.value))}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono font-bold focus:border-red-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-zinc-300 mb-1">Reason Code *</label>
                  <select
                    value={writeOffReason}
                    onChange={(e) => setWriteOffReason(e.target.value as any)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white focus:border-red-500 cursor-pointer"
                  >
                    <option value="warehouse_damage">Warehouse Damage</option>
                    <option value="damage_transit">Courier Transit Damage</option>
                    <option value="defective_return">Defective Customer Return</option>
                    <option value="shrinkage_loss">Unaccounted Shrinkage / Theft</option>
                    <option value="sample_marketing">Marketing / Display Sample</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Incident Details / Explanation</label>
                <textarea
                  value={writeOffNotes}
                  onChange={(e) => setWriteOffNotes(e.target.value)}
                  rows={2}
                  placeholder="Explain why this item is being removed from inventory..."
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white focus:border-red-500"
                />
              </div>

              <div className="pt-4 border-t border-zinc-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setModalType(null)}
                  className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold"
                >
                  {isSubmitting ? 'Writing off...' : 'Confirm Write-Off'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Physical Count Audit */}
      {modalType === 'audit' && selectedProduct && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center">
          <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl my-8">
            <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="w-5 h-5 text-indigo-400" />
                <h3 className="font-bold text-base text-white">Physical Stock Count Audit</h3>
              </div>
              <button onClick={() => setModalType(null)} className="text-zinc-400 hover:text-white p-1">
                &times;
              </button>
            </div>

            <form onSubmit={handleAuditSubmit} className="p-6 space-y-4 text-xs">
              {actionError && (
                <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-200">
                  {actionError}
                </div>
              )}
              {actionSuccess && (
                <div className="p-3 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-200">
                  {actionSuccess}
                </div>
              )}

              <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block text-[10px] uppercase">Auditing SKU</span>
                <span className="text-white font-bold text-sm">{selectedProduct.name}</span>
                <div className="text-zinc-400 font-mono mt-0.5">
                  SKU: {selectedProduct.sku} | System Current Stock: <strong>{selectedProduct.stockQuantity}</strong>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Physical Shelf Count *</label>
                <input
                  type="number"
                  min={0}
                  value={auditCountedQty}
                  onChange={(e) => setAuditCountedQty(Number(e.target.value))}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white font-mono font-bold text-sm focus:border-indigo-500"
                />
              </div>

              {/* Live Discrepancy indicator */}
              <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between font-mono">
                <span className="text-zinc-400">Calculated Variance:</span>
                <span className={`font-bold ${
                  auditCountedQty - selectedProduct.stockQuantity === 0
                    ? 'text-emerald-400'
                    : auditCountedQty - selectedProduct.stockQuantity > 0
                    ? 'text-indigo-400'
                    : 'text-red-400'
                }`}>
                  {auditCountedQty - selectedProduct.stockQuantity > 0 ? '+' : ''}
                  {auditCountedQty - selectedProduct.stockQuantity} units
                </span>
              </div>

              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Audit Notes / Location</label>
                <input
                  type="text"
                  value={auditNotes}
                  onChange={(e) => setAuditNotes(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-white focus:border-indigo-500"
                />
              </div>

              <div className="pt-4 border-t border-zinc-800 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setModalType(null)}
                  className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold"
                >
                  {isSubmitting ? 'Recording...' : 'Reconcile Count'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
