'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  User,
  MapPin,
  ShoppingBag,
  CreditCard,
  ShieldCheck,
  Plus,
  Trash2,
  Check,
  Edit3,
  Phone,
  Mail,
  Calendar,
  ExternalLink,
  Truck,
  FileText,
  ArrowRight,
  LogOut,
  RefreshCw,
  Clock,
  Sparkles,
  ChevronRight,
  Building,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import {
  type CustomerAccount,
  type CustomerAddress,
  type Order,
  type PaymentProvider,
} from '@/types/index';
import { AppImage } from '@/components/ui/AppImage';
import { shownPaymentReference } from '@/lib/paymentReference';
import {
  fetchCustomerAccountAction,
  fetchAllCustomersAction,
  updateCustomerProfileAction,
  addCustomerAddressAction,
  updateCustomerAddressAction,
  deleteCustomerAddressAction,
  setDefaultAddressAction,
  customerLoginAction,
  logoutAction,
} from '@/server/actions';

interface CustomerAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToAdmin?: () => void;
  onSelectOrderForTracking?: (orderNumber: string) => void;
  onRefreshGlobalData?: () => void;
}

type TabType = 'overview' | 'addresses' | 'orders' | 'payment';

export function CustomerAccountModal({
  isOpen,
  onClose,
  onNavigateToAdmin,
  onSelectOrderForTracking,
  onRefreshGlobalData,
}: CustomerAccountModalProps) {
  if (!isOpen) return null;

  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [allCustomers, setAllCustomers] = useState<CustomerAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    type: 'success' | 'error';
  } | null>(null);

  // Profile Edit State
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editPaymentMethod, setEditPaymentMethod] = useState<PaymentProvider>('mpesa_daraja');

  // Address Add/Edit Modal State
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [addrLabel, setAddrLabel] = useState('Home');
  const [addrRecipientName, setAddrRecipientName] = useState('');
  const [addrRecipientPhone, setAddrRecipientPhone] = useState('');
  const [addrStreet, setAddrStreet] = useState('');
  const [addrCity, setAddrCity] = useState('Nairobi');
  const [addrCounty, setAddrCounty] = useState('Nairobi County');
  const [addrPostalCode, setAddrPostalCode] = useState('00100');
  const [addrCountry, setAddrCountry] = useState('Kenya');
  const [addrIsDefault, setAddrIsDefault] = useState(false);

  // Receipt Modal State
  const [selectedReceiptOrder, setSelectedReceiptOrder] = useState<Order | null>(null);

  // Quick Switcher Dropdown
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const [customLoginInput, setCustomLoginInput] = useState('');

  // Initial Load
  const loadCustomerData = async (targetId?: string) => {
    try {
      setIsLoading(true);
      setStatusMessage(null);
      const [accountData, customersList] = await Promise.all([
        fetchCustomerAccountAction(targetId),
        fetchAllCustomersAction().catch(() => []),
      ]);

      setCustomer(accountData.customer);
      setOrders(accountData.orders);
      setAllCustomers(customersList);

      // Initialize edit fields
      if (accountData.customer) {
        setEditName(accountData.customer.name);
        setEditEmail(accountData.customer.email);
        setEditPhone(accountData.customer.phone);
        setEditPaymentMethod(
          accountData.customer.paymentPreferences?.preferredMethod || 'mpesa_daraja',
        );
      }
    } catch (err: any) {
      setStatusMessage({ text: err.message || 'Failed to load customer profile', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCustomerData();
  }, []);

  const showNotification = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMessage({ text, type });
    setTimeout(() => {
      setStatusMessage(null);
    }, 4000);
  };

  // Switch customer profile
  const handleSwitchCustomer = async (targetCustomer: CustomerAccount) => {
    try {
      setIsLoading(true);
      const { customer: updatedCustomer, session } = await customerLoginAction(
        targetCustomer.id,
        targetCustomer.name,
        targetCustomer.phone,
      );
      await loadCustomerData(updatedCustomer.id);
      setIsSwitchingAccount(false);
      showNotification(`Switched active account to ${updatedCustomer.name}`);
      onRefreshGlobalData?.();
    } catch (err: any) {
      showNotification(err.message || 'Failed to switch profile', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Custom login / registration
  const handleCustomLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customLoginInput.trim()) return;

    try {
      setIsLoading(true);
      const { customer: newCustomer } = await customerLoginAction(customLoginInput.trim());
      await loadCustomerData(newCustomer.id);
      setCustomLoginInput('');
      setIsSwitchingAccount(false);
      showNotification(`Logged in as ${newCustomer.name}`);
      onRefreshGlobalData?.();
    } catch (err: any) {
      showNotification(err.message || 'Login failed', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Save Profile
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customer) return;

    try {
      setIsSaving(true);
      const updated = await updateCustomerProfileAction(customer.id, {
        name: editName,
        email: editEmail,
        phone: editPhone,
        paymentPreferences: {
          preferredMethod: editPaymentMethod,
          defaultMpesaPhone: editPhone,
        },
      });
      setCustomer(updated);
      setIsEditingProfile(false);
      showNotification('Profile and preferences updated successfully.');
      onRefreshGlobalData?.();
    } catch (err: any) {
      showNotification(err.message || 'Failed to update profile', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Open Address Form for New Address
  const handleOpenAddAddress = () => {
    setEditingAddressId(null);
    setAddrLabel('Home');
    setAddrRecipientName(customer?.name || '');
    setAddrRecipientPhone(customer?.phone || '');
    setAddrStreet('');
    setAddrCity('Nairobi');
    setAddrCounty('Nairobi County');
    setAddrPostalCode('00100');
    setAddrCountry('Kenya');
    setAddrIsDefault(customer ? customer.addresses.length === 0 : true);
    setIsAddressModalOpen(true);
  };

  // Open Address Form for Edit
  const handleOpenEditAddress = (addr: CustomerAddress) => {
    setEditingAddressId(addr.id);
    setAddrLabel(addr.label);
    setAddrRecipientName(addr.recipientName);
    setAddrRecipientPhone(addr.recipientPhone);
    setAddrStreet(addr.street);
    setAddrCity(addr.city);
    setAddrCounty(addr.countyOrState);
    setAddrPostalCode(addr.postalCode || '00100');
    setAddrCountry(addr.country);
    setAddrIsDefault(addr.isDefault);
    setIsAddressModalOpen(true);
  };

  // Save Address (Create or Update)
  const handleSaveAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customer) return;

    if (!addrRecipientName || !addrRecipientPhone || !addrStreet || !addrCity) {
      showNotification('Please fill in all address details.', 'error');
      return;
    }

    try {
      setIsSaving(true);
      if (editingAddressId) {
        const { customer: updatedCustomer } = await updateCustomerAddressAction(
          customer.id,
          editingAddressId,
          {
            label: addrLabel,
            recipientName: addrRecipientName,
            recipientPhone: addrRecipientPhone,
            street: addrStreet,
            city: addrCity,
            countyOrState: addrCounty,
            postalCode: addrPostalCode,
            country: addrCountry,
            isDefault: addrIsDefault,
          },
        );
        setCustomer(updatedCustomer);
        showNotification('Address updated.');
      } else {
        const { customer: updatedCustomer } = await addCustomerAddressAction(customer.id, {
          label: addrLabel,
          recipientName: addrRecipientName,
          recipientPhone: addrRecipientPhone,
          street: addrStreet,
          city: addrCity,
          countyOrState: addrCounty,
          postalCode: addrPostalCode,
          country: addrCountry,
          isDefault: addrIsDefault,
        });
        setCustomer(updatedCustomer);
        showNotification('New address added to your address book.');
      }
      setIsAddressModalOpen(false);
      onRefreshGlobalData?.();
    } catch (err: any) {
      showNotification(err.message || 'Failed to save address', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Delete Address
  const handleDeleteAddress = async (addressId: string) => {
    if (!customer) return;
    try {
      const { customer: updatedCustomer } = await deleteCustomerAddressAction(
        customer.id,
        addressId,
      );
      setCustomer(updatedCustomer);
      showNotification('Address removed.');
      onRefreshGlobalData?.();
    } catch (err: any) {
      showNotification(err.message || 'Failed to remove address', 'error');
    }
  };

  // Set Default Address
  const handleSetDefaultAddress = async (addressId: string) => {
    if (!customer) return;
    try {
      const updated = await setDefaultAddressAction(customer.id, addressId);
      setCustomer(updated);
      showNotification('Default delivery address updated.');
      onRefreshGlobalData?.();
    } catch (err: any) {
      showNotification(err.message || 'Failed to set default address', 'error');
    }
  };

  // Kenyan Counties list for convenient dropdown
  const kenyanCounties = [
    'Nairobi County',
    'Mombasa County',
    'Nakuru County',
    'Kisumu County',
    'Uasin Gishu County (Eldoret)',
    'Kiambu County',
    'Machakos County',
    'Kajiado County',
    'Kilifi County',
    'Nyeri County',
    'Meru County',
    'Kakamega County',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/80 p-3 backdrop-blur-md sm:p-6">
      <div className="relative my-4 flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
        {/* Top Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-surface p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 text-lg font-bold text-fg-strong shadow-lg">
                {customer?.name?.charAt(0) || 'C'}
              </div>
              <div className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-line bg-emerald-500">
                <Check className="h-2.5 w-2.5 stroke-[3] text-fg-strong" />
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-fg-strong">
                  {customer?.name || 'Customer Account'}
                </h2>
                <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-indigo-400 uppercase">
                  {customer?.status === 'verified' ? 'Verified Buyer' : 'Active Account'}
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-2 text-xs text-fg-muted">
                <span>{customer?.email || 'customer@omnicommerce.ke'}</span>
                <span>•</span>
                <span>{customer?.phone || '+254 700 000000'}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Account Switcher Button */}
            <button
              onClick={() => setIsSwitchingAccount(!isSwitchingAccount)}
              className="flex cursor-pointer items-center gap-1.5 rounded-xl border border-line-strong bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg-strong transition-colors hover:bg-hover"
            >
              <User className="h-3.5 w-3.5 text-indigo-400" />
              <span>Switch Account</span>
            </button>

            {/* Admin Switcher Shortcut */}
            {onNavigateToAdmin && (
              <button
                onClick={() => {
                  onClose();
                  onNavigateToAdmin();
                }}
                className="hidden cursor-pointer items-center gap-1.5 rounded-xl border border-indigo-800/40 bg-indigo-50/60 px-3 py-1.5 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-100 sm:flex"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Admin Console</span>
              </button>
            )}

            {/* Refresh */}
            <button
              onClick={() => loadCustomerData(customer?.id)}
              disabled={isLoading}
              title="Refresh Account Data"
              className="cursor-pointer rounded-xl border border-line bg-surface-raised p-2 text-fg-muted transition-colors hover:text-fg-strong disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>

            {/* Close */}
            <button
              onClick={onClose}
              className="cursor-pointer rounded-xl border border-line bg-surface-raised p-2 text-fg-muted transition-colors hover:text-fg-strong"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Account Switcher Dropdown Drawer */}
        {isSwitchingAccount && (
          <div className="animate-in fade-in border-b border-line bg-surface p-4 duration-200 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-fg-muted uppercase">
                <User className="h-3.5 w-3.5 text-indigo-400" />
                Select Customer Account / Login
              </h3>
              <button
                onClick={() => setIsSwitchingAccount(false)}
                className="text-xs text-fg-subtle hover:text-fg"
              >
                Cancel
              </button>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
              {allCustomers.map((cust) => (
                <button
                  key={cust.id}
                  onClick={() => handleSwitchCustomer(cust)}
                  className={`flex cursor-pointer flex-col justify-between rounded-xl border p-3 text-left transition-all ${
                    cust.id === customer?.id
                      ? 'TW border-indigo-500 bg-indigo-600/10'
                      : 'border-line bg-surface-raised text-fg hover:bg-hover'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="truncate text-xs font-semibold">{cust.name}</span>
                    {cust.id === customer?.id && (
                      <span className="h-2 w-2 rounded-full bg-indigo-500" />
                    )}
                  </div>
                  <span className="mt-1 truncate text-[11px] text-fg-subtle">{cust.email}</span>
                  <div className="mt-2 flex items-center justify-between border-t border-line/60 pt-2 text-[10px] text-fg-muted">
                    <span>{cust.addresses?.length || 0} addresses</span>
                    <span className="font-medium text-indigo-400">
                      KES {cust.totalSpend?.toLocaleString()}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {/* Custom Phone or Email sign-in */}
            <form onSubmit={handleCustomLogin} className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  placeholder="Enter email or Kenyan phone (e.g. 0722000000 or customer@biz.co.ke)..."
                  value={customLoginInput}
                  onChange={(e) => setCustomLoginInput(e.target.value)}
                  className="w-full rounded-xl border border-line bg-surface-raised px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={!customLoginInput.trim()}
                className="cursor-pointer rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold whitespace-nowrap text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
              >
                Sign In / Register
              </button>
            </form>
          </div>
        )}

        {/* Global Notification Banner */}
        {statusMessage && (
          <div
            className={`flex items-center gap-2 px-5 py-2.5 text-xs font-medium ${
              statusMessage.type === 'success'
                ? 'border-b border-emerald-800/40 bg-emerald-50/80 text-emerald-700'
                : 'border-b border-rose-800/40 bg-rose-50/80 text-rose-700'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600" />
            ) : (
              <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-600" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 gap-px border-b border-line bg-surface-sunken sm:grid-cols-4">
          <div className="bg-surface-sunken/90 p-4">
            <span className="block text-[11px] tracking-wider text-fg-subtle uppercase">
              Total Orders
            </span>
            <span className="mt-0.5 block text-lg font-bold text-fg-strong">
              {customer?.totalOrders || orders.length || 0}
            </span>
          </div>
          <div className="bg-surface-sunken/90 p-4">
            <span className="block text-[11px] tracking-wider text-fg-subtle uppercase">
              Lifetime Spend
            </span>
            <span className="mt-0.5 block text-lg font-bold text-emerald-600">
              KES {customer?.totalSpend?.toLocaleString() || '0'}
            </span>
          </div>
          <div className="bg-surface-sunken/90 p-4">
            <span className="block text-[11px] tracking-wider text-fg-subtle uppercase">
              Saved Addresses
            </span>
            <span className="mt-0.5 block text-lg font-bold text-indigo-400">
              {customer?.addresses?.length || 0}
            </span>
          </div>
          <div className="bg-surface-sunken/90 p-4">
            <span className="block text-[11px] tracking-wider text-fg-subtle uppercase">
              Preferred Payment
            </span>
            <span className="mt-1.5 block truncate text-sm font-semibold text-fg-strong">
              {customer?.paymentPreferences?.preferredMethod === 'mpesa_daraja'
                ? 'M-Pesa STK'
                : 'Pesapal v3'}
            </span>
          </div>
        </div>

        {/* Nav Tabs */}
        <div className="flex scrollbar-none overflow-x-auto border-b border-line bg-surface/50 px-4 sm:px-6">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex cursor-pointer items-center gap-2 border-b-2 px-4 py-3.5 text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'overview'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-fg-muted hover:text-fg-strong'
            }`}
          >
            <User className="h-4 w-4" />
            <span>Profile & Account</span>
          </button>

          <button
            onClick={() => setActiveTab('addresses')}
            className={`flex cursor-pointer items-center gap-2 border-b-2 px-4 py-3.5 text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'addresses'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-fg-muted hover:text-fg-strong'
            }`}
          >
            <MapPin className="h-4 w-4" />
            <span>Address Book ({customer?.addresses?.length || 0})</span>
          </button>

          <button
            onClick={() => setActiveTab('orders')}
            className={`flex cursor-pointer items-center gap-2 border-b-2 px-4 py-3.5 text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'orders'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-fg-muted hover:text-fg-strong'
            }`}
          >
            <ShoppingBag className="h-4 w-4" />
            <span>Order History ({orders.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('payment')}
            className={`flex cursor-pointer items-center gap-2 border-b-2 px-4 py-3.5 text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'payment'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-fg-muted hover:text-fg-strong'
            }`}
          >
            <CreditCard className="h-4 w-4" />
            <span>Payment Rails & Security</span>
          </button>
        </div>

        {/* Tab Contents */}
        <div className="max-h-[60vh] flex-1 overflow-y-auto p-4 sm:p-6">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-fg-subtle">
              <RefreshCw className="mb-3 h-8 w-8 animate-spin text-indigo-500" />
              <p className="text-sm">Loading customer details...</p>
            </div>
          ) : (
            <>
              {/* TAB 1: OVERVIEW & PROFILE */}
              {activeTab === 'overview' && (
                <div className="space-y-6">
                  <div className="rounded-xl border border-line bg-surface p-5">
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-fg-strong">Personal Information</h3>
                        <p className="text-xs text-fg-muted">
                          Manage your contact details and default communication channels.
                        </p>
                      </div>
                      {!isEditingProfile ? (
                        <button
                          onClick={() => setIsEditingProfile(true)}
                          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg-strong transition-colors hover:bg-hover"
                        >
                          <Edit3 className="h-3.5 w-3.5 text-indigo-400" />
                          <span>Edit Profile</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => setIsEditingProfile(false)}
                          className="cursor-pointer rounded-lg border border-line-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-hover"
                        >
                          Cancel
                        </button>
                      )}
                    </div>

                    {isEditingProfile ? (
                      <form onSubmit={handleSaveProfile} className="space-y-4 pt-2">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div>
                            <label className="mb-1 block text-xs font-medium text-fg-muted">
                              Full Legal Name
                            </label>
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              required
                              className="w-full rounded-xl border border-line-strong bg-surface-raised px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                            />
                          </div>

                          <div>
                            <label className="mb-1 block text-xs font-medium text-fg-muted">
                              Email Address
                            </label>
                            <input
                              type="email"
                              value={editEmail}
                              onChange={(e) => setEditEmail(e.target.value)}
                              required
                              className="w-full rounded-xl border border-line-strong bg-surface-raised px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                            />
                          </div>

                          <div>
                            <label className="mb-1 block text-xs font-medium text-fg-muted">
                              Phone Number (M-Pesa registered)
                            </label>
                            <input
                              type="text"
                              value={editPhone}
                              onChange={(e) => setEditPhone(e.target.value)}
                              required
                              className="w-full rounded-xl border border-line-strong bg-surface-raised px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                            />
                          </div>

                          <div>
                            <label className="mb-1 block text-xs font-medium text-fg-muted">
                              Default Payment Method
                            </label>
                            <select
                              value={editPaymentMethod}
                              onChange={(e) =>
                                setEditPaymentMethod(e.target.value as PaymentProvider)
                              }
                              className="w-full rounded-xl border border-line-strong bg-surface-raised px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                            >
                              <option value="mpesa_daraja">Safaricom M-Pesa STK Push (LNMO)</option>
                              <option value="pesapal_v3">
                                Pesapal v3 (Cards, Bank, Mobile Money)
                              </option>
                            </select>
                          </div>
                        </div>

                        <div className="flex justify-end gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => setIsEditingProfile(false)}
                            className="cursor-pointer rounded-xl border border-line-strong bg-surface-raised px-4 py-2 text-xs font-medium text-fg hover:bg-hover"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            disabled={isSaving}
                            className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-500 disabled:opacity-50"
                          >
                            {isSaving ? (
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            <span>Save Changes</span>
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {customer?.customerNumber ? (
                          <div className="rounded-xl border border-line/80 bg-surface-sunken/60 p-3.5 sm:col-span-2">
                            <span className="mb-1 block text-[10px] font-semibold text-fg-subtle uppercase">
                              Customer Number
                            </span>
                            <span className="font-mono text-xs font-medium text-fg-strong">
                              {customer.customerNumber}
                            </span>
                          </div>
                        ) : null}
                        <div className="rounded-xl border border-line/80 bg-surface-sunken/60 p-3.5">
                          <span className="mb-1 block text-[10px] font-semibold text-fg-subtle uppercase">
                            Full Name
                          </span>
                          <span className="text-xs font-medium text-fg-strong">
                            {customer?.name}
                          </span>
                        </div>
                        <div className="rounded-xl border border-line/80 bg-surface-sunken/60 p-3.5">
                          <span className="mb-1 block text-[10px] font-semibold text-fg-subtle uppercase">
                            Email Address
                          </span>
                          <span className="text-xs font-medium text-fg-strong">
                            {customer?.email}
                          </span>
                        </div>
                        <div className="rounded-xl border border-line/80 bg-surface-sunken/60 p-3.5">
                          <span className="mb-1 block text-[10px] font-semibold text-fg-subtle uppercase">
                            Phone Number
                          </span>
                          <span className="text-xs font-medium text-fg-strong">
                            {customer?.phone}
                          </span>
                        </div>
                        <div className="rounded-xl border border-line/80 bg-surface-sunken/60 p-3.5">
                          <span className="mb-1 block text-[10px] font-semibold text-fg-subtle uppercase">
                            Default Payment Rail
                          </span>
                          <span className="text-xs font-medium text-indigo-400">
                            {customer?.paymentPreferences?.preferredMethod === 'mpesa_daraja'
                              ? 'Safaricom M-Pesa STK'
                              : 'Pesapal 3.0'}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Primary Delivery Address Banner */}
                  <div className="rounded-xl border border-line bg-surface p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 text-indigo-400" />
                        <h3 className="text-sm font-bold text-fg-strong">
                          Default Delivery Address
                        </h3>
                      </div>
                      <button
                        onClick={() => setActiveTab('addresses')}
                        className="flex cursor-pointer items-center gap-1 text-xs font-medium text-indigo-400 hover:text-indigo-300"
                      >
                        <span>Manage Address Book</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {customer?.addresses && customer.addresses.length > 0 ? (
                      (() => {
                        const defaultAddr =
                          customer.addresses.find((a) => a.isDefault) || customer.addresses[0];
                        return (
                          <div className="flex flex-col items-start justify-between gap-3 rounded-xl border border-line bg-surface-sunken/60 p-4 sm:flex-row sm:items-center">
                            <div>
                              <div className="mb-1 flex items-center gap-2">
                                <span className="text-xs font-semibold text-fg-strong">
                                  {defaultAddr.label}
                                </span>
                                <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                                  Default
                                </span>
                              </div>
                              <p className="text-xs text-fg">{defaultAddr.street}</p>
                              <p className="mt-0.5 text-xs text-fg-subtle">
                                {defaultAddr.city}, {defaultAddr.countyOrState},{' '}
                                {defaultAddr.country}
                              </p>
                            </div>
                            <div className="text-right text-xs text-fg-muted">
                              <p className="font-medium text-fg">{defaultAddr.recipientName}</p>
                              <p className="text-fg-subtle">{defaultAddr.recipientPhone}</p>
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <div className="rounded-xl border border-dashed border-line bg-surface-sunken/40 p-4 text-center">
                        <p className="mb-2 text-xs text-fg-subtle">No addresses saved yet.</p>
                        <button
                          onClick={handleOpenAddAddress}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>Add Primary Address</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 2: ADDRESS BOOK */}
              {activeTab === 'addresses' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-fg-strong">Your Saved Addresses</h3>
                      <p className="text-xs text-fg-muted">
                        Addresses saved here will automatically autofill at checkout.
                      </p>
                    </div>
                    <button
                      onClick={handleOpenAddAddress}
                      className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
                    >
                      <Plus className="h-4 w-4" />
                      <span>Add New Address</span>
                    </button>
                  </div>

                  {customer?.addresses && customer.addresses.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {customer.addresses.map((addr) => (
                        <div
                          key={addr.id}
                          className={`flex flex-col justify-between rounded-xl border p-4 transition-all ${
                            addr.isDefault
                              ? 'border-indigo-500/50 bg-surface shadow-sm shadow-indigo-500/10'
                              : 'border-line bg-surface/70 hover:border-line-strong'
                          }`}
                        >
                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <span className="flex items-center gap-1.5 text-xs font-bold text-fg-strong">
                                <Building className="h-3.5 w-3.5 text-indigo-400" />
                                {addr.label}
                              </span>
                              {addr.isDefault ? (
                                <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                                  Default Delivery
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleSetDefaultAddress(addr.id)}
                                  className="cursor-pointer text-[11px] font-medium text-fg-muted transition-colors hover:text-indigo-400"
                                >
                                  Make Default
                                </button>
                              )}
                            </div>

                            <div className="space-y-1 text-xs text-fg">
                              <p className="font-semibold text-fg-strong">{addr.recipientName}</p>
                              <p className="flex items-center gap-1 text-fg-muted">
                                <Phone className="h-3 w-3 text-fg-subtle" />
                                {addr.recipientPhone}
                              </p>
                              <p className="pt-1 text-fg">{addr.street}</p>
                              <p className="text-fg-subtle">
                                {addr.city}, {addr.countyOrState}{' '}
                                {addr.postalCode ? `(${addr.postalCode})` : ''}
                              </p>
                              <p className="text-[11px] text-fg-subtle">{addr.country}</p>
                            </div>
                          </div>

                          <div className="mt-4 flex items-center justify-end gap-2 border-t border-line/80 pt-3">
                            <button
                              onClick={() => handleOpenEditAddress(addr)}
                              className="flex cursor-pointer items-center gap-1 rounded-lg border border-line bg-surface-raised p-1.5 text-xs text-fg-muted transition-colors hover:text-fg-strong"
                              title="Edit address"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              onClick={() => handleDeleteAddress(addr.id)}
                              className="flex cursor-pointer items-center gap-1 rounded-lg border border-line bg-surface-raised p-1.5 text-xs text-fg-muted transition-colors hover:text-rose-600"
                              title="Delete address"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              <span>Delete</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-line bg-surface p-8 text-center">
                      <MapPin className="mx-auto mb-2 h-8 w-8 text-fg-faint" />
                      <h4 className="text-sm font-semibold text-fg">No addresses on file</h4>
                      <p className="mt-1 mb-4 text-xs text-fg-subtle">
                        Add your home or office address for fast Kenyan dispatch.
                      </p>
                      <button
                        onClick={handleOpenAddAddress}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        <Plus className="h-4 w-4" />
                        <span>Add First Address</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: ORDER HISTORY */}
              {activeTab === 'orders' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-fg-strong">Your Orders</h3>
                      <p className="text-xs text-fg-muted">
                        Track shipments, view payment receipts, and review itemized order history.
                      </p>
                    </div>
                    <span className="text-xs font-medium text-fg-subtle">
                      {orders.length} total orders
                    </span>
                  </div>

                  {orders.length > 0 ? (
                    <div className="space-y-4">
                      {orders.map((order) => (
                        <div
                          key={order.id}
                          className="overflow-hidden rounded-xl border border-line bg-surface transition-all hover:border-line-strong"
                        >
                          {/* Order Header Bar */}
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-sunken/60 p-4">
                            <div className="flex items-center gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-bold text-fg-strong">
                                    #{order.orderNumber}
                                  </span>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase ${
                                      order.status === 'delivered' || order.status === 'completed'
                                        ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                                        : order.status === 'processing' ||
                                            order.status === 'shipped'
                                          ? 'border border-indigo-500/20 bg-indigo-500/10 text-indigo-400'
                                          : 'border border-amber-500/20 bg-amber-500/10 text-amber-600'
                                    }`}
                                  >
                                    {order.status}
                                  </span>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase ${
                                      order.paymentStatus === 'reconciled' ||
                                      order.paymentStatus === 'paid'
                                        ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                                        : 'border border-amber-500/20 bg-amber-500/10 text-amber-600'
                                    }`}
                                  >
                                    {order.paymentStatus === 'reconciled'
                                      ? 'Paid & Reconciled'
                                      : order.paymentStatus}
                                  </span>
                                </div>
                                <span className="mt-0.5 block text-[11px] text-fg-subtle">
                                  Placed on{' '}
                                  {new Date(order.createdAt).toLocaleDateString('en-GB', {
                                    day: 'numeric',
                                    month: 'short',
                                    year: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {/* View Receipt */}
                              <button
                                onClick={() => setSelectedReceiptOrder(order)}
                                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg-strong transition-colors hover:bg-hover"
                              >
                                <FileText className="h-3.5 w-3.5 text-indigo-400" />
                                <span>View Receipt</span>
                              </button>

                              {/* Track Shipment */}
                              {onSelectOrderForTracking && (
                                <button
                                  onClick={() => {
                                    onClose();
                                    onSelectOrderForTracking(order.orderNumber);
                                  }}
                                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-600/10 px-3 py-1.5 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-600/20"
                                >
                                  <Truck className="h-3.5 w-3.5 text-indigo-400" />
                                  <span>Track</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Items List */}
                          <div className="space-y-3 p-4">
                            {order.items.map((item, idx) => (
                              <div
                                key={idx}
                                className="flex items-center justify-between gap-3 text-xs"
                              >
                                <div className="flex items-center gap-3">
                                  <AppImage
                                    src={item.imageUrl}
                                    alt={item.productName}
                                    width={40}
                                    height={40}
                                    sizes="40px"
                                    className="h-10 w-10 rounded-lg border border-line bg-surface-raised object-cover"
                                  />
                                  <div>
                                    <p className="font-semibold text-fg-strong">
                                      {item.productName}
                                    </p>
                                    <p className="text-[11px] text-fg-subtle">
                                      Qty: {item.quantity} × KES {item.unitPrice.toLocaleString()}
                                    </p>
                                  </div>
                                </div>
                                <span className="font-bold text-fg-strong">
                                  KES {item.totalPrice.toLocaleString()}
                                </span>
                              </div>
                            ))}

                            {/* Summary Totals */}
                            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/80 pt-3 text-xs">
                              <div className="text-[11px] text-fg-subtle">
                                {order.paymentMethod === 'mpesa_daraja' ? (
                                  <span>
                                    M-Pesa Ref:{' '}
                                    <strong className="text-fg">
                                      {shownPaymentReference(order) || 'N/A'}
                                    </strong>
                                  </span>
                                ) : (
                                  <span>
                                    Pesapal Ref:{' '}
                                    <strong className="text-fg">
                                      {order.pesapalTrackingId ||
                                        shownPaymentReference(order) ||
                                        'N/A'}
                                    </strong>
                                  </span>
                                )}
                                {order.trackingNumber && (
                                  <span className="ml-3">
                                    Courier Tracking:{' '}
                                    <strong className="text-indigo-400">
                                      {order.trackingNumber}
                                    </strong>
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-4">
                                <span className="text-xs text-fg-muted">
                                  VAT (16%): KES {order.tax.toLocaleString()}
                                </span>
                                <div className="text-right">
                                  <span className="block text-[10px] text-fg-subtle uppercase">
                                    Total
                                  </span>
                                  <span className="text-sm font-extrabold text-emerald-600">
                                    {order.currency} {order.totalAmount.toLocaleString()}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-line bg-surface p-12 text-center">
                      <ShoppingBag className="mx-auto mb-2 h-10 w-10 text-fg-faint" />
                      <h4 className="text-sm font-semibold text-fg">No Orders Yet</h4>
                      <p className="mt-1 mb-4 text-xs text-fg-subtle">
                        When you place orders through M-Pesa or Card, they will appear here with
                        live receipts.
                      </p>
                      <button
                        onClick={onClose}
                        className="cursor-pointer rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                      >
                        Explore Store Catalog
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 4: PAYMENT RAILS & SECURITY */}
              {activeTab === 'payment' && (
                <div className="space-y-6">
                  {/* Payment Rails Section */}
                  <div className="rounded-xl border border-line bg-surface p-5">
                    <div className="mb-3 flex items-center gap-2">
                      <CreditCard className="h-4 w-4 text-indigo-400" />
                      <h3 className="text-sm font-bold text-fg-strong">Configured Payment Rails</h3>
                    </div>
                    <p className="mb-4 text-xs text-fg-muted">
                      Direct integration with Safaricom Daraja STK Push and Pesapal v3.0 merchant
                      rails.
                    </p>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-sunken/60 p-4">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-600/20 text-xs font-bold text-emerald-600">
                          M
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-fg-strong">
                              Safaricom M-Pesa STK
                            </span>
                            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600">
                              Active
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-fg-muted">
                            Prompt Phone:{' '}
                            <strong className="text-fg-strong">{customer?.phone}</strong>
                          </p>
                          <p className="mt-0.5 text-[11px] text-fg-subtle">
                            Instant STK push PIN prompt to customer phone
                          </p>
                        </div>
                      </div>

                      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-sunken/60 p-4">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-600/20 text-xs font-bold text-indigo-400">
                          P
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-fg-strong">
                              Pesapal v3.0 Multi-Rail
                            </span>
                            <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-400">
                              Ready
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-fg-muted">
                            VISA, Mastercard, Airtel Money
                          </p>
                          <p className="mt-0.5 text-[11px] text-fg-subtle">
                            Encrypted 3DS tokenization & IPN webhooks
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Account Security & Role Status */}
                  <div className="rounded-xl border border-line bg-surface p-5">
                    <div className="mb-3 flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                      <h3 className="text-sm font-bold text-fg-strong">
                        Account Security & Session
                      </h3>
                    </div>

                    <div className="space-y-3 text-xs text-fg-muted">
                      <div className="flex items-center justify-between rounded-xl border border-line/80 bg-surface-sunken/40 p-3">
                        <span>Account Role Status</span>
                        <span className="font-bold text-fg-strong uppercase">
                          {customer?.role || 'customer'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-xl border border-line/80 bg-surface-sunken/40 p-3">
                        <span>Customer Identity ID</span>
                        <span className="font-mono text-fg">{customer?.id}</span>
                      </div>
                      <div className="flex items-center justify-between rounded-xl border border-line/80 bg-surface-sunken/40 p-3">
                        <span>Member Since</span>
                        <span className="text-fg">
                          {customer?.createdAt
                            ? new Date(customer.createdAt).toLocaleDateString('en-GB')
                            : 'August 2026'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-xs text-fg-subtle">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <span>256-Bit SSL Encrypted Customer Vault</span>
          </div>

          <form action={logoutAction}>
            <button type="submit" className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-red-600/20 transition-colors hover:bg-red-500">
              <LogOut className="h-3.5 w-3.5" />
              <span>Logout</span>
            </button>
          </form>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-xl bg-surface-sunken px-5 py-2 text-xs font-semibold text-fg-strong transition-colors hover:bg-hover"
          >
            Close Account
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* ADD / EDIT ADDRESS SUB-MODAL */}
      {/* ========================================================================= */}
      {isAddressModalOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-backdrop/80 p-4 backdrop-blur-sm">
          <div className="animate-in zoom-in-95 w-full max-w-lg rounded-2xl border border-line-strong bg-surface-raised p-6 shadow-2xl duration-150">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong">
                <MapPin className="h-4 w-4 text-indigo-400" />
                {editingAddressId ? 'Edit Delivery Address' : 'Add New Delivery Address'}
              </h3>
              <button
                onClick={() => setIsAddressModalOpen(false)}
                className="text-fg-muted hover:text-fg-strong"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSaveAddress} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-fg-muted">
                    Address Label
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Home, Office, HQ"
                    value={addrLabel}
                    onChange={(e) => setAddrLabel(e.target.value)}
                    required
                    className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-fg-muted">
                    Recipient Phone
                  </label>
                  <input
                    type="text"
                    placeholder="0712345678"
                    value={addrRecipientPhone}
                    onChange={(e) => setAddrRecipientPhone(e.target.value)}
                    required
                    className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-fg-muted">
                  Recipient Name
                </label>
                <input
                  type="text"
                  placeholder="Full name of person receiving package"
                  value={addrRecipientName}
                  onChange={(e) => setAddrRecipientName(e.target.value)}
                  required
                  className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-fg-muted">
                  Street Address / Building / Suite
                </label>
                <input
                  type="text"
                  placeholder="e.g. Riverside Drive, Delta Corner Suite 4A"
                  value={addrStreet}
                  onChange={(e) => setAddrStreet(e.target.value)}
                  required
                  className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-fg-muted">
                    City / Town
                  </label>
                  <input
                    type="text"
                    placeholder="Nairobi, Mombasa, Eldoret..."
                    value={addrCity}
                    onChange={(e) => setAddrCity(e.target.value)}
                    required
                    className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-fg-muted">
                    County / State
                  </label>
                  <select
                    value={addrCounty}
                    onChange={(e) => setAddrCounty(e.target.value)}
                    className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
                  >
                    {kenyanCounties.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="addrDefaultCheckbox"
                  checked={addrIsDefault}
                  onChange={(e) => setAddrIsDefault(e.target.checked)}
                  className="h-4 w-4 rounded border-line-strong bg-surface text-indigo-600"
                />
                <label htmlFor="addrDefaultCheckbox" className="cursor-pointer text-xs text-fg">
                  Set as my primary default delivery address
                </label>
              </div>

              <div className="flex justify-end gap-2 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => setIsAddressModalOpen(false)}
                  className="cursor-pointer rounded-xl bg-surface-sunken px-4 py-2 text-xs font-medium text-fg hover:bg-hover"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex cursor-pointer items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                >
                  {isSaving ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span>Save Address</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAX INVOICE / RECEIPT MODAL */}
      {/* ========================================================================= */}
      {selectedReceiptOrder && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-backdrop/85 p-4 backdrop-blur-md">
          <div className="animate-in zoom-in-95 max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-line-strong bg-surface p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-line pb-4">
              <div>
                <span className="text-[10px] font-bold tracking-widest text-indigo-400 uppercase">
                  Official E-Tax Receipt
                </span>
                <h3 className="mt-0.5 text-base font-extrabold text-fg-strong">
                  OmniCommerce Kenya Ltd
                </h3>
                <p className="text-[11px] text-fg-muted">
                  PIN: P051982341M • eTIMS System Verified
                </p>
              </div>
              <button
                onClick={() => setSelectedReceiptOrder(null)}
                className="rounded-lg border border-line bg-surface-raised p-1.5 text-fg-muted hover:text-fg-strong"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-surface-sunken/60 p-3">
                <div>
                  <span className="text-[10px] text-fg-subtle uppercase">Invoice To</span>
                  <p className="mt-0.5 font-bold text-fg-strong">
                    {selectedReceiptOrder.customerName}
                  </p>
                  <p className="text-fg-muted">{selectedReceiptOrder.customerEmail}</p>
                  <p className="text-fg-muted">{selectedReceiptOrder.customerPhone}</p>
                </div>
                <div>
                  <span className="text-[10px] text-fg-subtle uppercase">Order Details</span>
                  <p className="mt-0.5 font-bold text-indigo-400">
                    #{selectedReceiptOrder.orderNumber}
                  </p>
                  <p className="text-fg-muted">
                    Date: {new Date(selectedReceiptOrder.createdAt).toLocaleDateString('en-GB')}
                  </p>
                  <p className="font-medium text-emerald-600">Status: Paid & Reconciled</p>
                </div>
              </div>

              {/* Items Breakdown Table */}
              <div className="overflow-hidden rounded-xl border border-line">
                <table className="w-full text-left">
                  <thead className="border-b border-line bg-surface-sunken/80 text-[10px] text-fg-muted uppercase">
                    <tr>
                      <th className="p-2.5">Item</th>
                      <th className="p-2.5 text-center">Qty</th>
                      <th className="p-2.5 text-right">Price</th>
                      <th className="p-2.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {selectedReceiptOrder.items.map((item, i) => (
                      <tr key={i} className="text-fg">
                        <td className="p-2.5">
                          <p className="font-medium text-fg-strong">{item.productName}</p>
                        </td>
                        <td className="p-2.5 text-center">{item.quantity}</td>
                        <td className="p-2.5 text-right">KES {item.unitPrice.toLocaleString()}</td>
                        <td className="p-2.5 text-right font-semibold">
                          KES {item.totalPrice.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Financial Breakdown */}
              <div className="space-y-1.5 rounded-xl border border-line bg-surface-sunken/60 p-3.5">
                <div className="flex justify-between text-fg-muted">
                  <span>Subtotal:</span>
                  <span>KES {selectedReceiptOrder.subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-fg-muted">
                  <span>VAT (16% Kenya VAT):</span>
                  <span>KES {selectedReceiptOrder.tax.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-fg-muted">
                  <span>Shipping & Handling:</span>
                  <span>KES {selectedReceiptOrder.shippingFee.toLocaleString()}</span>
                </div>
                <div className="flex justify-between border-t border-line pt-2 text-sm font-extrabold text-fg-strong">
                  <span>Total Paid:</span>
                  <span className="text-emerald-600">
                    {selectedReceiptOrder.currency}{' '}
                    {selectedReceiptOrder.totalAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Payment Proof */}
              <div className="flex items-center justify-between rounded-xl border border-emerald-800/30 bg-emerald-50 p-3 text-[11px] text-emerald-700">
                <div>
                  <span className="block font-bold">Payment Confirmation</span>
                  <span>
                    Rail:{' '}
                    {selectedReceiptOrder.paymentMethod === 'mpesa_daraja'
                      ? 'Safaricom Daraja'
                      : 'Pesapal v3'}{' '}
                    • Ref: {shownPaymentReference(selectedReceiptOrder) || 'N/A'}
                  </span>
                </div>
                <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-emerald-600" />
              </div>
            </div>

            <div className="mt-5 flex justify-end border-t border-line pt-4">
              <button
                onClick={() => setSelectedReceiptOrder(null)}
                className="cursor-pointer rounded-xl bg-surface-sunken px-4 py-2 text-xs font-semibold text-fg-strong hover:bg-hover"
              >
                Close Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
