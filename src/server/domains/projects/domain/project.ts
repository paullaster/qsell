/**
 * Project rules that need no database. A project moves only through the steps declared here.
 * Amounts are exact: four decimal places, compared as whole units of 0.0001 so nothing is rounded
 * by floating point.
 */

export const PROJECT_STATUSES = ['draft', 'open', 'on_hold', 'completed', 'closed', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TASK_STATUSES = ['open', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PROJECT_COMMANDS = ['open', 'hold', 'resume', 'complete', 'close', 'cancel', 'reopen'] as const;
export type ProjectCommand = (typeof PROJECT_COMMANDS)[number];

export const TASK_COMMANDS = ['complete', 'cancel', 'reopen'] as const;
export type TaskCommand = (typeof TASK_COMMANDS)[number];

const NEXT: Record<ProjectStatus, Partial<Record<ProjectCommand, ProjectStatus>>> = {
  draft: { open: 'open', cancel: 'cancelled' },
  open: { hold: 'on_hold', complete: 'completed', cancel: 'cancelled' },
  on_hold: { resume: 'open', complete: 'completed', cancel: 'cancelled' },
  completed: { close: 'closed', reopen: 'open' },
  closed: {},
  cancelled: {},
};

const TASK_NEXT: Record<TaskStatus, Partial<Record<TaskCommand, TaskStatus>>> = {
  open: { complete: 'completed', cancel: 'cancelled' },
  completed: { reopen: 'open' },
  cancelled: {},
};

const REFUSAL: Record<ProjectCommand, string> = {
  open: 'This project cannot be opened from where it is.',
  hold: 'Only an open project can be put on hold.',
  resume: 'Only a project on hold can be resumed.',
  complete: 'Only an open project, or one on hold, can be completed.',
  close: 'Complete the project before closing it.',
  cancel: 'This project can no longer be cancelled.',
  reopen: 'Only a completed project can be reopened.',
};

const EDITABLE: ReadonlySet<ProjectStatus> = new Set(['draft', 'open', 'on_hold']);

/** 100 million, in units of 0.0001. Past this, a typed amount is treated as a slip. */
const MAX_UNITS = 100_000_000 * 10_000;
const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isProjectStatus(value: string): value is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isProjectCommand(value: string): value is ProjectCommand {
  return (PROJECT_COMMANDS as readonly string[]).includes(value);
}

export function isTaskCommand(value: string): value is TaskCommand {
  return (TASK_COMMANDS as readonly string[]).includes(value);
}

/** The status this command leads to, or null when the step is not allowed from here. */
export function applyProjectCommand(from: ProjectStatus, command: ProjectCommand): ProjectStatus | null {
  return NEXT[from][command] ?? null;
}

export function applyTaskCommand(from: TaskStatus, command: TaskCommand): TaskStatus | null {
  return TASK_NEXT[from][command] ?? null;
}

export function commandRefusal(command: ProjectCommand): string {
  return REFUSAL[command];
}

export function projectIsEditable(status: ProjectStatus): boolean {
  return EDITABLE.has(status);
}

export interface ProjectCapabilities {
  edit: boolean;
  changeCustomer: boolean;
  changeCurrency: boolean;
  addTask: boolean;
  open: boolean;
  hold: boolean;
  resume: boolean;
  complete: boolean;
  close: boolean;
  cancel: boolean;
  reopen: boolean;
}

export function projectCapabilities(status: ProjectStatus): ProjectCapabilities {
  return {
    edit: EDITABLE.has(status),
    changeCustomer: status === 'draft',
    changeCurrency: status === 'draft',
    addTask: EDITABLE.has(status),
    open: status === 'draft',
    hold: status === 'open',
    resume: status === 'on_hold',
    complete: status === 'open' || status === 'on_hold',
    close: status === 'completed',
    cancel: status === 'draft' || status === 'open' || status === 'on_hold',
    reopen: status === 'completed',
  };
}

export function taskCapabilities(
  projectStatus: ProjectStatus,
  taskStatus: TaskStatus,
): { edit: boolean; complete: boolean; cancel: boolean; reopen: boolean } {
  const live = EDITABLE.has(projectStatus);
  return {
    edit: live && taskStatus === 'open',
    complete: live && taskStatus === 'open',
    cancel: live && taskStatus === 'open',
    reopen: live && taskStatus === 'completed',
  };
}

/** The amount as whole units of 0.0001, or null when it is not a usable amount. */
export function amountUnits(raw: string): number | null {
  const value = raw.trim();
  if (!AMOUNT.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const units = Number(whole) * 10_000 + Number(frac.padEnd(4, '0').slice(0, 4));
  if (!Number.isSafeInteger(units)) return null;
  return units;
}

/** The amount stored to four decimal places, or null when it is not a usable amount. */
export function normalizeAmount(raw: string): string | null {
  const units = amountUnits(raw);
  if (units === null) return null;
  const whole = Math.trunc(units / 10_000);
  const frac = String(units % 10_000).padStart(4, '0');
  return `${String(whole)}.${frac}`;
}

export function checkAmount(raw: string): string | null {
  const units = amountUnits(raw.trim() === '' ? '0' : raw);
  if (units === null || units < 0) return 'Enter an amount with up to 4 decimal places.';
  if (units > MAX_UNITS) return 'That amount is too large to be right. Check it.';
  return null;
}

/** A note when the tasks that still count are together more than the project budget. Cancelled tasks are left out by the caller. */
export function budgetWarning(projectBudget: string, taskBudgets: readonly string[]): string | null {
  const project = amountUnits(projectBudget);
  if (project === null) return null;
  let tasks = 0;
  for (const budget of taskBudgets) {
    const units = amountUnits(budget);
    if (units === null) return null;
    tasks += units;
  }
  if (tasks > project) return 'The tasks together are more than the project budget.';
  return null;
}

export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function checkDates(start: string | null, end: string | null): string | null {
  if (start !== null && !isDay(start)) return 'The start date is not a real date.';
  if (end !== null && !isDay(end)) return 'The end date is not a real date.';
  if (start !== null && end !== null && end < start) return 'The end date cannot be before the start date.';
  return null;
}

export function checkName(raw: string, what = 'project'): string | null {
  const name = raw.trim();
  if (name === '') return `Give the ${what} a name.`;
  if (name.length > 120) return `Keep the ${what} name to 120 characters.`;
  return null;
}

export function checkDescription(raw: string): string | null {
  if (raw.trim().length > 2000) return 'Keep the description to 2000 characters.';
  return null;
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function checkCode(code: string): string | null {
  if (!/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(code)) return 'Use a short code of letters, numbers and hyphens, up to 20 characters.';
  return null;
}

export function normalizeCurrency(raw: string): string {
  return raw.trim().toUpperCase();
}

export function checkCurrency(code: string): string | null {
  if (!/^[A-Z]{3}$/.test(code)) return 'Use a three-letter currency code.';
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkCustomerId(id: string | null): string | null {
  if (id === null) return null;
  if (!UUID.test(id)) return 'Choose a customer from the list.';
  return null;
}
