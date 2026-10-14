// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Modal } from './Modal';

function Stacked({ outer, inner }: { outer: () => void; inner: () => void }) {
  return (
    <Modal title="Outer" onClose={outer}>
      <Modal title="Inner" onClose={inner}>
        <input aria-label="Deep" />
      </Modal>
    </Modal>
  );
}

function Host({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button onClick={() => setTick((n) => n + 1)}>Rerender</button>
      {open && (
        <Modal title="Dialog" onClose={() => onClose()}>
          <input aria-label="Inside" />
        </Modal>
      )}
    </>
  );
}

describe('Modal focus', () => {
  afterEach(cleanup);
  it('keeps focus inside while the page re-renders with a new close callback', async () => {
    const user = userEvent.setup();
    render(<Host onClose={vi.fn()} />);
    await user.click(screen.getByText('Open'));
    const inside = screen.getByLabelText('Inside');
    inside.focus();
    // A re-render of the host gives the Modal a new onClose; focus must not jump back out.
    screen.getByText('Rerender').click();
    await Promise.resolve();
    expect(document.activeElement).toBe(inside);
  });

  it('closes on Escape using the newest callback', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<Host onClose={close} />);
    await user.click(screen.getByText('Open'));
    await user.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('lets only the dialog on top react to Escape', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();
    render(<Stacked outer={outer} inner={inner} />);
    await user.keyboard('{Escape}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
