import type { ProductGridDesktopColumns } from './types';

/**
 * Map the company-chosen desktop density (~1140px band) to responsive Tailwind
 * grid classes. Smaller breakpoints always scale down; we never exceed the
 * configured desktop column count.
 *
 * Reference band ≈ Tailwind `lg`–`xl` (1024–1280px), i.e. around 1140px.
 */
const GRID_BY_DESKTOP: Record<ProductGridDesktopColumns, string> = {
  2: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
};

export function productGridClassName(
  desktopColumns: ProductGridDesktopColumns,
  gapClass = 'gap-3 sm:gap-4 lg:gap-6',
): string {
  return `grid ${gapClass} ${GRID_BY_DESKTOP[desktopColumns]}`;
}
