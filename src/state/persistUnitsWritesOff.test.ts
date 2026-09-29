import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geometryStringToQuad, lngLatToQuadFraction } from '../lib/geoReference';
import type { Unit } from '../lib/types';

/**
 * Room outline WRITES ship off (featureFlags.ts: ROOM_OUTLINE_WRITES = false) while the READ path
 * ships on. These pin what "off" promises, with the flag at its real default — NOT mocked — and a
 * fake org that logs every request:
 *  - loading, editing, deleting, rebinding rooms, Save, Discard and Refresh send not one create,
 *    update or delete to `floorplanmarkedzone`, and nothing at all to `floorplanmarkedzone` or
 *    `space` outside the floor load's own reads;
 *  - the desk/locker/stall markers are written exactly as they would be with no room touched;
 *  - the toast names the rooms whose changes did not reach Facilio, and a reload draws the org's
 *    outline again.
 * The write path itself stays tested in markedZones.test.ts / persistUnits.test.ts, flag forced on.
 */

const FLOOR = '5150';
const PLAN = 26;
const PLAN_GEOMETRY =
  '{"type":"Polygon","coordinates":[[[-122.4194,37.7749],[-122.41871810384222,37.7749],[-122.41871810384222,37.77451928452979],[-122.4194,37.77451928452979],[-122.4194,37.7749]]]}';
const quad = geometryStringToQuad(PLAN_GEOMETRY)!;
const ZONE_GEOMETRY = JSON.stringify({
  type: 'Polygon',
  coordinates: [
    [
      [-122.41886365321331, 37.774807231822805],
      [-122.4188634431893, 37.77479393152785],
      [-122.4188, 37.77479393152785],
      [-122.4188, 37.774807231822805],
      [-122.41886365321331, 37.774807231822805],
    ],
  ],
});
/** A zone as the org returns it — onboarding's geoId `space-<id>` unless overridden. */
const zoneRecord = (id: number, spaceId: number | null, label: string, over: Record<string, unknown> = {}) => ({
  id,
  geoId: spaceId ? `space-${spaceId}` : 'k3v',
  type: 'Feature',
  geometry: ZONE_GEOMETRY,
  indoorfloorplan: { id: PLAN },
  isReservable: false,
  label,
  moduleId: 128724,
  properties: '{"unitType":"room","secondary":null}',
  recordId: spaceId,
  space: spaceId ? { id: spaceId } : null,
  zoneModuleId: 128279,
  ...over,
});
const DESK_AT: [number, number] = [-122.419, 37.7747];
const deskMarker = () => ({
  id: 777,
  geoId: '1001',
  label: 'WS-1',
  recordId: 1001,
  markerModuleId: 99999,
  properties: '{"unitType":"workstation","secondary":null}',
  geometry: JSON.stringify({ type: 'Point', coordinates: DESK_AT }),
  indoorfloorplan: { id: PLAN },
});

const org = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  /** Every request, in order: [method, module, detail]. */
  log: [] as [string, string, unknown][],
  nextId: 9000,
}));

