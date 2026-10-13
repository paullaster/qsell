import { INTERNATIONAL_TEMPLATE } from './international';
import { KENYA_TEMPLATE } from './kenya';
import type { ChartTemplate } from './types';

export const CHART_TEMPLATES: ChartTemplate[] = [INTERNATIONAL_TEMPLATE, KENYA_TEMPLATE];

export function findTemplate(code: string): ChartTemplate | undefined {
  return CHART_TEMPLATES.find((t) => t.code === code);
}

export type { ChartTemplate } from './types';
