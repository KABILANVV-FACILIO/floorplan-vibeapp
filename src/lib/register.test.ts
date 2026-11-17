import { describe, expect, it } from 'vitest';
import { REGISTERS, registerCell, registerColumns, registerDate, registerKindsFor, registerPages, registerRows, rowsPerPage, columnsNote } from './register';
import type { RegisterContext } from './register';
import { DEFAULT_PARKING_PRINT, DEFAULT_REGISTER_PRINTS } from './types';
import type { Employee, ParkingPrint, Unit } from './types';

/**
 * The parking register printed after a parking plan (ENEC, 2026-11-09): every stall with the
 * details ticked in print › Details — read from the stall record and the holder's employee record,
 * a dash where they are empty, never an invented value.
 */

const stall = (n: number, record: Record<string, string> = {}): Unit =>
  ({ id: String(1576440 + n), type: 'parking', label: `ABU/EHQ/PKG/HQ-${n}`, geom: { kind: 'point', x: 0.1, y: 0.5 }, floor: 'f1', plan: 'parking', room: null, record: { id: String(1576440 + n), ...record } }) as Unit;

const people: Employee[] = [
  { id: 'e1', name: 'Omar Al Marri', hrmsEmployeeId: 'ENEC-10237', department: 'Finance', designation: 'Manager', grade: 'G14', mobile: '+971 50 100 1234', email: 'omar@enec.example', lineManagerId: 'e2' },
  { id: 'e2', name: 'Priya Nair', department: 'Engineering' },
];
const holders: Record<string, string> = { '1576962': 'e1', '1576970': 'e2' };

const ctx = (over: Partial<RegisterContext> = {}): RegisterContext => ({
  planLabel: (u) => u.record?.stall_number_parkingstall || u.label,
  labelField: null,
  holderOf: (u) => people.find((p) => p.id === holders[u.id]) ?? null,
  personById: (id) => people.find((p) => p.id === id) ?? null,
  location: 'ENEC HQ Office / ENEC HQ / HQ Parking',
  ...over,
});

const print = (over: Partial<ParkingPrint> = {}): ParkingPrint => ({ ...DEFAULT_PARKING_PRINT, ...over });

describe('the register columns', () => {
  it('always lead with the stall name, then what was ticked, in register order', () => {
    expect(registerColumns(print({ cols: ['dept', 'id'] }), null).map((c) => c.key)).toEqual(['name', 'id', 'dept']);
  });

  it('list the field the plan labels stalls with next to the name, so a number on the plan can be looked up', () => {
    const cols = registerColumns(print({ cols: ['emp'] }), { name: 'stall_number_parkingstall', label: 'Stall Number' });
    expect(cols.map((c) => c.label)).toEqual(['Stall name', 'Stall Number', 'Assigned to']);
    expect(registerColumns(print({ cols: ['emp'] }), { name: 'name', label: 'Name' }).map((c) => c.key)).toEqual(['name', 'emp']);
  });

  it('warn when there are so many that the text prints small', () => {
    expect(columnsNote(9).warn).toBe(false);
    expect(columnsNote(14)).toEqual({ text: '14 columns · prints small, about 6pt', warn: true });
  });
});