vi.mock('../lib/facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  customGet: vi.fn(async (path: string) => {
    org.log.push(['customGet', path, null]);
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: { '1': { id: PLAN } } } };
    return { code: 1, message: `no count for ${path}` };
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number }) => {
      org.log.push(['fetchRecord', module, id]);
      if (module === 'indoorfloorplan') return { indoorfloorplan: { id, geometry: PLAN_GEOMETRY } };
      if (module === 'desks') return { desks: { id, moduleId: 99999 } };
      if (module === 'space') return { space: { id, moduleId: 128279 } };
      return { error: { code: 1, message: `unexpected ${module}` } };
    }),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string; id: number }, params: { page: number; perPage: number }) => {
      org.log.push(['relatedList', opts.relatedModuleName, opts.id]);
      const all = (org.tables[opts.relatedModuleName] ?? []).filter(
        (r) => !['floorplanmarkedzone', 'floorplanmarker'].includes(opts.relatedModuleName) || Number(r.indoorfloorplan?.id) === Number(opts.id),
      );
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
    // The writes change the tables, so a later read (Refresh) sees what a save really left.
    createRecord: vi.fn(async (module: string, { data }: { data: any }) => {
      org.log.push(['create', module, data]);
      const row = { id: org.nextId++, ...data };
      (org.tables[module] ??= []).push(row);
      return { error: null, [module]: row };
    }),
    updateRecord: vi.fn(async (module: string, { id, data }: { id: number; data: any }) => {
      org.log.push(['update', module, { id, ...data }]);
      const row = (org.tables[module] ?? []).find((r) => r.id === id);
      if (row) Object.assign(row, data);
      return { error: null };
    }),
    deleteRecord: vi.fn(async (module: string, id: number) => {
      org.log.push(['delete', module, id]);
      org.tables[module] = (org.tables[module] ?? []).filter((r) => r.id !== id);
      return { error: null };
    }),
  },
}));
vi.mock('../lib/dataSource', () => ({ dataSource: { saveUnits: vi.fn(async () => {}) } }));
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

/** A fresh copy of every module — the data source's per-floor memory and caches start empty. */
async function fresh() {
  vi.resetModules();
  const [flags, api, persist, reducerMod] = await Promise.all([
    import('../lib/featureFlags'),
    import('../lib/facilioApiDataSource'),
    import('./persistUnits'),
    import('./reducer'),
  ]);
  return { ...flags, ...api, ...persist, ...reducerMod };
}

type Mods = Awaited<ReturnType<typeof fresh>>;

/** Load the floor the way the app does: getUnits, then SELECT_FLOOR_DONE into edit mode. */
async function loadFloor(m: Mods) {
  const loaded = await new m.FacilioApiDataSource().getUnits(FLOOR);
  const start = { ...m.buildInitialState(), mode: 'edit' as const, floorId: FLOOR, planId: 'workstation' as const };
  return m.reducer(start, { type: 'SELECT_FLOOR_DONE', floorId: FLOOR, units: loaded, assignments: {}, bookings: [] });
}

const ZONE_OR_SPACE = new Set(['floorplanmarkedzone', 'space']);
/** Every request that touched a zone or a space record, since `from`. */
const zoneOrSpace = (from = 0) => org.log.slice(from).filter(([, module]) => ZONE_OR_SPACE.has(module));
const zoneWrites = () => org.log.filter(([method, module]) => module === 'floorplanmarkedzone' && ['create', 'update', 'delete'].includes(method));
const markerWrites = () => org.log.filter(([method, module]) => module === 'floorplanmarker' && ['create', 'update', 'delete'].includes(method));

const SQUARE: [number, number][] = [
  [0.1, 0.1],
  [0.3, 0.1],
  [0.3, 0.3],
  [0.1, 0.3],
];
const [deskX, deskY] = lngLatToQuadFraction(quad, DESK_AT[0], DESK_AT[1]);

beforeEach(() => {
  org.tables = {
    desks: [{ id: 1001, name: 'WS-1' }],
    lockers: [],
    parkingstall: [],
    space: [
      { id: 819848, name: 'MALE TOILET', spaceTypeEnum: 'SPACE' },
      { id: 819849, name: 'Meeting Room 2', spaceTypeEnum: 'SPACE' },
      { id: 819850, name: 'Pantry', spaceTypeEnum: 'SPACE' },
    ],
    floorplanmarker: [deskMarker()],
    floorplanmarkedzone: [
      zoneRecord(4945, 819848, 'Male Toilet'),
      zoneRecord(4946, 819849, 'Meeting Room 2'),
      // Drawn in Facilio's editor, naming no room: reads as `zone-4947`.
      zoneRecord(4947, null, 'Editor Zone'),
    ],
  };
  org.log = [];
  org.nextId = 9000;
});

