'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Copy, Share2 } from 'lucide-react';
import { createWishlistShareAction } from '@/server/domains/wishlist/actions';

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function ShareWishlistButton({ ids }: { ids: string[] }) {
  const [token, setToken] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const createLink = async () => {
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const result = await createWishlistShareAction(ids);
      if (!result.ok) {
        setMessage(result.error);
        setFailed(true);
        return;
      }
      setToken(result.data.token);
      setUrl(new URL(`/wishlist/shared/${result.data.token}`, window.location.origin).href);
      setMessage('Your private share link is ready. Share it or copy it below.');
    } catch {
      setMessage('The share link could not be created. Please try again.');
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const shareLink = () => {
    if (url === null) return;
    if (typeof navigator.share === 'function') {
      void navigator
        .share({ title: 'My saved products', url })
        .then(() => setMessage('Your wishlist was shared.'))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setMessage('The share sheet is unavailable. Copy the link instead.');
        });
      return;
    }
    void copyLink(url);
  };

  const copyLink = async (address = url) => {
    if (address === null) return;
    try {
      await copyText(address);
      setMessage('Wishlist link copied. It works on any device for 30 days.');
      setFailed(false);
    } catch {
      const field = document.getElementById('wishlist-share-url');
      if (field instanceof HTMLInputElement) {
        field.focus();
        field.select();
      }
      setMessage('Copy did not work. Select the link above and copy it.');
      setFailed(true);
    }
  };

  return (
    <div className="space-y-2">
      {token === null ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void createLink()}
          className="inline-flex min-h-11 min-w-11 touch-manipulation items-center gap-2 rounded-lg border border-line px-3 text-sm font-medium text-fg-strong hover:bg-hover disabled:cursor-wait disabled:opacity-60"
        >
          <Share2 className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Creating link…' : 'Create share link'}
        </button>
      ) : (
        <div className="space-y-2 rounded-xl border border-line bg-surface-raised p-3">
          <label htmlFor="wishlist-share-url" className="block text-sm font-medium text-fg-strong">
            Shareable wishlist link
          </label>
          <input
            id="wishlist-share-url"
            value={url ?? ''}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-11 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-sm text-fg-strong"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={shareLink}
              className="inline-flex min-h-11 touch-manipulation items-center gap-2 rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              <Share2 className="h-4 w-4" aria-hidden="true" />
              Share wishlist
            </button>
            <button
              type="button"
              onClick={() => void copyLink()}
              className="inline-flex min-h-11 touch-manipulation items-center gap-2 rounded-lg border border-line px-3 text-sm font-medium text-fg-strong hover:bg-hover"
            >
              <Copy className="h-4 w-4" aria-hidden="true" />
              Copy link
            </button>
          </div>
          <p className="text-xs text-fg-muted">
            Anyone with this private link can see your saved products for 30 days.
          </p>
        </div>
      )}
      {message === null ? null : (
        <p role={failed ? 'alert' : 'status'} className="text-sm text-fg-muted">
          {message}
          {failed && token === null && message.startsWith('Sign in') ? (
            <>
              {' '}
              <Link
                href="/login?callbackUrl=%2Fwishlist"
                className="font-semibold text-indigo-600 underline"
              >
                Sign in
              </Link>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}