describe('a register cell', () => {
  it("reads the stall record and the holder's employee record", () => {
    const u = stall(522, { parkingMode: 'Permanent', moduleState: 'Occupied', qrVal: 'ABU/EHQ/PKG/HQ-522', stall_number_parkingstall: '522' });
    const c = ctx({ labelField: 'stall_number_parkingstall' });
    expect(registerCell(u, 'name', c)).toBe('ABU/EHQ/PKG/HQ-522');
    expect(registerCell(u, 'label', c)).toBe('522');
    expect(registerCell(u, 'id', c)).toBe('1576962');
    expect(registerCell(u, 'mode', c)).toBe('Permanent');
    expect(registerCell(u, 'status', c)).toBe('Occupied');
    expect(registerCell(u, 'loc', c)).toBe('ENEC HQ Office / ENEC HQ / HQ Parking');
    expect(['emp', 'hrms', 'dept', 'desig', 'grade', 'mobile', 'email', 'lm'].map((k) => registerCell(u, k, c))).toEqual([
      'Omar Al Marri',
      'ENEC-10237',
      'Finance',
      'Manager',
      'G14',
      '+971 50 100 1234',
      'omar@enec.example',
      'Priya Nair', // the line manager, by name
    ]);
  });

  it('reads a picklist sent as its raw option id by its label, and prints nothing for an id it cannot read', () => {
    const u = stall(1, { parkingType: '2' });
    expect(registerCell(u, 'type', ctx({ options: { parkingType: [{ value: '1', label: 'Parking Stall' }, { value: '2', label: 'Handicap' }] } }))).toBe('Handicap');
    expect(registerCell(u, 'type', ctx())).toBe('');
  });

  it('leaves what the records leave empty, empty', () => {
    const u = stall(2);
    expect(['qr', 'type', 'area', 'emp', 'since'].map((k) => registerCell(u, k, ctx()))).toEqual(['', '', '', '', '']);
    // A stall read without its record still says what the plan shows.
    expect(registerCell({ ...u, record: undefined }, 'status', ctx())).toBe('Vacant');
  });

  it('prints a time field as a date', () => {
    expect(registerDate(String(Date.UTC(2026, 2, 12, 9)))).toBe('12 Mar 2026');
    expect(registerDate('')).toBe('');
    expect(registerDate('soon')).toBe('');
  });
});

