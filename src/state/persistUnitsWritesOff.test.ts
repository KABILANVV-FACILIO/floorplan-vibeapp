import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geometryStringToQuad, lngLatToQuadFraction } from '../lib/geoReference';
import type { Unit } from '../lib/types';

/**
 * Room outline WRITES have a switch (featureFlags.ts: ROOM_OUTLINE_WRITES — on since 2026-10-01)
 * while the READ path is always on. These pin what "off" promises, with the flag mocked OFF — so
 * it stays a working fallback should the writes have to be switched off again — and a fake org
 * that logs every request:
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
// The "off" path under test — the flag ships on (see featureFlags.ts).
vi.mock('../lib/featureFlags', () => ({ ROOM_OUTLINE_WRITES: false }));
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

describe('room outline writes, switched off', () => {
  it('reads as off in every module that asks', async () => {
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
    // Says the desks went through, the room changes did not — and that a reload undoes them. Never
    // "Saved — … not saved".
    expect(m.savedNotice(outcome)).toBe("Desks saved. 2 room changes can't be saved to Facilio yet and will be undone when you reload: Male Toilet B, Meeting Room 2");
    expect(m.savedNotice({ roomsNotWritten: ['A', 'B', 'C', 'D', 'E'] })).toBe("Desks saved. 5 room changes can't be saved to Facilio yet and will be undone when you reload: A, B, C +2 more");
    expect(m.savedNotice({ roomsNotWritten: ['A'] })).toBe("Desks saved. 1 room change can't be saved to Facilio yet and will be undone when you reload: A");
    expect(m.savedNotice(outcome)).not.toMatch(/^Saved/);
    // Held long enough to read — well past the 3.2 s of a plain toast.
    expect(m.ROOM_NOTICE_MS).toBeGreaterThanOrEqual(8000);
  });

  it('counts two rooms that share a name as two changes, and names them once with how many', async () => {
    org.tables.space.push({ id: 819851, name: 'Store', spaceTypeEnum: 'SPACE' }, { id: 819852, name: 'Store', spaceTypeEnum: 'SPACE' });
    org.tables.floorplanmarkedzone.push(zoneRecord(4948, 819851, 'Store'), zoneRecord(4949, 819852, 'Store'));
    const m = await fresh();
    let state = await loadFloor(m);
    state = m.reducer(state, { type: 'UPDATE_UNIT', id: '819851', patch: { geom: { kind: 'poly', pts: SQUARE } } });
    state = m.reducer(state, { type: 'UPDATE_UNIT', id: '819852', patch: { geom: { kind: 'poly', pts: SQUARE.map(([x, y]) => [x + 0.3, y] as [number, number]) } } });
    const outcome = await m.persistUnits(state.floorId, state.units, state.savedUnits);
    expect(outcome.roomsNotWritten).toEqual(['Store', 'Store']);
    expect(m.savedNotice(outcome)).toBe("Desks saved. 2 room changes can't be saved to Facilio yet and will be undone when you reload: Store ×2");
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

describe('a zone never takes the id of a desk — not even on a floor that loads in pages', () => {
  /**
   * The case a paged floor made dangerous: the desk's marker is on the SECOND page of markers (over
   * 500 on the plan), and a zone on the first page of zones names that desk's id — through
   * `recordId` alone, tied to a record of another module in Facilio's editor, or through
   * `space.id`, since in this org a desk is a space too. Read as a room under the desk's id, the
   * room filled the id before the marker arrived; FLOOR_UNITS_MORE then took the marker for known
   * and dropped it, and the next Save — which sends point units only — DELETED the desk's marker.
   */
  const fillers = () =>
    Array.from({ length: 500 }, (_, i) => ({
      ...deskMarker(),
      id: i + 1,
      geoId: `f-${i + 1}`,
      label: `F-${i + 1}`,
      recordId: null,
      markerModuleId: null,
    }));

  /** Load in pages the way the app does — first answer, then the rest through onMore — and Save. */
  async function loadPagedAndSave() {
    const m = await fresh();
    expect(m.ROOM_OUTLINE_WRITES).toBe(false);
    let rest: Unit[] = [];
    let arrived!: () => void;
    const more = new Promise<void>((r) => (arrived = r));
    const first = await new m.FacilioApiDataSource().getUnits(FLOOR, (u) => {
      rest = u;
      arrived();
    });
    const start = { ...m.buildInitialState(), mode: 'edit' as const, floorId: FLOOR, planId: 'workstation' as const };
    let state = m.reducer(start, { type: 'SELECT_FLOOR_DONE', floorId: FLOOR, units: first, assignments: {}, bookings: [] });
    await more;
    state = m.reducer(state, { type: 'FLOOR_UNITS_MORE', floorId: FLOOR, units: rest });
    org.log = [];
    await m.persistUnits(state.floorId, state.units, state.savedUnits);
    return { m, first, state, markerDeletes: org.log.filter(([method, module]) => method === 'delete' && module === 'floorplanmarker') };
  }

  beforeEach(() => {
    org.tables.floorplanmarker = [...fillers(), deskMarker()]; // desk 1001's marker: page 2
    org.tables.floorplanmarkedzone = [];
  });

  it('a zone tied to a record of another module by recordId alone reads as zone-<id>, and Save deletes no marker', async () => {
    org.tables.floorplanmarkedzone = [zoneRecord(4947, null, 'Editor Zone', { geoId: 'k3v', recordId: 1001, space: null, zoneModuleId: 99999 })];
    const { first, state, markerDeletes } = await loadPagedAndSave();
    expect(first.find((u) => u.id === '1001')).toBeUndefined();
    expect(first.find((u) => u.id === 'zone-4947')?.type).toBe('room');
    const desk = state.units.find((u) => u.id === '1001')!;
    expect(desk).toMatchObject({ type: 'workstation', geom: { kind: 'point' } });
    expect(state.savedUnits.find((u) => u.id === '1001')?.type).toBe('workstation');
    expect(markerDeletes).toEqual([]);
  });

  it('still reads a bare recordId as the room when the zone names the space module', async () => {
    org.tables.floorplanmarkedzone = [
      zoneRecord(4945, 819848, 'Male Toilet'), // an app zone: teaches the space module id
      zoneRecord(4946, null, 'Meeting Room 2', { geoId: 'k4v', recordId: 819849, space: null, zoneModuleId: 128279 }),
    ];
    const { first } = await loadPagedAndSave();
    expect(first.find((u) => u.id === '819849')?.type).toBe('room');
  });

  it('a zone whose space IS the desk is not drawn, and does not take the desk out of the pool', async () => {
    org.tables.floorplanmarker = fillers(); // the desk has no marker at all
    org.tables.floorplanmarkedzone = [zoneRecord(4948, 1001, 'Desk zone', { geoId: 'k5v' })];
    const m = await fresh();
    const state = await loadFloor(m);
    expect(state.units.find((u) => u.id === '1001')).toBeUndefined();
    expect(state.unplacedUnits.find((u) => u.id === '1001')?.type).toBe('workstation');
  });

  it('with the desk list paged too, the desk marker takes the room\'s place when its page lands, and Save deletes no marker', async () => {
    // 600 desks: desk 1001 is on the second page of `desks`, so the first pages cannot tell the
    // zone's space from a room — only the reducer, once the rest arrives, can.
    org.tables.desks = [...Array.from({ length: 599 }, (_, i) => ({ id: 20_000 + i, name: `D-${i}` })), { id: 1001, name: 'WS-1' }];
    org.tables.floorplanmarkedzone = [zoneRecord(4948, 1001, 'Desk zone', { geoId: 'k5v' })];
    const { first, state, markerDeletes } = await loadPagedAndSave();
    expect(first.find((u) => u.id === '1001')?.type).toBe('room'); // what the first pages could see
    expect(state.units.filter((u) => u.id === '1001')).toEqual([expect.objectContaining({ type: 'workstation', geom: expect.objectContaining({ kind: 'point' }) })]);
    expect(state.savedUnits.filter((u) => u.id === '1001').map((u) => u.type)).toEqual(['workstation']);
    expect(state.unplacedUnits.find((u) => u.id === '1001')).toBeUndefined();
    expect(state.unsavedChanges).toBe(0);
    expect(markerDeletes).toEqual([]);
  });
});

