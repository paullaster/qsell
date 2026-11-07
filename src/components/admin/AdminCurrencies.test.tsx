// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrencyConfig } from '@/types/index';

vi.mock('@/server/actions', () => ({
  createCurrencyAction: vi.fn(),
  updateCurrencyAction: vi.fn(),
  deleteCurrencyAction: vi.fn(),
  setBaseCurrencyAction: vi.fn(),
}));
vi.mock('next/link', () => ({ default: ({ children, href, 'aria-label': label }: { children: React.ReactNode; href: string; 'aria-label'?: string }) => <a href={href} aria-label={label}>{children}</a> }));

import { AdminCurrencies } from './AdminCurrencies';

const currency = (over: Partial<CurrencyConfig>): CurrencyConfig => ({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', exchangeRate: 1, isBaseCurrency: true, decimalDigits: 2, symbolPosition: 'prefix', isEnabled: true, updatedAt: '2026-11-01T00:00:00.000Z', ...over });
const list: CurrencyConfig[] = [
  currency({}),
  currency({ code: 'USD', name: 'US Dollar', symbol: '$', exchangeRate: 0.00772201, isBaseCurrency: false, financeRate: { rate: '129.50000000', since: '2026-11-01' } }),
  currency({ code: 'EUR', name: 'Euro', symbol: '€', exchangeRate: 0.0072, isBaseCurrency: false, financeRate: null }),
];
const same = { financeBase: 'KES', displayBase: 'KES', basesDiffer: false };

async function show(link = same) {
  await act(() => {
    render(
      <Suspense fallback={null}>
        <AdminCurrencies currenciesPromise={Promise.resolve(list)} linkPromise={Promise.resolve(link)} onRefreshAll={vi.fn()} />
      </Suspense>,
    );
    return Promise.resolve();
  });
}

describe('the currencies screen and the books exchange rates', () => {
  afterEach(cleanup);

  it('says a currency’s rate comes from Finance, with a link to it, and shows that rate', async () => {
    await show();
    const link = screen.getByRole('link', { name: 'The rate of USD comes from Finance, exchange rates' });
    expect(link.getAttribute('href')).toBe('/admin/finance/exchange-rates');
    expect(screen.getByText(/1 USD = 129.5 KES since 2026-11-01/)).toBeTruthy();
  });

  it('says a currency with no books rate is typed here, and that documents in it cannot be booked yet', async () => {
    await show();
    expect(screen.getByText(/No rate in Finance yet, so documents in EUR cannot be booked/)).toBeTruthy();
    expect(screen.getAllByText(/No rate in Finance yet/)).toHaveLength(1);
  });

  it('does not let a currency whose rate comes from Finance be given a rate here', async () => {
    await show();
    const row = screen.getByText('US Dollar').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByTitle('Edit currency'));
    const note = screen.getByRole('note', { name: 'Where this rate comes from' });
    expect(note.textContent).toContain('1 USD = 129.5 KES, from 2026-11-01');
    expect(within(note).getByRole('link', { name: 'Finance, exchange rates' }).getAttribute('href')).toBe('/admin/finance/exchange-rates');
    expect(screen.queryByPlaceholderText('130.00')).toBeNull();
  });

  it('lets a rate be typed for a currency Finance has no rate for', async () => {
    await show();
    const row = screen.getByText('Euro').closest('tr');
    fireEvent.click(within(row as HTMLElement).getByTitle('Edit currency'));
    expect(screen.queryByRole('note', { name: 'Where this rate comes from' })).toBeNull();
    expect(screen.getByPlaceholderText('130.00')).toBeTruthy();
  });

  it('warns when the shop and the books use different base currencies', async () => {
    await show({ financeBase: 'USD', displayBase: 'KES', basesDiffer: true });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('different base currencies');
    expect(alert.textContent).toContain('KES');
    expect(alert.textContent).toContain('USD');
  });

  it('shows no warning when the bases are the same', async () => {
    await show();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
