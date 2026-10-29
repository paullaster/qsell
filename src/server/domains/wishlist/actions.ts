'use server';

import { auth } from '@/auth';
import { WishlistService } from './service';
import { WISHLIST_MAX } from '@/lib/wishlist';
import { createWishlistShareToken } from './share-token';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** The signed-in shopper's id; staff and vendors have no wishlist. Null when nobody (or not a shopper) is signed in. */
async function shopper(): Promise<string | null> {
  try {
    const user = (await auth())?.user;
    return user?.role === 'customer' ? user.id : null;
  } catch {
    return null;
  }
}

const idOf = (raw: unknown): string | null =>
  typeof raw === 'string' && raw !== '' && raw.length <= 100 ? raw : null;

/** The saved product ids of the signed-in shopper, or null for a guest (whose list is kept in the browser). */
export async function wishlistIdsAction(): Promise<Result<string[] | null>> {
  const who = await shopper();
  if (who === null) return { ok: true, data: null };
  try {
    return { ok: true, data: await WishlistService.ids(who) };
  } catch (error) {
    console.error('[wishlist] list', error);
    return { ok: false, error: 'Your saved products could not be loaded.' };
  }
}

export async function setWishlistAction(raw: unknown): Promise<Result<string[]>> {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const productId = idOf(input.productId);
  const who = await shopper();
  if (who === null) return { ok: false, error: 'Please sign in to save products to your account.' };
  if (productId === null || typeof input.on !== 'boolean')
    return { ok: false, error: 'That product could not be saved.' };
  try {
    await WishlistService.set(who, productId, input.on);
    return { ok: true, data: await WishlistService.ids(who) };
  } catch (error) {
    console.error('[wishlist] set', error);
    return { ok: false, error: 'That could not be saved. Please try again.' };
  }
}

/** After sign-in: what the shopper saved as a guest joins their account's list. */
export async function mergeWishlistAction(raw: unknown): Promise<Result<string[]>> {
  const who = await shopper();
  if (who === null) return { ok: false, error: 'Please sign in first.' };
  const ids = Array.isArray(raw)
    ? raw
        .map(idOf)
        .filter((id): id is string => id !== null)
        .slice(0, WISHLIST_MAX)
    : [];
  try {
    return { ok: true, data: await WishlistService.merge(who, ids) };
  } catch (error) {
    console.error('[wishlist] merge', error);
    return { ok: false, error: 'Your saved products could not be updated.' };
  }
}

/** Creates an expiring public link for the signed-in shopper's current saved list. */
export async function createWishlistShareAction(
  rawGuestIds: unknown,
): Promise<Result<{ token: string }>> {
  const who = await shopper();
  if (who === null) {
    return {
      ok: false,
      error: 'Sign in with a customer account to create a wishlist link for other devices.',
    };
  }

  if (!Array.isArray(rawGuestIds)) {
    return { ok: false, error: 'Your saved products could not be prepared for sharing.' };
  }
  const guestIds = rawGuestIds
    .map(idOf)
    .filter((id): id is string => id !== null)
    .slice(0, WISHLIST_MAX);

  try {
    // A guest list held on this device joins the account before a cross-device link is issued.
    await WishlistService.merge(who, guestIds);
    const ids = await WishlistService.ids(who);
    if (ids.length === 0)
      return { ok: false, error: 'Save at least one product before sharing your wishlist.' };

    const secret = process.env.AUTH_SECRET;
    if (secret === undefined || secret === '') {
      return {
        ok: false,
        error: 'Wishlist sharing is temporarily unavailable. Please try again later.',
      };
    }
    const created = createWishlistShareToken(who, new Date(), secret);
    return { ok: true, data: { token: created.token } };
  } catch (error) {
    console.error('[wishlist] share', error);
    return { ok: false, error: 'Your wishlist link could not be created. Please try again.' };
  }
}
