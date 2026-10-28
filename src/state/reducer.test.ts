import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, which imports pdf.js's worker via `?url` —
// a Vite-only import form the test runner can't resolve. Nothing here touches PDFs.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { buildInitialState, reducer } from './reducer';
import { settingsFromState } from '../lib/settingsStore';

/**
 * Guards the property that makes a post-action refresh safe.
 *
 * Assign/vacate now re-read the whole floor so the sidebar and markers catch up, not just the
 * selected unit's record. That is only acceptable because re-reading the floor you are ALREADY on
 * leaves the selection alone — otherwise every assignment would close the popup you just acted in.
 * The refresh button depends on the same property, so this is worth pinning rather than assuming.
 */
describe('reducer: re-reading the current floor', () => {
  const withSelection = () => ({ ...buildInitialState(), floorId: 'f1', selected: 'u1' });

  it('keeps the selection when the floor is unchanged', () => {
    const next = reducer(withSelection(), { type: 'SELECT_FLOOR_START', floorId: 'f1' });
    expect(next.selected).toBe('u1');
  });

  it('still clears the selection when moving to a DIFFERENT floor', () => {
    const next = reducer(withSelection(), { type: 'SELECT_FLOOR_START', floorId: 'f2' });
    expect(next.selected).toBeNull();
  });

  it('keeps the selection when the floor load completes', () => {
    const next = reducer(withSelection(), {
      type: 'SELECT_FLOOR_DONE',
      floorId: 'f1',
      units: [],
      assignments: {},
      bookings: [],
    });
    expect(next.selected).toBe('u1');
  });

});

/**
 * The people lists show ONE secondary line under a name: department when the org sets one, else
 * client. The single-contact upsert resolves a name from a record summary and carries no
 * department, so it must not wipe the line off someone already in the directory.
 */

/**
 * A big floor is drawn from its first pages and the rest merges in when it arrives. The merge
 * adds; it never undoes what happened on screen in between.
 */
describe('reducer: the rest of a big floor', () => {
  const desk = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, type: 'workstation', label: id, room: null, geom: { kind: 'point', x: 0.1, y: 0.1 }, floor: 'f1', plan: 'workstation', ...over }) as never;
  const loaded = () =>
    reducer({ ...buildInitialState(), floorId: 'f1' }, { type: 'SELECT_FLOOR_DONE', floorId: 'f1', units: [desk('a'), desk('b')], assignments: { a: 'c1' }, bookings: [] });

  it('adds the markers from the later pages, as saved', () => {
    const next = reducer(loaded(), { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [desk('a'), desk('b'), desk('c')] });
    expect(next.units.map((u) => u.id)).toEqual(['a', 'b', 'c']);
    expect(next.savedUnits.map((u) => u.id)).toEqual(['a', 'b', 'c']);
    expect(next.unsavedChanges).toBe(0);
  });

  it('does not bring back a marker deleted in the meantime', () => {
    const state = { ...loaded(), units: loaded().units.filter((u) => u.id !== 'b') };
    const next = reducer(state, { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [desk('a'), desk('b'), desk('c')] });
    expect(next.units.map((u) => u.id)).toEqual(['a', 'c']);
  });

  it('gives an already-drawn marker the department its desk record carries', () => {
    const next = reducer(loaded(), { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [desk('a', { department: 'Finance', departmentId: '7' }), desk('b')] });
    expect(next.units.find((u) => u.id === 'a')).toMatchObject({ department: 'Finance', departmentId: '7' });
  });

  it('adds holders for the later records, and keeps what changed on screen', () => {
    const vacated = { ...loaded(), assignments: {} };
    const next = reducer(vacated, { type: 'FLOOR_ASSIGNMENTS_MORE', floorId: 'f1', assignments: { d: 'c9' } });
    expect(next.assignments).toEqual({ d: 'c9' });
  });

  it('ignores pages for a floor no longer on screen', () => {
    const state = loaded();
    const moved = { ...state, floorId: 'f2' };
    expect(reducer(moved, { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [desk('z')] })).toBe(moved);
  });
});

/**
 * The first responders list is read back from the settings file, which older builds wrote without
 * it and which nothing guards against hand edits. A bad entry must never be drawn as a responder.
 */
