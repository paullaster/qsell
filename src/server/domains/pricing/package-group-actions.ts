'use server';

import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { isWellFormedGroupToken } from '@/lib/group-order';
import { parsePackageLine } from './domain/package-shop-input';
import type { GroupCart, GroupView } from './package-group-service';
import type { ShopResult } from './package-shop-actions';

const fail = (error: unknown): { ok: false; error: string } => {
  console.error('[group order]', error);
  return { ok: false, error: 'Something went wrong. Please try again.' };
};

/** The signed-in shopper who would organise or manage a group, or null. */
async function organiser(): Promise<{ customerId: string; name: string } | null> {
  const session = await auth();
  const customerId = session?.user.customerStoreId ?? null;
  return customerId === null ? null : { customerId, name: session?.user.name ?? '' };
}

/** Turns away a visitor that is asking too often; returns the words to show, or null. */
async function limited(rule: 'group_create_ip' | 'group_view_ip' | 'group_entry_ip', token?: string): Promise<string | null> {
  const h = await headers();
  const c = getContainer();
  const byAddress = await c.rateLimits.hit(rule, clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  if (!byAddress.allowed) return waitMessage(byAddress.retryAfterSeconds);
  if (rule === 'group_entry_ip' && token !== undefined) {
    // The limit on a link is kept by a fingerprint of it, never by the link itself.
    const byLink = await c.rateLimits.hit('group_entry_link', createHash('sha256').update(token).digest('hex').slice(0, 24));
    if (!byLink.allowed) return waitMessage(byLink.retryAfterSeconds);
  }
  return null;
}

const badLink = { ok: false, error: 'This link is not valid.' } as const;
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A person's choice as the browser sends it: their name, the picks (ids and counts) and a note. Nothing about price. */
function readEntry(raw: unknown): { name: unknown; picks: ReturnType<typeof parsePackageLine> } {
  const r = obj(raw);
  return { name: r.name, picks: parsePackageLine({ productId: 'group', servings: 1, picks: r.picks, note: r.note }) };
}

/** A signed-in shopper starts a group order for a package; the link to share is returned (it is not shown again). */
export async function createGroupAction(raw: unknown): Promise<ShopResult<{ token: string }>> {
  const who = await organiser();
  if (who === null) return { ok: false, error: 'Please sign in to start a group order.' };
  const wait = await limited('group_create_ip');
  if (wait !== null) return { ok: false, error: wait };
  const r = obj(raw);
  if (typeof r.productId !== 'string' || r.productId.length === 0 || r.productId.length > 100) return { ok: false, error: 'Choose a package.' };
  try {
    const c = getContainer();
    const made = await c.packageGroups.create((await c.companySettings.ensureSeeded()).id, who, { productId: r.productId, title: r.title, forDate: r.forDate, closesAt: r.closesAt });
    return made.ok ? { ok: true, data: { token: made.token } } : { ok: false, error: made.error };
  } catch (error) {
    return fail(error);
  }
}

/** Anyone with the link: what the group order is, whether choices are taken, and (to the organiser only) who has chosen what. */
export async function groupViewAction(token: unknown): Promise<ShopResult<GroupView | null>> {
  if (!isWellFormedGroupToken(token)) return { ok: true, data: null };
  const wait = await limited('group_view_ip');
  if (wait !== null) return { ok: false, error: wait };
  try {
    const who = await organiser();
    return { ok: true, data: await getContainer().packageGroups.view(token, who?.customerId ?? null) };
  } catch (error) {
    return fail(error);
  }
}

/** Anyone with the link adds their own choice. They are given a secret to change or withdraw it. */
export async function addGroupEntryAction(token: unknown, raw: unknown): Promise<ShopResult<{ entryId: string; secret: string }>> {
  if (!isWellFormedGroupToken(token)) return badLink;
  const wait = await limited('group_entry_ip', token);
  if (wait !== null) return { ok: false, error: wait };
  const entry = readEntry(raw);
  if (entry.picks === null) return { ok: false, error: 'Your choice could not be read.' };
  try {
    const made = await getContainer().packageGroups.addEntry(token, { name: entry.name, picks: entry.picks.picks, note: entry.picks.note ?? '' });
    return made.ok ? { ok: true, data: { entryId: made.entryId, secret: made.secret } } : { ok: false, error: made.error };
  } catch (error) {
    return fail(error);
  }
}

/** The person who chose changes their choice, with the secret their browser holds. */
export async function updateGroupEntryAction(token: unknown, entryId: unknown, secret: unknown, raw: unknown): Promise<ShopResult<{ entryId: string }>> {
  if (!isWellFormedGroupToken(token) || typeof entryId !== 'string' || typeof secret !== 'string' || secret.length > 100) return badLink;
  const wait = await limited('group_entry_ip', token);
  if (wait !== null) return { ok: false, error: wait };
  const entry = readEntry(raw);
  if (entry.picks === null) return { ok: false, error: 'Your choice could not be read.' };
  try {
    const done = await getContainer().packageGroups.updateEntry(token, entryId, secret, { name: entry.name, picks: entry.picks.picks, note: entry.picks.note ?? '' });
    return done.ok ? { ok: true, data: { entryId: done.entryId } } : { ok: false, error: done.error };
  } catch (error) {
    return fail(error);
  }
}

/** A person withdraws their own choice (with their secret), or the organiser removes anyone's (signed in, no secret). */
export async function removeGroupEntryAction(token: unknown, entryId: unknown, secret?: unknown): Promise<ShopResult<null>> {
  if (!isWellFormedGroupToken(token) || typeof entryId !== 'string') return badLink;
  const wait = await limited('group_entry_ip', token);
  if (wait !== null) return { ok: false, error: wait };
  try {
    const groups = getContainer().packageGroups;
    if (typeof secret === 'string' && secret !== '') {
      const done = await groups.removeEntry(token, entryId, { secret: secret.slice(0, 100) });
      return done.ok ? { ok: true, data: null } : { ok: false, error: done.error };
    }
    const who = await organiser();
    if (who === null) return { ok: false, error: 'Please sign in as the organiser.' };
    const done = await groups.removeEntry(token, entryId, { organiserCustomerId: who.customerId });
    return done.ok ? { ok: true, data: null } : { ok: false, error: done.error };
  } catch (error) {
    return fail(error);
  }
}

/** The organiser opens, closes or cancels the group. */
export async function setGroupStatusAction(token: unknown, status: unknown): Promise<ShopResult<null>> {
  if (!isWellFormedGroupToken(token)) return badLink;
  if (status !== 'open' && status !== 'closed' && status !== 'cancelled') return { ok: false, error: 'That is not a state a group order can be in.' };
  const who = await organiser();
  if (who === null) return { ok: false, error: 'Please sign in as the organiser.' };
  try {
    const done = await getContainer().packageGroups.setStatus(token, who.customerId, status);
    return done.ok ? { ok: true, data: null } : { ok: false, error: done.error };
  } catch (error) {
    return fail(error);
  }
}

/** The organiser: everyone's choices as cart lines (identical ones joined), with whoever's choice cannot be made today named. Choosing stops. */
export async function groupToCartAction(token: unknown): Promise<ShopResult<GroupCart>> {
  if (!isWellFormedGroupToken(token)) return badLink;
  const who = await organiser();
  if (who === null) return { ok: false, error: 'Please sign in as the organiser.' };
  try {
    const done = await getContainer().packageGroups.forCart(token, who.customerId);
    return done.ok ? { ok: true, data: done.cart } : { ok: false, error: done.error };
  } catch (error) {
    return fail(error);
  }
}
