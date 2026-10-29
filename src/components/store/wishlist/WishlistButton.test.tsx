// @vitest-environment jsdom

import { fireEvent, render, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toggle } = vi.hoisted(() => ({ toggle: vi.fn() }));

vi.mock('./WishlistProvider', () => ({
  useWishlist: () => ({ has: () => false, ready: true, toggle }),
}));

const { WishlistButton } = await import('./WishlistButton');
const product = { id: 'product-1', name: 'Rice 5kg' };

beforeEach(() => toggle.mockClear());

describe('WishlistButton', () => {
  it('handles a tap on the icon without activating the product-card link', () => {
    const parentClick = vi.fn();
    const view = render(
      <div onClick={parentClick}>
        <WishlistButton product={product} />
      </div>,
    );

    fireEvent.click(
      within(view.container).getByRole('button', { name: 'Save Rice 5kg for later' }),
    );

    expect(toggle).toHaveBeenCalledWith('product-1', 'Rice 5kg');
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('handles the text save button tap', () => {
    const view = render(<WishlistButton product={product} variant="text" />);

    fireEvent.click(
      within(view.container).getByRole('button', { name: 'Save Rice 5kg for later' }),
    );

    expect(toggle).toHaveBeenCalledWith('product-1', 'Rice 5kg');
  });
});