describe('a zone tied to a desk on a later page of `desks` leaves the plan once that page lands', () => {
  /**
   * 600 desks: desk 1001's record is on the second page of `desks`, so the first pages read an
   * editor zone (geoId not `space-…`) tied to it as room 1001. The full load knows better and drops
   * the zone. The room must go with it — kept, it held the id as placed: the desk was left out of
   * "Available to place" (when it has no marker) or drawn beside its marker (when the marker has an
   * id of its own), on every load.
   */
  const fillers = () =>
    Array.from({ length: 500 }, (_, i) => ({ ...deskMarker(), id: i + 1, geoId: `f-${i + 1}`, label: `F-${i + 1}`, recordId: null, markerModuleId: null }));

  async function loadPaged() {
    const m = await fresh();
    expect(m.ROOM_OUTLINE_WRITES).toBe(false);
    let rest: Unit[] = [];
    let arrived!: () => void;
    const more = new Promise<void>((r) => (arrived = r));
    const first = await new m.FacilioApiDataSource().getUnits(FLOOR, (u) => {
      rest = u;
      arrived();
    });
    const start = { ...m.buildInitialState(), mode: 'edit' as const, floorId: FLOOR, planId: 'workstation' as const };
    const drawn = m.reducer(start, { type: 'SELECT_FLOOR_DONE', floorId: FLOOR, units: first, assignments: {}, bookings: [] });
    await more;
    return { m, first, drawn, rest };
  }

  beforeEach(() => {
    org.tables.desks = [...Array.from({ length: 599 }, (_, i) => ({ id: 20_000 + i, name: `D-${i}` })), { id: 1001, name: 'WS-1' }];
    org.tables.floorplanmarkedzone = [zoneRecord(4948, 1001, 'Desk zone', { geoId: 'k5v' })];
  });

  it('an unmarked desk: the room goes, and the desk is offered in the pool', async () => {
    org.tables.floorplanmarker = fillers(); // desk 1001 has no marker
    const { m, first, drawn, rest } = await loadPaged();
    expect(first.find((u) => u.id === '1001')?.type).toBe('room'); // what the first pages could see
    const state = m.reducer(drawn, { type: 'FLOOR_UNITS_MORE', floorId: FLOOR, units: rest });
    expect(state.units.find((u) => u.id === '1001')).toBeUndefined();
    expect(state.savedUnits.find((u) => u.id === '1001')).toBeUndefined();
    expect(state.unplacedUnits.filter((u) => u.id === '1001').map((u) => u.type)).toEqual(['workstation']);
    expect(state.unplacedUnits.filter((u) => u.type === 'workstation')).toHaveLength(600); // every desk, as main lists them
    expect(state.unsavedChanges).toBe(0);
  });

  it('an unmarked desk whose room was deleted meanwhile: the pooled room goes too, and the desk takes its row', async () => {
    org.tables.floorplanmarker = fillers();
    const { m, drawn, rest } = await loadPaged();
    const deleted = m.reducer(drawn, { type: 'DELETE_UNIT', id: '1001' });
    expect(deleted.unplacedUnits.find((u) => u.id === '1001')?.type).toBe('room');
    const state = m.reducer(deleted, { type: 'FLOOR_UNITS_MORE', floorId: FLOOR, units: rest });
    expect(state.unplacedUnits.filter((u) => u.id === '1001').map((u) => u.type)).toEqual(['workstation']);
    expect(state.unsavedChanges).toBe(0);
  });

  it('a desk whose marker has another geoId ("3fp"): the room goes, the marker is drawn alone, and Save deletes nothing', async () => {
    org.tables.floorplanmarker = [...fillers(), { ...deskMarker(), id: 778, geoId: '3fp' }]; // page 2, recordId 1001
    const { m, drawn, rest } = await loadPaged();
    const state = m.reducer(drawn, { type: 'FLOOR_UNITS_MORE', floorId: FLOOR, units: rest });
    expect(state.units.find((u) => u.id === '1001')).toBeUndefined();
    expect(state.savedUnits.find((u) => u.id === '1001')).toBeUndefined();
    expect(state.units.find((u) => u.id === '3fp')).toMatchObject({ type: 'workstation', geom: { kind: 'point' } });
    expect(state.unplacedUnits.find((u) => u.id === '1001')).toBeUndefined(); // placed, by its marker
    expect(state.unsavedChanges).toBe(0);
    org.log = [];
    await m.persistUnits(state.floorId, state.units, state.savedUnits);
    expect(markerWrites()).toEqual([]);
  });

  it('a Save that the page lands during keeps the desk marker as saved, so Discard re-creates it', async () => {
    org.tables.floorplanmarker = [...fillers(), deskMarker()]; // desk 1001's marker: page 2
    const { m, drawn, rest } = await loadPaged();
    expect(drawn.units.find((u) => u.id === '1001')?.type).toBe('room');
    // Move a desk and press Save before page 2 lands: the snapshot holds the stand-in room.
    const moved = m.reducer(drawn, { type: 'UPDATE_UNIT', id: 'f-1', patch: { geom: { kind: 'point', x: 0.6, y: 0.6 } } });
    const { floorId, units, savedUnits } = moved;
    const outcome = await m.persistUnits(floorId, units, savedUnits);
    // Page 2 lands while the save is out; then the save finishes.
    let state = m.reducer(moved, { type: 'FLOOR_UNITS_MORE', floorId, units: rest });
    state = m.reducer(state, { type: 'MARK_SAVED', floorId, units, baseline: savedUnits, retry: outcome.roomsToRetry });
    expect(state.savedUnits.filter((u) => u.id === '1001').map((u) => u.type)).toEqual(['workstation']);
    expect(state.units.filter((u) => u.id === '1001').map((u) => u.type)).toEqual(['workstation']);
    expect(state.unsavedChanges).toBe(0);
    // Discard's housekeeping re-persists the saved snapshot: the marker the save took out comes back.
    state = m.reducer(state, { type: 'DISCARD_CHANGES' });
    await m.persistUnits(state.floorId, state.savedUnits, state.savedUnits);
    expect(org.tables.floorplanmarker.some((r) => String(r.geoId) === '1001')).toBe(true);
    expect(org.tables.floorplanmarker).toHaveLength(501);
  });
});

