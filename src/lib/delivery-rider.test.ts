import { describe, expect, it } from 'vitest';
import { dialable, kindAllowed, kindsInWords, kindsProblem, mayCarry, riderStatusAfter } from './delivery-rider';

describe('which kinds of rider a company uses', () => {
  it('needs at least one kind', () => {
    expect(kindsProblem({ allowStaff: false, allowSeparate: false }, { staff: 0, separate: 0 })).toMatch(/at least one/);
  });

  it('cannot switch a kind off while people of that kind are riding, and says how many', () => {
    expect(kindsProblem({ allowStaff: false, allowSeparate: true }, { staff: 2, separate: 0 })).toMatch(/2 staff members are still riding/);
    expect(kindsProblem({ allowStaff: true, allowSeparate: false }, { staff: 0, separate: 1 })).toMatch(/1 rider has an account of their own/);
  });

  it('lets a kind go once nobody rides on it', () => {
    expect(kindsProblem({ allowStaff: false, allowSeparate: true }, { staff: 0, separate: 3 })).toBeNull();
    expect(kindsProblem({ allowStaff: true, allowSeparate: true }, { staff: 4, separate: 3 })).toBeNull();
  });

  it('is described in words', () => {
    expect(kindsInWords({ allowStaff: true, allowSeparate: true })).toBe('staff and riders with their own accounts');
    expect(kindsInWords({ allowStaff: false, allowSeparate: true })).toBe('riders with their own accounts');
    expect(kindsInWords({ allowStaff: true, allowSeparate: false })).toBe('staff');
  });

  it('knows which kind is allowed', () => {
    expect(kindAllowed({ allowStaff: true, allowSeparate: false }, 'separate')).toBe(false);
    expect(kindAllowed({ allowStaff: true, allowSeparate: false }, 'staff')).toBe(true);
  });
});

describe('who may be given a run', () => {
  const both = { allowStaff: true, allowSeparate: true };
  it('is someone riding, on a kind the company still uses', () => {
    expect(mayCarry({ status: 'active', kind: 'staff' }, both)).toBe(true);
    expect(mayCarry({ status: 'paused', kind: 'staff' }, both)).toBe(false);
    expect(mayCarry({ status: 'ended', kind: 'separate' }, both)).toBe(false);
    expect(mayCarry({ status: 'active', kind: 'separate' }, { allowStaff: true, allowSeparate: false })).toBe(false);
  });
});

describe('changing a rider', () => {
  it('pauses only an active rider, resumes anyone not active, ends anyone who has not left', () => {
    expect(riderStatusAfter('active', 'pause')).toBe('paused');
    expect(riderStatusAfter('paused', 'pause')).toBeNull();
    expect(riderStatusAfter('paused', 'resume')).toBe('active');
    expect(riderStatusAfter('ended', 'resume')).toBe('active');
    expect(riderStatusAfter('active', 'resume')).toBeNull();
    expect(riderStatusAfter('paused', 'end')).toBe('ended');
    expect(riderStatusAfter('ended', 'end')).toBeNull();
  });
});

describe('a number to dial', () => {
  it('keeps digits and a leading plus, and refuses what is too short or too long', () => {
    expect(dialable('+254 711-000 555')).toBe('+254711000555');
    expect(dialable('0711 000 555')).toBe('0711000555');
    expect(dialable('12345')).toBeNull();
    expect(dialable('1234567890123456')).toBeNull();
    expect(dialable(null)).toBeNull();
  });
});
