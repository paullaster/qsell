// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SwapSummary } from '@/server/domains/quotes/template-swap-service';
import { TemplateSwapDialog } from './TemplateSwapDialog';

afterEach(cleanup);

const form = { customerName: 'x', lines: [], sections: [] } as never;
const summary = (over: Partial<SwapSummary> = {}): SwapSummary => ({
  kind: 'replace',
  replacedLines: 2,
  replacedSections: 0,
  additions: { items: [], sections: [] },
  edited: [],
  keep: form,
  drop: form,
  toName: 'Pack 10kg',
  fromName: 'Pack 5kg',
  ...over,
});

const setup = (
  s: SwapSummary,
  extra: { scope?: 'quote' | 'section'; sectionName?: string } = {},
) => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<TemplateSwapDialog summary={s} onConfirm={onConfirm} onClose={onClose} {...extra} />);
  return { onConfirm, onClose };
};

describe('the template switch dialog', () => {
  it('is an alert dialog named by its title, with focus on the confirm button', () => {
    setup(summary());
    const dialog = screen.getByRole('alertdialog', { name: /Switch to “Pack 10kg”/ });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch template' })).toHaveFocus();
  });

  it('says what is replaced when the quote came from a template', () => {
    setup(summary());
    expect(screen.getByText(/came from “Pack 5kg”/)).toBeInTheDocument();
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('warns that a quote with no template has its items replaced', () => {
    setup(summary({ kind: 'manual', fromName: null }));
    expect(screen.getByText(/not built from a template/)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('names the items the person changed, which are replaced too', () => {
    setup(summary({ edited: [{ key: 'a', name: 'Rice 5kg' }] }));
    expect(screen.getByText(/1 item you changed will be replaced too/)).toBeInTheDocument();
    expect(screen.getByText('Rice 5kg')).toBeInTheDocument();
  });

  it('asks what to do with additions, keeps them by default, and passes the choice on', async () => {
    const { onConfirm } = setup(
      summary({
        kind: 'additions',
        additions: {
          items: [{ key: 'i', name: 'Salt' }],
          sections: [{ key: 's', title: 'Extras', items: 2 }],
        },
      }),
    );
    expect(screen.getByText(/You added 2 things that are not in the template/)).toBeInTheDocument();
    expect(screen.getByText('Salt')).toBeInTheDocument();
    expect(screen.getByText('Section: Extras (2 items)')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Keep them on the quote' })).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Switch template' }));
    expect(onConfirm).toHaveBeenLastCalledWith(true);

    await userEvent.click(screen.getByRole('radio', { name: 'Remove them' }));
    await userEvent.click(screen.getByRole('button', { name: 'Switch template' }));
    expect(onConfirm).toHaveBeenLastCalledWith(false);
  });

  it('never keeps anything when there is nothing to ask', async () => {
    const { onConfirm } = setup(summary());
    await userEvent.click(screen.getByRole('button', { name: 'Switch template' }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('is worded for a section when it switches one', () => {
    setup(summary({ kind: 'replace', toName: 'Tea set', fromName: 'Baking set' }), {
      scope: 'section',
      sectionName: 'Baking',
    });
    expect(
      screen.getByRole('alertdialog', { name: /Switch section “Baking” to “Tea set”/ }),
    ).toBeInTheDocument();
  });

  it('says "no template" when the template is being removed', () => {
    setup(summary({ toName: null }));
    expect(screen.getByRole('alertdialog', { name: /Switch to no template/ })).toBeInTheDocument();
  });

  it('cancels with the button, the close icon and Escape', async () => {
    const { onClose } = setup(summary());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
