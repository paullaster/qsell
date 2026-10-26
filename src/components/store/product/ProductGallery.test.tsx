// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The picture itself is not under test; a plain image keeps the test about what the gallery does.
vi.mock('@/components/ui/AppImage', () => ({
  // eslint-disable-next-line @next/next/no-img-element -- stands in for next/image
  AppImage: ({ src, alt, className }: { src?: string | null; alt: string; className?: string }) => <img src={src ?? ''} alt={alt} className={className} />,
}));
import { nth, required } from '@/lib/values';
import { ProductGallery } from './ProductGallery';

afterEach(cleanup);

const images = ['/a.jpg', '/b.jpg', '/c.jpg'];

describe('ProductGallery', () => {
  it('shows the picture whole (contained, never cropped) and says which one is chosen', () => {
    render(<ProductGallery images={images} name="Rice" />);
    const main = screen.getAllByRole('img', { name: 'Rice' })[0];
    expect(main?.getAttribute('src')).toBe('/a.jpg');
    expect(main?.className).toContain('object-contain');
    expect(main?.className).not.toContain('object-cover');
    expect(screen.getByRole('button', { name: 'Show picture 1 of 3' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('chooses another picture from the small ones', () => {
    render(<ProductGallery images={images} name="Rice" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show picture 3 of 3' }));
    expect(screen.getAllByRole('img', { name: 'Rice' })[0]?.getAttribute('src')).toBe('/c.jpg');
    expect(screen.getByRole('button', { name: 'Show picture 3 of 3' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows no row of small pictures for one picture', () => {
    render(<ProductGallery images={['/a.jpg']} name="Rice" />);
    expect(screen.queryByRole('list', { name: 'Pictures of Rice' })).toBeNull();
  });

  it('says there is no picture instead of showing nothing', () => {
    render(<ProductGallery images={[]} name="Rice" />);
    expect(screen.getByRole('img', { name: 'No picture available' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /full size/ })).toBeNull();
  });

  it('opens the full-size viewer as a dialog, moves between pictures with the keys, zooms, and closes with Escape', () => {
    render(<ProductGallery images={images} name="Rice" />);
    fireEvent.click(screen.getByRole('button', { name: 'View Rice full size' }));
    const dialog = screen.getByRole('dialog', { name: 'Pictures of Rice' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('1 of 3')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByText('2 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous picture' }));
    expect(screen.getByText('3 of 3')).toBeTruthy(); // wraps round

    const zoom = screen.getByRole('button', { name: 'Zoom in' });
    fireEvent.click(zoom);
    expect(screen.getByRole('button', { name: 'Zoom out' }).getAttribute('aria-pressed')).toBe('true');
    // Changing picture starts unzoomed again.
    fireEvent.click(screen.getByRole('button', { name: 'Next picture' }));
    expect(screen.getByRole('button', { name: 'Zoom in' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a swipe by touch changes the picture, a short touch does not', () => {
    render(<ProductGallery images={images} name="Rice" />);
    const box = required(nth(screen.getAllByRole('img', { name: 'Rice' }), 0).parentElement, 'the picture box');
    fireEvent.pointerDown(box, { pointerType: 'touch', clientX: 300 });
    fireEvent.pointerUp(box, { clientX: 290 });
    expect(screen.getByRole('button', { name: 'Show picture 1 of 3' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.pointerDown(box, { pointerType: 'touch', clientX: 300 });
    fireEvent.pointerUp(box, { clientX: 200 });
    expect(screen.getByRole('button', { name: 'Show picture 2 of 3' }).getAttribute('aria-pressed')).toBe('true');
  });
});
