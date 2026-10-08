import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `app/admin/@modal/(.)products/[id]` opens the product editor over the list for any soft
 * navigation to `/admin/products/<something>`. A page placed directly under `app/admin/products/`
 * is therefore hijacked: clicking its link opens the "new product" form until the page is
 * refreshed. Pages that belong to products live elsewhere (for example `/admin/trash/products`).
 */
describe('admin product routes', () => {
  it('only the product list and the [id] editor live directly under /admin/products', () => {
    const entries = readdirSync(join(process.cwd(), 'app/admin/products')).sort();
    expect(entries).toEqual(['[id]', 'page.tsx']);
  });
});
