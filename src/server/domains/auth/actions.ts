'use server';

import { AuthError } from 'next-auth';
import { auth, signIn, signOut } from '@/auth';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { db } from '@/server/db/store';
import type { UserSession, CustomerAccount } from '@/types/index';
import { AuthService, SESSION_COOKIE } from './service';
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
      ? db.getCustomerByEmailOrPhone(session.user.email) ||
        (session.user.customerStoreId
          ? db.getCustomerById(session.user.customerStoreId)
          : null)
      : null;

  return { session: shaped, customer };
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

  const customer = db.createCustomer({
    name: input.name.trim(),
    email,
    phone: input.phone?.trim() || '0700000000',
    role: 'customer',
    status: 'verified',
    addresses: [],
    paymentPreferences: {
      preferredMethod: 'mpesa_daraja',
      defaultMpesaPhone: input.phone?.trim(),
    },
  });

  await users.create({
    email,
    password: input.password,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    role: 'customer',
    customerStoreId: customer.id,
  });

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
    await users.ensureAdminSeed();
    await signIn('credentials', {
      email: input.email,
      password: input.password,
      redirect: false,
    });
    const session = await auth();
    return { ok: true, role: session?.user?.role || 'customer' };
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

  let customer = db.getCustomerByEmailOrPhone(identifier) || db.getCustomerById(identifier);
  if (!customer) {
    const isEmail = identifier.includes('@');
    customer = db.createCustomer({
      name: input.name || (isEmail ? identifier.split('@')[0]! : 'Shopper'),
      email: isEmail ? identifier : `${identifier}@guest.omnicommerce.ke`,
      phone: input.phone || (isEmail ? '0700000000' : identifier),
      role: 'customer',
      status: 'verified',
      addresses: [],
      paymentPreferences: { preferredMethod: 'mpesa_daraja', defaultMpesaPhone: input.phone },
    });
  }

  const session = AuthService.createSession(
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
  if (session?.user?.role === 'admin' || session?.user?.role === 'manager') {
    return toSessionShape({
      id: session.user.id,
      email: session.user.email!,
      name: session.user.name || 'Admin',
      role: session.user.role,
    });
  }

  // Seed admin and require proper login — do not auto-elevate anonymous users.
  const users = new UserRepository();
  await users.ensureAdminSeed();
  throw new Error('Admin login required. Sign in at /login with an admin account.');
}

export async function switchRoleAction(_role: 'admin' | 'customer'): Promise<{
  session: UserSession | null;
  customer: CustomerAccount | null;
}> {
  // Role switching without credentials is disabled under Auth.js.
  return getSessionAction();
}
