export type CreditLimitDisplay = 'running' | 'static';

export const CREDIT_LIMIT_DISPLAYS: readonly {
  id: CreditLimitDisplay;
  label: string;
  description: string;
}[] = [
  {
    id: 'running',
    label: 'Running',
    description: 'Show the set credit limit less the net amount the customer owes.',
  },
  {
    id: 'static',
    label: 'Static',
    description: 'Show only the credit limit set on the customer account.',
  },
];

export const DEFAULT_CREDIT_LIMIT_DISPLAY: CreditLimitDisplay = 'running';
export const DEFAULT_ALLOW_OVER_CREDIT_LIMIT = false;

export function isCreditLimitDisplay(value: unknown): value is CreditLimitDisplay {
  return value === 'running' || value === 'static';
}

export function creditLimitDisplayLabel(value: CreditLimitDisplay): string {
  return CREDIT_LIMIT_DISPLAYS.find((d) => d.id === value)?.label ?? value;
}

export function displayedAvailableCredit(
  creditLimitCents: number,
  netOwedCents: number,
  display: CreditLimitDisplay,
): number {
  return Math.max(0, display === 'static' ? creditLimitCents : creditLimitCents - netOwedCents);
}
