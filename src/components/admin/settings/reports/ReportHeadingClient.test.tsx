// @vitest-environment jsdom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PLAIN_HEADING, STANDARD_LETTERHEAD, type BrandProfile } from '@/lib/print-branding';
import type { ReportPrintScreen } from '@/server/domains/company/print-branding-actions';

const save = vi.fn();
vi.mock('@/server/domains/company/print-branding-actions', () => ({
  saveReportPrintAction: (raw: unknown) => save(raw) as unknown,
}));

import { ReportHeadingClient } from './ReportHeadingClient';

afterEach(cleanup);
beforeEach(() => {
  save.mockReset();
});

const profile: BrandProfile = {
  tradingName: 'SM Engineering',
  legalName: 'SM Engineering Limited',
  streetAddress: 'Mombasa Road',
  city: 'Nairobi',
  countyOrState: 'Nairobi',
  postalCode: '00100',
  country: 'Kenya',
  email: 'info@sm.example',
  phone: '0712 345 678',
  kraPin: 'P051234567X',
};

const screenData = (over: Partial<ReportPrintScreen> = {}): ReportPrintScreen => ({
  general: PLAIN_HEADING,
  modules: [
    { code: 'sales', label: 'Sales', own: null },
    { code: 'finance', label: 'Finance', own: { ...PLAIN_HEADING, logo: true } },
  ],
  profile,
  ...over,
});

const show = async (moduleCode: string | null, data: ReportPrintScreen) => {
  await act(async () => {
    await Promise.resolve();
    render(
      <Suspense fallback="loading">
        <ReportHeadingClient
          firstPromise={Promise.resolve({ ok: true as const, data })}
          moduleCode={moduleCode}
        />
      </Suspense>,
    );
  });
};

describe('the heading of downloaded reports', () => {
  it('starts as the business name only and cannot be saved until something changes', async () => {
    await show(null, screenData());
    expect(await screen.findByRole('heading', { name: 'All reports' })).toBeInTheDocument();
    expect(screen.getByText('Reports show the business name only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves the general heading as chosen, after a preset', async () => {
    save.mockResolvedValue({
      ok: true,
      data: screenData({ general: STANDARD_LETTERHEAD }),
    });
    await show(null, screenData());
    await userEvent.click(await screen.findByRole('button', { name: 'Standard letterhead' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({ module: null, show: STANDARD_LETTERHEAD });
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
  });

  it('lets a module follow the general heading, and saves nothing of its own', async () => {
    await show('sales', screenData({ general: STANDARD_LETTERHEAD }));
    expect(await screen.findByRole('heading', { name: 'Sales reports' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Use the heading of all reports' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /^Logo/ })).toBeNull();
  });

  it('gives a module its own heading and saves it for that module only', async () => {
    save.mockResolvedValue({
      ok: true,
      data: screenData({ modules: [{ code: 'sales', label: 'Sales', own: { ...PLAIN_HEADING, email: true } }] }),
    });
    await show('sales', screenData());
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Use the heading of all reports' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /^Email/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({ module: 'sales', show: { ...PLAIN_HEADING, email: true } });
  });

  it('takes a module’s own heading away when it goes back to the general one', async () => {
    save.mockResolvedValue({ ok: true, data: screenData({ modules: [{ code: 'finance', label: 'Finance', own: null }] }) });
    await show('finance', screenData());
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Use the heading of all reports' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith({ module: 'finance', show: null });
  });

  it('shows the refusal in words and keeps the choices', async () => {
    save.mockResolvedValue({ ok: false, error: 'You do not have permission to do that.' });
    await show(null, screenData());
    await userEvent.click(await screen.findByRole('button', { name: 'Standard letterhead' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that.');
    expect(screen.getByRole('checkbox', { name: /^Logo/ })).toBeChecked();
  });
});
