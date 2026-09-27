import { describe, expect, it } from 'vitest';
import { buildSeatingRows, seatingPages, seatingSummary } from './seatingList';
import type { SeatingLookups } from './seatingList';
import type { Unit } from './types';

/**
 * The print sheet's Seating list: every desk, who is placed there, and the department. These pin
 * that no desk is dropped, what each status reads as, and where the pages break — the demo floor
 * is too small to show a second page, and a real floor is not.
 */

const desk = (id: string, label: string, over: Partial<Unit> = {}) => ({ id, label, type: 'workstation', ...over }) as unknown as Unit;

const look = (over: Partial<SeatingLookups> = {}): SeatingLookups => ({
  holderName: () => null,
  isBooked: () => false,
  holderDepartment: () => undefined,
  colorFor: () => '#8a4bd3',
  ...over,
});

describe('the rows', () => {
  it('lists every desk, in natural order (WS-2 before WS-10)', () => {
    const rows = buildSeatingRows([desk('a', 'WS-10'), desk('b', 'WS-2'), desk('c', 'New Test Desk 1')], look());
    expect(rows.map((r) => r.desk)).toEqual(['New Test Desk 1', 'WS-2', 'WS-10']);
  });

  it('names who is placed at a desk, and says Free or Booked otherwise', () => {
    const rows = buildSeatingRows(
      [desk('a', 'WS-01'), desk('b', 'WS-02'), desk('c', 'WS-03')],
      look({ holderName: (id) => (id === 'a' ? 'Amrithya' : null), isBooked: (id) => id === 'b' }),
    );
    expect(rows.map((r) => [r.desk, r.status, r.holder])).toEqual([
      ['WS-01', 'assigned', 'Amrithya'],
      ['WS-02', 'booked', null],
      ['WS-03', 'free', null],
    ]);
  });

  it('counts a desk assigned to someone outside the roster as assigned, without a name', () => {
    const [row] = buildSeatingRows([desk('a', 'WS-01')], look({ holderName: () => '' }));
    expect(row.status).toBe('assigned');
    expect(row.holder).toBeNull();
  });

  it("uses the desk's department first, and the holder's only when the desk has none", () => {
    const rows = buildSeatingRows(
      [desk('a', 'WS-01', { department: 'Finance' } as Partial<Unit>), desk('b', 'WS-02')],
      look({ holderName: () => 'Someone', holderDepartment: () => 'HR' }),
    );
    expect(rows.map((r) => r.department)).toEqual(['Finance', 'HR']);
  });

  it('leaves a free desk with no department blank rather than borrowing one', () => {
    const [row] = buildSeatingRows([desk('a', 'WS-01')], look({ holderDepartment: () => 'HR' }));
    expect(row.department).toBeNull();
    expect(row.departmentColor).toBeUndefined();
  });

  it('summarises the counts', () => {
    const rows = buildSeatingRows(
      [desk('a', '1'), desk('b', '2'), desk('c', '3')],
      look({ holderName: (id) => (id === 'a' ? 'A' : null), isBooked: (id) => id === 'b' }),
    );
    expect(seatingSummary(rows)).toBe('3 desks · 1 assigned · 1 booked · 1 free');
  });
});

describe('the pages', () => {
  const rows = Array.from({ length: 130 }, (_, i) => i + 1);

  it('fills two columns per page, down the left then down the right', () => {
    const pages = seatingPages(rows, 28);
    expect(pages[0][0][0]).toBe(1);
    expect(pages[0][0][pages[0][0].length - 1]).toBe(28);
    expect(pages[0][1][0]).toBe(29);
    expect(pages[0][1][pages[0][1].length - 1]).toBe(56);
    expect(pages[1][0][0]).toBe(57);
  });

  it('breaks into as many pages as the rows need, and drops none', () => {
    const pages = seatingPages(rows, 28);
    expect(pages).toHaveLength(3); // 56 + 56 + 18
    expect(pages.flat(2)).toEqual(rows);
    expect(pages[2].map((c) => c.length)).toEqual([9, 9]); // the last 18, split evenly
  });

  it('splits a small floor evenly across the two columns', () => {
    const pages = seatingPages(Array.from({ length: 25 }, (_, i) => i), 28);
    expect(pages).toHaveLength(1);
    expect(pages[0].map((c) => c.length)).toEqual([13, 12]);
  });

  it('has no pages for no desks', () => {
    expect(seatingPages([], 28)).toEqual([]);
  });
});
