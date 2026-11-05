// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductEditLink } from './ProductEditLink';

afterEach(cleanup);

describe('ProductEditLink', () => {
  it('is not drawn for a person who may not update products', () => {
    const { container } = render(<ProductEditLink productId="p1" name="Pump" canEdit={false} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('is not drawn for a line without a product', () => {
    const { container } = render(<ProductEditLink productId={null} name="Pump" canEdit />);
    expect(container).toBeEmptyDOMElement();
  });
  it('links to the product edit window with a name a screen reader can use', () => {
    render(<ProductEditLink productId="p1" name="Pump" canEdit />);
    expect(screen.getByRole('link', { name: 'Edit product Pump' }).getAttribute('href')).toBe('/admin/products/p1?quick=1');
  });
});
