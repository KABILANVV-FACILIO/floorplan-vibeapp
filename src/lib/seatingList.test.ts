import { describe, expect, it } from 'vitest';
import { buildSeatingRows, seatingColumns, seatingPages, seatingRowLines, seatingSummary } from './seatingList';
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
  isAssignable: () => true,
  holderDepartment: () => undefined,
  colorFor: () => '#8a4bd3',
  ...over,
});

describe('names as the org writes them', () => {
  it('prints the holder without the employee number, and the number in its own column', () => {
    const [row] = buildSeatingRows([desk('a', 'E-1-WS77')], look({ holderName: () => '251850 - Johar  Ali Ali Asghar' }));
    expect(row).toMatchObject({ holder: 'Johar Ali Ali Asghar', holderNo: '251850' });
  });

  it('prefers the HRMS id for the number when the org fills it', () => {
    const [row] = buildSeatingRows([desk('a', 'E-1-WS77')], look({ holderName: () => '251850 - Johar Ali', holderNumber: () => 'HR-9' }));
    expect(row.holderNo).toBe('HR-9');
  });

  it('prints the department without its cost-centre code, but colours it by the record', () => {
    const colorFor = (_u: Unit, dept: string) => (dept === '10000264-Investment Executive Program' ? '#123456' : undefined);
    const [row] = buildSeatingRows([desk('a', 'E-1-WS77', { department: '10000264-Investment Executive Program' })], look({ colorFor }));
    expect(row).toMatchObject({ department: 'Investment Executive Program', departmentColor: '#123456' });
  });
});

describe('the rows', () => {
  it('lists every desk, in natural order (WS-2 before WS-10)', () => {
    const rows = buildSeatingRows([desk('a', 'WS-10'), desk('b', 'WS-2'), desk('c', 'New Test Desk 1')], look());
    expect(rows.map((r) => r.desk)).toEqual(['New Test Desk 1', 'WS-2', 'WS-10']);
  });

  it('numbers the desks 1..n in list order — the number printed on each desk chip', () => {
    const rows = buildSeatingRows([desk('a', 'WS-10'), desk('b', 'WS-2'), desk('c', 'WS-1')], look());
    expect(rows.map((r) => [r.no, r.desk])).toEqual([
      [1, 'WS-1'],
      [2, 'WS-2'],
      [3, 'WS-10'],
    ]);
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

  it('says Not assignable for a hot desk nobody is placed at, as the viewer does', () => {
    const rows = buildSeatingRows(
      [desk('a', 'WS-01', { deskType: 'HOT' } as Partial<Unit>), desk('b', 'WS-02', { deskType: 'HOT' } as Partial<Unit>)],
      look({ isAssignable: (u) => (u as { deskType?: string }).deskType !== 'HOT', holderName: (id) => (id === 'b' ? 'Someone' : null) }),
    );
    expect(rows.map((r) => r.status)).toEqual(['unassignable', 'assigned']);
    expect(seatingSummary(rows)).toBe('2 desks · 1 assigned · 0 free · 1 not assignable');
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

describe('printed columns', () => {
  const opts = { tablePx: 480, numbered: true, withNumbers: true };
  const enec = buildSeatingRows(
    [
      desk('a', 'E-1-WS77', { department: '10000264-Investment Executive Program' }),
      desk('b', 'E-1-WS78', { department: '10000204-Chief Communications & PR Officer Office' }),
      desk('c', 'E-1-WS79', { department: 'Finance' }),
    ],
    look({ holderName: (id) => (id === 'c' ? null : '251795 - Abdulrahman Abdullah Khalaf AlAnazi') }),
  );

  it('gives short desk names a narrow column, and the department the room', () => {
    const cols = seatingColumns(enec, opts);
    expect(cols.desk).toBeLessThan(80);
    expect(cols.dept).toBeGreaterThanOrEqual(150);
    expect(cols.no + cols.desk + cols.holder + cols.empNo + cols.dept).toBe(480);
  });

  it('prints a department that fits on one line, and wraps one that does not', () => {
    const cols = seatingColumns(enec, opts);
    const lines = new Map(enec.map((r) => [r.desk, seatingRowLines(r, cols)]));
    expect(lines.get('E-1-WS79')).toBe(1); // Free · Finance
    expect(lines.get('E-1-WS78')).toBe(2); // Chief Communications & PR Officer Office
  });

  it('holds fewer rows on a page when rows wrap', () => {
    const rows = Array.from({ length: 60 }, (_, i) => i);
    const tall = (i: number) => (i % 2 ? 32 : 20);
    const pages = seatingPages(rows, 560, 2, tall);
    for (const col of pages.flat(1)) expect(col.reduce((sum, i) => sum + tall(i), 0)).toBeLessThanOrEqual(560);
    expect(pages.flat(2)).toEqual(rows);
    expect(pages.length).toBe(2);
  });
});
