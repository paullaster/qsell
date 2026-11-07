// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const read = vi.fn();
vi.mock('@/server/domains/delivery/billing-actions', () => ({
  deliveryBillingPageAction: (...a: unknown[]) => read(...a) as unknown,
  saveDeliveryBillingAction: vi.fn(),
}));
vi.mock('@/components/ui/autocomplete/ChoicePicker', () => ({ ChoicePicker: () => null }));
vi.mock('next/link', () => ({ default: ({ children, href, 'aria-label': label }: { children: React.ReactNode; href: string; 'aria-label'?: string }) => <a href={href} aria-label={label}>{children}</a> }));

import { publishProductUpdated } from '@/components/admin/product-updated';
import { DeliveryInvoicingClient } from './DeliveryInvoicingClient';

const item = (taxRate: number | null) => ({ id: 'prod_svc', name: 'Delivery service', sku: 'DLV', registered: true, taxRate, isService: true });
const view = (taxRate: number | null) => ({ mode: 'with_goods', version: 3, serviceItem: item(taxRate), taxMismatches: [] });

async function show(canEdit: boolean) {
  await act(() => {
    render(
      <Suspense fallback={null}>
        <DeliveryInvoicingClient data={Promise.resolve({ ok: true, data: view(16) } as never)} canManage={Promise.resolve(true)} canEditProducts={Promise.resolve(canEdit)} />
      </Suspense>,
    );
    // Lets what the screen reads (its data, the permissions) arrive before the test looks.
    return Promise.resolve();
  });
}

describe('delivery invoicing and the delivery service item', () => {
  afterEach(cleanup);

  it('offers the item’s edit window to a person who may update products', async () => {
    await show(true);
    expect(screen.getByRole('link', { name: 'Edit product Delivery service (DLV)' }).getAttribute('href')).toBe('/admin/products/prod_svc?quick=1');
  });

  it('does not offer it to a person who may not', async () => {
    await show(false);
    expect(screen.queryByRole('link', { name: /Edit product/ })).toBeNull();
  });

  it('reads the item again when it is saved in its edit window, so the tax shown is the new one', async () => {
    read.mockResolvedValue({ ok: true, data: view(8) });
    await show(true);
    expect(screen.getByText('Tax 16%')).toBeTruthy();
    await act(() => {
      publishProductUpdated('prod_svc');
      return Promise.resolve();
    });
    expect(await screen.findByText('Tax 8%')).toBeTruthy();
  });

  it('ignores a product that is not the delivery item', async () => {
    read.mockClear();
    await show(true);
    await act(() => {
      publishProductUpdated('prod_other');
      return Promise.resolve();
    });
    expect(read).not.toHaveBeenCalled();
  });
});