describe('room outline writes ship off', () => {
  it('is off by default', async () => {
    const { ROOM_OUTLINE_WRITES } = await fresh();
    expect(ROOM_OUTLINE_WRITES).toBe(false);
  });

  it('still reads the org outlines on a floor load, and only reads', async () => {
    const m = await fresh();
    const state = await loadFloor(m);
    expect(state.units.map((u) => u.id).sort()).toEqual(['1001', '819848', '819849', 'zone-4947']);
    expect(state.unplacedUnits.map((u) => u.id)).toEqual(['819850']);
    expect(zoneOrSpace().every(([method]) => method === 'relatedList')).toBe(true);
    expect(zoneWrites()).toHaveLength(0);
  });
});

describe('with room outline writes off, nothing writes a zone', () => {
  it('load, edit a room, delete a room, rebind a room, Save, Discard, Refresh: zero zone writes, zero zone/space requests past the load', async () => {
    const m = await fresh();
    let state = await loadFloor(m);
    const afterLoad = org.log.length;

    // Edit: reshape and relabel an org room; relabel the editor's zone; move the desk.
    state = m.reducer(state, { type: 'UPDATE_UNIT', id: '819848', patch: { geom: { kind: 'poly', pts: SQUARE }, label: 'Male Toilet B' } });
    state = m.reducer(state, { type: 'UPDATE_UNIT', id: 'zone-4947', patch: { label: 'Editor Zone 2' } });
    state = m.reducer(state, { type: 'UPDATE_UNIT', id: '1001', patch: { geom: { kind: 'point', x: 0.6, y: 0.6 } } });
    // Delete an org room — it goes back to the pool — and rebind: drop the pooled Pantry onto the
    // editor zone's outline, so that outline now stands for Pantry and the zone's own room is gone.
    state = m.reducer(state, { type: 'DELETE_UNIT', id: '819849' });
    expect(state.unplacedUnits.some((u) => u.id === '819849')).toBe(true);
    state = m.reducer(state, { type: 'REPLACE_UNIT_AT', unitId: '819850', targetId: 'zone-4947' });

    // Save.
    const { floorId, units, savedUnits } = state;
    const outcome = await m.persistUnits(floorId, units, savedUnits);
    state = m.reducer(state, { type: 'MARK_SAVED', floorId, units, baseline: savedUnits, retry: outcome.roomsToRetry });
    expect(outcome.roomsToRetry).toEqual([]);
    // The editor zone was relabelled and then rebound away: it counts once, as the room it was.
    expect(outcome.roomsNotWritten.sort()).toEqual(['Editor Zone', 'Male Toilet B', 'Meeting Room 2', 'Pantry']);
    // The desk went through, as it would have with no room touched.
    expect(markerWrites()).toHaveLength(1);
    expect(markerWrites()[0]).toMatchObject(['update', 'floorplanmarker', { id: 777 }]);

    // Discard, after another room edit: the housekeeping re-persist of the saved snapshot.
    state = m.reducer(state, { type: 'UPDATE_UNIT', id: '819848', patch: { label: 'Scratch' } });
    state = m.reducer(state, { type: 'DISCARD_CHANGES' });
    const discarded = await m.persistUnits(state.floorId, state.savedUnits, state.savedUnits);
    expect(discarded.roomsNotWritten).toEqual([]);

    // Discard-and-switch after deleting a room: same housekeeping call.
    state = m.reducer(state, { type: 'DELETE_UNIT', id: '819848' });
    await m.persistUnits(state.floorId, state.savedUnits, state.savedUnits);

    // Up to here: not one request to a zone or a space.
    expect(zoneOrSpace(afterLoad)).toEqual([]);
    expect(zoneWrites()).toEqual([]);

    // Refresh: caches dropped, the floor read again. Reads only — and the org's outlines are back.
    m.invalidateOrgCaches();
    const beforeRefresh = org.log.length;
    const reread = await new m.FacilioApiDataSource().getUnits(FLOOR);
    expect(zoneOrSpace(beforeRefresh).every(([method]) => method === 'relatedList')).toBe(true);
    expect(zoneWrites()).toEqual([]);
    const toilet = reread.find((u) => u.id === '819848')!;
    expect(toilet.label).toBe('Male Toilet');
    expect(toilet.unplaced).toBeUndefined();
    expect(reread.find((u) => u.id === '819849')?.unplaced).toBeUndefined(); // the deleted room is drawn again
    expect(reread.find((u) => u.id === 'zone-4947')?.label).toBe('Editor Zone');
    expect(reread.find((u) => u.id === '819850')?.unplaced).toBe(true); // the rebind never reached the org
    expect(org.tables.floorplanmarkedzone.map((z) => z.id)).toEqual([4945, 4946, 4947]);
  });

  it('the zone sync itself refuses to send anything, if it is ever called', async () => {
    const m = await fresh();
    const state = await loadFloor(m);
    const afterLoad = org.log.length;
    const room = state.units.find((u) => u.id === '819848')!;
    const result = await m.saveFloorplanZones(FLOOR, [{ ...room, label: 'Renamed' }, { ...state.unplacedUnits[0], geom: { kind: 'poly', pts: SQUARE }, unplaced: undefined }], state.savedUnits);
    expect(org.log.slice(afterLoad)).toEqual([]);
    expect(result).toMatchObject({ plansSynced: 0, created: 0, updated: 0, deleted: 0, retryIds: [] });
    expect(result.roomsNotWritten.sort()).toEqual(['Editor Zone', 'Meeting Room 2', 'Pantry', 'Renamed']);
  });
});

