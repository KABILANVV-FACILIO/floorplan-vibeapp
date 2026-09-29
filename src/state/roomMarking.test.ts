import { describe, expect, it } from 'vitest';
import { buildInitialState, reducer } from './reducer';
import type { Unit } from '../lib/types';

/**
 * A room record in "Available to place" could not be marked on the plan at all: the sidebar row
 * was inert for zones, and arming a record forced the `select` tool, which has no way to collect a
 * polygon. These pin the path that replaces it — arm the record, trace the outline, and the
 * outline binds to THAT record rather than minting a second space for a room the org already has.
 */

const room = (over: Partial<Unit> = {}): Unit =>
  ({
    id: '783701',
    type: 'room',
    label: 'Internal Audit',
    room: null,
    geom: { kind: 'poly', pts: [] },
    floor: 'f1',
    plan: 'custom',
    unplaced: true,
    ...over,
  }) as Unit;

const desk = (over: Partial<Unit> = {}): Unit =>
  ({
    id: '1676023',
    type: 'workstation',
    label: 'WS-01',
    room: null,
    geom: { kind: 'point', x: 0, y: 0 },
    floor: 'f1',
    plan: 'workstation',
    unplaced: true,
    ...over,
  }) as Unit;

function withPool(units: Unit[]) {
  return { ...buildInitialState(), mode: 'edit' as const, floorId: 'f1', planId: 'workstation' as const, units: [], savedUnits: [], unplacedUnits: units };
}

describe('arming a record picks the right tool for its shape', () => {
  it('arms the room tool for a room, because a zone is traced not dropped', () => {
    const next = reducer(withPool([room()]), { type: 'SET_PLACING_UNIT', id: '783701' });
    expect(next.placingUnitId).toBe('783701');
    expect(next.tool).toBe('room');
  });

  it('arms the delivery tool for a delivery area', () => {
    const next = reducer(withPool([room({ id: 'd1', type: 'delivery' })]), { type: 'SET_PLACING_UNIT', id: 'd1' });
    expect(next.tool).toBe('delivery');
  });

  it('still arms select for a point record', () => {
    const next = reducer(withPool([desk()]), { type: 'SET_PLACING_UNIT', id: '1676023' });
    expect(next.placingUnitId).toBe('1676023');
    expect(next.tool).toBe('select');
  });

  it('keeps the record armed — the tool and the arming land in ONE update', () => {
    // SET_TOOL clears placingUnitId, so doing this as two dispatches disarmed the record and the
    // outline had nothing to bind to.
    const next = reducer(withPool([room()]), { type: 'SET_PLACING_UNIT', id: '783701' });
    expect(next.placingUnitId).not.toBeNull();
    expect(next.draft).toEqual([]);
  });

  it('disarming clears the record without forcing a tool', () => {
    const armed = reducer(withPool([room()]), { type: 'SET_PLACING_UNIT', id: '783701' });
    const off = reducer(armed, { type: 'SET_PLACING_UNIT', id: null });
    expect(off.placingUnitId).toBeNull();
    expect(off.tool).toBe('room'); // the draw tool stays; only the record is released
  });
});

describe('a traced room can change which record it stands for', () => {
  const pts: [number, number][] = [
    [0.1, 0.1],
    [0.4, 0.1],
    [0.4, 0.5],
  ];
  const onPlan = room({ id: '783701', label: 'Internal Audit', geom: { kind: 'poly', pts }, unplaced: undefined });
  const other = room({ id: '783702', label: 'Executive Meeting Room' });

  function planned() {
    return { ...withPool([other]), units: [onPlan], savedUnits: [onPlan] };
  }

  it('hands the outline to the picked record, without re-tracing it', () => {
    const next = reducer(planned(), { type: 'REPLACE_UNIT_AT', unitId: '783702', targetId: '783701' });

    const placed = next.units.find((u) => u.id === '783702');
    expect(placed).toBeDefined();
    expect(placed!.geom).toEqual({ kind: 'poly', pts }); // the same outline, not a fresh one
    expect(placed!.label).toBe('Executive Meeting Room');
    expect(next.units.find((u) => u.id === '783701')).toBeUndefined();
  });

  it('returns the record it displaced to Available to place', () => {
    const next = reducer(planned(), { type: 'REPLACE_UNIT_AT', unitId: '783702', targetId: '783701' });
    const pooled = next.unplacedUnits.find((u) => u.id === '783701');
    expect(pooled).toBeDefined();
    expect(pooled!.unplaced).toBe(true);
    expect(next.unplacedUnits.find((u) => u.id === '783702')).toBeUndefined();
  });

  it('selects the record that now holds the outline', () => {
    const next = reducer(planned(), { type: 'REPLACE_UNIT_AT', unitId: '783702', targetId: '783701' });
    expect(next.selected).toBe('783702');
  });

  it('refuses to swap a record with itself', () => {
    const before = planned();
    const next = reducer(before, { type: 'REPLACE_UNIT_AT', unitId: '783701', targetId: '783701' });
    expect(next).toBe(before);
  });
});

