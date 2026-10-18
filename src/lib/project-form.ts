import { trimToNull, required } from '@/lib/values';
import {
  checkAmount,
  checkCode,
  checkCurrency,
  checkCustomerId,
  checkDates,
  checkDescription,
  checkName,
  normalizeAmount,
  normalizeCode,
  normalizeCurrency,
} from '@/server/domains/projects/domain/project';

/** What the new-project and edit forms hold. The server checks the same rules again. */
export interface ProjectDraft {
  name: string;
  description: string;
  customerId: string | null;
  billable: boolean;
  currency: string;
  budgetAmount: string;
  startOn: string;
  endOn: string;
}

export interface TaskDraft {
  code: string;
  name: string;
  description: string;
  budgetAmount: string;
}

export const emptyProjectDraft = (): ProjectDraft => ({
  name: '',
  description: '',
  customerId: null,
  billable: false,
  currency: '',
  budgetAmount: '',
  startOn: '',
  endOn: '',
});

export function projectProblem(form: ProjectDraft): string | null {
  return (
    checkName(form.name) ??
    checkDescription(form.description) ??
    checkCustomerId(form.customerId) ??
    checkCurrency(normalizeCurrency(form.currency)) ??
    checkAmount(form.budgetAmount) ??
    checkDates(trimToNull(form.startOn), trimToNull(form.endOn))
  );
}

export function projectPayload(form: ProjectDraft) {
  const budget = form.budgetAmount.trim() === '' ? '0' : form.budgetAmount;
  return {
    name: form.name.trim(),
    description: trimToNull(form.description),
    customerId: form.customerId,
    billable: form.billable,
    currency: normalizeCurrency(form.currency),
    budgetAmount: required(normalizeAmount(budget), 'an amount'),
    startOn: trimToNull(form.startOn),
    endOn: trimToNull(form.endOn),
  };
}

export function taskProblem(form: TaskDraft): string | null {
  return checkCode(normalizeCode(form.code)) ?? checkName(form.name, 'task') ?? checkDescription(form.description) ?? checkAmount(form.budgetAmount);
}

export function taskPayload(form: TaskDraft) {
  const budget = form.budgetAmount.trim() === '' ? '0' : form.budgetAmount;
  return {
    code: normalizeCode(form.code),
    name: form.name.trim(),
    description: trimToNull(form.description),
    budgetAmount: required(normalizeAmount(budget), 'an amount'),
  };
}

export const projectRoute = (id: string): string => `/admin/projects/${id}`;
