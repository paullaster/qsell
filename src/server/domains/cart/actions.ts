'use server';

import { auth } from '@/auth';
import { ShopCartService } from './service';
import { isReminderToken, SERVER_CART_MAX_LINES, type ServerCartLine } from '@/lib/shop-cart';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** The signed-in shopper's account id; staff and vendors have no shop cart. Null when nobody (or not a shopper) is signed in. */
async function shopper(): Promise<string | null> {
  try {
    const user = (await auth())?.user;
    return user?.role === 'customer' ? user.id : null;
  } catch {
    return null;
  }
}

const bounded = (raw: unknown): unknown => (Array.isArray(raw) ? raw.slice(0, SERVER_CART_MAX_LINES * 3) : []);

/** The cart kept on the shopper's account, or null for a guest (whose cart stays in the browser). */
export async function serverCartAction(): Promise<Result<ServerCartLine[] | null>> {
  const who = await shopper();
  if (who === null) return { ok: true, data: null };
  try {
    return { ok: true, data: await ShopCartService.get(who) };
  } catch (error) {
    console.error('[cart] read', error);
    return { ok: false, error: 'Your saved cart could not be loaded.' };
  }
}

/** Keeps the account's cart as the browser now has it. */
export async function saveServerCartAction(raw: unknown): Promise<Result<ServerCartLine[]>> {
  const who = await shopper();
  if (who === null) return { ok: false, error: 'Please sign in to keep your cart on your account.' };
  try {
    return { ok: true, data: await ShopCartService.save(who, bounded(raw)) };
  } catch (error) {
    console.error('[cart] save', error);
    return { ok: false, error: 'Your cart could not be saved. Please try again.' };
  }
}

/** After sign-in: what was carried in the browser joins the account's cart, and the joined cart comes back. */
export async function mergeServerCartAction(raw: unknown): Promise<Result<ServerCartLine[]>> {
  const who = await shopper();
  if (who === null) return { ok: false, error: 'Please sign in first.' };
  try {
    return { ok: true, data: await ShopCartService.merge(who, bounded(raw)) };
  } catch (error) {
    console.error('[cart] merge', error);
    return { ok: false, error: 'Your cart could not be updated.' };
  }
}

/** The link in a reminder: the person presses the button, and no more reminders about a left cart are sent. */
export async function stopCartRemindersAction(token: unknown): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (!isReminderToken(token)) return { ok: false, error: 'This link is not valid.' };
  try {
    return (await ShopCartService.stopReminders(token))
      ? { ok: true, message: 'Done. We will not send you reminders about a cart you left.' }
      : { ok: false, error: 'This link is not valid.' };
  } catch (error) {
    console.error('[cart] stop reminders', error);
    return { ok: false, error: 'We could not do that just now. Please try again.' };
  }
}