describe('with room outline writes off, markers save exactly as they would with no room touched', () => {
  /** Load fresh, apply the edits, save; the marker writes that went out. */
  async function markersAfter(edit: (s: Awaited<ReturnType<typeof loadFloor>>, m: Mods) => Awaited<ReturnType<typeof loadFloor>>) {
    org.tables.floorplanmarker = [deskMarker()];
    org.log = [];
    const m = await fresh();
    const state = edit(await loadFloor(m), m);
    await m.persistUnits(state.floorId, state.units, state.savedUnits);
    return markerWrites();
  }
  const moveDesk = (s: Awaited<ReturnType<typeof loadFloor>>, m: Mods) => m.reducer(s, { type: 'UPDATE_UNIT', id: '1001', patch: { geom: { kind: 'point', x: 0.6, y: 0.6 } } });
  const placeLocker = (s: Awaited<ReturnType<typeof loadFloor>>, m: Mods) =>
    m.reducer(s, { type: 'ADD_UNIT', unit: { id: 'l-1', type: 'locker', label: 'L-1', room: null, geom: { kind: 'point', x: 0.2, y: 0.2 }, floor: FLOOR, plan: 'workstation' } });

  it('the same marker writes with and without room edits and deletes', async () => {
    const desksOnly = await markersAfter((s, m) => placeLocker(moveDesk(s, m), m));
    const withRooms = await markersAfter((s, m) => {
      let next = placeLocker(moveDesk(s, m), m);
      next = m.reducer(next, { type: 'UPDATE_UNIT', id: '819848', patch: { geom: { kind: 'poly', pts: SQUARE } } });
      next = m.reducer(next, { type: 'DELETE_UNIT', id: '819849' });
      return m.reducer(next, { type: 'DELETE_UNIT', id: 'zone-4947' });
    });
    expect(withRooms).toEqual(desksOnly);
    expect(desksOnly.map(([method]) => method).sort()).toEqual(['create', 'update']);
    expect(zoneWrites()).toEqual([]);
  });

  it('an untouched desk writes no marker, and an untouched floor says plain "Changes saved"', async () => {
    const m = await fresh();
    const state = await loadFloor(m);
    const outcome = await m.persistUnits(state.floorId, state.units, state.savedUnits);
    expect(markerWrites()).toEqual([]);
    expect(m.savedNotice(outcome)).toBe('Changes saved');
  });

  it('a save the markers could not reach is still reported as failed', async () => {
    const m = await fresh();
    const state = await loadFloor(m);
    const { facilioApi } = await import('../lib/facilioApi');
    vi.mocked(facilioApi.fetchRecord).mockImplementationOnce(async () => ({ error: { code: 500, message: 'down' } }) as any);
    const moved = m.reducer(state, { type: 'UPDATE_UNIT', id: '1001', patch: { geom: { kind: 'point', x: deskX, y: deskY + 0.1 } } });
    await expect(m.persistUnits(moved.floorId, moved.units, moved.savedUnits)).rejects.toThrow(/markers not written/);
    expect(zoneWrites()).toEqual([]);
  });
});

