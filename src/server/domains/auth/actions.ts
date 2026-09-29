'use server';

import { AuthError, CredentialsSignin } from 'next-auth';
import { auth, EMAIL_NOT_VERIFIED_CODE, signIn, signOut } from '@/auth';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { isStaffRole } from '@/server/domains/auth/roles';
import { getContainer } from '@/server/di/container';
import type { UserSession, CustomerAccount } from '@/types/index';
import { SESSION_COOKIE } from './service';
import { StorefrontCustomerService } from '@/server/domains/customers/storefront-service';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { validatePassword } from '@/lib/passwordPolicy';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';

const LOGIN_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ActionResult = { ok: true } | { ok: false; error: string };

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Run account-email work once the response has been sent. Besides keeping SMTP
 * latency off the request, this makes "account exists" and "no such account"
 * indistinguishable by timing. Failures are reported, never surfaced.
 */
function afterResponse(action: string, work: () => Promise<void>): void {
  after(async () => {
    try {
      await work();
    } catch (error) {
      console.error(`[auth.${action}] background email failed`, describeAuthError(error));
      Sentry.captureException(error, { tags: { area: 'auth', action } });
    }
  });
}

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
    const hasSessionCookie = store.getAll().some((c) => isAuthSessionCookie(c.name));
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

/** Auth.js session cookies: plain, `__Secure-` prefixed (HTTPS) and chunked (`.0`, `.1`…). */
function isAuthSessionCookie(name: string): boolean {
  return name.includes('authjs.session-token') || name.includes('next-auth.session-token');
}

/**
 * Expire every session cookie the browser sent.
 *
 * A deletion must carry the attributes the cookie was set with. Browsers ignore
 * any Set-Cookie for a `__Secure-`/`__Host-` name that lacks `Secure` — and
 * behind HTTPS Auth.js names its cookie `__Secure-authjs.session-token`. A bare
 * `cookies().delete(name)` sends no `Secure`, so in production the deletion was
 * silently dropped (and it replaced Auth.js's own valid deletion), leaving users
 * signed in after "logout".
 */
async function expireSessionCookies(): Promise<void> {
  const store = await cookies();
  for (const { name } of store.getAll()) {
    if (name !== SESSION_COOKIE && !isAuthSessionCookie(name)) continue;
    const prefixed = name.startsWith('__Secure-') || name.startsWith('__Host-');
    store.set(name, '', {
      path: '/',
      expires: new Date(0),
      maxAge: 0,
      httpOnly: true,
      sameSite: 'lax',
      secure: prefixed || process.env.NODE_ENV === 'production',
    });
  }
}

async function clearStaleAuthSessionCookies(): Promise<void> {
  try {
    await expireSessionCookies();
  } catch {
    /* cookies() can throw outside a request — ignore */
  }
}

