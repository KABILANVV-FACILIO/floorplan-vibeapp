import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, whose pdf.js worker import the runner can't resolve.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { renderHook } from '@testing-library/react';
import { buildInitialState, reducer } from './reducer';
import { colorByOf, departmentColorIds, deskDepartmentCounts, floorCounts, markerLabelInputs, spaceOfPerson, spacesByPerson } from './selectors';
import { unitStatus } from '../lib/unitStatus';
import { markerModel } from '../lib/markerModel';
import { bookingSegmentsFromRow } from '../lib/bookingRows';
import { settingsFromState } from '../lib/settingsStore';
import { markerStyle } from '../lib/unitStatus';
import { departmentColor, departmentKey, departmentsIn } from '../lib/departmentColors';
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

describe('record states', () => {
  it("replace with a floor's read, merge a later page's, and ignore another floor's", () => {
    let s = reducer(floor(), { type: 'RECORD_STATES', floorId: 'f1', states: { d1: 'vacant', d3: 'temporarilyvacant' } });
    s = reducer(s, { type: 'RECORD_STATES', floorId: 'f1', states: { p2: 'reserved' }, merge: true });
    expect(s.recordStates).toEqual({ d1: 'vacant', d3: 'temporarilyvacant', p2: 'reserved' });
    s = reducer(s, { type: 'RECORD_STATES', floorId: 'f9', states: { x: 'reserved' } });
    expect(s.recordStates).toEqual({ d1: 'vacant', d3: 'temporarilyvacant', p2: 'reserved' });
    // The re-read after a Vacate replaces the lot.
    s = reducer(s, { type: 'RECORD_STATES', floorId: 'f1', states: { d1: 'temporarilyvacant' } });
    expect(s.recordStates).toEqual({ d1: 'temporarilyvacant' });
    expect(reducer(s, { type: 'SELECT_FLOOR_START', floorId: 'f2' }).recordStates).toEqual({});
  });
});

describe('a person in the People list', () => {
  it('shows the desk they hold on the plan on screen, else one they booked in the window, else nothing', () => {
    expect(spaceOfPerson(floor(), 'e1')?.id).toBe('d1');
    // A stall on the parking plan is not on the workstation plan on screen.
    expect(spaceOfPerson(floor(), 'e3')).toBeNull();
    expect(spaceOfPerson(floor({ planId: 'parking' }), 'e3')?.id).toBe('p1');
    // Booked a room in 09:00–10:00, not outside it.
    const bookings = [{ ...booking('r1'), host: 'e9' }, { ...booking('r2', 11 * 60, 12 * 60), host: 'e8' }];
    expect(spaceOfPerson(floor({ bookings }), 'e9')?.id).toBe('r1');
    expect(spaceOfPerson(floor({ bookings }), 'e8')).toBeNull();
  });

  it('finds an org booking, which names its booker in `by` and no host', () => {
    // As bookingRows maps a spacebooking row: reservedBy → `by`, no host on the row.
    const [org] = bookingSegmentsFromRow({ id: 77, space: { id: 'r2' }, reservedBy: { id: 'e7' }, bookingStartTime: Date.UTC(2026, 10, 13, 9, 0), bookingEndTime: Date.UTC(2026, 10, 13, 10, 0), name: 'Sync' } as never, 'UTC')!;
    expect(org).toMatchObject({ by: 'e7', unitId: 'r2', date: '2026-11-13', start: 540 });
    expect(org.host).toBeUndefined();
    expect(spaceOfPerson(floor({ bookings: [org] }), 'e7')?.id).toBe('r2');
  });

  it('answers every person the same from the one-pass map as from spaceOfPerson', () => {
    const bookings: Booking[] = [
      { ...booking('r1'), by: 'e1', host: 'e9' },
      { ...booking('r2'), by: 'e9' },
      { ...booking('d4'), by: 'e8' },
      { ...booking('d3', 11 * 60, 12 * 60), by: 'e6' },
      { ...booking('r2'), by: 'e6', host: 'e5' },
      { ...booking('r1'), by: '' },
    ];
    for (const s of [floor({ bookings }), floor({ bookings, planId: 'parking' }), floor({ bookings, enabledModules: { ...floor().enabledModules, room: false } })]) {
      const map = spacesByPerson(s);
      for (const id of ['e1', 'e2', 'e3', 'e5', 'e6', 'e7', 'e8', 'e9', 'nobody']) expect(map.get(id) ?? null).toBe(spaceOfPerson(s, id));
    }
  });
});

describe('a desk the org holds open, or a stall it reserved', () => {
  const states = { d4: 'temporarilyvacant', p2: 'reserved' };

  it('is called what the counts card calls it, in its pill, tooltip and name — a desk in its own colour', () => {
    const s = floor({ recordStates: states });
    const name = (id: string) => '';
    const d4 = s.units.find((u) => u.id === 'd4')!;
    const status = unitStatus(s, d4, name);
    expect(status.text).toBe('Temporarily vacant');
    expect(status.key).toBe('free');
    // Settings › Desks › States & colour coding: the Temporarily vacant colour, not the vacant one.
    expect(status.dot).toBe('#F59E0B');
    expect(unitStatus(floor(), d4, name).dot).toBe('#29A01E');
    expect(markerModel(s, d4).title).toContain('Temporarily vacant');
    expect(markerStyle(s, d4).bd).toBe('#F59E0B');
    expect(markerStyle(floor(), d4).bd).toBe('#29A01E');
    // The colour picked in Settings is the one drawn.
    expect(markerStyle({ ...s, moduleColors: { 'workstation.tempVacant': '#123456' } }, d4).bd).toBe('#123456');

    const p2 = s.units.find((u) => u.id === 'p2')!;
    expect(unitStatus({ ...s, planId: 'parking' }, p2, name).text).toBe('Reserved');
    // Held, it is theirs whatever its state; and a plain vacant desk stays "Vacant".
    expect(unitStatus({ ...s, recordStates: { d1: 'temporarilyvacant' } }, s.units[0], name).text).toMatch(/^Assigned/);
    expect(unitStatus(s, s.units.find((u) => u.id === 'd3')!, name).text).toBe('Vacant');
  });

  it('is keyed in the legend only on a floor that has one', () => {
    const keys = (st: ReturnType<typeof floor>) => legendItems(st).map((i) => i.key);
    expect(keys(floor({ recordStates: states }))).toContain('state:tempVacant');
    expect(keys(floor())).not.toContain('state:tempVacant');
    expect(legendItems(floor({ recordStates: states })).find((i) => i.key === 'state:tempVacant')?.color).toBe('#F59E0B');
  });
});

