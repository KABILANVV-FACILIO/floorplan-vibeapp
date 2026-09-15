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
