'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

interface NavigationApi {
  canGoBack?: boolean;
}

/** Whether there is an earlier page of this app to return to. */
function canReturn(): boolean {
  // Where the browser can tell us (it counts in-app moves too), ask it.
  const navigation = (window as { navigation?: NavigationApi }).navigation;
  if (navigation?.canGoBack !== undefined) return navigation.canGoBack;
  // Otherwise the page that opened this one must have been ours.
  return (
    window.history.length > 1 &&
    document.referrer !== '' &&
    new URL(document.referrer).origin === window.location.origin
  );
}

/**
 * Takes the person back to where they came from: the Business Overview, the Reports list, or another report. When the page was
 * opened directly (a bookmark, a shared link, a new tab) there is nothing to go back to inside the app, so it goes to the list.
 */
export function BackButton({ fallbackHref = '/admin/reports' }: { fallbackHref?: string }) {
  const router = useRouter();
  const goBack = () => {
    if (canReturn()) router.back();
    else router.push(fallbackHref);
  };
  return (
    <button
      type="button"
      onClick={goBack}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-semibold text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-indigo-500"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back
    </button>
  );
}
