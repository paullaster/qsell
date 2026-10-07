'use client';

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
  DollarSign,
} from 'lucide-react';
import { type Product, type InventoryLedgerEntry, InventoryChangeType } from '@/types/index';
import {
  updateProductStockAction,
  receiveStockAction,
  writeOffStockAction,
  auditStockCountAction,
} from '@/server/actions';

interface AdminInventoryProps {
  productsPromise: Promise<Product[]>;
  ledgerPromise: Promise<InventoryLedgerEntry[]>;
  onRefresh: () => void;
}

export function AdminInventory({ productsPromise, ledgerPromise, onRefresh }: AdminInventoryProps) {
  const products = use(productsPromise);
  const ledger = use(ledgerPromise);

  const [activeTab, setActiveTab] = useState<
    'stock_levels' | 'receive_po' | 'write_off' | 'audit_count' | 'ledger' | 'reorder_plan'
  >('stock_levels');
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
  const [writeOffReason, setWriteOffReason] = useState<
    | 'damage_transit'
    | 'defective_return'
    | 'warehouse_damage'
    | 'shrinkage_loss'
    | 'sample_marketing'
  >('warehouse_damage');
  const [writeOffNotes, setWriteOffNotes] = useState('');

  // Form states for Physical Audit
  const [auditCountedQty, setAuditCountedQty] = useState<number>(0);
  const [auditNotes, setAuditNotes] = useState('Quarterly cycle count verification');

  // Filtered Products
  const filteredProducts = products.filter((p) => {
    const matchesSearch =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase()) ||
      p.stockCode.toLowerCase().includes(search.toLowerCase());
    const matchesCategory =
      categoryFilter === 'all' || p.category.toLowerCase() === categoryFilter.toLowerCase();
    return matchesSearch && matchesCategory;
  });

  const lowStockItems = products.filter(
    (p) => p.stockQuantity - p.reservedQuantity <= p.lowStockThreshold,
  );

  // Quick Delta Adjust
  const handleQuickAdjust = async (product: Product, delta: number) => {
    const newQty = Math.max(0, product.stockQuantity + delta);
    try {
      const res = await updateProductStockAction(
        product.id,
        newQty,
        `Quick adjustment by ${delta > 0 ? '+' : ''}${delta}`,
      );
      // A workflow may want this approved first: nothing has changed yet, so say so.
      if ('pendingApproval' in res) alert(res.message);
      onRefresh();
    } catch (err: any) {
      alert(`Adjustment error: ${err.message}`);
    }
  };

  // Open Modals
  const openReceiveModal = (product: Product) => {
    setSelectedProduct(product);
    setReceiveQty(10);
    setUnitCost(
      product.costPrice ?? (product.price != null ? Math.round(product.price * 0.75) : 0),
    );
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
        notes: receiveNotes.trim(),
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
      const res = await writeOffStockAction({
        productId: selectedProduct.id,
        quantity: Number(writeOffQty),
        reasonCode: writeOffReason,
        notes: writeOffNotes.trim(),
      });
      setActionSuccess(
        'pendingApproval' in res
          ? res.message
          : `Successfully written off ${writeOffQty} units for ${selectedProduct.sku}`,
      );
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
        notes: auditNotes.trim(),
      });
      setActionSuccess(
        'pendingApproval' in res
          ? res.message
          : `Audit reconciled. Discrepancy: ${res.discrepancy >= 0 ? '+' : ''}${res.discrepancy} units.`,
      );
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
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong">
            <Layers className="h-5 w-5 text-indigo-400" />
            Stock Control & Warehouse Management
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Receive supplier goods (PO), record damaged stock write-offs, conduct physical stock
            audits, and view stock movement history.
          </p>
        </div>

        {/* Tab Navigation */}
        <div
          aria-label="Inventory views"
          className="flex items-center gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1"
          role="group"
        >
          <button
            type="button"
            aria-pressed={activeTab === 'stock_levels'}
            onClick={() => setActiveTab('stock_levels')}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
              activeTab === 'stock_levels'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-fg-muted hover:bg-hover hover:text-fg-strong'
            }`}
          >
            Current Stock Levels
          </button>
          <button
            type="button"
            aria-pressed={activeTab === 'reorder_plan'}
            onClick={() => setActiveTab('reorder_plan')}
            className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
              activeTab === 'reorder_plan'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-fg-muted hover:bg-hover hover:text-fg-strong'
            }`}
          >
            Low Stock Alerts
            {lowStockItems.length > 0 && (
              <span className="py-0.2 rounded-full bg-red-500 px-1.5 font-mono text-[10px] font-bold text-white">
                {lowStockItems.length}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-pressed={activeTab === 'ledger'}
            onClick={() => setActiveTab('ledger')}
            className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
              activeTab === 'ledger'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-fg-muted hover:bg-hover hover:text-fg-strong'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            Stock Movement History ({ledger.length})
          </button>
        </div>
      </div>

      {/* TAB 1: Stock Levels & Quick Operations */}
      {activeTab === 'stock_levels' && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4 text-xs sm:flex-row">
            <div className="relative w-full sm:w-80">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <input
                type="text"
                placeholder="Search by SKU or item title..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-line bg-surface py-1.5 pr-4 pl-9 text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="flex w-full items-center justify-between gap-4 sm:w-auto sm:justify-end">
              <span className="text-fg-muted">
                Low Stock Critical:{' '}
                <strong className="text-amber-600">{lowStockItems.length} items</strong>
              </span>
              <button
                onClick={onRefresh}
                className="flex cursor-pointer items-center gap-1 rounded-lg bg-surface-sunken px-3 py-1.5 text-fg transition-colors hover:bg-hover hover:text-fg-strong"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </button>
            </div>
          </div>

          {/* Warehouse Table */}
          <div className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
                  <tr>
                    <th className="px-4 py-3">SKU & Item</th>
                    <th className="px-4 py-3 text-center">On-Hand Total</th>
                    <th className="px-4 py-3 text-center">Reserved</th>
                    <th className="px-4 py-3 text-center">Available</th>
                    <th className="px-4 py-3 text-center">Quick Adjust</th>
                    <th className="px-4 py-3 text-right">Warehouse Operations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line text-fg">
                  {filteredProducts.map((p) => {
                    const available = p.stockQuantity - p.reservedQuantity;
                    const isLow = available <= p.lowStockThreshold && available > 0;
                    const isOut = available <= 0;

                    return (
                      <tr key={p.id} className="transition-colors hover:bg-hover">
                        <td className="px-4 py-3.5">
                          <div className="font-semibold text-fg-strong">{p.name}</div>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-fg-muted">
                            <span className="font-bold text-indigo-400">SKU: {p.sku}</span>
                            <span>• Stock: {p.stockCode}</span>
                            <span>• {p.category}</span>
                            <span>• Threshold: {p.lowStockThreshold}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-center font-mono font-bold text-fg-strong">
                          {p.stockQuantity}
                        </td>
                        <td className="px-4 py-3.5 text-center font-mono text-fg-muted">
                          {p.reservedQuantity}
                        </td>
                        <td className="px-4 py-3.5 text-center">
                          <span
                            className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ${
                              isOut
                                ? 'border border-red-800 bg-red-50 text-red-600'
                                : isLow
                                  ? 'border border-amber-800 bg-amber-50 text-amber-700'
                                  : 'border border-emerald-800 bg-emerald-50/80 text-emerald-700'
                            }`}
                          >
                            {available} {isOut ? '(Out of Stock)' : isLow ? '(Low Stock)' : 'Units'}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-center">
                          <div className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
                            <button
                              onClick={() => handleQuickAdjust(p, -5)}
                              className="cursor-pointer rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-fg hover:bg-hover"
                              title="Decrease 5"
                            >
                              -5
                            </button>
                            <button
                              onClick={() => handleQuickAdjust(p, -1)}
                              className="cursor-pointer rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-fg hover:bg-hover"
                              title="Decrease 1"
                            >
                              -1
                            </button>
                            <button
                              onClick={() => handleQuickAdjust(p, 1)}
                              className="cursor-pointer rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-fg hover:bg-hover"
                              title="Increase 1"
                            >
                              +1
                            </button>
                            <button
                              onClick={() => handleQuickAdjust(p, 5)}
                              className="cursor-pointer rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-fg hover:bg-hover"
                              title="Increase 5"
                            >
                              +5
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => openReceiveModal(p)}
                              className="flex cursor-pointer items-center gap-1 rounded-lg border border-emerald-800/80 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
                              title="Receive Goods from Purchase Order"
                            >
                              <Truck className="h-3 w-3" />
                              Receive PO
                            </button>
                            <button
                              onClick={() => openWriteOffModal(p)}
                              className="flex cursor-pointer items-center gap-1 rounded-lg border border-red-800/80 bg-red-50 px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100"
                              title="Record Damaged or Lost Stock"
                            >
                              <ShieldAlert className="h-3 w-3" />
                              Write-Off
                            </button>
                            <button
                              onClick={() => openAuditModal(p)}
                              className="flex cursor-pointer items-center gap-1 rounded-lg border border-line-strong bg-surface-sunken px-2.5 py-1 text-[11px] font-medium text-fg-strong transition-colors hover:bg-hover"
                              title="Physical Count Audit"
                            >
                              <ClipboardCheck className="h-3 w-3" />
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
          <div className="flex flex-col justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4 text-xs sm:flex-row sm:items-center">
            <div>
              <h3 className="text-sm font-bold text-fg-strong">
                Automated Inventory Replenishment Plan
              </h3>
              <p className="text-fg-muted">
                Products currently at or below their safety stock threshold requiring immediate
                purchase orders.
              </p>
            </div>
            <div className="rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-fg">
              Total Recommended Restock:{' '}
              <strong>
                {lowStockItems.reduce(
                  (acc, p) =>
                    acc + (p.lowStockThreshold * 3 - (p.stockQuantity - p.reservedQuantity)),
                  0,
                )}{' '}
                units
              </strong>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
                  <tr>
                    <th className="px-4 py-3">SKU & Item</th>
                    <th className="px-4 py-3 text-center">Available Stock</th>
                    <th className="px-4 py-3 text-center">Safety Threshold</th>
                    <th className="px-4 py-3 text-center">Suggested PO Qty</th>
                    <th className="px-4 py-3 text-right">Est. Cost (KES)</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line text-fg">
                  {lowStockItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center font-medium text-emerald-600">
                        All products are currently well above safety stock thresholds!
                      </td>
                    </tr>
                  ) : (
                    lowStockItems.map((p) => {
                      const available = p.stockQuantity - p.reservedQuantity;
                      const suggestedQty = Math.max(10, p.lowStockThreshold * 3 - available);
                      const unitCostEst =
                        p.costPrice ?? (p.price != null ? Math.round(p.price * 0.75) : 0);
                      const totalCostEst = suggestedQty * unitCostEst;

                      return (
                        <tr key={p.id} className="hover:bg-hover">
                          <td className="px-4 py-3.5">
                            <div className="font-semibold text-fg-strong">{p.name}</div>
                            <div className="font-mono text-[11px] text-fg-muted">{p.sku}</div>
                          </td>
                          <td className="px-4 py-3.5 text-center font-mono font-bold text-red-600">
                            {available} units
                          </td>
                          <td className="px-4 py-3.5 text-center font-mono text-fg-muted">
                            {p.lowStockThreshold} units
                          </td>
                          <td className="px-4 py-3.5 text-center font-mono font-bold text-indigo-400">
                            +{suggestedQty} units
                          </td>
                          <td className="px-4 py-3.5 text-right font-mono text-fg-strong">
                            KES {totalCostEst.toLocaleString()}
                          </td>
                          <td className="px-4 py-3.5 text-right">
                            <button
                              onClick={() => openReceiveModal(p)}
                              className="cursor-pointer rounded-lg bg-indigo-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500"
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
        <div className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
                <tr>
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">SKU / Item</th>
                  <th className="px-4 py-3">Change Type</th>
                  <th className="px-4 py-3 text-center">Delta</th>
                  <th className="px-4 py-3 text-center">Prior &rarr; New</th>
                  <th className="px-4 py-3">Actor</th>
                  <th className="px-4 py-3">Reason / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-fg">
                {ledger.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-fg-subtle">
                      No ledger entries recorded yet.
                    </td>
                  </tr>
                ) : (
                  ledger.map((entry) => {
                    const isPositive = entry.changeAmount > 0;
                    return (
                      <tr key={entry.id} className="font-mono hover:bg-hover">
                        <td className="px-4 py-3 text-[11px] text-fg-muted">
                          {new Date(entry.timestamp).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 font-semibold text-fg-strong">
                          {entry.productName}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded px-2 py-0.5 font-sans text-[10px] font-bold tracking-wider uppercase ${
                              entry.changeType === 'purchase_order_receipt'
                                ? 'border border-emerald-800 bg-emerald-50 text-emerald-700'
                                : entry.changeType === 'damage_writeoff'
                                  ? 'border border-red-800 bg-red-50 text-red-700'
                                  : entry.changeType === 'order_fulfillment'
                                    ? 'border border-blue-800 bg-blue-50 text-blue-700'
                                    : 'bg-surface-sunken text-fg'
                            }`}
                          >
                            {entry.changeType.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td
                          className={`px-4 py-3 text-center font-bold ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}
                        >
                          {isPositive ? `+${entry.changeAmount}` : entry.changeAmount}
                        </td>
                        <td className="px-4 py-3 text-center text-fg-muted">
                          {entry.previousStock} &rarr;{' '}
                          <strong className="text-fg-strong">{entry.newStock}</strong>
                        </td>
                        <td className="px-4 py-3 text-fg">{entry.actor}</td>
                        <td
                          className="max-w-xs truncate px-4 py-3 font-sans text-fg-muted"
                          title={entry.note}
                        >
                          {entry.note}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-sm">
          <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
            <div className="flex items-center justify-between border-b border-line bg-surface p-5">
              <div className="flex items-center gap-2">
                <Truck className="h-5 w-5 text-emerald-600" />
                <h3 className="text-base font-bold text-fg-strong">
                  Receive Goods (Purchase Order Inward)
                </h3>
              </div>
              <button
                onClick={() => setModalType(null)}
                className="p-1 text-fg-muted hover:text-fg-strong"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleReceiveSubmit} className="space-y-4 p-6 text-xs">
              {actionError && (
                <div className="rounded-lg border border-red-800 bg-red-50 p-3 text-red-800">
                  {actionError}
                </div>
              )}
              {actionSuccess && (
                <div className="rounded-lg border border-emerald-800 bg-emerald-50 p-3 text-emerald-800">
                  {actionSuccess}
                </div>
              )}

              <div className="rounded-lg border border-line bg-surface p-3">
                <span className="block text-[10px] text-fg-subtle uppercase">
                  Product Receiving Into
                </span>
                <span className="text-sm font-bold text-fg-strong">{selectedProduct.name}</span>
                <div className="mt-0.5 font-mono text-fg-muted">
                  SKU: {selectedProduct.sku} | Current On-Hand: {selectedProduct.stockQuantity}{' '}
                  units
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block font-semibold text-fg">Quantity Received *</label>
                  <input
                    type="number"
                    min={1}
                    value={receiveQty}
                    onChange={(e) => setReceiveQty(Number(e.target.value))}
                    required
                    className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono font-bold text-fg-strong focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-semibold text-fg">Unit Cost (KES)</label>
                  <input
                    type="number"
                    min={0}
                    value={unitCost}
                    onChange={(e) => setUnitCost(Number(e.target.value))}
                    className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-fg-strong focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block font-semibold text-fg">Supplier / Distributor</label>
                <input
                  type="text"
                  value={supplierName}
                  onChange={(e) => setSupplierName(e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-fg-strong focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="mb-1 block font-semibold text-fg">
                  PO / Delivery Note Reference #
                </label>
                <input
                  type="text"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-fg-strong focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="mb-1 block font-semibold text-fg">Internal Notes</label>
                <input
                  type="text"
                  value={receiveNotes}
                  onChange={(e) => setReceiveNotes(e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-fg-strong focus:border-emerald-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => setModalType(null)}
                  className="rounded-lg bg-surface-sunken px-4 py-2 text-fg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-emerald-600 px-5 py-2 font-bold text-white hover:bg-emerald-500"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-sm">
          <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
            <div className="flex items-center justify-between border-b border-line bg-surface p-5">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-red-600" />
                <h3 className="text-base font-bold text-fg-strong">
                  Stock Loss & Damage Write-Off
                </h3>
              </div>
              <button
                onClick={() => setModalType(null)}
                className="p-1 text-fg-muted hover:text-fg-strong"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleWriteOffSubmit} className="space-y-4 p-6 text-xs">
              {actionError && (
                <div className="rounded-lg border border-red-800 bg-red-50 p-3 text-red-800">
                  {actionError}
                </div>
              )}
              {actionSuccess && (
                <div className="rounded-lg border border-emerald-800 bg-emerald-50 p-3 text-emerald-800">
                  {actionSuccess}
                </div>
              )}

              <div className="rounded-lg border border-line bg-surface p-3">
                <span className="block text-[10px] text-fg-subtle uppercase">Selected Product</span>
                <span className="text-sm font-bold text-fg-strong">{selectedProduct.name}</span>
                <div className="mt-0.5 font-mono text-fg-muted">
                  SKU: {selectedProduct.sku} | Available:{' '}
                  {selectedProduct.stockQuantity - selectedProduct.reservedQuantity} units
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block font-semibold text-fg">
                    Quantity to Write Off *
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={selectedProduct.stockQuantity}
                    value={writeOffQty}
                    onChange={(e) => setWriteOffQty(Number(e.target.value))}
                    required
                    className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono font-bold text-fg-strong focus:border-red-500"
                  />
                </div>

                <div>
                  <label className="mb-1 block font-semibold text-fg">Reason Code *</label>
                  <select
                    value={writeOffReason}
                    onChange={(e) => setWriteOffReason(e.target.value as any)}
                    className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3.5 py-2 text-fg-strong focus:border-red-500"
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
                <label className="mb-1 block font-semibold text-fg">
                  Incident Details / Explanation
                </label>
                <textarea
                  value={writeOffNotes}
                  onChange={(e) => setWriteOffNotes(e.target.value)}
                  rows={2}
                  placeholder="Explain why this item is being removed from inventory..."
                  className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-fg-strong focus:border-red-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => setModalType(null)}
                  className="rounded-lg bg-surface-sunken px-4 py-2 text-fg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-red-600 px-5 py-2 font-bold text-white hover:bg-red-500"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-sm">
          <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
            <div className="flex items-center justify-between border-b border-line bg-surface p-5">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5 text-indigo-400" />
                <h3 className="text-base font-bold text-fg-strong">Physical Stock Count Audit</h3>
              </div>
              <button
                onClick={() => setModalType(null)}
                className="p-1 text-fg-muted hover:text-fg-strong"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleAuditSubmit} className="space-y-4 p-6 text-xs">
              {actionError && (
                <div className="rounded-lg border border-red-800 bg-red-50 p-3 text-red-800">
                  {actionError}
                </div>
              )}
              {actionSuccess && (
                <div className="rounded-lg border border-emerald-800 bg-emerald-50 p-3 text-emerald-800">
                  {actionSuccess}
                </div>
              )}

              <div className="rounded-lg border border-line bg-surface p-3">
                <span className="block text-[10px] text-fg-subtle uppercase">Auditing SKU</span>
                <span className="text-sm font-bold text-fg-strong">{selectedProduct.name}</span>
                <div className="mt-0.5 font-mono text-fg-muted">
                  SKU: {selectedProduct.sku} | System Current Stock:{' '}
                  <strong>{selectedProduct.stockQuantity}</strong>
                </div>
              </div>

              <div>
                <label className="mb-1 block font-semibold text-fg">Physical Shelf Count *</label>
                <input
                  type="number"
                  min={0}
                  value={auditCountedQty}
                  onChange={(e) => setAuditCountedQty(Number(e.target.value))}
                  required
                  className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-sm font-bold text-fg-strong focus:border-indigo-500"
                />
              </div>

              {/* Live Discrepancy indicator */}
              <div className="flex items-center justify-between rounded-lg border border-line bg-surface p-3 font-mono">
                <span className="text-fg-muted">Calculated Variance:</span>
                <span
                  className={`font-bold ${
                    auditCountedQty - selectedProduct.stockQuantity === 0
                      ? 'text-emerald-600'
                      : auditCountedQty - selectedProduct.stockQuantity > 0
                        ? 'text-indigo-400'
                        : 'text-red-600'
                  }`}
                >
                  {auditCountedQty - selectedProduct.stockQuantity > 0 ? '+' : ''}
                  {auditCountedQty - selectedProduct.stockQuantity} units
                </span>
              </div>

              <div>
                <label className="mb-1 block font-semibold text-fg">Audit Notes / Location</label>
                <input
                  type="text"
                  value={auditNotes}
                  onChange={(e) => setAuditNotes(e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-fg-strong focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
                <button
                  type="button"
                  onClick={() => setModalType(null)}
                  className="rounded-lg bg-surface-sunken px-4 py-2 text-fg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-indigo-600 px-5 py-2 font-bold text-white hover:bg-indigo-500"
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
