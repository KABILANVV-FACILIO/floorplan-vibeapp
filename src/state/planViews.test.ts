import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, which imports pdf.js's worker via `?url` —
// a Vite-only import form the test runner can't resolve. Nothing here touches PDFs.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildInitialState, permittedMode, reducer } from './reducer';
import { activeDepartment, bookingAllowed, canAssign, canBookFromCalendar, canSee, floorDepartments, markerLabelInputs, myAssignedUnit, unitDepartment } from './selectors';
import { markerModel } from '../lib/markerModel';
import { settingsFromState } from '../lib/settingsStore';
import { SURFACES, SURFACE_ORDER } from '../lib/types';
import type { Access, Employee, OrgRole, Unit } from '../lib/types';
import type { AppState } from './types';

/**
 * Three asks from ENEC's floor-plan review (2026-11-08):
 *  - "Your desk" only on the signed-in person's own desk;
 *  - a department filter on the plan;
 *  - Assignment and Booking each a setting, the plan a map when both are off — then (2026-11-09)
 *    rights in Roles & access, under Floorplans beside Edit, given role by role.
 */

const desk = (id: string, x: number, extra: Partial<Unit> = {}): Unit =>
  ({ id, type: 'workstation', label: `D-${id}`, geom: { kind: 'point', x, y: 0.5 }, floor: 'f1', plan: 'workstation', deskType: 'ASSIGNED', ...extra }) as Unit;

const people: Employee[] = [
  { id: '7', name: 'Omar Al Marri', department: 'Finance' },
  { id: '8', name: 'Priya Nair', department: 'Engineering' },
];

const floor = (over: Partial<AppState> = {}): AppState => ({
  ...buildInitialState(),
  floorId: 'f1',
  units: [desk('1', 0.1), desk('2', 0.2), desk('3', 0.3, { department: 'Legal Affairs' }), desk('4', 0.4), { id: 'st', type: 'amenity', label: 'Stairs', geom: { kind: 'point', x: 0.9, y: 0.5 }, floor: 'f1', plan: 'workstation' } as Unit],
  assignments: { '1': '7', '2': '8', '3': '8' },
  employees: people,
  ...over,
});

describe('"Your desk"', () => {
  it('is nobody\'s until Facilio says who is signed in', () => {
    const s = floor();
    expect(s.bookBy).toBe('');
    expect(myAssignedUnit(s)).toBeNull();
    expect(markerModel(s, s.units[0]).isMine).toBe(false);
  });

  it("is the signed-in person's own desk once they are known, and only that one", () => {
    const s = floor({ bookBy: '7' });
    expect(myAssignedUnit(s)?.id).toBe('1');
    expect(s.units.filter((u) => markerModel(s, u).isMine).map((u) => u.id)).toEqual(['1']);
  });

  it('is only ever on a desk: their parking stall says "Your parking", and a locker nothing', () => {
    // ENEC's accounts hold parking stalls: on the parking floor, the stall wore "Your desk".
    const stall = { id: 'p1', type: 'parking', label: 'ABU/EHQ/PKG/HQ-623', geom: { kind: 'point', x: 0.6, y: 0.5 }, floor: 'f1', plan: 'parking' } as Unit;
    const stall2 = { ...stall, id: 'p2', label: 'ABU/EHQ/PKG/HQ-624', geom: { kind: 'point', x: 0.65, y: 0.5 } } as Unit;
    const locker = { id: 'l1', type: 'locker', label: 'L-04', geom: { kind: 'point', x: 0.7, y: 0.5 }, floor: 'f1', plan: 'locker' } as Unit;
    const s = floor({ bookBy: '9', units: [...floor().units, stall, stall2, locker], assignments: { p1: '9', p2: '9', l1: '9' } });
    expect(myAssignedUnit(s)).toBeNull(); // My desk finds no desk here
    const pins = s.units.map((u) => markerModel(s, u)).filter((m) => m.isMine).map((m) => [m.unit.id, m.pinText]);
    expect(pins).toEqual([
      ['p1', 'Your parking'],
      ['p2', 'Your parking'],
    ]);
    expect(markerLabelInputs(s, s.units).find((l) => l.id === 'p1')).toMatchObject({ pill: true, pillText: 'Your parking' });
    // …and their desk, where they hold one too, whatever order the floor lists them in.
    const withDesk = { ...s, assignments: { p1: '9', l1: '9', '4': '9' } };
    expect(myAssignedUnit(withDesk)?.id).toBe('4');
    expect(markerModel(withDesk, withDesk.units[3]).pinText).toBe('Your desk');
    // Never on paper.
    expect(markerModel(s, stall, { personal: false }).isMine).toBe(false);
  });
});

