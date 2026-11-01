// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Scopes } from '@/server/domains/pricing/domain/types';
import { ScopeEditor } from './ScopeEditor';

vi.mock('@/server/domains/pricing/actions', () => ({
  searchCustomersAction: vi.fn(() => Promise.resolve({ ok: true, data: [] })),
}));

afterEach(cleanup);

const lookups = {
  branches: [{ id: 'b1', code: 'NBO', name: 'Nairobi' }],
  currencies: [],
  groups: [{ id: 'g1', code: 'WA', name: 'Wholesale A' }],
  channels: ['ecommerce'],
  salesTypes: ['cash', 'credit'],
  baseCurrency: 'KES',
};

function Harness({ start = {} }: { start?: Scopes }) {
  const [value, setValue] = useState<Scopes>(start);
  return (
    <>
      <ScopeEditor value={value} onChange={setValue} lookups={lookups} names={{}} dimensions={['branch', 'sales_type']} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

describe('ScopeEditor', () => {
  it('uses no native select', () => {
    const { container } = render(<Harness start={{ branch: { op: 'in', values: [] } }} />);
    expect(container.querySelector('select')).toBeNull();
  });

  it('turns a limit on and off', async () => {
    render(<Harness />);
    expect(screen.queryByRole('group', { name: /Branch: only or all except/ })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: /Branch/ }));
    expect(screen.getByTestId('value').textContent).toBe('{"branch":{"op":"in","values":[]}}');
    await userEvent.click(screen.getByRole('checkbox', { name: /Branch/ }));
    expect(screen.getByTestId('value').textContent).toBe('{}');
  });

  it('switches between only these and everything except these, keeping the values', async () => {
    render(<Harness start={{ branch: { op: 'in', values: ['b1'] } }} />);
    expect(screen.getByRole('radio', { name: 'Only these' })).toBeChecked();
    await userEvent.click(screen.getByText('Everything except these'));
    expect(screen.getByRole('radio', { name: 'Everything except these' })).toBeChecked();
    expect(screen.getByTestId('value').textContent).toBe('{"branch":{"op":"not_in","values":["b1"]}}');
  });

  it('picks values from the lists it was given', async () => {
    render(<Harness start={{ sales_type: { op: 'in', values: [] } }} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Credit sale' }));
    expect(screen.getByTestId('value').textContent).toBe('{"sales_type":{"op":"in","values":["credit"]}}');
  });
});