describe('department colours', () => {
  it('are resolved over the org’s department list once it has loaded, else over the floor’s', () => {
    const s = floor();
    expect(departmentColorIds(s)).toEqual(departmentsIn(s.units).map((d) => d.id));
    const org = [
      { id: '30', name: 'Accounts' },
      { id: '20', name: 'Engineering' },
      { id: '10', name: 'Finance' },
      { id: '40', name: 'Legal' },
    ];
    expect(departmentColorIds(floor({ departments: org }))).toEqual(['30', '20', '10', '40']);
  });

  it('give a department one default colour on the plan, its legend, the counts card and in Settings', () => {
    const org = [
      { id: '30', name: 'Accounts' },
      { id: '20', name: 'Engineering' },
      { id: '10', name: 'Finance' },
      { id: '40', name: 'Legal' },
    ];
    const s = floor({ departments: org, colorByView: 'department' });
    // What Settings draws for Finance: the org's list, as the swatch beside it.
    const settings = departmentColor('10', s.departmentColors, org.map((d) => d.id));
    expect(markerStyle(s, s.units[0]).bg).toBe(settings);
    expect(legendItems(s).find((i) => i.label === 'Finance')?.color).toBe(settings);
    expect(deskDepartmentCounts(s, '#29A01E').find((l) => l.name === 'Finance')?.color).toBe(settings);
  });

  it('leave the plan’s colours as they were where no org list is loaded (the demo data)', async () => {
    // Demo/local mode reads no department list (fetchDepartments answers [] without an org), so the
    // set is the floor's, exactly as the plan resolved it before: every seed desk keeps its colour.
    const { seedUnits } = await import('../lib/mockData');
    const units = seedUnits();
    const s = floor({ units, colorByView: 'department', departments: [] });
    const before = departmentsIn(units).map((d) => d.id);
    const desks = units.filter((u) => u.type === 'workstation' && u.department?.trim());
    expect(desks.length).toBeGreaterThan(0);
    for (const u of desks) {
      const key = u.departmentId || 'name:' + departmentKey(u.department!);
      expect(markerStyle(s, u).bg).toBe(departmentColor(key, s.departmentColors, before));
    }
  });
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

  it('splits each type into occupied, set aside and vacant or free — adding up to the total', () => {
    const [desks, stalls, rooms] = floorCounts(floor());
    expect(desks).toMatchObject({ occupied: 2, aside: 0, free: 2 }); // desks are not booked in this org: d4's booking leaves it vacant
    expect(stalls).toMatchObject({ occupied: 1, aside: 0, free: 1 });
    expect(rooms).toMatchObject({ occupied: 0, aside: 1, free: 1 }); // r1 booked in 09:00–10:00
    for (const r of floorCounts(floor())) expect(r.occupied + r.aside + r.free).toBe(r.total);
  });

  it("sets aside the desks whose record is Temporarily Vacant and the stalls whose record is Reserved — a holder first, whatever the state", () => {
    // d1 still names its holder beside the new state (the org clears it a moment later); d3 and d4
    // are emptied for now; a desk Reserved counts as vacant (only stalls are split by it); p2 reserved.
    const recordStates = { d1: 'temporarilyvacant', d3: 'temporarilyvacant', d4: 'reserved', p1: 'reserved', p2: 'reserved', r2: 'reserved' };
    const [desks, stalls, rooms] = floorCounts(floor({ recordStates }));
    expect(desks).toMatchObject({ total: 4, occupied: 2, aside: 1, free: 1 });
    expect(stalls).toMatchObject({ total: 2, occupied: 1, aside: 1, free: 0 });
    expect(rooms).toMatchObject({ occupied: 0, aside: 1, free: 1 }); // rooms go by bookings only
    for (const r of floorCounts(floor({ recordStates }))) expect(r.occupied + r.aside + r.free).toBe(r.total);
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

describe('the key', () => {
  it('keys two departments that print the same name apart, so both are drawn', async () => {
    const { render, cleanup } = await import('@testing-library/react');
    const { createElement } = await import('react');
    const twins = [
      point('t1', 'workstation', 'workstation', { department: 'Finance', departmentId: '10' }),
      point('t2', 'workstation', 'workstation', { department: 'Finance', departmentId: '11' }),
    ];
    const s = floor({ units: twins, colorByView: 'department' });
    const items = legendItems(s).filter((i) => i.label === 'Finance');
    expect(items).toHaveLength(2);
    expect(new Set(legendItems(s).map((i) => i.key)).size).toBe(legendItems(s).length);
    // Drawn as two entries — keyed by their label, React kept one and warned.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { LegendSwatch } = await import('../components/canvas/Legend');
    const { container } = render(createElement('div', null, legendItems(s).map((it) => createElement('span', { key: it.key }, createElement(LegendSwatch, { item: it }), it.label))));
    expect(container.textContent?.match(/Finance/g)).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    cleanup();
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