describe('the department filter on the plan', () => {
  it("files a space under its own department, else its holder's", () => {
    const s = floor();
    expect(unitDepartment(s, s.units[0])).toBe('Finance'); // held by Omar
    expect(unitDepartment(s, s.units[2])).toBe('Legal Affairs'); // its own, though Priya holds it
    expect(unitDepartment(s, s.units[3])).toBeNull(); // free, and none of its own
  });

  it("offers the floor's departments, from desks and holders alike", () => {
    expect(floorDepartments(floor())).toEqual(['Engineering', 'Finance', 'Legal Affairs']);
  });

  it('dims the other departments on the plan, never a landmark, and keeps them clickable', () => {
    const s = floor({ spaceDepartment: 'Finance' });
    const dept = activeDepartment(s);
    expect(dept).toBe('Finance');
    const dimmed = s.units.filter((u) => markerModel(s, u, { department: dept }).isDimmed).map((u) => u.id);
    expect(dimmed).toEqual(['2', '3', '4']);
  });

  it("drops the other departments' cards, but not the selected desk's", () => {
    const s = floor({ spaceDepartment: 'Finance', selected: '2' });
    const ids = markerLabelInputs(s, s.units, { department: 'Finance' }).map((l) => l.id);
    expect(ids).toEqual(['1', '2', 'st']);
  });

  it('filters nothing for a department no longer on the floor', () => {
    expect(activeDepartment(floor({ spaceDepartment: 'Strategy & Planning' }))).toBeNull();
  });
});

const ADMIN: OrgRole = { id: '3873', name: 'CAFM Super Administrator', isAdmin: true };
const STAFF: OrgRole = { id: '4215', name: 'ENEC Executive' };
const everyone = { all: true, roles: [] };
const only = (...roles: string[]) => ({ all: false, roles });

/** A boot as the app does it: the role arrives, then the grid (from the app database). */
const signedIn = (role: OrgRole | null, access: Access = {}, over: Partial<AppState> = {}) =>
  reducer(reducer({ ...floor(), ...over }, { type: 'SET_VIEWER_ROLE', role }), { type: 'SET_ACCESS', access });

describe('Assignment and Booking as rights in Roles & access', () => {
  it('sit under Floorplans with Edit, in the grid and in the server function alike', () => {
    expect(SURFACES.filter((s) => s.parent === 'map').map((s) => s.id)).toEqual(['map.assign', 'map.book', 'map.edit']);
    expect(SURFACE_ORDER).not.toContain('map.assign'); // rights are never somewhere to land
    const fn = readFileSync(resolve(__dirname, '../../functions/floorplanResponders/code.ts'), 'utf8');
    for (const s of SURFACES) expect(fn).toContain(`'${s.id}'`);
  });

  it('start closed: the plan is a map with nothing to assign or book, admins included', () => {
    const s = signedIn(ADMIN);
    expect(s.planViews).toEqual({ assign: false, book: false });
    expect(s.mode).toBe('assign');
    expect(s.mobileTab).toBe('assign'); // not the Book tab's time strip without the right
    expect(canSee(s, 'settings')).toBe(true); // the admin still reaches Settings to grant them
  });

  it('are given role by role', () => {
    const grid: Access = { 'map.assign': only(STAFF.id), 'map.book': everyone };
    expect(signedIn(STAFF, grid).planViews).toEqual({ assign: true, book: true });
    expect(signedIn(ADMIN, grid).planViews).toEqual({ assign: false, book: true });
  });

  it('need the plan: a role without Floorplans holds no plan right', () => {
    const s = signedIn(STAFF, { map: only(ADMIN.id), 'map.assign': everyone });
    expect(canAssign(s)).toBe(false);
  });

  it('go to nobody we cannot place, unless open to everyone', () => {
    expect(signedIn(null, { 'map.assign': only(STAFF.id), 'map.book': only(STAFF.id) }).planViews).toEqual({ assign: false, book: false });
    expect(signedIn(null, { 'map.book': everyone }).planViews).toEqual({ assign: false, book: true });
    // Tabs keep the old rule: a missing role must never empty the app.
    expect(canSee(signedIn(null, { people: only(STAFF.id) }), 'people')).toBe(true);
  });

  it('never enter a view the role lacks', () => {
    expect(permittedMode({ assign: false, book: false }, 'book')).toBe('assign');
    expect(permittedMode({ assign: false, book: true }, 'assign')).toBe('book');
    expect(permittedMode({ assign: true, book: false }, 'book')).toBe('assign');
    expect(permittedMode({ assign: true, book: true }, 'book')).toBe('book');
    expect(permittedMode({ assign: false, book: false }, 'edit')).toBe('edit');
    expect(reducer(signedIn(STAFF), { type: 'SET_MODE', mode: 'book' }).mode).toBe('assign');
    expect(reducer(signedIn(STAFF, { 'map.book': everyone }), { type: 'SET_MODE', mode: 'book' }).mode).toBe('book');
  });

  it('move the plan, and the phone, off a view the grid takes away', () => {
    const both = signedIn(STAFF, { 'map.assign': everyone, 'map.book': everyone });
    expect(both.mode).toBe('assign');
    const bookOnly = reducer(both, { type: 'SET_ACCESS', access: { 'map.book': everyone } });
    expect(bookOnly.mode).toBe('book');
    expect(bookOnly.mobileTab).toBe('book');
    const none = reducer(bookOnly, { type: 'SET_ACCESS', access: {} });
    expect(none.mode).toBe('assign');
    expect(none.planViews).toEqual({ assign: false, book: false });
  });

  it('leave the Bookings tab to its own row, but take the booking form with the Booking right', () => {
    const s = signedIn(STAFF, { 'map.book': everyone }, { activeView: 'bookings' as const });
    const open = reducer(s, { type: 'SET_BOOK_FORM', form: { unitId: '1', date: '2026-11-08', start: 600, end: 660 } });
    expect(open.bookModalOpen).toBe(true);
    const next = reducer(open, { type: 'SET_ACCESS', access: {} });
    expect(canSee(next, 'bookings')).toBe(true); // the calendar is still theirs to look at
    expect(next.activeView).toBe('bookings');
    expect(next.bookForm).toBeNull();
    expect(next.bookModalOpen).toBe(false);
    // …and no way back into the form without the right.
    expect(reducer(next, { type: 'SET_BOOK_FORM', form: { unitId: '1', date: '2026-11-08', start: 600, end: 660 } }).bookForm).toBeNull();
    expect(reducer(next, { type: 'SET_BOOK_MODAL', open: true }).bookModalOpen).toBe(false);
  });

  it("put the phone back on its Book default once both are held, but keep a choice made between two", () => {
    const both = signedIn(STAFF, { 'map.assign': everyone, 'map.book': everyone });
    expect(both.mobileTab).toBe('book');
    const chose = reducer(both, { type: 'SET_MOBILE_TAB', tab: 'assign' });
    expect(reducer(chose, { type: 'SET_ACCESS', access: { 'map.assign': everyone, 'map.book': everyone, people: everyone } }).mobileTab).toBe('assign');
  });

  it('come back from leaving Edit to a view the role holds', () => {
    const s = { ...signedIn(STAFF, { 'map.book': everyone }), mode: 'edit' as const };
    expect(reducer(s, { type: 'TOGGLE_EDIT' }).mode).toBe('book');
  });

  it('follow a grid read from the settings blob too', () => {
    const applied = reducer(signedIn(STAFF), { type: 'APPLY_SETTINGS', config: { access: { 'map.book': everyone } } });
    expect(applied.planViews).toEqual({ assign: false, book: true });
    expect(applied.mode).toBe('book');
    // Nothing of the old org-wide switch is written any more.
    expect('planViews' in settingsFromState(applied)).toBe(false);
  });
});

