'use client';

import { Share2 } from 'lucide-react';
import { useToast } from '@/components/store/ToastProvider';

/** Shares the page with the phone's share sheet when there is one, else copies its address. */
export function ShareButton({ title }: { title: string }) {
  const toast = useToast();
  const share = async () => {
    const url = window.location.href;
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast({ type: 'success', title: 'Link copied', message: 'The address of this product is on your clipboard.' });
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast({ type: 'error', title: 'Could not share', message: 'Copy the address from your browser instead.' });
    }
  };
  return (
    <button type="button" onClick={() => void share()} className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium text-fg-muted hover:bg-hover hover:text-fg-strong">
      <Share2 className="h-4 w-4" aria-hidden="true" />
      Share
    </button>
  );
}
