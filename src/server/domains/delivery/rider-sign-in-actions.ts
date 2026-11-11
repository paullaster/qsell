'use server';

import { headers } from 'next/headers';
import { AuthError } from 'next-auth';
import { RiderPinLocked, signIn } from '@/auth';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { isPinShape, normalizePhone } from '@/lib/rider-pin';

export type RiderSignInResult = { ok: true } | { ok: false; error: string };

const WRONG = 'The phone number or PIN is not right.';

/**
 * A rider signs in with their phone number and PIN. Counted by address and by number before anything is checked, so many guesses from
 * many addresses at one rider's number run out as quickly as many from one. The answer to a wrong number and a wrong PIN is the same.
 */
export async function riderPinSignInAction(input: { phone?: unknown; pin?: unknown }): Promise<RiderSignInResult> {
  const phone = normalizePhone(input.phone);
  const pin = typeof input.pin === 'string' ? input.pin : '';
  if (phone === null) return { ok: false, error: 'Enter your Kenyan mobile number, like 0712 345 678.' };
  if (!isPinShape(pin)) return { ok: false, error: 'Your PIN is 6 digits.' };
  const h = await headers();
  const address = clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for'));
  let wait = 0;
  for (const t of [{ rule: 'rider_pin_ip' as const, subject: address }, { rule: 'rider_pin_phone' as const, subject: phone }]) {
    const verdict = await getContainer().rateLimits.hit(t.rule, t.subject);
    if (!verdict.allowed) wait = Math.max(wait, verdict.retryAfterSeconds);
  }
  if (wait > 0) return { ok: false, error: waitMessage(wait) };
  try {
    await signIn('rider-pin', { phone, pin, redirect: false });
    return { ok: true };
  } catch (error) {
    if (error instanceof RiderPinLocked) return { ok: false, error: `Too many wrong tries. Try again in ${error.words}, or ask the office to let you try again.` };
    if (error instanceof AuthError) return { ok: false, error: WRONG };
    console.error('[rider-sign-in]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