describe('booking from the Bookings calendar (Bookings › Book)', () => {
  const slot = { unitId: '1', date: '2026-11-09', start: 600, end: 660, fromCalendar: true };

  it('is a right of its own under the Bookings tab, closed until granted', () => {
    expect(SURFACES.filter((s) => s.parent === 'bookings').map((s) => s.id)).toEqual(['bookings.book']);
    expect(canBookFromCalendar(signedIn(ADMIN))).toBe(false);
    expect(canBookFromCalendar(signedIn(STAFF, { 'bookings.book': only(STAFF.id) }))).toBe(true);
    expect(canBookFromCalendar(signedIn(null, { 'bookings.book': only(STAFF.id) }))).toBe(false);
    // …and needs the calendar itself.
    expect(canBookFromCalendar(signedIn(STAFF, { bookings: only(ADMIN.id), 'bookings.book': everyone }))).toBe(false);
  });

  it('lets a slot open the booking form without the plan’s Booking right, and only with its own', () => {
    const calendarOnly = signedIn(STAFF, { 'bookings.book': everyone });
    expect(calendarOnly.planViews.book).toBe(false);
    expect(reducer(calendarOnly, { type: 'SET_BOOK_FORM', form: slot }).bookForm).toEqual(slot);
    // The plan's form is still the plan's right.
    expect(reducer(calendarOnly, { type: 'SET_BOOK_FORM', form: { ...slot, fromCalendar: undefined } }).bookForm).toBeNull();
    const planOnly = signedIn(STAFF, { 'map.book': everyone });
    expect(reducer(planOnly, { type: 'SET_BOOK_FORM', form: slot }).bookForm).toBeNull();
    expect(bookingAllowed(planOnly, { ...slot, fromCalendar: undefined })).toBe(true);
  });

  it('closes a calendar booking form when the right is taken away', () => {
    const open = reducer(signedIn(STAFF, { 'bookings.book': everyone }), { type: 'SET_BOOK_FORM', form: slot });
    const next = reducer(open, { type: 'SET_ACCESS', access: {} });
    expect(next.bookForm).toBeNull();
    expect(next.bookModalOpen).toBe(false);
  });
});