describe('org rooms are not offered for booking or assignment while room booking is not wired', () => {
  it('a loaded org room carries the zone\'s isReservable, and is neither bookable nor assignable', async () => {
    const m = await fresh();
    const selectors = await import('./selectors');
    const state = { ...(await loadFloor(m)), mode: 'book' as const };
    const toilet = state.units.find((u) => u.id === '819848')!;
    expect(toilet).toMatchObject({ isReservable: false, orgRoom: true });
    // BookPanel's list, and the 'N available' pill counted from it.
    const bookable = selectors.visibleUnits(state).filter(selectors.isBookable);
    expect(bookable.some((u) => u.type === 'room')).toBe(false);
    // Nor the other way round: `isReservable: false` must not make it assignable instead.
    expect(state.units.filter((u) => u.type === 'room').some(selectors.isAssignable)).toBe(false);
    // A room from the org's pool, once traced onto the plan, is an org room too.
    expect(state.unplacedUnits.find((u) => u.id === '819850')?.orgRoom).toBe(true);
    // Demo rooms keep their own rules.
    const demo: Unit = { id: 'r1', type: 'room', label: 'Demo', room: null, geom: { kind: 'poly', pts: SQUARE }, floor: FLOOR, plan: 'workstation' };
    expect(selectors.isBookable(demo)).toBe(true);
    expect(selectors.isAssignable({ ...demo, isReservable: false })).toBe(true);
  });
});

describe('a room traced on a floor with org outlines gets the name it always did', () => {
  it('RM-01 on a floor of three org rooms — the outlines drawn from the load are not counted', async () => {
    const m = await fresh();
    const selectors = await import('./selectors');
    const state = await loadFloor(m);
    expect(state.units.filter((u) => u.type === 'room')).toHaveLength(3); // the org's outlines, drawn
    // What closeDraft names the traced room, and so what create-space sends as its name.
    expect(selectors.nextLabel(state, 'room', 'RM')).toBe('RM-01');
    // A room traced here (not an org room) still counts, as it always has.
    const traced = m.reducer(state, {
      type: 'ADD_UNIT',
      unit: { id: 'u1', type: 'room', label: 'RM-01', room: null, geom: { kind: 'poly', pts: SQUARE }, floor: FLOOR, plan: 'workstation' },
    });
    expect(selectors.nextLabel(traced, 'room', 'RM')).toBe('RM-02');
    // Desks are numbered as before.
    expect(selectors.nextLabel(state, 'workstation', 'WS')).toBe('WS-02');
  });
});
