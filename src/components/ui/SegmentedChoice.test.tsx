// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SegmentedChoice } from './SegmentedChoice';

afterEach(cleanup);

const options = [
  { value: 'catalog', label: 'Catalog' },
  { value: 'fixed', label: 'Fixed' },
] as const;

describe('SegmentedChoice', () => {
  it('is one labelled radio group with the current value checked', () => {
    render(
      <SegmentedChoice label="Price source" value="fixed" options={options} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('group', { name: 'Price source' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Fixed' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Catalog' })).not.toBeChecked();
  });

  it('reports a choice made with the mouse', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedChoice label="Price source" value="fixed" options={options} onChange={onChange} />,
    );
    await userEvent.click(screen.getByText('Catalog'));
    expect(onChange).toHaveBeenCalledWith('catalog');
  });

  it('works by keyboard with the arrow keys', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedChoice
        label="Price source"
        value="catalog"
        options={options}
        onChange={onChange}
      />,
    );
    screen.getByRole('radio', { name: 'Catalog' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('fixed');
  });

  it('can hide its label from the screen but keep it for assistive technology', () => {
    render(
      <SegmentedChoice
        label="Price source"
        hideLabel
        value="catalog"
        options={options}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Price source')).toHaveClass('sr-only');
  });

  it('cannot be changed when disabled', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedChoice
        label="Price source"
        disabled
        value="catalog"
        options={options}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByText('Fixed'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
