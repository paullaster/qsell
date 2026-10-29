'use client';

import { Share2 } from 'lucide-react';
import { useToast } from '@/components/store/ToastProvider';

async function copyAddress(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
}

/** Shares the page with the phone's share sheet when there is one, else copies its address. */
export function ShareButton({ title }: { title: string }) {
  const toast = useToast();
  const share = async () => {
    const url = window.location.href;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        // Closing the share sheet is not a failure; other share-sheet failures fall back to copy.
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    try {
      await copyAddress(url);
      toast({
        type: 'success',
        title: 'Link copied',
        message: 'The address of this product is on your clipboard.',
      });
    } catch {
      toast({
        type: 'error',
        title: 'Could not share',
        message: 'Use your browser address bar to copy the product link.',
      });
    }
  };
  return (
    <button
      type="button"
      onClick={() => void share()}
      className="inline-flex min-h-11 min-w-11 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-fg-muted hover:bg-hover hover:text-fg-strong"
    >
      <Share2 className="h-4 w-4" aria-hidden="true" />
      Share
    </button>
  );
}
