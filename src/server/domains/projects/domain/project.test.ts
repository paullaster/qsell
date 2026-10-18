import { describe, expect, it } from 'vitest';
import {
  applyProjectCommand,
  applyTaskCommand,
  budgetWarning,
  checkAmount,
  checkCode,
  checkCurrency,
  checkDates,
  checkName,
  commandRefusal,
  normalizeAmount,
  normalizeCode,
  projectCapabilities,
  projectIsEditable,
  taskCapabilities,
} from './project';

describe('project steps', () => {
  it('opens a draft, holds it, resumes it, completes it and closes it', () => {
    expect(applyProjectCommand('draft', 'open')).toBe('open');
    expect(applyProjectCommand('open', 'hold')).toBe('on_hold');
    expect(applyProjectCommand('on_hold', 'resume')).toBe('open');
    expect(applyProjectCommand('open', 'complete')).toBe('completed');
    expect(applyProjectCommand('completed', 'close')).toBe('closed');
  });

  it('refuses a step the project is not in a position to take', () => {
    expect(applyProjectCommand('draft', 'close')).toBeNull();
    expect(applyProjectCommand('closed', 'reopen')).toBeNull();
    expect(applyProjectCommand('cancelled', 'open')).toBeNull();
    expect(commandRefusal('close')).toMatch(/Complete the project/);
  });

  it('lets a completed project be reopened, and a draft be cancelled', () => {
    expect(applyProjectCommand('completed', 'reopen')).toBe('open');
    expect(applyProjectCommand('draft', 'cancel')).toBe('cancelled');
    expect(applyProjectCommand('open', 'cancel')).toBe('cancelled');
  });

  it('allows tasks only while the project is still being worked', () => {
    expect(projectIsEditable('draft')).toBe(true);
    expect(projectIsEditable('open')).toBe(true);
    expect(projectIsEditable('on_hold')).toBe(true);
    expect(projectIsEditable('completed')).toBe(false);
    expect(projectCapabilities('completed')).toMatchObject({ edit: false, addTask: false, close: true, reopen: true });
    expect(taskCapabilities('open', 'open')).toMatchObject({ complete: true, cancel: true, edit: true });
    expect(taskCapabilities('completed', 'open')).toMatchObject({ complete: false, edit: false });
    expect(applyTaskCommand('open', 'complete')).toBe('completed');
    expect(applyTaskCommand('completed', 'reopen')).toBe('open');
    expect(applyTaskCommand('cancelled', 'reopen')).toBeNull();
  });
});

describe('project amounts and names', () => {
  it('stores an amount to four decimal places and refuses a slip', () => {
    expect(normalizeAmount('10')).toBe('10.0000');
    expect(normalizeAmount('10.5')).toBe('10.5000');
    expect(normalizeAmount('')).toBeNull();
    expect(checkAmount('')).toBeNull();
    expect(checkAmount('10.12345')).toMatch(/4 decimal/);
    expect(checkAmount('-1')).toMatch(/amount/);
    expect(checkAmount('100000000.0001')).toMatch(/too large/);
  });

  it('warns when the tasks together pass the project budget', () => {
    expect(budgetWarning('100.0000', ['40.0000', '50.0000'])).toBeNull();
    expect(budgetWarning('100.0000', ['60.5000', '40.0000'])).toMatch(/more than the project budget/);
  });

  it('checks the name, the code, the currency and the dates', () => {
    expect(checkName('  Fit-out  ')).toBeNull();
    expect(checkName('   ')).toMatch(/name/);
    expect(normalizeCode(' site-1 ')).toBe('SITE-1');
    expect(checkCode('SITE-1')).toBeNull();
    expect(checkCode('bad code')).toMatch(/short code/);
    expect(checkCurrency('kes')).toMatch(/three-letter/);
    expect(checkCurrency('KES')).toBeNull();
    expect(checkDates('2026-10-01', '2026-12-01')).toBeNull();
    expect(checkDates('2026-12-01', '2026-10-01')).toMatch(/before the start/);
    expect(checkDates('2026-02-31', null)).toMatch(/not a real date/);
    expect(checkDates(null, null)).toBeNull();
  });
});