describe('reducer: first responders from saved settings', () => {
  it('keeps the list in state when the saved config has none', () => {
    const start = { ...buildInitialState(), firstResponders: [{ employeeId: 'e1', name: 'Ahmed', roles: ['firstAider' as const] }] };
    const next = reducer(start, { type: 'APPLY_SETTINGS', config: {} });
    expect(next.firstResponders).toEqual(start.firstResponders);
  });

  it('drops malformed entries and keeps the good ones', () => {
    const next = reducer(buildInitialState(), {
      type: 'APPLY_SETTINGS',
      config: { firstResponders: [{ employeeId: 'e1', name: 'Ahmed', roles: ['floorWarden'] }, { name: 'no id', roles: ['firstAider'] }, 'junk'] as never },
    });
    expect(next.firstResponders).toEqual([{ employeeId: 'e1', name: 'Ahmed', roles: ['floorWarden'] }]);
  });

  it('reads a blob that is not a list as nobody', () => {
    const next = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { firstResponders: { e1: 'Ahmed' } as never } });
    expect(next.firstResponders).toEqual([]);
  });
});

describe('reducer: responder roles', () => {
  const marshal = { id: 'r_fire_marshal', name: 'Fire marshal', plural: 'Fire marshals', color: '#D9480F', icon: 'flame' as const, shape: 'diamond' as const };

  it('keeps a person only under roles that still exist when a role is removed', () => {
    let s = reducer(buildInitialState(), { type: 'SET_RESPONDER_ROLES', roles: [...buildInitialState().responderRoles, marshal] });
    s = reducer(s, {
      type: 'SET_FIRST_RESPONDERS',
      responders: [
        { employeeId: 'e1', name: 'Ahmed', roles: ['firstAider', 'r_fire_marshal'] },
        { employeeId: 'e2', name: 'Mohammed', roles: ['r_fire_marshal'] },
      ],
    });
    expect(s.firstResponders.map((r) => [r.employeeId, r.roles])).toEqual([
      ['e1', ['firstAider', 'r_fire_marshal']],
      ['e2', ['r_fire_marshal']],
    ]);
    const after = reducer(s, { type: 'SET_RESPONDER_ROLES', roles: s.responderRoles.filter((r) => r.id !== 'r_fire_marshal') });
    expect(after.firstResponders.map((r) => [r.employeeId, r.roles])).toEqual([['e1', ['firstAider']]]);
  });

  it('never loses the built-in roles, whatever is saved', () => {
    const next = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { responderRoles: [marshal] } });
    expect(next.responderRoles.map((r) => r.id)).toEqual(['firstAider', 'floorWarden', 'r_fire_marshal']);
  });

  it('reads saved people against the saved roles, not the ones in state', () => {
    const next = reducer(buildInitialState(), {
      type: 'APPLY_SETTINGS',
      config: { responderRoles: [marshal], firstResponders: [{ employeeId: 'e2', name: 'Mohammed', roles: ['r_fire_marshal'] }] },
    });
    expect(next.firstResponders.map((r) => r.roles)).toEqual([['r_fire_marshal']]);
  });
});

/**
 * In a deployed app the responders come from the app database (lib/responderStore), loaded in
 * parallel with the settings blob. Whichever arrives second must not decide: once the database has
 * answered, it is the only source, and the blob neither overrides nor stores the responders.
 */
