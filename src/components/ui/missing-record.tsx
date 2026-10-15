import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

/** True when an action's answer says the record asked for is not there (NOT_FOUND, or a specific one such as ACCOUNT_NOT_FOUND). */
export const isMissing = (result: { ok: boolean; code?: string }): boolean => !result.ok && /(^|_)NOT_FOUND$/.test(result.code ?? '');

/**
 * Shows the not-found page when the record a detail screen was opened for does not exist, instead of an
 * error message inside a working-looking screen. It waits for the same answer the screen itself reads,
 * so nothing is fetched twice, and it sits inside the screen's loading frame so the page still draws at once.
 * (The page is already streaming by then, so the status stays 200; Next adds a noindex tag, which keeps it out of search.)
 */
export async function MissingAs404({ result, children }: { result: Promise<{ ok: boolean; code?: string }>; children: ReactNode }) {
  if (isMissing(await result)) notFound();
  return await children;
}
