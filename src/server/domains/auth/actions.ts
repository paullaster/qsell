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
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { recordApplicationError } from '@/server/observability/application-errors';

const LOGIN_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
          c.name.includes('authjs.session-token') || c.name.includes('next-auth.session-token'),
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
      ? ((await StorefrontCustomerService.findByEmailOrPhone(session.user.email)) ??
        (session.user.customerStoreId
          ? await StorefrontCustomerService.findById(session.user.customerStoreId)
          : null))
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
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const requestId = randomUUID();
  try {
    const name = input.name.trim();
    const email = input.email.toLowerCase().trim();
    if (!name || !email || !input.password) {
      return { ok: false, error: 'Enter your name, email address, and password to continue.' };
    }
    if (input.password.length < 8) {
      return { ok: false, error: 'Choose a password with at least 8 characters.' };
    }

    const users = new UserRepository();
    const existing = await users.findByEmail(email);
    if (existing) {
      console.info('[auth.register] account already exists', { requestId, code: 'EMAIL_EXISTS' });
      return {
        ok: false,
        error: 'An account with this email already exists. Sign in or reset your password instead.',
      };
    }

    const customer = await StorefrontCustomerService.ensure({
      name,
      email,
      phone: input.phone?.trim() || '0700000000',
    });

    await users.create({
      email,
      password: input.password,
      name,
      phone: input.phone?.trim() || null,
      role: 'customer',
      customerStoreId: customer.id,
    });

    try {
      const container = getContainer();
      const company = await container.companySettings.ensureSeeded();
      await container.customers.ensureStorefrontCustomer(company.id, {
        name,
        email,
        phone: input.phone?.trim() || null,
      });
    } catch (error) {
      console.error('[auth.register] storefront customer sync failed', {
        requestId,
        code: 'CUSTOMER_SYNC_FAILED',
        error: describeAuthError(error),
      });
      // The linked trade record is repaired during account/checkout loading.
    }

    await signIn('credentials', {
      email,
      password: input.password,
      redirect: false,
    });

    return { ok: true };
  } catch (error) {
    console.error('[auth.register] account creation failed', {
      requestId,
      code: 'REGISTRATION_FAILED',
      error: describeAuthError(error),
    });
    if (error instanceof AuthError) {
      return {
        ok: false,
        error:
          'Your account was created, but we could not sign you in automatically. Please sign in with your new account.',
      };
    }
    if (isUniqueConstraintError(error)) {
      return {
        ok: false,
        error: 'An account with this email already exists. Sign in or reset your password instead.',
      };
    }
    return {
      ok: false,
      error: `We couldn't create your account right now. Please try again. If this continues, contact support with reference ${requestId}.`,
    };
  }
}

function describeAuthError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export async function loginAction(input: {
  email: string;
  password: string;
}): Promise<{ ok: true; role: string } | { ok: false; error: string }> {
  const requestId = randomUUID();
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input?.password === 'string' ? input.password : '';
  if (!email || !password) {
    return { ok: false, error: 'Enter both your email address and password.' };
  }
  if (!LOGIN_EMAIL_PATTERN.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }

  try {
    const users = new UserRepository();
    await users.ensureSuperAdminSeed();
    const verified = await users.verifyPassword(email, password);
    if (!verified) {
      return { ok: false, error: 'Email or password is incorrect. Please try again.' };
    }
    await signIn('credentials', {
      email,
      password,
      redirect: false,
    });
    // Prefer DB-verified role — auth() in the same request often lacks the new session cookie.
    const session = await auth();
    const role = verified.role || session?.user?.role || 'customer';
    return { ok: true, role };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, error: 'Email or password is incorrect. Please try again.' };
    }
    await recordApplicationError({
      source: 'auth-action',
      errorName: err instanceof Error ? err.name : 'AuthenticationError',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      path: '/login',
      routeType: 'action',
      requestId,
      context: { operation: 'credentials_sign_in' },
    });
    return {
      ok: false,
      error: `We couldn't sign you in right now. Please try again. If this continues, contact support with reference ${requestId}.`,
    };
  }
}

export async function logoutAction(formData?: FormData): Promise<void> {
  try {
    await signOut({ redirect: false });
  } catch (error) {
    console.error(
      '[auth.logout] Auth.js sign-out failed; clearing session cookies directly',
      error,
    );
  }

  const cookieStore = await cookies();
  const legacyToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (legacyToken) {
    try {
      await getContainer().userSessions.deleteByToken(legacyToken);
    } catch (error) {
      console.error('[auth.logout] legacy session revocation failed', error);
    }
  }
  for (const cookie of cookieStore.getAll()) {
    if (
      cookie.name === SESSION_COOKIE ||
      cookie.name.includes('authjs.session-token') ||
      cookie.name.includes('next-auth.session-token')
    ) {
      cookieStore.delete(cookie.name);
    }
  }

  const returnTo = formData?.get('returnTo');
  redirect(returnTo === '/login' ? '/login' : '/');
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
