// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BrandBlock } from '@/lib/print-branding';
import type { SaleSummary } from '@/server/domains/selling/cash-sales/cash-sale-service';
import { SaleDone } from './SaleDone';

afterEach(cleanup);

const sale: SaleSummary = {
  orderId: 'o1',
  orderNumber: 'CS-1',
  receiptNumber: 'RC-1',
  total: 500,
  changeDue: 0,
  customerName: 'Walk-in',
  at: '2026-11-25T08:00:00Z',
  lines: [{ name: 'Cable', quantity: 1, unitPrice: 500, total: 500, discount: 0 }],
  discount: 0,
  tenders: [],
};

const brand = (over: Partial<BrandBlock> = {}): BrandBlock => ({
  name: 'SM Engineering',
  legalName: null,
  tagline: null,
  address: null,
  contacts: [],
  kraPin: null,
  logoUrl: null,
  ...over,
});

const printed = () => screen.getByTestId('receipt-print');

describe('the printed till receipt', () => {
  it('is headed by the shop name alone until the company chooses more', () => {
    render(<SaleDone sale={sale} brand={brand()} receiptDiscount="hidden" onClose={vi.fn()} />);
    expect(printed().querySelector('h1')).toHaveTextContent('SM Engineering');
    expect(printed().querySelector('img')).toBeNull();
    expect(printed().querySelectorAll('p.small')).toHaveLength(0);
  });

  it('prints the chosen contact details under the name, and the logo above it', () => {
    render(
      <SaleDone
        sale={sale}
        brand={brand({
          address: 'Mombasa Road, Nairobi',
          contacts: ['Tel 0712 345 678', 'info@sm.example'],
          logoUrl: '/api/company/logo/logo-1.png',
        })}
        receiptDiscount="hidden"
        onClose={vi.fn()}
      />,
    );
    const lines = Array.from(printed().querySelectorAll('p.small')).map((p) => p.textContent);
    expect(lines).toEqual(['Mombasa Road, Nairobi', 'Tel 0712 345 678', 'info@sm.example']);
    const logo = printed().querySelector('img');
    expect(logo).toHaveAttribute('src', '/api/company/logo/logo-1.png');
    expect(logo?.compareDocumentPosition(printed().querySelector('h1') as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
