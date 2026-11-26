// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PLAIN_HEADING, STANDARD_LETTERHEAD, type BrandProfile } from '@/lib/print-branding';
import { BrandingChoices } from './BrandingChoices';

afterEach(cleanup);

const profile: BrandProfile = {
  tradingName: 'SM Engineering',
  legalName: 'SM Engineering Limited',
  tagline: null,
  streetAddress: 'Mombasa Road',
  city: 'Nairobi',
  countyOrState: 'Nairobi',
  postalCode: '00100',
  country: 'Kenya',
  email: 'info@sm.example',
  phone: '0712 345 678',
  tel: null,
  website: null,
  kraPin: 'P051234567X',
  logoUrl: null,
};

const presets = [
  { label: 'Standard letterhead', show: STANDARD_LETTERHEAD },
  { label: 'Business name only', show: PLAIN_HEADING },
];

describe('the switches for a printed heading', () => {
  it('lists every detail the heading can carry, ticked as chosen', () => {
    render(
      <BrandingChoices profile={profile} value={{ ...PLAIN_HEADING, email: true }} onChange={vi.fn()} presets={presets} kind="report" name="t" />,
    );
    expect(screen.getByRole('checkbox', { name: /^Email/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Address/ })).not.toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
  });

  it('reports the whole new set of choices when one is switched', async () => {
    const onChange = vi.fn();
    render(
      <BrandingChoices profile={profile} value={PLAIN_HEADING} onChange={onChange} presets={presets} kind="report" name="t" />,
    );
    await userEvent.click(screen.getByRole('checkbox', { name: /^Phone numbers/ }));
    expect(onChange).toHaveBeenCalledWith({ ...PLAIN_HEADING, phone: true });
  });

  it('applies a preset in one press', async () => {
    const onChange = vi.fn();
    render(
      <BrandingChoices profile={profile} value={PLAIN_HEADING} onChange={onChange} presets={presets} kind="report" name="t" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Standard letterhead' }));
    expect(onChange).toHaveBeenCalledWith(STANDARD_LETTERHEAD);
  });

  it('previews the heading from the business’s own details, and only what is switched on', () => {
    const { rerender } = render(
      <BrandingChoices profile={profile} value={PLAIN_HEADING} onChange={vi.fn()} presets={presets} kind="receipt" name="t" />,
    );
    const preview = screen.getByLabelText('How the heading will look');
    expect(preview).toHaveTextContent('SM Engineering');
    expect(preview).not.toHaveTextContent('info@sm.example');
    rerender(
      <BrandingChoices profile={profile} value={{ ...PLAIN_HEADING, email: true, address: true }} onChange={vi.fn()} presets={presets} kind="receipt" name="t" />,
    );
    expect(screen.getByLabelText('How the heading will look')).toHaveTextContent('info@sm.example');
    expect(screen.getByLabelText('How the heading will look')).toHaveTextContent('Mombasa Road, Nairobi');
  });

  it('says so beside a switch whose detail the business has not entered', () => {
    render(
      <BrandingChoices profile={profile} value={PLAIN_HEADING} onChange={vi.fn()} presets={presets} kind="report" name="t" />,
    );
    expect(screen.getByRole('checkbox', { name: /^Website/ })).toHaveAccessibleName(/Not entered in the company profile/);
    expect(screen.getByRole('checkbox', { name: /^Email/ })).not.toHaveAccessibleName(/Not entered/);
  });
});
