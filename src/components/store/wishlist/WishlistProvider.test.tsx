// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WISHLIST_KEY } from '@/lib/wishlist';

const { wishlistIdsAction, setWishlistAction, mergeWishlistAction } = vi.hoisted(() => ({
  wishlistIdsAction: vi.fn(),
  setWishlistAction: vi.fn(),
  mergeWishlistAction: vi.fn(),
}));

vi.mock('@/server/domains/wishlist/actions', () => ({
  wishlistIdsAction,
  setWishlistAction,
  mergeWishlistAction,
}));
vi.mock('@/components/store/StoreContext', () => ({
  useStore: () => ({ sessionName: 'Signed-in shop user' }),
}));
vi.mock('@/components/store/ToastProvider', () => ({ useToast: () => vi.fn() }));

const { WishlistProvider } = await import('./WishlistProvider');
const { WishlistButton } = await import('./WishlistButton');

beforeEach(() => {
  window.localStorage.clear();
  wishlistIdsAction.mockReset().mockResolvedValue({ ok: true, data: null });
  setWishlistAction.mockReset();
  mergeWishlistAction.mockReset();
});

describe('WishlistProvider', () => {
  it('keeps a signed-in non-customer session usable as a local guest wishlist', async () => {
    render(
      <WishlistProvider>
        <WishlistButton product={{ id: 'product-1', name: 'Rice 5kg' }} />
      </WishlistProvider>,
    );
    const save = screen.getByRole('button', { name: 'Save Rice 5kg for later' });
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.click(save);

    await waitFor(() => expect(save).toHaveAttribute('aria-pressed', 'true'));
    expect(JSON.parse(window.localStorage.getItem(WISHLIST_KEY) ?? '[]')).toEqual(['product-1']);
    expect(setWishlistAction).not.toHaveBeenCalled();
    expect(mergeWishlistAction).not.toHaveBeenCalled();
  });
});
