'use server';

import { cookies } from 'next/headers';
import { auth } from '@/auth';
import { UserRepository } from '@/server/domains/auth/user-repository';
import {
  DEFAULT_THEME_MODE,
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  isThemeMode,
  normalizeThemeMode,
  type ThemeMode,
} from '@/config/theme';

/**
 * The mode to render with, preferring the cookie and falling back to the signed
 * in account's stored preference (so a choice made on another device is picked
 * up on first visit) and finally the app default.
 */
export async function getThemeModeAction(): Promise<ThemeMode> {
  try {
    const stored = (await cookies()).get(THEME_COOKIE_NAME)?.value;
    if (isThemeMode(stored)) return stored;
  } catch {
    /* cookies() throws outside a request — fall through to the account */
  }

  try {
    const session = await auth();
    const userId = session?.user.id;
    if (userId !== undefined) {
      const user = await new UserRepository().findById(userId);
      if (user?.themeMode != null && isThemeMode(user.themeMode)) return user.themeMode;
    }
  } catch {
    /* anonymous visitor — use the default */
  }

  return DEFAULT_THEME_MODE;
}

/**
 * Persist a scheme choice: always to the cookie (so the next request renders
 * the right tokens immediately) and, when signed in, to the account as well.
 */
export async function setThemeModeAction(mode: ThemeMode): Promise<{ ok: true }> {
  if (!isThemeMode(mode)) {
    throw new Error('Unsupported theme mode.');
  }
  const resolved = normalizeThemeMode(mode);

  try {
    (await cookies()).set(THEME_COOKIE_NAME, resolved, {
      path: '/',
      sameSite: 'lax',
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      maxAge: THEME_COOKIE_MAX_AGE,
    });
  } catch {
    /* ignore — the optimistic client-side update still applies for this page */
  }

  try {
    const session = await auth();
    const userId = session?.user.id;
    if (userId !== undefined) await new UserRepository().setThemeMode(userId, resolved);
  } catch {
    /* guests keep the cookie only */
  }

  return { ok: true };
}