describe('the traced outline binds to the armed record', () => {
  it('moves the record out of the pool and onto the plan with its polygon', () => {
    const pts: [number, number][] = [
      [0.1, 0.1],
      [0.4, 0.1],
      [0.4, 0.5],
    ];
    const armed = reducer(withPool([room()]), { type: 'SET_PLACING_UNIT', id: '783701' });
    const placed = reducer(armed, { type: 'PLACE_EXISTING_UNIT', unitId: '783701', geom: { kind: 'poly', pts }, room: null });

    const unit = placed.units.find((u) => u.id === '783701');
    expect(unit).toBeDefined();
    expect(unit!.geom).toEqual({ kind: 'poly', pts });
    expect(unit!.label).toBe('Internal Audit'); // the org's name, not an auto-numbered RM-01
    expect(unit!.unplaced).toBeUndefined();
    expect(placed.unplacedUnits).toHaveLength(0);
  });

  it('scopes the traced zone to the plan it was drawn over', () => {
    // The outline's points are in THAT image's coordinates, so it belongs to that plan — the same
    // rule that stopped one room appearing on all three of a floor's floorplans.
    const armed = { ...reducer(withPool([room()]), { type: 'SET_PLACING_UNIT', id: '783701' }), planId: 'locker' as const };
    const placed = reducer(armed, {
      type: 'PLACE_EXISTING_UNIT',
      unitId: '783701',
      geom: { kind: 'poly', pts: [[0, 0], [1, 0], [1, 1]] as [number, number][] },
      room: null,
    });
    expect(placed.units.find((u) => u.id === '783701')!.plan).toBe('locker');
  });
});

describe('deleting a room that stands for an org space', () => {
  const pts: [number, number][] = [
    [0.1, 0.1],
    [0.4, 0.1],
    [0.4, 0.5],
  ];
  // Read back from the org's marked zones: a placed room under its space id.
  const fromOrg = room({ id: '819848', label: 'MALE TOILET', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined });
  const local = room({ id: 'u1699000000', label: 'RM-01', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined });
  const planned = () => ({ ...withPool([]), units: [fromOrg, local], savedUnits: [fromOrg, local] });

  it('returns the room to Available to place with its outline cleared, ready to trace again', () => {
    const next = reducer(planned(), { type: 'DELETE_UNIT', id: '819848' });
    expect(next.units.find((u) => u.id === '819848')).toBeUndefined();
    const pooled = next.unplacedUnits.find((u) => u.id === '819848');
    expect(pooled).toMatchObject({ unplaced: true, geom: { kind: 'poly', pts: [] }, label: 'MALE TOILET' });
  });

  it('still deletes a zone drawn only in the app outright', () => {
    const next = reducer(planned(), { type: 'DELETE_UNIT', id: 'u1699000000' });
    expect(next.unplacedUnits).toHaveLength(0);
  });

  it('un-places the same way in a bulk delete', () => {
    const next = reducer(planned(), { type: 'DELETE_UNITS', ids: ['819848', 'u1699000000'] });
    expect(next.units).toHaveLength(0);
    expect(next.unplacedUnits.map((u) => u.id)).toEqual(['819848']);
  });

  it('discarding the delete puts the room back on the plan and out of the pool', () => {
    const deleted = reducer(planned(), { type: 'DELETE_UNIT', id: '819848' });
    const reverted = reducer(deleted, { type: 'DISCARD_CHANGES' });
    expect(reverted.units.find((u) => u.id === '819848')?.geom).toEqual({ kind: 'poly', pts });
    expect(reverted.unplacedUnits.find((u) => u.id === '819848')).toBeUndefined();
  });
});

