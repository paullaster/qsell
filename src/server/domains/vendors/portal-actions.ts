'use server';

import { after } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';
import { UserRepository } from '@/server/domains/auth/user-repository';
import { validatePassword } from '@/lib/passwordPolicy';
import { checkRegistration, type VendorRegistration } from '@/lib/vendor-forms';
import { has } from '@/lib/values';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { PortalAccessError } from './portal-session';
import { portal } from './portal-runner';

type Result = { ok: true } | { ok: false; error: string };

/**
 * A vendor business signs up (docs/architecture/vendor-management-module.md §5.2). Open to anyone; nothing is visible to the
 * vendor until staff review its profile. The answer is the same whether or not the address already has an account, so the
 * form cannot be used to find out who is registered: an existing unverified address is mailed its link again, anything else
 * existing is left alone.
 */
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
    return {
      legalName: found.legalName,
      status: found.status,
      block: found.block,
      number: found.number,
      yourName: me.name,
      yourRole: me.portalRole,
      sections: profile?.statuses ?? null,
    };
  });
}
