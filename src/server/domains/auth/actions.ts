'use server';

import { cookies } from 'next/headers';
import { db } from '@/server/db/store';
import { AuthService, SESSION_COOKIE } from './service';
import type { UserSession, CustomerAccount } from '@/types/index';

async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function getSessionAction(): Promise<{
  session: UserSession;
  customer: CustomerAccount | null;
}> {
  let session = await AuthService.getSessionFromCookies();
  if (!session) {
    session = AuthService.createSession('customer');
    await setSessionCookie(session.token);
  }
  const customer =
    db.getCustomerById(session.userId) || db.getCustomerByEmailOrPhone(session.email) || null;
  return { session, customer };
}

export async function switchRoleAction(role: 'admin' | 'customer'): Promise<{
  session: UserSession;
  customer: CustomerAccount | null;
}> {
  const targetRole = role === 'admin' ? 'admin' : 'customer';
  const targetName = targetRole === 'admin' ? 'Admin Paul' : 'Paul Laster Okoth';
  const targetEmail =
    targetRole === 'admin' ? 'admin@omnicommerce.ke' : 'paullasterokoth98@gmail.com';
  const targetPhone = targetRole === 'admin' ? '0700000000' : '0712345678';

  const session = AuthService.createSession(targetRole, targetEmail, targetName, targetPhone);
  await setSessionCookie(session.token);

  const customer =
    targetRole === 'customer'
      ? db.getCustomerById(session.userId) || db.getCustomerByEmailOrPhone(targetEmail) || null
      : null;

  return { session, customer };
}

export async function customerLoginAction(
  identifierOrInput: string | { identifier: string; name?: string; phone?: string },
  name?: string,
  phone?: string,
): Promise<{ session: UserSession; customer: CustomerAccount }> {
  const input =
    typeof identifierOrInput === 'string'
      ? { identifier: identifierOrInput, name, phone }
      : identifierOrInput;
  const { identifier } = input;
  if (!identifier) throw new Error('Email, phone, or Customer ID is required.');

  let customer = db.getCustomerByEmailOrPhone(identifier) || db.getCustomerById(identifier);
  if (!customer) {
    const isEmail = identifier.includes('@');
    customer = db.createCustomer({
      name: input.name || (isEmail ? identifier.split('@')[0] : 'Kenyan Shopper'),
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
  await setSessionCookie(session.token);
  return { session, customer };
}

export async function ensureAdminSessionAction(): Promise<UserSession> {
  const existing = await AuthService.getSessionFromCookies();
  if (existing?.role === 'admin' || existing?.role === 'manager') {
    return existing;
  }
  const session = AuthService.createSession(
    'admin',
    'admin@omnicommerce.ke',
    'Admin Paul',
    '0700000000',
  );
  await setSessionCookie(session.token);
  return session;
}
