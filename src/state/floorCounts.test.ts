import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, whose pdf.js worker import the runner can't resolve.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { renderHook } from '@testing-library/react';
import { buildInitialState, reducer } from './reducer';
import { colorByOf, deskDepartmentCounts, floorCounts, markerLabelInputs } from './selectors';
import { settingsFromState } from '../lib/settingsStore';
import { markerStyle } from '../lib/unitStatus';
import { departmentColor, departmentsIn } from '../lib/departmentColors';
import { legendItems } from '../components/canvas/Legend';
import type { Booking, Employee, Unit } from '../lib/types';
import type { AppState } from './types';

/**
 * The plan's counts card (ENEC, 2026-11-13): every desk, parking stall and room on the floor, how
 * many are occupied, booked and free, narrowed by the ticked departments; a switch that colours
 * desks by department for the viewer alone; and the print following the ticked departments.
 */

const point = (id: string, type: Unit['type'], plan: Unit['plan'], extra: Partial<Unit> = {}): Unit =>
  ({ id, type, label: `${type}-${id}`, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan, room: null, ...extra }) as Unit;
const room = (id: string, extra: Partial<Unit> = {}): Unit =>
  ({ id, type: 'room', label: `Room ${id}`, geom: { kind: 'poly', pts: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] }, floor: 'f1', plan: 'workstation', room: null, ...extra }) as Unit;

const people: Employee[] = [
  { id: 'e1', name: 'Omar Al Marri', department: 'Finance' },
  { id: 'e2', name: 'Priya Nair', department: 'Engineering' },
  { id: 'e3', name: 'Lena Fischer', department: 'Finance' },
];
const booking = (unitId: string, start = 9 * 60, end = 10 * 60, date = '2026-11-13'): Booking => ({ id: `b-${unitId}`, unitId, date, start, end }) as Booking;

const floor = (over: Partial<AppState> = {}): AppState => ({
  ...buildInitialState(),
  floorId: 'f1',
  planId: 'workstation',
  mode: 'assign',
  date: '2026-11-13',
  start: 9 * 60,
  end: 10 * 60,
  units: [
    point('d1', 'workstation', 'workstation', { department: 'Finance', departmentId: '10' }),
    point('d2', 'workstation', 'workstation', { department: 'Engineering', departmentId: '20' }),
    point('d3', 'workstation', 'workstation', { department: 'Finance', departmentId: '10' }),
    point('d4', 'workstation', 'workstation'),
    point('d5', 'workstation', 'workstation', { unplaced: true }),
    point('p1', 'parking', 'parking'),
    point('p2', 'parking', 'parking'),
    point('l1', 'locker', 'locker'),
    room('r1'),
    room('r2'),
    room('r3', { geom: { kind: 'poly', pts: [] } }),
    room('dz', { type: 'delivery' }),
  ],
  // d1 held, d2 held and booked too, d4 booked; a stall held by someone in Finance.
  assignments: { d1: 'e1', d2: 'e2', p1: 'e3' },
  bookings: [booking('d2'), booking('d4'), booking('r1'), booking('p2', 11 * 60, 12 * 60)],
  employees: people,
  ...over,
});

describe('the counts card', () => {
  it('counts every placed desk, stall and room on the floor — not lockers, delivery areas, unplaced desks or rooms with no outline', () => {
    const rows = floorCounts(floor());
    expect(rows.map((r) => [r.type, r.total])).toEqual([
      ['workstation', 4],
      ['parking', 2],
      ['room', 2],
    ]);
  });

  it('splits each type into occupied, booked in the window on screen, and free — adding up to the total', () => {
    const [desks, stalls, rooms] = floorCounts(floor());
    expect(desks).toMatchObject({ occupied: 2, booked: 1, free: 1 }); // d2 is held, so occupied, though booked too
    expect(stalls).toMatchObject({ occupied: 1, booked: 0, free: 1 }); // p2's booking is outside 09:00–10:00
    expect(rooms).toMatchObject({ occupied: 0, booked: 1, free: 1 });
    for (const r of floorCounts(floor())) expect(r.occupied + r.booked + r.free).toBe(r.total);
  });

  it('counts the whole floor whichever plan is on screen', () => {
    expect(floorCounts(floor({ planId: 'parking' })).map((r) => r.total)).toEqual([4, 2, 2]);
  });

  it('narrows desks and stalls to the ticked departments, and leaves rooms whole-floor', () => {
    const [desks, stalls, rooms] = floorCounts(floor({ spaceDepartments: ['Finance'] }));
    expect(desks).toMatchObject({ total: 2, occupied: 1, narrowed: true });
    expect(stalls).toMatchObject({ total: 1, occupied: 1, narrowed: true }); // p1, by its holder's department
    expect(rooms).toMatchObject({ total: 2, narrowed: false });
  });

  it('leaves out a type the floor has none of, and a module switched off', () => {
    expect(floorCounts(floor({ units: floor().units.filter((u) => u.type !== 'parking') })).map((r) => r.type)).toEqual(['workstation', 'room']);
    expect(floorCounts(floor({ enabledModules: { ...buildInitialState().enabledModules, parking: false } })).map((r) => r.type)).toEqual(['workstation', 'room']);
  });
});

