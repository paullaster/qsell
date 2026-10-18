import { describe, expect, it } from 'vitest';
import { projectPayload, projectProblem, taskPayload, taskProblem } from './project-form';

const draft = {
  name: 'Shop fit-out',
  description: 'Counters and shelves',
  customerId: null,
  billable: true,
  currency: 'kes',
  budgetAmount: '1500.5',
  startOn: '2026-10-01',
  endOn: '2026-11-01',
};

describe('project form', () => {
  it('turns a filled form into the values the server stores', () => {
    expect(projectProblem(draft)).toBeNull();
    expect(projectPayload(draft)).toMatchObject({
      name: 'Shop fit-out',
      currency: 'KES',
      budgetAmount: '1500.5000',
      billable: true,
      customerId: null,
    });
  });

  it('says what is missing, and treats a blank budget as zero', () => {
    expect(projectProblem({ ...draft, name: '  ' })).toMatch(/name/);
    expect(projectProblem({ ...draft, currency: 'K' })).toMatch(/three-letter/);
    expect(projectProblem({ ...draft, endOn: '2026-01-01' })).toMatch(/before the start/);
    expect(projectPayload({ ...draft, budgetAmount: '' }).budgetAmount).toBe('0.0000');
  });

  it('uppercases a task code', () => {
    const task = { code: 'site-1', name: 'Measure', description: '', budgetAmount: '10' };
    expect(taskProblem(task)).toBeNull();
    expect(taskPayload(task)).toMatchObject({ code: 'SITE-1', name: 'Measure', budgetAmount: '10.0000' });
    expect(taskProblem({ ...task, code: 'has space' })).toMatch(/short code/);
  });
});
