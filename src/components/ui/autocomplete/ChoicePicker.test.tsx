// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChoicePicker } from './ChoicePicker';

const search = vi.hoisted(() => vi.fn());
vi.mock('@/server/domains/lookups/actions', () => ({ searchLookupAction: search }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

afterEach(() => {
  cleanup();
  search.mockReset();
});

const reply = (...options: { id: string; label: string; meta?: Record<string, string> }[]) => search.mockResolvedValue({ ok: true, data: { options, nextCursor: null } });

describe('the ChoicePicker', () => {
  it('shows the words of a chosen value before the list is ever opened, and asks the server for nothing', () => {
    render(<ChoicePicker label="Environment" source="provider-environments" choice={{ id: 'staging', label: 'Testing (sandbox)' }} onChoice={() => undefined} />);
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveValue('Testing (sandbox)');
    expect(search).not.toHaveBeenCalled();
  });

  it('asks the named list only when it is used, and hands back the id, the words and what the server said about the option', async () => {
    reply({ id: 'm1', label: 'E2E Cash', meta: { currency: 'KES', requiresReference: '1' } });
    const onChoice = vi.fn();
    render(<ChoicePicker label="Payment method" source="receipt-methods" choice={null} onChoice={onChoice} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Payment method' }));
    await userEvent.click(await screen.findByRole('option', { name: /E2E Cash/ }));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ source: 'receipt-methods' }));
    expect(onChoice).toHaveBeenCalledWith({ id: 'm1', label: 'E2E Cash', meta: { currency: 'KES', requiresReference: '1' } });
  });

  it('sends the filters it was given, and starts afresh when they change', async () => {
    reply({ id: 'a', label: 'Alpha' });
    const { rerender } = render(<ChoicePicker label="Operation" source="daraja-operations" filters={{ provider: 'p1' }} choice={null} onChoice={() => undefined} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Operation' }));
    await screen.findByRole('option', { name: 'Alpha' });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { provider: 'p1' } }));
    rerender(<ChoicePicker label="Operation" source="daraja-operations" filters={{ provider: 'p2' }} choice={null} onChoice={() => undefined} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Operation' }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { provider: 'p2' } })));
  });

  it('says so, in words, when the server refuses the list', async () => {
    search.mockResolvedValue({ ok: false, error: 'You do not have permission to see this list.' });
    render(<ChoicePicker label="Branch" source="branches" choice={null} onChoice={() => undefined} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Branch' }));
    expect(await screen.findByText(/permission to see this list/)).toBeInTheDocument();
  });

  it('can be cleared when clearing is allowed', async () => {
    const onChoice = vi.fn();
    render(<ChoicePicker label="Branch" source="branches" choice={{ id: 'b1', label: 'HQ' }} onChoice={onChoice} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear Branch' }));
    expect(onChoice).toHaveBeenCalledWith(null);
  });
});
