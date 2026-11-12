import { KIT_ALLOCATIONS } from '@/server/domains/pricing/domain/kits';
import type { PackagePricingMode, ShortStockMode } from '@/server/domains/pricing/domain/packages';

export interface PackageChoice {
  id: string;
  label: string;
}

export const PACKAGE_PRICING_CHOICES: (PackageChoice & { id: PackagePricingMode })[] = [
  { id: 'base_plus_differences', label: 'One base price, plus a difference for each option (usual)' },
  { id: 'summed', label: 'Each option priced on its own and added up' },
];

export const PACKAGE_SHORT_STOCK_CHOICES: (PackageChoice & { id: ShortStockMode })[] = [
  { id: 'hide', label: 'Hide it (usual)' },
  { id: 'disable', label: 'Show it greyed out, saying it is sold out' },
  { id: 'substitute', label: 'Show it greyed out and suggest another' },
];

export const PACKAGE_SPLIT_CHOICES: PackageChoice[] = KIT_ALLOCATIONS.map((a) => ({ id: a.value, label: a.label }));

export const labelOfPackageChoice = (choices: readonly PackageChoice[], id: string): string => choices.find((c) => c.id === id)?.label ?? id;