describe('the register rows', () => {
  const stalls = [stall(530, { moduleState: 'Occupied', stall_number_parkingstall: '530' }), stall(9, { moduleState: 'Vacant', stall_number_parkingstall: '9' }), stall(522, { moduleState: 'Occupied', stall_number_parkingstall: '522' })];

  it('sort by the plan label as numbers read, so 9 comes before 522', () => {
    expect(registerRows(stalls, print(), ctx()).map((u) => ctx().planLabel(u))).toEqual(['9', '522', '530']);
  });

  it('keep only the assigned, or only the vacant, stalls when asked', () => {
    expect(registerRows(stalls, print({ rows: 'assigned' }), ctx()).map((u) => u.id)).toEqual(['1576962', '1576970']);
    expect(registerRows(stalls, print({ rows: 'vacant' }), ctx()).map((u) => u.id)).toEqual(['1576449']);
  });

  it('put the stalls with no department last when sorted by department', () => {
    expect(registerRows(stalls, print({ sort: 'dept' }), ctx()).map((u) => registerCell(u, 'dept', ctx()))).toEqual(['Engineering', 'Finance', '']);
  });

  it('split into pages, the type shrinking as the columns grow, and an empty register still prints a page', () => {
    expect(rowsPerPage(14)).toBeGreaterThan(rowsPerPage(9)); // smaller type, more rows
    expect(registerPages([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(registerPages([], 20)).toEqual([[]]);
  });
});

describe('registers for desks, rooms and lockers, each its own', () => {
  const desk = (n: number, over: Partial<Unit> = {}): Unit =>
    ({ id: `d${n}`, type: 'workstation', label: `ABU/EHQ/3F/B/N-${String(n).padStart(3, '0')}`, geom: { kind: 'point', x: 0.1, y: 0.5 }, floor: 'f1', plan: 'workstation', room: 'Open office', record: { id: String(9000 + n), deskCode: `N-${n}` }, ...over }) as Unit;
  const room = (n: number, over: Partial<Unit> = {}): Unit =>
    ({ id: `r${n}`, type: 'room', label: `HQ-BKB-3F-Meeting Room ${n}`, geom: { kind: 'poly', pts: [[0, 0], [1, 0], [1, 1]] }, floor: 'f1', plan: 'workstation', room: null, record: { id: String(7000 + n), code_space: `MR-${n}` }, ...over }) as Unit;
  const deskHolders: Record<string, string> = { d1: 'e1' };
  const deskCtx = ctx({ kind: 'workstation', holderOf: (u) => people.find((p) => p.id === deskHolders[u.id]) ?? null });
  const booking = { id: 'b1', unitId: 'r1', date: '2026-11-16', start: 600, end: 660, by: 'e2', purpose: 'Quarterly review' } as never;
  const roomCtx = ctx({ kind: 'room', bookingOf: (u) => (u.id === 'r1' ? booking : null) });

  it('know which registers a plan prints: desks and rooms after a desk plan, its own kind after another', () => {
    expect(registerKindsFor('workstation')).toEqual(['workstation', 'room']);
    expect(registerKindsFor('custom')).toEqual(['workstation', 'room']);
    expect(registerKindsFor('parking')).toEqual(['parking']);
    expect(registerKindsFor('locker')).toEqual(['locker']);
  });

  it('read a desk from its record and its holder: code, type, its own department, its room', () => {
    const d = desk(1, { deskType: 'HOT', department: 'Finance' });
    expect(registerCell(d, 'code', deskCtx)).toBe('N-1');
    expect(registerCell(d, 'dtype', deskCtx)).toBe('Hot desk');
    expect(registerCell(d, 'ddept', deskCtx)).toBe('Finance');
    expect(registerCell(d, 'room', deskCtx)).toBe('Open office');
    expect(registerCell(d, 'status', deskCtx)).toBe('Occupied');
    expect(registerCell(d, 'emp', deskCtx)).toBe('Omar Al Marri');
    expect(registerCell(desk(2), 'status', deskCtx)).toBe('Vacant');
    // A desk label field (Settings › Desks) prints beside the name, as a stall's does.
    expect(registerColumns({ ...DEFAULT_REGISTER_PRINTS.workstation }, { name: 'deskCode', label: 'Desk Code' }, 'workstation').map((c) => c.key).slice(0, 2)).toEqual(['name', 'label']);
  });

  it('read a room by its booking in the window printed — booked or free, by whom, when, what for', () => {
    expect(registerCell(room(1), 'status', roomCtx)).toBe('Booked');
    expect(registerCell(room(1), 'by', roomCtx)).toBe('Priya Nair');
    expect(registerCell(room(1), 'time', roomCtx)).toBe('10:00–11:00');
    expect(registerCell(room(1), 'purpose', roomCtx)).toBe('Quarterly review');
    expect(registerCell(room(1), 'code', roomCtx)).toBe('MR-1');
    expect(registerCell(room(2), 'status', roomCtx)).toBe('Free');
    expect(registerCell(room(2, { isReservable: false }), 'bookable', roomCtx)).toBe('No');
  });

  it('take "booked only" for a room the way they take "assigned only" for a desk', () => {
    const rooms = [room(1), room(2), room(3)];
    expect(registerRows(rooms, { ...DEFAULT_REGISTER_PRINTS.room, rows: 'assigned' }, roomCtx).map((u) => u.id)).toEqual(['r1']);
    expect(registerRows(rooms, { ...DEFAULT_REGISTER_PRINTS.room, rows: 'vacant' }, roomCtx).map((u) => u.id)).toEqual(['r2', 'r3']);
    const desks = [desk(1), desk(2)];
    expect(registerRows(desks, { ...DEFAULT_REGISTER_PRINTS.workstation, rows: 'assigned' }, deskCtx).map((u) => u.id)).toEqual(['d1']);
  });

  it('name each register and its rows as the kind it lists', () => {
    expect(REGISTERS.workstation.title).toBe('Desk register');
    expect(REGISTERS.room.rowChoices.assigned).toBe('Booked only');
    expect(REGISTERS.locker.columns.map((c) => c.group)).not.toContain('dates');
    // Parking reads exactly as it did.
    expect(REGISTERS.parking.columns.map((c) => c.key)).toEqual(['name', 'id', 'qr', 'type', 'mode', 'status', 'area', 'loc', 'emp', 'hrms', 'dept', 'desig', 'grade', 'mobile', 'email', 'lm', 'since', 'released']);
  });
});
