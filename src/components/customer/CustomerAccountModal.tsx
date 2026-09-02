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
  AlertCircle
} from 'lucide-react';
import { 
  CustomerAccount, 
  CustomerAddress, 
  Order, 
  PaymentProvider 
} from '@/types/index';
import { 
  fetchCustomerAccountAction, 
  fetchAllCustomersAction, 
  updateCustomerProfileAction, 
  addCustomerAddressAction, 
  updateCustomerAddressAction, 
  deleteCustomerAddressAction, 
  setDefaultAddressAction, 
  customerLoginAction 
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
  onRefreshGlobalData
}: CustomerAccountModalProps) {
  if (!isOpen) return null;

  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [allCustomers, setAllCustomers] = useState<CustomerAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

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
        fetchAllCustomersAction().catch(() => [])
      ]);

      setCustomer(accountData.customer);
      setOrders(accountData.orders);
      setAllCustomers(customersList);

      // Initialize edit fields
      if (accountData.customer) {
        setEditName(accountData.customer.name);
        setEditEmail(accountData.customer.email);
        setEditPhone(accountData.customer.phone);
        setEditPaymentMethod(accountData.customer.paymentPreferences?.preferredMethod || 'mpesa_daraja');
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
        targetCustomer.phone
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
          defaultMpesaPhone: editPhone
        }
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
        const { customer: updatedCustomer } = await updateCustomerAddressAction(customer.id, editingAddressId, {
          label: addrLabel,
          recipientName: addrRecipientName,
          recipientPhone: addrRecipientPhone,
          street: addrStreet,
          city: addrCity,
          countyOrState: addrCounty,
          postalCode: addrPostalCode,
          country: addrCountry,
          isDefault: addrIsDefault
        });
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
          isDefault: addrIsDefault
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
      const { customer: updatedCustomer } = await deleteCustomerAddressAction(customer.id, addressId);
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
    'Kakamega County'
  ];

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-md p-3 sm:p-6 flex items-center justify-center">
      <div className="relative w-full max-w-5xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-4 max-h-[92vh]">
        
        {/* Top Header Bar */}
        <div className="p-4 sm:p-6 border-b border-zinc-800 bg-zinc-950 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center text-white font-bold text-lg shadow-lg">
                {customer?.name?.charAt(0) || 'C'}
              </div>
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-500 rounded-full border-2 border-zinc-950 flex items-center justify-center">
                <Check className="w-2.5 h-2.5 text-white stroke-[3]" />
              </div>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-lg text-white">
                  {customer?.name || 'Customer Account'}
                </h2>
                <span className="px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  {customer?.status === 'verified' ? 'Verified Buyer' : 'Active Account'}
                </span>
              </div>
              <p className="text-xs text-zinc-400 flex items-center gap-2 mt-0.5">
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
              className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <User className="w-3.5 h-3.5 text-indigo-400" />
              <span>Switch Account</span>
            </button>

            {/* Admin Switcher Shortcut */}
            {onNavigateToAdmin && (
              <button
                onClick={() => {
                  onClose();
                  onNavigateToAdmin();
                }}
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-950/60 hover:bg-indigo-900 border border-indigo-800/40 text-indigo-300 text-xs font-medium transition-colors cursor-pointer"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Admin Console</span>
              </button>
            )}

            {/* Refresh */}
            <button
              onClick={() => loadCustomerData(customer?.id)}
              disabled={isLoading}
              title="Refresh Account Data"
              className="p-2 rounded-xl text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-400' : ''}`} />
            </button>

            {/* Close */}
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Account Switcher Dropdown Drawer */}
        {isSwitchingAccount && (
          <div className="bg-zinc-950 border-b border-zinc-800 p-4 sm:p-5 animate-in fade-in duration-200">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                <User className="w-3.5 h-3.5 text-indigo-400" />
                Select Customer Account / Login
              </h3>
              <button
                onClick={() => setIsSwitchingAccount(false)}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              {allCustomers.map((cust) => (
                <button
                  key={cust.id}
                  onClick={() => handleSwitchCustomer(cust)}
                  className={`p-3 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between ${
                    cust.id === customer?.id 
                      ? 'bg-indigo-600/10 border-indigo-500 text-white' 
                      : 'bg-zinc-900 hover:bg-zinc-850 border-zinc-800 text-zinc-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs truncate">{cust.name}</span>
                    {cust.id === customer?.id && (
                      <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                    )}
                  </div>
                  <span className="text-[11px] text-zinc-500 truncate mt-1">{cust.email}</span>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800/60 text-[10px] text-zinc-400">
                    <span>{cust.addresses?.length || 0} addresses</span>
                    <span className="text-indigo-400 font-medium">KES {cust.totalSpend?.toLocaleString()}</span>
                  </div>
                </button>
              ))}
            </div>

            {/* Custom Phone or Email sign-in */}
            <form onSubmit={handleCustomLogin} className="flex gap-2 items-center">
              <div className="relative flex-1">
                <input
                  type="text"
                  placeholder="Enter email or Kenyan phone (e.g. 0722000000 or customer@biz.co.ke)..."
                  value={customLoginInput}
                  onChange={(e) => setCustomLoginInput(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <button
                type="submit"
                disabled={!customLoginInput.trim()}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors"
              >
                Sign In / Register
              </button>
            </form>
          </div>
        )}

        {/* Global Notification Banner */}
        {statusMessage && (
          <div className={`px-5 py-2.5 text-xs font-medium flex items-center gap-2 ${
            statusMessage.type === 'success' 
              ? 'bg-emerald-950/80 text-emerald-300 border-b border-emerald-800/40' 
              : 'bg-rose-950/80 text-rose-300 border-b border-rose-800/40'
          }`}>
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-zinc-800 border-b border-zinc-800">
          <div className="bg-zinc-900/90 p-4">
            <span className="text-[11px] text-zinc-500 uppercase tracking-wider block">Total Orders</span>
            <span className="text-lg font-bold text-white mt-0.5 block">{customer?.totalOrders || orders.length || 0}</span>
          </div>
          <div className="bg-zinc-900/90 p-4">
            <span className="text-[11px] text-zinc-500 uppercase tracking-wider block">Lifetime Spend</span>
            <span className="text-lg font-bold text-emerald-400 mt-0.5 block">
              KES {customer?.totalSpend?.toLocaleString() || '0'}
            </span>
          </div>
          <div className="bg-zinc-900/90 p-4">
            <span className="text-[11px] text-zinc-500 uppercase tracking-wider block">Saved Addresses</span>
            <span className="text-lg font-bold text-indigo-400 mt-0.5 block">{customer?.addresses?.length || 0}</span>
          </div>
          <div className="bg-zinc-900/90 p-4">
            <span className="text-[11px] text-zinc-500 uppercase tracking-wider block">Preferred Payment</span>
            <span className="text-sm font-semibold text-white mt-1.5 block truncate">
              {customer?.paymentPreferences?.preferredMethod === 'mpesa_daraja' ? 'M-Pesa STK' : 'Pesapal v3'}
            </span>
          </div>
        </div>

        {/* Nav Tabs */}
        <div className="flex border-b border-zinc-800 bg-zinc-950/50 px-4 sm:px-6 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-3.5 px-4 text-xs font-semibold border-b-2 transition-all whitespace-nowrap cursor-pointer flex items-center gap-2 ${
              activeTab === 'overview'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <User className="w-4 h-4" />
            <span>Profile & Account</span>
          </button>

          <button
            onClick={() => setActiveTab('addresses')}
            className={`py-3.5 px-4 text-xs font-semibold border-b-2 transition-all whitespace-nowrap cursor-pointer flex items-center gap-2 ${
              activeTab === 'addresses'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <MapPin className="w-4 h-4" />
            <span>Address Book ({customer?.addresses?.length || 0})</span>
          </button>

          <button
            onClick={() => setActiveTab('orders')}
            className={`py-3.5 px-4 text-xs font-semibold border-b-2 transition-all whitespace-nowrap cursor-pointer flex items-center gap-2 ${
              activeTab === 'orders'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <ShoppingBag className="w-4 h-4" />
            <span>Order History ({orders.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('payment')}
            className={`py-3.5 px-4 text-xs font-semibold border-b-2 transition-all whitespace-nowrap cursor-pointer flex items-center gap-2 ${
              activeTab === 'payment'
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <CreditCard className="w-4 h-4" />
            <span>Payment Rails & Security</span>
          </button>
        </div>

        {/* Tab Contents */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 max-h-[60vh]">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
              <RefreshCw className="w-8 h-8 animate-spin text-indigo-500 mb-3" />
              <p className="text-sm">Loading customer details...</p>
            </div>
          ) : (
            <>
              {/* TAB 1: OVERVIEW & PROFILE */}
              {activeTab === 'overview' && (
                <div className="space-y-6">
                  <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-bold text-white">Personal Information</h3>
                        <p className="text-xs text-zinc-400">Manage your contact details and default communication channels.</p>
                      </div>
                      {!isEditingProfile ? (
                        <button
                          onClick={() => setIsEditingProfile(true)}
                          className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Edit Profile</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => setIsEditingProfile(false)}
                          className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-400 transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                      )}
                    </div>

                    {isEditingProfile ? (
                      <form onSubmit={handleSaveProfile} className="space-y-4 pt-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="block text-xs font-medium text-zinc-400 mb-1">Full Legal Name</label>
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              required
                              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-zinc-400 mb-1">Email Address</label>
                            <input
                              type="email"
                              value={editEmail}
                              onChange={(e) => setEditEmail(e.target.value)}
                              required
                              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-zinc-400 mb-1">Phone Number (M-Pesa registered)</label>
                            <input
                              type="text"
                              value={editPhone}
                              onChange={(e) => setEditPhone(e.target.value)}
                              required
                              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-zinc-400 mb-1">Default Payment Method</label>
                            <select
                              value={editPaymentMethod}
                              onChange={(e) => setEditPaymentMethod(e.target.value as PaymentProvider)}
                              className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                            >
                              <option value="mpesa_daraja">Safaricom M-Pesa STK Push (LNMO)</option>
                              <option value="pesapal_v3">Pesapal v3 (Cards, Bank, Mobile Money)</option>
                            </select>
                          </div>
                        </div>

                        <div className="flex justify-end gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => setIsEditingProfile(false)}
                            className="px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-300 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            disabled={isSaving}
                            className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-semibold text-white cursor-pointer flex items-center gap-1.5 shadow-md shadow-indigo-600/20"
                          >
                            {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                            <span>Save Changes</span>
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                          <span className="text-[10px] uppercase font-semibold text-zinc-500 block mb-1">Full Name</span>
                          <span className="text-xs font-medium text-zinc-200">{customer?.name}</span>
                        </div>
                        <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                          <span className="text-[10px] uppercase font-semibold text-zinc-500 block mb-1">Email Address</span>
                          <span className="text-xs font-medium text-zinc-200">{customer?.email}</span>
                        </div>
                        <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                          <span className="text-[10px] uppercase font-semibold text-zinc-500 block mb-1">Phone Number</span>
                          <span className="text-xs font-medium text-zinc-200">{customer?.phone}</span>
                        </div>
                        <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800/80">
                          <span className="text-[10px] uppercase font-semibold text-zinc-500 block mb-1">Default Payment Rail</span>
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
                  <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-indigo-400" />
                        <h3 className="text-sm font-bold text-white">Default Delivery Address</h3>
                      </div>
                      <button
                        onClick={() => setActiveTab('addresses')}
                        className="text-xs text-indigo-400 hover:text-indigo-300 font-medium flex items-center gap-1 cursor-pointer"
                      >
                        <span>Manage Address Book</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {customer?.addresses && customer.addresses.length > 0 ? (
                      (() => {
                        const defaultAddr = customer.addresses.find(a => a.isDefault) || customer.addresses[0];
                        return (
                          <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-semibold text-xs text-white">{defaultAddr.label}</span>
                                <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 font-medium">Default</span>
                              </div>
                              <p className="text-xs text-zinc-300">{defaultAddr.street}</p>
                              <p className="text-xs text-zinc-500 mt-0.5">
                                {defaultAddr.city}, {defaultAddr.countyOrState}, {defaultAddr.country}
                              </p>
                            </div>
                            <div className="text-right text-xs text-zinc-400">
                              <p className="font-medium text-zinc-300">{defaultAddr.recipientName}</p>
                              <p className="text-zinc-500">{defaultAddr.recipientPhone}</p>
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <div className="p-4 rounded-xl bg-zinc-900/40 border border-dashed border-zinc-800 text-center">
                        <p className="text-xs text-zinc-500 mb-2">No addresses saved yet.</p>
                        <button
                          onClick={handleOpenAddAddress}
                          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium cursor-pointer inline-flex items-center gap-1.5"
                        >
                          <Plus className="w-3.5 h-3.5" />
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
                      <h3 className="text-sm font-bold text-white">Your Saved Addresses</h3>
                      <p className="text-xs text-zinc-400">Addresses saved here will automatically autofill at checkout.</p>
                    </div>
                    <button
                      onClick={handleOpenAddAddress}
                      className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow-md shadow-indigo-600/20 cursor-pointer transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Add New Address</span>
                    </button>
                  </div>

                  {customer?.addresses && customer.addresses.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {customer.addresses.map((addr) => (
                        <div
                          key={addr.id}
                          className={`p-4 rounded-xl border transition-all flex flex-col justify-between ${
                            addr.isDefault
                              ? 'bg-zinc-950 border-indigo-500/50 shadow-sm shadow-indigo-500/10'
                              : 'bg-zinc-950/70 border-zinc-800 hover:border-zinc-700'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-bold text-xs text-white flex items-center gap-1.5">
                                <Building className="w-3.5 h-3.5 text-indigo-400" />
                                {addr.label}
                              </span>
                              {addr.isDefault ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                  Default Delivery
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleSetDefaultAddress(addr.id)}
                                  className="text-[11px] text-zinc-400 hover:text-indigo-400 font-medium cursor-pointer transition-colors"
                                >
                                  Make Default
                                </button>
                              )}
                            </div>

                            <div className="space-y-1 text-xs text-zinc-300">
                              <p className="font-semibold text-zinc-200">{addr.recipientName}</p>
                              <p className="text-zinc-400 flex items-center gap-1">
                                <Phone className="w-3 h-3 text-zinc-500" />
                                {addr.recipientPhone}
                              </p>
                              <p className="text-zinc-300 pt-1">{addr.street}</p>
                              <p className="text-zinc-500">
                                {addr.city}, {addr.countyOrState} {addr.postalCode ? `(${addr.postalCode})` : ''}
                              </p>
                              <p className="text-[11px] text-zinc-500">{addr.country}</p>
                            </div>
                          </div>

                          <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-zinc-800/80">
                            <button
                              onClick={() => handleOpenEditAddress(addr)}
                              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 text-xs flex items-center gap-1 cursor-pointer transition-colors"
                              title="Edit address"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              onClick={() => handleDeleteAddress(addr.id)}
                              className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-400 bg-zinc-900 border border-zinc-800 text-xs flex items-center gap-1 cursor-pointer transition-colors"
                              title="Delete address"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Delete</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-8 rounded-xl bg-zinc-950 border border-dashed border-zinc-800 text-center">
                      <MapPin className="w-8 h-8 text-zinc-600 mx-auto mb-2" />
                      <h4 className="text-sm font-semibold text-zinc-300">No addresses on file</h4>
                      <p className="text-xs text-zinc-500 mt-1 mb-4">Add your home or office address for fast Kenyan dispatch.</p>
                      <button
                        onClick={handleOpenAddAddress}
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer inline-flex items-center gap-1.5"
                      >
                        <Plus className="w-4 h-4" />
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
                      <h3 className="text-sm font-bold text-white">Your Orders</h3>
                      <p className="text-xs text-zinc-400">Track shipments, view payment receipts, and review itemized order history.</p>
                    </div>
                    <span className="text-xs text-zinc-500 font-medium">{orders.length} total orders</span>
                  </div>

                  {orders.length > 0 ? (
                    <div className="space-y-4">
                      {orders.map((order) => (
                        <div
                          key={order.id}
                          className="bg-zinc-950 border border-zinc-800 rounded-xl overflow-hidden hover:border-zinc-700 transition-all"
                        >
                          {/* Order Header Bar */}
                          <div className="p-4 bg-zinc-900/60 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-sm text-white">#{order.orderNumber}</span>
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                    order.status === 'delivered' || order.status === 'completed'
                                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                      : order.status === 'processing' || order.status === 'shipped'
                                      ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                  }`}>
                                    {order.status}
                                  </span>
                                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                    order.paymentStatus === 'reconciled' || order.paymentStatus === 'paid'
                                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                  }`}>
                                    {order.paymentStatus === 'reconciled' ? 'Paid & Reconciled' : order.paymentStatus}
                                  </span>
                                </div>
                                <span className="text-[11px] text-zinc-500 block mt-0.5">
                                  Placed on {new Date(order.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {/* View Receipt */}
                              <button
                                onClick={() => setSelectedReceiptOrder(order)}
                                className="px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                              >
                                <FileText className="w-3.5 h-3.5 text-indigo-400" />
                                <span>View Receipt</span>
                              </button>

                              {/* Track Shipment */}
                              {onSelectOrderForTracking && (
                                <button
                                  onClick={() => {
                                    onClose();
                                    onSelectOrderForTracking(order.orderNumber);
                                  }}
                                  className="px-3 py-1.5 rounded-lg bg-indigo-600/10 hover:bg-indigo-600/20 border border-indigo-500/30 text-indigo-300 text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors"
                                >
                                  <Truck className="w-3.5 h-3.5 text-indigo-400" />
                                  <span>Track</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Items List */}
                          <div className="p-4 space-y-3">
                            {order.items.map((item, idx) => (
                              <div key={idx} className="flex items-center justify-between gap-3 text-xs">
                                <div className="flex items-center gap-3">
                                  <img
                                    src={item.imageUrl}
                                    alt={item.productName}
                                    className="w-10 h-10 rounded-lg object-cover bg-zinc-900 border border-zinc-800"
                                  />
                                  <div>
                                    <p className="font-semibold text-zinc-200">{item.productName}</p>
                                    <p className="text-[11px] text-zinc-500">
                                      SKU: {item.sku} • Qty: {item.quantity} × KES {item.unitPrice.toLocaleString()}
                                    </p>
                                  </div>
                                </div>
                                <span className="font-bold text-zinc-200">
                                  KES {item.totalPrice.toLocaleString()}
                                </span>
                              </div>
                            ))}

                            {/* Summary Totals */}
                            <div className="pt-3 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-2 text-xs">
                              <div className="text-zinc-500 text-[11px]">
                                {order.paymentMethod === 'mpesa_daraja' ? (
                                  <span>M-Pesa Ref: <strong className="text-zinc-300">{order.mpesaReceiptNumber || order.transactionReference || 'N/A'}</strong></span>
                                ) : (
                                  <span>Pesapal Ref: <strong className="text-zinc-300">{order.pesapalTrackingId || order.transactionReference || 'N/A'}</strong></span>
                                )}
                                {order.trackingNumber && (
                                  <span className="ml-3">Courier Tracking: <strong className="text-indigo-400">{order.trackingNumber}</strong></span>
                                )}
                              </div>

                              <div className="flex items-center gap-4">
                                <span className="text-zinc-400 text-xs">
                                  VAT (16%): KES {order.tax.toLocaleString()}
                                </span>
                                <div className="text-right">
                                  <span className="text-[10px] text-zinc-500 uppercase block">Total</span>
                                  <span className="text-sm font-extrabold text-emerald-400">
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
                    <div className="p-12 rounded-xl bg-zinc-950 border border-dashed border-zinc-800 text-center">
                      <ShoppingBag className="w-10 h-10 text-zinc-600 mx-auto mb-2" />
                      <h4 className="text-sm font-semibold text-zinc-300">No Orders Yet</h4>
                      <p className="text-xs text-zinc-500 mt-1 mb-4">When you place orders through M-Pesa or Card, they will appear here with live receipts.</p>
                      <button
                        onClick={onClose}
                        className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer"
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
                  <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <CreditCard className="w-4 h-4 text-indigo-400" />
                      <h3 className="text-sm font-bold text-white">Configured Payment Rails</h3>
                    </div>
                    <p className="text-xs text-zinc-400 mb-4">
                      Direct integration with Safaricom Daraja STK Push and Pesapal v3.0 merchant rails.
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-xs flex-shrink-0">
                          M
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-xs text-white">Safaricom M-Pesa STK</span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-emerald-500/10 text-emerald-400">Active</span>
                          </div>
                          <p className="text-xs text-zinc-400 mt-1">Prompt Phone: <strong className="text-zinc-200">{customer?.phone}</strong></p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">Instant STK push PIN prompt to customer phone</p>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-xs flex-shrink-0">
                          P
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-xs text-white">Pesapal v3.0 Multi-Rail</span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-indigo-500/10 text-indigo-400">Ready</span>
                          </div>
                          <p className="text-xs text-zinc-400 mt-1">VISA, Mastercard, Airtel Money</p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">Encrypted 3DS tokenization & IPN webhooks</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Account Security & Role Status */}
                  <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <h3 className="text-sm font-bold text-white">Account Security & Session</h3>
                    </div>

                    <div className="space-y-3 text-xs text-zinc-400">
                      <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
                        <span>Account Role Status</span>
                        <span className="font-bold text-white uppercase">{customer?.role || 'customer'}</span>
                      </div>
                      <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
                        <span>Customer Identity ID</span>
                        <span className="font-mono text-zinc-300">{customer?.id}</span>
                      </div>
                      <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/80">
                        <span>Member Since</span>
                        <span className="text-zinc-300">
                          {customer?.createdAt ? new Date(customer.createdAt).toLocaleDateString('en-GB') : 'August 2026'}
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
        <div className="p-4 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span>256-Bit SSL Encrypted Customer Vault</span>
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold cursor-pointer transition-colors"
          >
            Close Account
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* ADD / EDIT ADDRESS SUB-MODAL */}
      {/* ========================================================================= */}
      {isAddressModalOpen && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center">
          <div className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <MapPin className="w-4 h-4 text-indigo-400" />
                {editingAddressId ? 'Edit Delivery Address' : 'Add New Delivery Address'}
              </h3>
              <button
                onClick={() => setIsAddressModalOpen(false)}
                className="text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveAddress} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">Address Label</label>
                  <input
                    type="text"
                    placeholder="e.g. Home, Office, HQ"
                    value={addrLabel}
                    onChange={(e) => setAddrLabel(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">Recipient Phone</label>
                  <input
                    type="text"
                    placeholder="0712345678"
                    value={addrRecipientPhone}
                    onChange={(e) => setAddrRecipientPhone(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1">Recipient Name</label>
                <input
                  type="text"
                  placeholder="Full name of person receiving package"
                  value={addrRecipientName}
                  onChange={(e) => setAddrRecipientName(e.target.value)}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-zinc-400 mb-1">Street Address / Building / Suite</label>
                <input
                  type="text"
                  placeholder="e.g. Riverside Drive, Delta Corner Suite 4A"
                  value={addrStreet}
                  onChange={(e) => setAddrStreet(e.target.value)}
                  required
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">City / Town</label>
                  <input
                    type="text"
                    placeholder="Nairobi, Mombasa, Eldoret..."
                    value={addrCity}
                    onChange={(e) => setAddrCity(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-zinc-400 mb-1">County / State</label>
                  <select
                    value={addrCounty}
                    onChange={(e) => setAddrCounty(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                  >
                    {kenyanCounties.map((c) => (
                      <option key={c} value={c}>{c}</option>
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
                  className="w-4 h-4 rounded text-indigo-600 bg-zinc-950 border-zinc-700"
                />
                <label htmlFor="addrDefaultCheckbox" className="text-xs text-zinc-300 cursor-pointer">
                  Set as my primary default delivery address
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsAddressModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white cursor-pointer flex items-center gap-1.5"
                >
                  {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
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
        <div className="fixed inset-0 z-60 bg-black/85 backdrop-blur-md p-4 flex items-center justify-center">
          <div className="w-full max-w-xl bg-zinc-950 border border-zinc-700 rounded-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-4">
              <div>
                <span className="text-[10px] uppercase tracking-widest text-indigo-400 font-bold">Official E-Tax Receipt</span>
                <h3 className="text-base font-extrabold text-white mt-0.5">OmniCommerce Kenya Ltd</h3>
                <p className="text-[11px] text-zinc-400">PIN: P051982341M • eTIMS System Verified</p>
              </div>
              <button
                onClick={() => setSelectedReceiptOrder(null)}
                className="p-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
                <div>
                  <span className="text-[10px] text-zinc-500 uppercase">Invoice To</span>
                  <p className="font-bold text-zinc-200 mt-0.5">{selectedReceiptOrder.customerName}</p>
                  <p className="text-zinc-400">{selectedReceiptOrder.customerEmail}</p>
                  <p className="text-zinc-400">{selectedReceiptOrder.customerPhone}</p>
                </div>
                <div>
                  <span className="text-[10px] text-zinc-500 uppercase">Order Details</span>
                  <p className="font-bold text-indigo-400 mt-0.5">#{selectedReceiptOrder.orderNumber}</p>
                  <p className="text-zinc-400">Date: {new Date(selectedReceiptOrder.createdAt).toLocaleDateString('en-GB')}</p>
                  <p className="text-emerald-400 font-medium">Status: Paid & Reconciled</p>
                </div>
              </div>

              {/* Items Breakdown Table */}
              <div className="border border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-zinc-900/80 text-[10px] uppercase text-zinc-400 border-b border-zinc-800">
                    <tr>
                      <th className="p-2.5">Item</th>
                      <th className="p-2.5 text-center">Qty</th>
                      <th className="p-2.5 text-right">Price</th>
                      <th className="p-2.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {selectedReceiptOrder.items.map((item, i) => (
                      <tr key={i} className="text-zinc-300">
                        <td className="p-2.5">
                          <p className="font-medium text-white">{item.productName}</p>
                          <span className="text-[10px] text-zinc-500">{item.sku}</span>
                        </td>
                        <td className="p-2.5 text-center">{item.quantity}</td>
                        <td className="p-2.5 text-right">KES {item.unitPrice.toLocaleString()}</td>
                        <td className="p-2.5 text-right font-semibold">KES {item.totalPrice.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Financial Breakdown */}
              <div className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 space-y-1.5">
                <div className="flex justify-between text-zinc-400">
                  <span>Subtotal:</span>
                  <span>KES {selectedReceiptOrder.subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>VAT (16% Kenya VAT):</span>
                  <span>KES {selectedReceiptOrder.tax.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Shipping & Handling:</span>
                  <span>KES {selectedReceiptOrder.shippingFee.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm font-extrabold text-white pt-2 border-t border-zinc-800">
                  <span>Total Paid:</span>
                  <span className="text-emerald-400">{selectedReceiptOrder.currency} {selectedReceiptOrder.totalAmount.toLocaleString()}</span>
                </div>
              </div>

              {/* Payment Proof */}
              <div className="p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/30 text-[11px] text-emerald-300 flex items-center justify-between">
                <div>
                  <span className="font-bold block">Payment Confirmation</span>
                  <span>
                    Rail: {selectedReceiptOrder.paymentMethod === 'mpesa_daraja' ? 'Safaricom Daraja' : 'Pesapal v3'} • Ref: {selectedReceiptOrder.mpesaReceiptNumber || selectedReceiptOrder.transactionReference || 'TX-8821'}
                  </span>
                </div>
                <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0" />
              </div>
            </div>

            <div className="mt-5 pt-4 border-t border-zinc-800 flex justify-end">
              <button
                onClick={() => setSelectedReceiptOrder(null)}
                className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white cursor-pointer"
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
