// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineConfirm } from './InlineConfirm';

afterEach(cleanup);

describe('InlineConfirm', () => {
  it('asks first and does nothing until the second press', () => {
    const onConfirm = vi.fn();
    render(<InlineConfirm label="Delete dimension WH" action="Delete" confirm="Delete for good" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete dimension WH' }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm: Delete dimension WH' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Delete dimension WH' })).toBeTruthy();
  });

  it('puts everything back on "Keep it"', () => {
    const onConfirm = vi.fn();
    render(<InlineConfirm label="Delete dimension WH" action="Delete" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete dimension WH' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete dimension WH' })).toBeTruthy();
  });

  it('cannot be started while busy', () => {
    render(<InlineConfirm label="Delete x" action="Delete" busy onConfirm={() => undefined} />);
    expect((screen.getByRole('button', { name: 'Delete x' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