describe('colouring desks by department, from the card', () => {
  it("is this viewer's alone: it overrides the Settings default and is never saved", () => {
    const s = reducer(floor(), { type: 'SET_COLOR_BY_VIEW', value: 'department' });
    expect(s.colorBy).toBe('status');
    expect(colorByOf(s)).toBe('department');
    expect(settingsFromState(s)).not.toHaveProperty('colorByView');
    expect(settingsFromState(s).colorBy).toBe('status');
    expect(colorByOf(reducer(s, { type: 'SET_COLOR_BY_VIEW', value: null }))).toBe('status');
  });

  it('colours the plan and its legend by department in Assignment view, and not in Booking view', () => {
    const s = floor({ colorByView: 'department' });
    const ids = departmentsIn(s.units).map((d) => d.id);
    const finance = departmentColor('10', s.departmentColors, ids);
    expect(markerStyle(s, s.units[0]).bg).toBe(finance);
    expect(legendItems(s).find((i) => i.label === 'Finance')?.color).toBe(finance);
    expect(markerStyle({ ...s, mode: 'book' }, s.units[0]).bg).not.toBe(finance);
  });

  it("breaks the desks down by each desk's own department, in the legend's colours, with none last", () => {
    const s = floor({ colorByView: 'department' });
    const free = '#29A01E';
    const lines = deskDepartmentCounts(s, free);
    expect(lines.map((l) => [l.name, l.total, l.occupied])).toEqual([
      ['Engineering', 1, 1],
      ['Finance', 2, 1],
      ['No department', 1, 0],
    ]);
    const legend = legendItems(s);
    for (const l of lines.slice(0, 2)) expect(l.color).toBe(legend.find((i) => i.label === l.name)?.color);
    expect(lines[2].color).toBe(free);
  });
});

describe('the key, with departments ticked', () => {
  it('names only the ticked departments when desks are coloured by department', () => {
    const s = floor({ colorByView: 'department', spaceDepartments: ['Finance'] });
    expect(legendItems(s).map((i) => i.label)).toEqual(['Finance']);
  });
});

describe('the print, with departments ticked', () => {
  it("labels only the ticked departments' desks — not even the desk selected on screen", () => {
    const s = floor({ spaceDepartments: ['Finance'], selected: 'd2' });
    expect(markerLabelInputs(s, s.units.filter((u) => u.geom.kind === 'point'), { departments: ['Finance'] }).map((l) => l.id)).toContain('d2');
    const printed = markerLabelInputs(s, s.units.filter((u) => u.geom.kind === 'point'), { personal: false, departments: ['Finance'], keepSelected: false }).map((l) => l.id);
    expect(printed).not.toContain('d2');
    expect(printed).toEqual(expect.arrayContaining(['d1', 'd3']));
  });

  it('lists only their stalls in the parking register', async () => {
    const { useRegister } = await import('../components/print/useRegister');
    const s = floor({ planId: 'parking' });
    expect(renderHook(() => useRegister(s, 'parking')).result.current.units.map((u) => u.id)).toEqual(['p1', 'p2']);
    const ticked = floor({ planId: 'parking', spaceDepartments: ['Finance'] });
    expect(renderHook(() => useRegister(ticked, 'parking')).result.current.units.map((u) => u.id)).toEqual(['p1']);
  });
});
