'use client';

import { use, useState } from 'react';
import type { CustomerAccount, UserSession } from '@/types/index';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  User,
  Mail,
  Phone,
  ShieldCheck,
  Settings,
  LogOut,
  Edit3,
  CreditCard,
  Truck,
  History,
  Building2,
  Key,
  Menu,
  X,
} from 'lucide-react';
import { format } from 'date-fns';
import { logoutAction } from '@/server/domains/auth/actions';
import { updateUserProfileAction } from '@/server/domains/users/actions';

interface UserProfile {
  id: string;
  name: string;
  email: string;
  phone?: string;
  role: 'super_admin' | 'admin' | 'manager' | 'customer';
  createdAt: string;
  lastLoginAt?: string;
  customerId?: string;
  customerNumber?: string;
}

interface CustomerProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  customerNumber?: string;
  addresses: {
    id: string;
    label: string;
    isDefault: boolean;
    street: string;
    city: string;
    countyOrState: string;
    country: string;
  }[];
  orders: {
    id: string;
    orderNumber: string;
    status: string;
    totalAmount: number;
    createdAt: string;
  }[];
}

export function AdminProfileClient({
  sessionPromise,
}: {
  sessionPromise: Promise<{ session: UserSession | null; customer: CustomerAccount | null }>;
}) {
  // Fix: UserSession is already imported
  const router = useRouter();
  const { session, customer: customerData } = use(sessionPromise) ?? {
    session: null,
    customer: null,
  };
  const customer = customerData;

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session?.name || '');
  const [editPhone, setEditPhone] = useState(customer?.phone || '');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateUserProfileAction({ name: editName, phone: editPhone });
      router.refresh();
      setIsEditing(false);
    } catch (err) {
      alert('Failed to update profile');
    }
  };

  const handleLogout = async () => {
    // Form submission handled by logoutAction
  };

  const user = session;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg-strong">My Profile</h1>
          <p className="text-sm text-fg-muted">Manage your account settings and preferences</p>
        </div>
        <div className="flex items-center gap-3">
          <form action={logoutAction}>
            <input type="hidden" name="returnTo" value="/login" />
            <button
              type="submit"
              className="flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-hover hover:text-fg-strong"
            >
              <LogOut className="h-4 w-4" />
              <span>Logout</span>
            </button>
          </form>
        </div>
      </div>

      {/* Profile Card */}
      <div className="rounded-xl border border-line bg-surface-raised p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-600/20 text-3xl font-bold text-indigo-400">
              {user?.name?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div>
              <h2 className="text-xl font-bold text-fg-strong">{user?.name || 'Unknown User'}</h2>
              <div className="mt-1 flex items-center gap-2 text-sm text-fg-muted">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                    user?.role === 'super_admin'
                      ? 'bg-red-500/10 text-red-600'
                      : user?.role === 'admin'
                        ? 'bg-indigo-500/10 text-indigo-600'
                        : 'bg-emerald-500/10 text-emerald-600'
                  }`}
                >
                  {user?.role || 'customer'}
                </span>
                {customer?.customerNumber && (
                  <span className="font-mono text-xs text-fg-subtle">
                    #{customer.customerNumber}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 sm:ml-auto">
            <button
              onClick={() => setIsEditing(!isEditing)}
              className="flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-hover hover:text-fg-strong"
            >
              <Edit3 className="h-4 w-4" />
              <span>{isEditing ? 'Cancel' : 'Edit Profile'}</span>
            </button>
          </div>
        </div>

        {isEditing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
            }}
            className="mt-6 space-y-4"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-fg-muted">Full Name</label>
                <input
                  name="name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-fg-muted">Phone Number</label>
                <input
                  name="phone"
                  type="tel"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium text-fg hover:bg-hover"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                Save Changes
              </button>
            </div>
          </form>
        )}

        {!isEditing && (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-line bg-surface p-4">
              <span className="text-xs tracking-wider text-fg-subtle uppercase">Email</span>
              <p className="mt-1 font-medium break-all text-fg-strong">{user?.email}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <span className="text-xs tracking-wider text-fg-subtle uppercase">Phone</span>
              <p className="mt-1 font-medium text-fg-strong">{customer?.phone || 'Not set'}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <span className="text-xs tracking-wider text-fg-subtle uppercase">Role</span>
              <p className="mt-1 font-medium text-fg-strong capitalize">{user?.role}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <span className="text-xs tracking-wider text-fg-subtle uppercase">Member Since</span>
              <p className="mt-1 font-medium text-fg-strong">
                {user?.createdAt ? format(new Date(user.createdAt), 'MMM d, yyyy') : 'Unknown'}
              </p>
            </div>
          </div>
        )}

        {/* Customer Profile Link (if admin has customer profile) */}
        {customer && !isEditing && (
          <div className="mt-6 border-t border-line pt-6">
            <h3 className="mb-4 text-lg font-semibold text-fg-strong">Customer Profile</h3>
            <Link
              href="/admin/customers"
              className="flex items-center gap-2 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-indigo-500 hover:bg-indigo-50/50"
            >
              <Building2 className="h-5 w-5 text-indigo-400" />
              <div>
                <p className="font-medium text-fg-strong">View Customer Details</p>
                <p className="text-sm text-fg-muted">
                  {customer.name} • {customer.email}
                </p>
              </div>
            </Link>
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/admin/settings"
          className="flex items-center gap-3 rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500 hover:bg-indigo-50/50"
        >
          <Settings className="h-5 w-5 text-indigo-400" />
          <div>
            <p className="font-medium text-fg-strong">Settings</p>
            <p className="text-sm text-fg-muted">Preferences & Configuration</p>
          </div>
        </Link>

        <Link
          href="/admin/transactions"
          className="flex items-center gap-3 rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500 hover:bg-indigo-50/50"
        >
          <CreditCard className="h-5 w-5 text-emerald-400" />
          <div>
            <p className="font-medium text-fg-strong">Transactions</p>
            <p className="text-sm text-fg-muted">Payment History</p>
          </div>
        </Link>

        <Link
          href="/admin/orders"
          className="flex items-center gap-3 rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500 hover:bg-indigo-50/50"
        >
          <Truck className="h-5 w-5 text-amber-400" />
          <div>
            <p className="font-medium text-fg-strong">Orders</p>
            <p className="text-sm text-fg-muted">Order Management</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