describe('with room outline writes off, the toast names the room changes that were not saved', () => {
  it('lists each changed room once, and says they did not reach Facilio', async () => {
    const m = await fresh();
    let state = await loadFloor(m);
    state = m.reducer(state, { type: 'UPDATE_UNIT', id: '819848', patch: { label: 'Male Toilet B' } });
    state = m.reducer(state, { type: 'DELETE_UNIT', id: '819849' });
    const outcome = await m.persistUnits(state.floorId, state.units, state.savedUnits);
    expect(m.savedNotice(outcome)).toBe('Saved — 2 room changes not saved to Facilio (room outlines are read-only for now): Male Toilet B, Meeting Room 2');
    expect(m.savedNotice({ roomsNotWritten: ['A', 'B', 'C', 'D', 'E'] })).toBe('Saved — 5 room changes not saved to Facilio (room outlines are read-only for now): A, B, C +2 more');
    expect(m.savedNotice({ roomsNotWritten: ['A'] })).toBe('Saved — 1 room change not saved to Facilio (room outlines are read-only for now): A');
  });

  it('counts every kind of outline change, and nothing that is not one', async () => {
    const m = await fresh();
    const state = await loadFloor(m);
    const base = state.savedUnits;
    const room = base.find((u) => u.id === '819848')!;
    const others = base.filter((u) => u.id !== '819848');
    const changes = (next: Unit[]) => m.roomOutlineChanges(FLOOR, next, base);

    expect(changes(base)).toEqual([]); // Discard
    expect(changes([...others, { ...room, geom: { kind: 'poly', pts: SQUARE } }])).toEqual(['Male Toilet']); // reshaped
    expect(changes([...others, { ...room, label: 'WC' }])).toEqual(['WC']); // relabelled
    expect(changes([...others, { ...room, plan: 'locker' }])).toEqual(['Male Toilet']); // moved plan
    expect(changes([...others, { ...room, plan: 'custom' }])).toEqual([]); // `custom` IS the workstation plan
    expect(changes(others)).toEqual(['Male Toilet']); // deleted
    expect(changes([...others, { ...room, unplaced: true, geom: { kind: 'poly', pts: [] } }])).toEqual(['Male Toilet']); // back to the pool
    // Rebound: the outline now stands for another record — the old one's is gone, the new one's added.
    expect(changes([...others, { ...room, id: '819850', label: 'Pantry' }]).sort()).toEqual(['Male Toilet', 'Pantry']);
    // Traced from the pool.
    expect(changes([...base, { id: '819850', type: 'room', label: 'Pantry', room: null, geom: { kind: 'poly', pts: SQUARE }, floor: FLOOR, plan: 'workstation' }])).toEqual(['Pantry']);
    // Not org outlines: a desk moved, a room minted in the app, another floor's room.
    expect(changes(base.map((u) => (u.id === '1001' ? { ...u, geom: { kind: 'point', x: 0.9, y: 0.9 } } : u)))).toEqual([]);
    expect(changes([...base, { id: 'r-local', type: 'room', label: 'Scratch', room: null, geom: { kind: 'poly', pts: SQUARE }, floor: FLOOR, plan: 'workstation' }])).toEqual([]);
    expect(changes([...base, { ...room, id: '819850', floor: '9999' }])).toEqual([]);
  });
});
