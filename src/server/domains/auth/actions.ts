'use server';

import { AuthError } from 'next-auth';
import { auth, signIn, signOut } from '@/auth';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { isStaffRole } from '@/server/domains/auth/roles';
import { getContainer } from '@/server/di/container';
import type { UserSession, CustomerAccount } from '@/types/index';
import { AuthService, SESSION_COOKIE } from './service';
import { StorefrontCustomerService } from '@/server/domains/customers/storefront-service';
import { cookies } from 'next/headers';

function toSessionShape(user: {
  id: string;
  email: string;
  name: string;
  role: string;
}): UserSession {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserSession['role'],
    token: `authjs:${user.id}`,
    createdAt: new Date().toISOString(),
  };
}

export async function getSessionAction(): Promise<{
  session: UserSession | null;
  customer: CustomerAccount | null;
}> {
  let session = null;
  try {
    session = await auth();
  } catch {
    await clearStaleAuthSessionCookies();
    return { session: null, customer: null };
  }

  if (!session?.user?.email) {
    // Cookie may be undecryptable after AUTH_SECRET rotation; drop it so Auth.js stops retrying.
    const store = await cookies();
    const hasSessionCookie = store
      .getAll()
      .some(
        (c) =>
          c.name.includes('authjs.session-token') ||
          c.name.includes('next-auth.session-token'),
      );
    if (hasSessionCookie) await clearStaleAuthSessionCookies();
    return { session: null, customer: null };
  }

  const shaped = toSessionShape({
    id: session.user.id,
    email: session.user.email,
    name: session.user.name || session.user.email,
    role: session.user.role || 'customer',
  });

  const customer =
    session.user.role === 'customer'
      ? (await StorefrontCustomerService.findByEmailOrPhone(session.user.email)) ??
        (session.user.customerStoreId
          ? await StorefrontCustomerService.findById(session.user.customerStoreId)
          : null)
      : null;

  if (!customer || session.user.role !== 'customer') {
    return { session: shaped, customer };
  }

  try {
    const container = getContainer();
    const company = await container.companySettings.ensureSeeded();
    const trade = await container.customers.ensureStorefrontCustomer(company.id, {
      name: customer.name || session.user.name || session.user.email,
      email: customer.email || session.user.email,
      phone: customer.phone || session.user.phone,
    });
    const addresses = await container.customers.listAddresses(trade.id);
    return {
      session: shaped,
      customer: {
        ...customer,
        name: trade.name || customer.name,
        email: trade.email || customer.email,
        phone: trade.phone || customer.phone,
        tradeCustomerId: trade.id,
        customerNumber: trade.number,
        buyerKraPin: trade.buyerKraPin,
        addresses: addresses.map((row) => ({
          id: row.id,
          label: row.label,
          recipientName: row.recipientName,
          recipientPhone: row.recipientPhone,
          street: row.street,
          city: row.city,
          countyOrState: row.countyOrState,
          postalCode: row.postalCode || undefined,
          country: row.country,
          isDefault: row.isDefault,
        })),
      },
    };
  } catch {
    return { session: shaped, customer };
  }
}

async function clearStaleAuthSessionCookies(): Promise<void> {
  try {
    const store = await cookies();
    for (const cookie of store.getAll()) {
      if (
        cookie.name.includes('authjs.session-token') ||
        cookie.name.includes('next-auth.session-token')
      ) {
        store.delete(cookie.name);
      }
    }
  } catch {
    /* cookies() can throw outside a request — ignore */
  }
}

export async function registerCustomerAction(input: {
  name: string;
  email: string;
  phone?: string;
  password: string;
}): Promise<{ ok: true }> {
  const email = input.email.toLowerCase().trim();
  const users = new UserRepository();
  const existing = await users.findByEmail(email);
  if (existing) throw new Error('An account with this email already exists.');

  const customer = await StorefrontCustomerService.ensure({
    name: input.name.trim(),
    email,
    phone: input.phone?.trim() || '0700000000',
  });

  await users.create({
    email,
    password: input.password,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    role: 'customer',
    customerStoreId: customer.id,
  });

  try {
    const container = getContainer();
    const company = await container.companySettings.ensureSeeded();
    await container.customers.ensureStorefrontCustomer(company.id, {
      name: input.name.trim(),
      email,
      phone: input.phone?.trim() || null,
    });
  } catch {
    /* trade card is created on first account/checkout load if this fails */
  }

  await signIn('credentials', {
    email,
    password: input.password,
    redirect: false,
  });

  return { ok: true };
}

export async function loginAction(input: {
  email: string;
  password: string;
}): Promise<{ ok: true; role: string }> {
  try {
    const users = new UserRepository();
    await users.ensureSuperAdminSeed();
    const verified = await users.verifyPassword(input.email, input.password);
    if (!verified) {
      throw new Error('Invalid email or password.');
    }
    await signIn('credentials', {
      email: input.email,
      password: input.password,
      redirect: false,
    });
    // Prefer DB-verified role — auth() in the same request often lacks the new session cookie.
    const session = await auth();
    const role = verified.role || session?.user?.role || 'customer';
    return { ok: true, role };
  } catch (err) {
    if (err instanceof AuthError) {
      throw new Error('Invalid email or password.');
    }
    throw err;
  }
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirect: false });
  try {
    const cookieStore = await cookies();
    cookieStore.delete(SESSION_COOKIE);
  } catch {
    /* ignore */
  }
}

/** @deprecated Prefer loginAction — kept for CustomerAccountModal compatibility */
export async function customerLoginAction(
  identifierOrInput: string | { identifier: string; name?: string; phone?: string },
  name?: string,
  phone?: string,
): Promise<{ session: UserSession; customer: CustomerAccount }> {
  const input =
    typeof identifierOrInput === 'string'
      ? { identifier: identifierOrInput, name, phone }
      : identifierOrInput;

  // Legacy path without password: create/find customer and Auth.js session is not established.
  // Prefer registerCustomerAction / loginAction.
  const identifier = input.identifier;
  if (!identifier) throw new Error('Email, phone, or Customer ID is required.');

  const isEmail = identifier.includes('@');
  const resolvedEmail = isEmail ? identifier : `${identifier}@guest.omnicommerce.ke`;
  const customer =
    (await StorefrontCustomerService.findByEmailOrPhone(identifier)) ??
    (await StorefrontCustomerService.ensure({
      name: input.name || (isEmail ? identifier.split('@')[0]! : 'Shopper'),
      email: resolvedEmail,
      phone: input.phone || (isEmail ? '0700000000' : identifier),
    }));

  const session = await AuthService.createSession(
    'customer',
    customer.email,
    customer.name,
    customer.phone,
  );
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 7,
  });
  return { session, customer };
}

export async function ensureAdminSessionAction(): Promise<UserSession> {
  const session = await auth();
  if (isStaffRole(session?.user?.role)) {
    return toSessionShape({
      id: session!.user.id,
      email: session!.user.email!,
      name: session!.user.name || 'Admin',
      role: session!.user.role,
    });
  }

  // Seed super-admin from env; require proper login — do not auto-elevate anonymous users.
  const users = new UserRepository();
  await users.ensureSuperAdminSeed();
  throw new Error('Admin login required. Sign in at /login with a staff account.');
}

export async function switchRoleAction(_role: 'admin' | 'customer'): Promise<{
  session: UserSession | null;
  customer: CustomerAccount | null;
}> {
  // Role switching without credentials is disabled under Auth.js.
  return getSessionAction();
}
