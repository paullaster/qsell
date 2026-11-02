'use server';

import { after } from 'next/server';
import { headers } from 'next/headers';
import * as Sentry from '@sentry/nextjs';
import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';
import { validatePassword } from '@/lib/passwordPolicy';
import { checkRegistration, type VendorRegistration } from '@/lib/vendor-forms';
import { has } from '@/lib/values';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { PortalAccessError } from './portal-session';
import { portal } from './portal-runner';
import { auth } from '@/auth';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { findPortalAccess } from './portal-access';

type Result = { ok: true } | { ok: false; error: string };

/** A signed-in customer can also register a vendor business without creating a duplicate login. */
export async function registerVendorBusinessForCurrentAccountAction(raw: unknown): Promise<Result> {
  try {
    const session = await auth();
    const actor = session?.user;
    if (actor === undefined || actor.isStaff || actor.role !== 'customer') {
      return { ok: false, error: 'Sign in to a verified customer account to register a vendor business.' };
    }
    const current = await new UserRepository().findById(actor.id);
    if (current?.role !== 'customer' || !current.isActive || current.emailVerifiedAt === null) {
      return { ok: false, error: 'This qsell account cannot register a vendor business. Sign in with a verified customer account or ask the buyer for an invitation.' };
    }
    if (await findPortalAccess(current.id) !== null) return { ok: false, error: 'This account already has access to a vendor business. Open the vendor portal or ask the buyer to invite a separate vendor account.' };
    const form = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const legalName = typeof form.legalName === 'string' ? form.legalName.trim() : '';
    const phone = typeof form.phone === 'string' ? form.phone.trim() : '';
    if (legalName.length < 2 || legalName.length > 200) return { ok: false, error: 'Enter the legal name of your business (2–200 characters).' };
    if (phone !== '' && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return { ok: false, error: 'Enter a phone number with 7 to 20 digits.' };
    const company = await getContainer().companySettings.ensureSeeded();
    await getContainer().vendors.registerBusiness({ companyId: company.id, userId: current.id, legalName, email: current.email, phone: phone === '' ? current.phone : phone });
    return { ok: true };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, error: 'This business is already registered. Sign in to the linked vendor account or contact the buyer for help.' };
    console.error('[vendor.register.existing_account]', error);
    return { ok: false, error: 'We could not register this vendor business just now. Please try again or ask the buyer for an invitation.' };
  }
}

/** A supplier can create a vendor business here; this is separate from customer registration and buyer invitations. */
export async function registerVendorAction(input: VendorRegistration): Promise<Result> {
  const requestId = randomUUID();
  try {
    // The browser's values are never trusted to be the right type.
    const raw = input as Partial<Record<keyof VendorRegistration, unknown>> | null;
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const form: VendorRegistration = {
      legalName: text(raw?.legalName),
      contactName: text(raw?.contactName),
      email: text(raw?.email),
      phone: text(raw?.phone),
      password: text(raw?.password),
    };
    const problems = checkRegistration(form, validatePassword(form.password));
    const first = Object.values(problems)[0];
    if (has(first)) return { ok: false, error: first };
    const h = await headers();
    const verdict = await getContainer().rateLimits.hit('register_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
    if (!verdict.allowed) return { ok: false, error: waitMessage(verdict.retryAfterSeconds) };

    const email = form.email.trim().toLowerCase();
    const users = new UserRepository();
    const existing = await users.findByEmail(email);
    if (existing !== null) {
      if (existing.emailVerifiedAt === null) {
        after(async () => {
          try {
            await getContainer().accounts.resendVerification(email);
          } catch (error) {
            console.error('[vendor.register] resend failed', error);
          }
        });
      }
      return { ok: true };
    }

    const container = getContainer();
    const company = await container.companySettings.ensureSeeded();
    const user = await users.create({
      email,
      password: form.password,
      name: form.contactName.trim(),
      phone: has(form.phone) ? form.phone.trim() : null,
      role: 'vendor',
      emailVerified: false,
    });
    try {
      await container.vendors.registerBusiness({ companyId: company.id, userId: user.id, legalName: form.legalName, email, phone: has(form.phone) ? form.phone.trim() : null });
    } catch (error) {
      // A login without a business is useless and could never sign in: take it back so the address can try again.
      await users.deleteUnverified(user.id).catch(() => undefined);
      throw error;
    }
    after(async () => {
      try {
        await container.accounts.sendVerification(user);
      } catch (error) {
        console.error('[vendor.register] verification email failed', error);
        Sentry.captureException(error, { tags: { area: 'vendor', action: 'register_email' } });
      }
    });
    return { ok: true };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: true };
    console.error('[vendor.register] failed', { requestId, error });
    Sentry.captureException(error, { tags: { area: 'vendor', action: 'register' }, extra: { requestId } });
    return { ok: false, error: `We couldn't create your account right now. Please try again. If this continues, contact support with reference ${requestId}.` };
  }
}

/** What the vendor's dashboard shows: the business, where it stands, and what it still has to do. */
export async function portalOverviewAction() {
  return await portal('overview', async (me) => {
    const container = getContainer();
    const found = await container.vendors.portalView(me.vendorId);
    if (found === null) throw new PortalAccessError();
    const profile = await container.vendorProfile.statuses(me.companyId, me.vendorId);
    const company = await container.companySettings.ensureSeeded();
    const standing = await container.vendorLifecycle.standing(me.companyId, me.vendorId);
    return {
      legalName: found.legalName,
      status: found.status,
      block: found.block,
      number: found.number,
      yourName: me.name,
      yourRole: me.portalRole,
      supportEmail: company.email,
      standingReason: standing?.reasonText ?? null,
      sections: profile?.statuses ?? null,
    };
  });
}
