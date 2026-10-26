'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  User,
  Mail,
  Phone,
  MapPin,
  Truck,
  History,
  ShieldCheck,
  LogOut,
  Edit3,
  Settings,
  Building2,
  Menu,
  X,
  Star,
} from 'lucide-react';
import { format } from 'date-fns';
import { logoutAction } from '@/server/domains/auth/actions';
import { updateUserProfileAction } from '@/server/domains/users/actions';

interface CustomerAccount {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: string;
  status: string;
  customerNumber?: string;
  addresses: Array<{
    id: string;
    label: string;
    isDefault: boolean;
    street: string;
    city: string;
    countyOrState: string;
    postalCode?: string;
    country: string;
    recipientName: string;
    recipientPhone: string;
  }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    totalAmount: number;
    createdAt: string;
    paymentStatus: string;
  }>;
  paymentPreferences: {
    preferredMethod?: string;
    defaultMpesaPhone?: string;
  };
  createdAt: string;
}

import type { UserSession } from '@/types/index';

interface StorefrontProfileClientProps {
  sessionPromise: Promise<{ session: UserSession | null; customer: CustomerAccount | null }>;
}

export function StorefrontProfileClient({ sessionPromise }: StorefrontProfileClientProps) {
  const router = useRouter();
  const { session, customer: customerData } = use(sessionPromise) ?? {
    session: null,
    customer: null,
  };
  const customer = customerData;

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState(customer?.phone || '');
  const [editEmail, setEditEmail] = useState('');

  const user = session;
  const handleLogout = async () => {
    // Form submission handled by logoutAction
  };

  return (
    <div className="text-fg">
      <div className="mx-auto max-w-4xl space-y-6 py-4 sm:py-8">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-fg-strong">My Account</h1>
            <p className="mt-1 text-sm text-fg-muted">
              Manage your details, delivery addresses and orders
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <form action={logoutAction}>
              <input type="hidden" name="returnTo" value="/" />
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

        {/* Profile Header Card */}
        <div className="rounded-2xl border border-line bg-surface-raised p-6 sm:p-8">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
            <div className="flex items-center gap-4">
              <div className="flex h-24 w-24 items-center justify-center rounded-full bg-indigo-600/20 text-4xl font-bold text-indigo-400">
                {customer?.name?.charAt(0).toUpperCase() ||
                  user?.name?.charAt(0).toUpperCase() ||
                  'U'}
              </div>
              <div>
                <h2 className="text-2xl font-bold text-fg-strong">
                  {customer?.name || user?.name || 'Customer'}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                    <ShieldCheck className="h-3 w-3" />
                    {customer?.status || 'Active'}
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
              action={async (formData) => {
                await updateUserProfileAction({
                  name: formData.get('name') as string,
                  phone: formData.get('phone') as string,
                  email: formData.get('email') as string,
                });
                router.refresh();
              }}
              className="mt-6 space-y-4"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                  <label className="mb-1 block text-sm font-medium text-fg-muted">Email</label>
                  <input
                    name="email"
                    type="email"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    required
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-fg-muted">
                    Phone Number
                  </label>
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
                <p className="mt-1 font-medium break-all text-fg-strong">
                  {user?.email || customer?.email}
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <span className="text-xs tracking-wider text-fg-subtle uppercase">Phone</span>
                <p className="mt-1 font-medium text-fg-strong">{customer?.phone || 'Not set'}</p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <span className="text-xs tracking-wider text-fg-subtle uppercase">Status</span>
                <p className="mt-1 font-medium text-fg-strong">
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                    <ShieldCheck className="h-3 w-3" />
                    {customer?.status || 'Active'}
                  </span>
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <span className="text-xs tracking-wider text-fg-subtle uppercase">
                  Member Since
                </span>
                <p className="mt-1 font-medium text-fg-strong">
                  {customer?.createdAt
                    ? format(new Date(customer.createdAt), 'MMM d, yyyy')
                    : user?.createdAt
                      ? format(new Date(user.createdAt), 'MMM d, yyyy')
                      : 'Unknown'}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Quick Navigation */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-2">
          <Link
            href="/profile/addresses"
            className="flex items-center gap-3 rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500 hover:bg-indigo-50/50"
          >
            <MapPin className="h-5 w-5 text-indigo-400" />
            <div>
              <p className="font-medium text-fg-strong">Addresses</p>
              <p className="text-sm text-fg-muted">Manage delivery addresses</p>
            </div>
          </Link>

          <Link
            href="/profile/orders"
            className="flex items-center gap-3 rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500 hover:bg-indigo-50/50"
          >
            <Truck className="h-5 w-5 text-amber-400" />
            <div>
              <p className="font-medium text-fg-strong">My Orders</p>
              <p className="text-sm text-fg-muted">Track & view order history</p>
            </div>
          </Link>

        </div>

        {/* Recent Orders Preview */}
        {customer?.orders && customer.orders.length > 0 && (
          <div className="mt-8">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-fg-strong">Recent Orders</h3>
              <Link
                href="/profile/orders"
                className="text-sm text-indigo-400 hover:text-indigo-300"
              >
                View all →
              </Link>
            </div>
            <div className="space-y-3">
              {customer.orders.slice(0, 3).map((order) => (
                <Link
                  key={order.id}
                  href={`/profile/orders/${order.id}`}
                  className="flex items-center justify-between rounded-xl border border-line bg-surface-raised p-4 transition-colors hover:border-indigo-500 hover:bg-indigo-50/50"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600/20">
                      <Truck className="h-6 w-6 text-indigo-400" />
                    </div>
                    <div>
                      <p className="font-medium text-fg-strong">Order #{order.orderNumber}</p>
                      <p className="text-sm text-fg-muted">
                        {format(new Date(order.createdAt), 'MMM d, yyyy')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-right">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                        order.status === 'delivered' || order.status === 'completed'
                          ? 'bg-emerald-500/10 text-emerald-600'
                          : order.status === 'processing' || order.status === 'shipped'
                            ? 'bg-indigo-500/10 text-indigo-600'
                            : 'bg-amber-500/10 text-amber-600'
                      }`}
                    >
                      {order.status}
                    </span>
                    <span className="font-semibold text-fg-strong">
                      KES {order.totalAmount.toLocaleString()}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
