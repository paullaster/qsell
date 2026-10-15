import { Suspense, type ReactNode } from 'react';
import { PageSkeleton } from '@/components/ui/screen-kit';

/**
 * A settings screen's frame. It returns at once with a loading state for this screen; the screen's
 * own data (started by the page before this renders) fills it in as it arrives, so nothing waits
 * on anything else.
 */
export function SettingsFrame({ label, children }: { label: string; children: ReactNode }) {
  return <Suspense fallback={<PageSkeleton label={label} />}>{children}</Suspense>;
}