describe('the pool stays whole around a background load and a discard', () => {
  const pts: [number, number][] = [
    [0.1, 0.1],
    [0.4, 0.1],
    [0.4, 0.5],
  ];
  const fromOrg = room({ id: '819848', label: 'MALE TOILET', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined });

  it('keeps a room deleted before the rest of the floor arrived in Available to place', () => {
    const loaded = { ...withPool([]), units: [fromOrg], savedUnits: [fromOrg] };
    const deleted = reducer(loaded, { type: 'DELETE_UNIT', id: '819848' });
    // The background load predates the delete: it still reads the room as placed (its zone).
    const more = reducer(deleted, { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [fromOrg, desk({ id: '5001' })] });
    expect(more.units.find((u) => u.id === '819848')).toBeUndefined();
    expect(more.unplacedUnits.find((u) => u.id === '819848')).toMatchObject({ unplaced: true, geom: { kind: 'poly', pts: [] } });
    expect(more.unplacedUnits.map((u) => u.id).sort()).toEqual(['5001', '819848']);
  });

  it('puts a pool room traced since the save back in the pool on discard', () => {
    const traced = reducer(withPool([room()]), { type: 'PLACE_EXISTING_UNIT', unitId: '783701', geom: { kind: 'poly', pts }, room: null });
    expect(traced.unplacedUnits).toHaveLength(0);
    const reverted = reducer(traced, { type: 'DISCARD_CHANGES' });
    expect(reverted.units).toHaveLength(0);
    expect(reverted.unplacedUnits).toEqual([expect.objectContaining({ id: '783701', unplaced: true, geom: { kind: 'poly', pts: [] } })]);
  });

  it('puts a desk dropped from the pool since the save back too, and drops an app-minted unit', () => {
    const dropped = reducer(withPool([desk()]), { type: 'PLACE_EXISTING_UNIT', unitId: '1676023', geom: { kind: 'point', x: 0.5, y: 0.5 }, room: null });
    const minted = reducer(dropped, { type: 'CLOSE_DRAFT', unit: room({ id: 'u1699000001', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined }) });
    const reverted = reducer(minted, { type: 'DISCARD_CHANGES' });
    expect(reverted.units).toHaveLength(0);
    expect(reverted.unplacedUnits.map((u) => u.id)).toEqual(['1676023']);
  });
});

describe('a room deleted and saved before the rest of the floor arrived', () => {
  const pts: [number, number][] = [
    [0.1, 0.1],
    [0.4, 0.1],
    [0.4, 0.5],
  ];
  const fromOrg = room({ id: '819848', label: 'MALE TOILET', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined });
  const other = room({ id: '819849', label: 'Meeting Room 2', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined });

  it('stays off the plan and in the pool — the older load does not bring it back as saved', () => {
    const loaded = reducer({ ...withPool([]), floorId: 'f1' }, { type: 'SELECT_FLOOR_DONE', floorId: 'f1', units: [fromOrg, other], assignments: {}, bookings: [] });
    const deleted = reducer(loaded, { type: 'DELETE_UNIT', id: '819848' });
    const saved = reducer(deleted, { type: 'MARK_SAVED', floorId: 'f1', units: deleted.units, baseline: loaded.savedUnits });
    // The background pages were built from a read that started before the delete: the room is placed there.
    const more = reducer(saved, { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [fromOrg, other, desk({ id: '5001', unplaced: undefined, geom: { kind: 'point', x: 0.5, y: 0.5 } })] });
    expect(more.units.map((u) => u.id)).toEqual(['819849', '5001']);
    expect(more.savedUnits.map((u) => u.id)).toEqual(['819849', '5001']);
    expect(more.unplacedUnits.find((u) => u.id === '819848')).toMatchObject({ unplaced: true, geom: { kind: 'poly', pts: [] } });
    expect(more.unsavedChanges).toBe(0);
  });

  it('leaves a deleted desk exactly as before (only rooms are held back by the pool)', () => {
    const d = desk({ id: '5002', unplaced: undefined, geom: { kind: 'point', x: 0.5, y: 0.5 } });
    const loaded = reducer({ ...withPool([]), floorId: 'f1' }, { type: 'SELECT_FLOOR_DONE', floorId: 'f1', units: [d], assignments: {}, bookings: [] });
    const deleted = reducer(loaded, { type: 'DELETE_UNIT', id: '5002' });
    const saved = reducer(deleted, { type: 'MARK_SAVED', floorId: 'f1', units: deleted.units, baseline: loaded.savedUnits });
    const more = reducer(saved, { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [d] });
    expect(more.units.map((u) => u.id)).toEqual(['5002']);
  });
});

