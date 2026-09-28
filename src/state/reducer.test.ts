import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, which imports pdf.js's worker via `?url` —
// a Vite-only import form the test runner can't resolve. Nothing here touches PDFs.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { buildInitialState, reducer } from './reducer';

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