describe('reducer: responders from the app database', () => {
  const marshal = { id: 'r_fire_marshal', name: 'Fire marshal', plural: 'Fire marshals', color: '#D9480F', icon: 'flame' as const, shape: 'diamond' as const };
  const fromDb = () =>
    reducer(buildInitialState(), {
      type: 'RESPONDERS_LOADED',
      roles: [...buildInitialState().responderRoles, marshal],
      responders: [{ employeeId: '901', name: 'Ahmed', roles: ['firstAider', 'r_fire_marshal'] }],
    });

  it('takes the database answer as the source', () => {
    const s = fromDb();
    expect(s.respondersInDb).toBe(true);
    expect(s.responderRoles.map((r) => r.id)).toEqual(['firstAider', 'floorWarden', 'r_fire_marshal']);
    expect(s.firstResponders).toEqual([{ employeeId: '901', name: 'Ahmed', roles: ['firstAider', 'r_fire_marshal'] }]);
  });

  it('names responders as their employee records do, whichever loads first', () => {
    const records = [{ id: '901', name: 'Ahmed Al Busaeedi' }] as never;
    // Records after responders…
    expect(reducer(fromDb(), { type: 'EMPLOYEES_LOADED', employees: records }).firstResponders[0].name).toBe('Ahmed Al Busaeedi');
    // …and responders after records.
    const withRecords = reducer(buildInitialState(), { type: 'EMPLOYEES_LOADED', employees: records });
    const s = reducer(withRecords, { type: 'RESPONDERS_LOADED', roles: buildInitialState().responderRoles, responders: [{ employeeId: '901', name: 'Old name', roles: ['firstAider'] }] });
    expect(s.firstResponders[0].name).toBe('Ahmed Al Busaeedi');
  });

  it('ignores the settings blob once the database has answered, whichever loads last', () => {
    const next = reducer(fromDb(), {
      type: 'APPLY_SETTINGS',
      config: { labelStyle: undefined, responderRoles: [], firstResponders: [{ employeeId: 'e9', name: 'Stale', roles: ['floorWarden'] }] },
    });
    expect(next.firstResponders.map((r) => r.employeeId)).toEqual(['901']);
    expect(next.responderRoles.map((r) => r.id)).toContain('r_fire_marshal');
  });

  it('lets the database replace what the blob loaded first', () => {
    let s = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { firstResponders: [{ employeeId: 'e9', name: 'Stale', roles: ['floorWarden'] }] } });
    s = reducer(s, { type: 'RESPONDERS_LOADED', roles: buildInitialState().responderRoles, responders: [] });
    expect(s.firstResponders).toEqual([]);
  });

  it('leaves the responders out of the settings blob it saves', () => {
    expect(settingsFromState(fromDb())).not.toHaveProperty('firstResponders');
    expect(settingsFromState(fromDb())).not.toHaveProperty('responderRoles');
    expect(settingsFromState(buildInitialState())).toHaveProperty('firstResponders', []);
  });
});

/**
 * The access grid moved from the settings blob (which any browser can overwrite) to the app
 * database (which only the function writes, after checking the caller). Orgs configured it in the
 * blob first, so until an admin saves once the blob's grid still shows; from then on the database's.
 */
describe('reducer: the access grid in the app database', () => {
  const grid = { settings: { all: false, roles: ['3874'] } };

  it('sends saves to the database once it answers, but keeps the blob grid while the database holds none', () => {
    let s = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { access: grid } });
    s = reducer(s, { type: 'ACCESS_LOADED', access: {} });
    expect(s.accessInDb).toBe(true);
    expect(s.accessStoredInDb).toBe(false);
    expect(s.access).toEqual(grid);
    expect(settingsFromState(s)).toHaveProperty('access', grid);
  });

  it("makes the database's grid the only one once it holds one, whichever loads last", () => {
    let s = reducer(buildInitialState(), { type: 'ACCESS_LOADED', access: grid });
    s = reducer(s, { type: 'APPLY_SETTINGS', config: { access: { settings: { all: true, roles: [] } } } });
    expect(s.access).toEqual(grid);
    expect(settingsFromState(s)).not.toHaveProperty('access');
  });

  it('puts the grid back when a save is refused while the database holds none yet', () => {
    // The blob's grid governs until an admin saves once. A refused save was applied optimistically,
    // and the re-read brings back no grid to replace it — so the grid from before is restored, and
    // it is that one the settings blob is written with.
    const before = { people: { all: false, roles: ['412'] } };
    let s = reducer(buildInitialState(), { type: 'APPLY_SETTINGS', config: { access: before } });
    s = reducer(s, { type: 'ACCESS_LOADED', access: {} });
    s = reducer(s, { type: 'SET_ACCESS', access: grid }); // optimistic
    s = reducer(s, { type: 'ACCESS_LOADED', access: {} }); // the re-read after the refusal
    expect(s.access).toEqual(grid); // the re-read alone cannot undo it…
    s = reducer(s, { type: 'SET_ACCESS', access: before }); // …so the action restores what was there
    expect(s.access).toEqual(before);
    expect(settingsFromState(s)).toHaveProperty('access', before);
  });

  it('takes over from the blob when the first save is stored, and hands back on a reset', () => {
    let s = reducer(buildInitialState(), { type: 'ACCESS_LOADED', access: {} });
    s = reducer(s, { type: 'SET_ACCESS', access: grid });
    s = reducer(s, { type: 'ACCESS_STORED' });
    expect(s.accessStoredInDb).toBe(true);
    s = reducer(s, { type: 'RESET_ACCESS' });
    s = reducer(s, { type: 'ACCESS_STORED' });
    expect(s.accessStoredInDb).toBe(false);
    expect(settingsFromState(s)).toHaveProperty('access', {});
  });
});