describe('MARK_SAVED marks what was sent, not what is on screen', () => {
  const pts: [number, number][] = [
    [0.1, 0.1],
    [0.4, 0.1],
    [0.4, 0.5],
  ];
  const x = room({ id: '819848', label: 'MALE TOILET', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined });
  const y = room({ id: '819849', label: 'Meeting Room 2', geom: { kind: 'poly', pts }, plan: 'workstation', unplaced: undefined });
  const start = () => ({ ...withPool([]), units: [x, y], savedUnits: [x, y] });

  it('keeps an edit made while the save was in flight unsaved', () => {
    const edited = reducer(start(), { type: 'UPDATE_UNIT', id: '819848', patch: { label: 'Male Toilet' } });
    const sent = edited.units;
    const during = reducer(edited, { type: 'DELETE_UNIT', id: '819849' }); // made while the save runs
    const done = reducer(during, { type: 'MARK_SAVED', floorId: 'f1', units: sent, baseline: [x, y] });
    expect(done.savedUnits.map((u) => u.id)).toEqual(['819848', '819849']);
    expect(done.savedUnits[0].label).toBe('Male Toilet');
    expect(done.unsavedChanges).toBe(1); // Y's delete was never sent
  });

  it('keeps a room whose write failed at its baseline, so the next Save sends it again', () => {
    const deleted = reducer(start(), { type: 'DELETE_UNIT', id: '819848' });
    const done = reducer(deleted, { type: 'MARK_SAVED', floorId: 'f1', units: deleted.units, baseline: [x, y], retry: ['819848'] });
    expect(done.savedUnits.find((u) => u.id === '819848')).toEqual(x);
    expect(done.unsavedChanges).toBe(1);
    // …and Discard now puts it back where the org still has it.
    expect(reducer(done, { type: 'DISCARD_CHANGES' }).units.find((u) => u.id === '819848')?.geom).toEqual({ kind: 'poly', pts });
  });

  it('leaves a room whose create failed out of the saved snapshot', () => {
    const traced = reducer({ ...withPool([room()]), units: [x], savedUnits: [x] }, { type: 'PLACE_EXISTING_UNIT', unitId: '783701', geom: { kind: 'poly', pts }, room: null });
    const done = reducer(traced, { type: 'MARK_SAVED', floorId: 'f1', units: traced.units, baseline: [x], retry: ['783701'] });
    expect(done.savedUnits.map((u) => u.id)).toEqual(['819848']);
    expect(done.unsavedChanges).toBe(1);
  });

  it('keeps what the background pages added and stamped during the save', () => {
    const s = start();
    const sent = s.units;
    const more = reducer(s, { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [desk({ id: '5001', unplaced: undefined, geom: { kind: 'point', x: 0.5, y: 0.5 } })] });
    const done = reducer(more, { type: 'MARK_SAVED', floorId: 'f1', units: sent, baseline: s.savedUnits });
    expect(done.savedUnits.map((u) => u.id)).toEqual(['819848', '819849', '5001']);
    expect(done.unsavedChanges).toBe(0);
  });

  it('ignores a save that finished after a floor switch', () => {
    const s = { ...start(), floorId: 'f2' };
    expect(reducer(s, { type: 'MARK_SAVED', floorId: 'f1', units: [], baseline: [] })).toBe(s);
  });
});