export async function registerCustomerAction(input: {
  name: string;
  email: string;
  phone?: string;
  password: string;
}): Promise<ActionResult> {
  const requestId = randomUUID();
  try {
    const name = input.name.trim();
    const email = input.email.toLowerCase().trim();
    if (!name || !email || !input.password) {
      return { ok: false, error: 'Enter your name, email address, and password to continue.' };
    }
    if (!LOGIN_EMAIL_PATTERN.test(email)) {
      return { ok: false, error: 'Enter a valid email address.' };
    }
    const passwordProblem = validatePassword(input.password);
    if (passwordProblem !== null) {
      return { ok: false, error: passwordProblem };
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

    const user = await users.create({
      email,
      password: input.password,
      name,
      phone: input.phone?.trim() || null,
      role: 'customer',
      customerStoreId: customer.id,
      emailVerified: false,
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

    // No session until the address is proven; the user signs in after verifying.
    afterResponse('register_verification_email', () =>
      getContainer().accounts.sendVerification(user),
    );

    return { ok: true };
  } catch (error) {
    console.error('[auth.register] account creation failed', {
      requestId,
      code: 'REGISTRATION_FAILED',
      error: describeAuthError(error),
    });
    if (isUniqueConstraintError(error)) {
      return {
        ok: false,
        error: 'An account with this email already exists. Sign in or reset your password instead.',
      };
    }
    // Unexpected failure swallowed by the graceful return, so report it explicitly.
    Sentry.captureException(error, {
      tags: { area: 'auth', action: 'register' },
      extra: { requestId },
    });
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
}): Promise<
  | { ok: true; role: string; mustChangePassword: boolean }
  | { ok: false; error: string; code?: 'EMAIL_NOT_VERIFIED' }
> {
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
    // The password is checked exactly once, in the Credentials provider's authorize().
    // bcrypt is deliberately slow, so checking it here as well would double every login's cost.
    await signIn('credentials', { email, password, redirect: false });
    // Role and flags come from an indexed lookup; no hashing, the password is already verified.
    const user = await new UserRepository().findByEmail(email);
    return {
      ok: true,
      role: user?.role ?? 'customer',
      mustChangePassword: user?.mustChangePassword === true,
    };
  } catch (err) {
    if (err instanceof CredentialsSignin && err.code === EMAIL_NOT_VERIFIED_CODE) {
      return {
        ok: false,
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Please confirm your email address first. Check your inbox for the link we sent.',
      };
    }
    if (err instanceof AuthError) {
      return { ok: false, error: 'Email or password is incorrect. Please try again.' };
    }
    Sentry.captureException(err, {
      tags: { area: 'auth', action: 'credentials_sign_in' },
      extra: { requestId },
    });
    return {
      ok: false,
      error: `We couldn't sign you in right now. Please try again. If this continues, contact support with reference ${requestId}.`,
    };
  }
}

/** Always reports success so the response never reveals whether the address is registered. */
export async function resendVerificationEmailAction(input: {
  email: string;
}): Promise<ActionResult> {
  const email = normalizeEmail(input.email);
  if (!LOGIN_EMAIL_PATTERN.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  afterResponse('resend_verification_email', () =>
    getContainer().accounts.resendVerification(email),
  );
  return { ok: true };
}

/** Always reports success so the response never reveals whether the address is registered. */
export async function requestPasswordResetAction(input: { email: string }): Promise<ActionResult> {
  const email = normalizeEmail(input.email);
  if (!LOGIN_EMAIL_PATTERN.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  afterResponse('password_reset_email', () => getContainer().accounts.requestPasswordReset(email));
  return { ok: true };
}

export async function verifyEmailAction(input: { token: string }): Promise<ActionResult> {
  const token = typeof input.token === 'string' ? input.token : '';
  try {
    const outcome = await getContainer().accounts.verifyEmail(token);
    if (outcome === 'invalid') {
      return {
        ok: false,
        error:
          'This confirmation link is invalid, has expired, or was already used. Sign in to request a new one.',
      };
    }
    return { ok: true };
  } catch (error) {
    const requestId = randomUUID();
    Sentry.captureException(error, {
      tags: { area: 'auth', action: 'verify_email' },
      extra: { requestId },
    });
    return {
      ok: false,
      error: `We couldn't confirm your email right now. Please try again. Reference ${requestId}.`,
    };
  }
}

export async function resetPasswordAction(input: {
  token: string;
  password: string;
}): Promise<ActionResult> {
  const token = typeof input.token === 'string' ? input.token : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const passwordProblem = validatePassword(password);
  if (passwordProblem !== null) {
    return { ok: false, error: passwordProblem };
  }
  try {
    const outcome = await getContainer().accounts.resetPassword(token, password);
    if (outcome === 'invalid') {
      return {
        ok: false,
        error: 'This reset link is invalid, has expired, or was already used. Request a new one.',
      };
    }
    return { ok: true };
  } catch (error) {
    const requestId = randomUUID();
    Sentry.captureException(error, {
      tags: { area: 'auth', action: 'reset_password' },
      extra: { requestId },
    });
    return {
      ok: false,
      error: `We couldn't reset your password right now. Please try again. Reference ${requestId}.`,
    };
  }
}

/**
 * Signed-in user replaces their password, e.g. the temporary one an admin set.
 * Re-signs in afterwards so the session token drops `mustChangePassword`.
 */
export async function changeOwnPasswordAction(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: true; role: string } | { ok: false; error: string }> {
  const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
  const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';

  const session = await auth();
  const email = session?.user.email;
  if (email === undefined || email === '') {
    return { ok: false, error: 'Your session has ended. Sign in again to continue.' };
  }
  const passwordProblem = validatePassword(newPassword);
  if (passwordProblem !== null) {
    return { ok: false, error: passwordProblem };
  }
  if (newPassword === currentPassword) {
    return { ok: false, error: 'Choose a new password that is different from the current one.' };
  }

  try {
    const users = new UserRepository();
    const verified = await users.verifyPassword(email, currentPassword);
    if (!verified) {
      return { ok: false, error: 'Your current password is incorrect.' };
    }
    await users.setPassword(verified.id, newPassword);
    await signIn('credentials', { email, password: newPassword, redirect: false });
    return { ok: true, role: verified.role };
  } catch (error) {
    const requestId = randomUUID();
    Sentry.captureException(error, {
      tags: { area: 'auth', action: 'change_password' },
      extra: { requestId },
    });
    return {
      ok: false,
      error: `We couldn't change your password right now. Please try again. Reference ${requestId}.`,
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
      Sentry.captureException(error, { tags: { area: 'auth', action: 'logout_revoke' } });
    }
  }
  await expireSessionCookies();

  const returnTo = formData?.get('returnTo');
  redirect(returnTo === '/login' ? '/login' : '/');
}

/**
 * @deprecated Removed. This used to create a session for any customer from just
 * an email, phone or customer id — no password — which let anyone open any
 * shopper's account. Kept only so stale clients get a clear error.
 */
export async function customerLoginAction(
  _identifierOrInput: string | { identifier: string; name?: string; phone?: string },
  _name?: string,
  _phone?: string,
): Promise<{ session: UserSession; customer: CustomerAccount }> {
  throw new Error('Please sign in with your email and password.');
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
