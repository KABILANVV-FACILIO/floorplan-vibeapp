import { describe, expect, it } from 'vitest';
import { isIdleStatus } from './unitStatus';

/**
 * The popover reported the absence of news three times over — "Free" in its pill, "Record status:
 * Vacant" as a row, and "State: Vacant" under the divider. The pill is now suppressed for the
 * states that mean "nothing is happening", which is the default condition of most units on a plan.
 */
describe('idle statuses are not worth a pill', () => {
  it('recognises the app’s own idle words', () => {
    for (const s of ['Free', 'free', '  Free  ']) expect(isIdleStatus(s)).toBe(true);
  });

  it('recognises the words orgs put on the record', () => {
    for (const s of ['Vacant', 'Available', 'Unassigned', 'Yet to Assign', 'Not Assigned']) {
      expect(isIdleStatus(s)).toBe(true);
    }
  });

  it('keeps anything that IS news', () => {
    for (const s of ['Occupied', 'Booked', 'In Use', 'Assigned · Samar AlHazmi', 'Blocked', 'Under Maintenance', 'Not assignable']) {
      expect(isIdleStatus(s)).toBe(false);
    }
  });

  it('treats nothing at all as nothing to report', () => {
    expect(isIdleStatus(null)).toBe(false);
    expect(isIdleStatus(undefined)).toBe(false);
    expect(isIdleStatus('')).toBe(false);
  });

  it('does not match a status that merely contains an idle word', () => {
    // "Free" inside a longer label is a real state, not the empty default.
    expect(isIdleStatus('Freed by admin')).toBe(false);
    expect(isIdleStatus('Available from 3pm')).toBe(false);
  });
});
