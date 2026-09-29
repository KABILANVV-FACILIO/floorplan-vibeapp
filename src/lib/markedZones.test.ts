import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geometryStringToQuad, lngLatToQuadFraction } from './geoReference';
import type { Unit } from './types';

/**
 * Rooms read from, and written back to, the org's `floorplanmarkedzone` records.
 *
 * The org holds its room outlines as marked zones — onboarding wrote 353 of them, geoId
 * `space-<spaceId>` — yet the app read only point markers, so every room showed "Unplaced" and no
 * outline was ever drawn. These pin both halves: a real-shaped zone becomes a placed room under the
 * id the Rooms pool uses for it, and the save path creates, updates and deletes zones only within
 * the narrow rules that keep it from touching anything it doesn't own. The org is an in-memory
 * stand-in answering the same calls the real one does (relatedList pages, fetchRecord, CRUD).
 */

const FLOOR = '5150';
const PLAN = 26;
const SPACE_MODULE_ID = 128279;
const PLAN_GEOMETRY =
  '{"type":"Polygon","coordinates":[[[-122.4194,37.7749],[-122.41871810384222,37.7749],[-122.41871810384222,37.77451928452979],[-122.4194,37.77451928452979],[-122.4194,37.7749]]]}';
const quad = geometryStringToQuad(PLAN_GEOMETRY)!;

/** The zone record as the org returns it (the first two ring points are the live record's own). */
const zoneRecord = (over: Record<string, unknown> = {}) => ({
  id: 4945,
  geoId: 'space-819848',
  type: 'Feature',
  geometry: JSON.stringify({
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
  }),
  indoorfloorplan: { id: PLAN },
  isReservable: false,
  label: 'HQ-BKC-2F-MALE TOILET Common Area',
  moduleId: 128724,
  properties: '{"unitType":"room","secondary":null}',
  recordId: 819848,
  space: { id: 819848 },
  zoneModuleId: SPACE_MODULE_ID,
  ...over,
});

/** A zone drawn in Facilio's own editor: random geoId, and a frame near 0,0. */
const foreignOutOfFrame = () =>
  zoneRecord({
    id: 5001,
    geoId: '3fp',
    label: 'Editor room',
    recordId: 819860,
    space: { id: 819860 },
    geometry: JSON.stringify({ type: 'Polygon', coordinates: [[[-0.0002, 0.0001], [-0.0001, 0.0001], [-0.0001, 0.0002], [-0.0002, 0.0001]]] }),
  });

const org = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  /** Plan type -> indoorfloorplan record id, as getFloorplanDetailsByType answers. */
  plans: { '1': { id: 26 } } as Record<string, { id: number }>,
  failZones: false,
  spaceModuleId: 128279 as number | null,
  /** A space record's own type, when it is not a plain space (a desk read through `space`). */
  spaceTypes: {} as Record<number, { spaceTypeEnum: string; moduleId: number }>,
  /** Ids that answer through a point-record module (`desks`, `lockers`, `parkingstall`) — desks, in this org, are spaces too. */
  pointRecords: {} as Record<string, number[]>,
  /** Related-list pages that fail, by related module (`desks: [1]` fails the desk list's first page). */
  failPages: {} as Record<string, number[]>,
  failWrites: { create: false, update: false, delete: false },
  nextId: 9000,
  create: [] as { module: string; data: any }[],
  update: [] as { module: string; id: number; data: any }[],
  remove: [] as { module: string; id: number }[],
}));

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  customGet: vi.fn(async (path: string) => {
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: org.plans } };
    return { code: 1, message: `no count for ${path}` }; // counts unavailable: the loader pages on
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number }) => {
      if (module === 'indoorfloorplan') return { indoorfloorplan: { id, geometry: PLAN_GEOMETRY } };
      if (org.pointRecords[module]?.includes(id)) return { [module]: { id, moduleId: 99999 } };
      if (module === 'space' && org.spaceTypes[id]) return { space: { id, ...org.spaceTypes[id] } };
      if (module === 'space') return org.spaceModuleId ? { space: { id, moduleId: org.spaceModuleId } } : { error: { code: 1, message: 'nope' } };
      return { error: { code: 1, message: `unexpected ${module}` } };
    }),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string; id: number }, params: { page: number; perPage: number }) => {
      if (opts.relatedModuleName === 'floorplanmarkedzone' && org.failZones) return { error: { code: 500, message: 'zone list down' }, list: null };
      if (org.failPages[opts.relatedModuleName]?.includes(params.page)) return { error: { code: 429, message: 'slow down' }, list: null };
      // Zones belong to one plan each — a floor with two plans answers each plan with its own.
      const all = (org.tables[opts.relatedModuleName] ?? []).filter((r) => opts.relatedModuleName !== 'floorplanmarkedzone' || Number(r.indoorfloorplan?.id) === Number(opts.id));
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
    createRecord: vi.fn(async (module: string, { data }: { data: any }) => {
      if (org.failWrites.create) return { error: { code: 500, message: 'create down' } };
      org.create.push({ module, data });
      const id = org.nextId++;
      return { error: null, [module]: { id, ...data } };
    }),
    updateRecord: vi.fn(async (module: string, { id, data }: { id: number; data: any }) => {
      if (org.failWrites.update) return { error: { code: 500, message: 'update down' } };
      org.update.push({ module, id, data });
      return { error: null };
    }),
    deleteRecord: vi.fn(async (module: string, id: number) => {
      if (org.failWrites.delete) return { error: { code: 429, message: 'slow down' } };
      org.remove.push({ module, id });
      return { error: null };
    }),
  },
}));
// Room outline WRITES ship off (featureFlags.ts); the write path is pinned here with them forced on,
// so it stays tested until the flag flips. The read path does not look at the flag.
vi.mock('./featureFlags', () => ({ ROOM_OUTLINE_WRITES: true }));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

/** A fresh copy of the data source — its per-floor memory (which rooms a read produced) starts empty. */
async function fresh() {
  vi.resetModules();
  return import('./facilioApiDataSource');
}

beforeEach(() => {
  org.tables = {
    desks: [],
    lockers: [],
    parkingstall: [],
    space: [
      { id: 819848, name: 'MALE TOILET', spaceTypeEnum: 'SPACE' },
      { id: 819849, name: 'Meeting Room 2', spaceTypeEnum: 'SPACE' },
      { id: 819850, name: 'Pantry', spaceTypeEnum: 'SPACE' },
    ],
    floorplanmarker: [],
    floorplanmarkedzone: [zoneRecord()],
  };
  org.plans = { '1': { id: PLAN } };
  org.failZones = false;
  org.spaceModuleId = SPACE_MODULE_ID;
  org.spaceTypes = {};
  org.pointRecords = {};
  org.failPages = {};
  org.failWrites = { create: false, update: false, delete: false };
  org.create = [];
  org.update = [];
  org.remove = [];
});

const zones = <T extends { module: string }>(calls: T[]): T[] => calls.filter((c) => c.module === 'floorplanmarkedzone');
const traced = (id: string, pts: [number, number][], over: Partial<Unit> = {}): Unit => ({
  id,
  type: 'room',
  label: `Room ${id}`,
  room: null,
  geom: { kind: 'poly', pts },
  floor: FLOOR,
  plan: 'workstation',
  ...over,
});
const SQUARE: [number, number][] = [
  [0.1, 0.1],
  [0.3, 0.1],
  [0.3, 0.3],
  [0.1, 0.3],
];

describe('a marked zone reads back as a placed room', () => {
  it('converts the real record through the plan quad: 0-1 points, closing point dropped, id = space id', async () => {
    const { markedZoneToUnit } = await fresh();
    const read = markedZoneToUnit(zoneRecord(), quad, FLOOR, 'workstation');
    expect('unit' in read).toBe(true);
    const unit = (read as { unit: Unit }).unit;
    expect(unit.id).toBe('819848');
    expect(unit.type).toBe('room');
    expect(unit.label).toBe('HQ-BKC-2F-MALE TOILET Common Area');
    expect(unit.plan).toBe('workstation');
    expect(unit.floor).toBe(FLOOR);
    expect(unit.room).toBeNull();
    expect(unit.unplaced).toBeUndefined();
    if (unit.geom.kind !== 'poly') throw new Error('expected a polygon');
    expect(unit.geom.pts).toHaveLength(4); // five stored points, the last repeating the first
    for (const [x, y] of unit.geom.pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
    // Literal, not derived through geoReference — a frame error there (a flipped y axis, tl/bl read
    // wrong from the ring) must fail here rather than cancel out.
    expect(unit.geom.pts[0][0]).toBeCloseTo(0.786552, 5);
    expect(unit.geom.pts[0][1]).toBeCloseTo(0.243668, 5);
    const [x0, y0] = lngLatToQuadFraction(quad, -122.41886365321331, 37.774807231822805);
    expect(unit.geom.pts[0][0]).toBeCloseTo(x0, 9);
    expect(unit.geom.pts[0][1]).toBeCloseTo(y0, 9);
  });

  it('reads a delivery area as one, and anything else in unitType as a room', async () => {
    const { markedZoneToUnit } = await fresh();
    const delivery = markedZoneToUnit(zoneRecord({ properties: '{"unitType":"delivery"}' }), quad, FLOOR, 'workstation');
    expect((delivery as { unit: Unit }).unit.type).toBe('delivery');
    const junk = markedZoneToUnit(zoneRecord({ properties: '{"unitType":"workstation"}' }), quad, FLOOR, 'workstation');
    expect((junk as { unit: Unit }).unit.type).toBe('room');
  });

  it('falls back to a zone- id when the zone names no space', async () => {
    const { markedZoneToUnit } = await fresh();
    const read = markedZoneToUnit(zoneRecord({ space: null, recordId: null }), quad, FLOOR, 'workstation');
    expect((read as { unit: Unit }).unit.id).toBe('zone-4945');
  });

  it('skips a zone drawn in another frame, and malformed ones', async () => {
    const { markedZoneToUnit } = await fresh();
    expect(markedZoneToUnit(foreignOutOfFrame(), quad, FLOOR, 'workstation')).toEqual({ skipped: 'outOfFrame' });
    const bad = [
      zoneRecord({ geometry: 'not json' }),
      zoneRecord({ geometry: '{"type":"Point","coordinates":[-122.4189,37.7748]}' }),
      zoneRecord({ geometry: '{"type":"Polygon","coordinates":[[[-122.4189,37.7748],[-122.4188,37.7748],[-122.4189,37.7748]]]}' }), // 2 points + closing
      zoneRecord({ geometry: null }),
    ];
    for (const z of bad) expect(markedZoneToUnit(z, quad, FLOOR, 'workstation')).toEqual({ skipped: 'malformed' });
  });
});

describe('a floor load draws the org rooms', () => {
  it('places the outlined room and takes it out of the unplaced pool', async () => {
    org.tables.floorplanmarkedzone = [zoneRecord(), foreignOutOfFrame()];
    const { FacilioApiDataSource } = await fresh();
    const units = await new FacilioApiDataSource().getUnits(FLOOR);

    const rooms = units.filter((u) => u.id === '819848');
    expect(rooms).toHaveLength(1); // once — placed, not also "Unplaced"
    expect(rooms[0].unplaced).toBeUndefined();
    expect(rooms[0].geom.kind).toBe('poly');
    expect(rooms[0].plan).toBe('workstation');
    // The room without an outline is still in the pool, and the editor's zone drew nothing.
    expect(units.find((u) => u.id === '819849')?.unplaced).toBe(true);
    expect(units.filter((u) => !u.unplaced)).toHaveLength(1);
  });

  it('still loads the floor when the zone list fails — the rooms simply read as unplaced', async () => {
    org.failZones = true;
    const { FacilioApiDataSource } = await fresh();
    const units = await new FacilioApiDataSource().getUnits(FLOOR);
    expect(units.find((u) => u.id === '819848')?.unplaced).toBe(true);
    expect(units.filter((u) => !u.unplaced)).toHaveLength(0);
  });

  it('draws the first page of outlines at once and hands the rest over through onMore', async () => {
    // 600 rooms, each outlined: the zone list is longer than one related-list page (500).
    org.tables.space = Array.from({ length: 600 }, (_, i) => ({ id: 700000 + i, name: `R${i}`, spaceTypeEnum: 'SPACE' }));
    org.tables.floorplanmarkedzone = org.tables.space.map((s, i) => zoneRecord({ id: 20000 + i, geoId: `space-${s.id}`, recordId: s.id, space: { id: s.id }, label: s.name }));
    const { FacilioApiDataSource } = await fresh();
    let more: Unit[] | null = null;
    const first = await new FacilioApiDataSource().getUnits(FLOOR, (u) => (more = u));
    expect(first).toHaveLength(500);
    await vi.waitFor(() => expect(more).not.toBeNull());
    const all = more as unknown as Unit[];
    expect(all.filter((u) => !u.unplaced)).toHaveLength(600);
    expect(all.filter((u) => u.unplaced)).toHaveLength(0);
  });
});

describe('one room, more than one zone', () => {
  it('draws a room outlined on two plans once, from the first plan in type order', async () => {
    org.plans = { '1': { id: PLAN }, '2': { id: 27 } };
    org.tables.floorplanmarkedzone = [zoneRecord(), zoneRecord({ id: 4946, indoorfloorplan: { id: 27 } })];
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    const rooms = loaded.filter((u) => u.id === '819848');
    expect(rooms).toHaveLength(1);
    expect(rooms[0].plan).toBe('workstation');

    // Saved back unchanged: the locker plan's copy is neither rewritten nor deleted.
    const placed = loaded.filter((u) => !u.unplaced);
    await saveFloorplanZones(FLOOR, placed, placed);
    expect(org.update.length + org.remove.length + org.create.length).toBe(0);

    // Removed: the zone it was shown from goes, and so does its hidden copy on the locker plan —
    // left there, it would draw the room on that plan on the next read.
    const r = await saveFloorplanZones(FLOOR, [], placed);
    expect(org.remove.map((x) => x.id).sort()).toEqual([4945, 4946]);
    expect(r.roomsNotWritten).toEqual([]);
  });

  it('keeps the copy on the other plan when the room only moved plans, and never deletes an editor copy there', async () => {
    org.plans = { '1': { id: PLAN }, '2': { id: 27 } };
    org.tables.floorplanmarkedzone = [zoneRecord(), zoneRecord({ id: 4946, indoorfloorplan: { id: 27 } }), zoneRecord({ id: 4948, geoId: 'q9z', indoorfloorplan: { id: 27 } })];
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const placed = (await new FacilioApiDataSource().getUnits(FLOOR)).filter((u) => !u.unplaced);
    const moved = placed.map((u) => (u.id === '819848' ? { ...u, plan: 'locker' as const } : u));
    await saveFloorplanZones(FLOOR, moved, placed);
    expect(org.remove).toEqual([{ module: 'floorplanmarkedzone', id: 4945 }]); // off the workstation plan only

    org.remove = [];
    const r = await saveFloorplanZones(FLOOR, [], placed);
    expect(org.remove.map((x) => x.id).sort()).toEqual([4945, 4946]); // never 4948, the editor's
    expect(r.roomsNotWritten).toEqual([]); // and a copy that was never on screen is no news
  });

  it('keeps duplicate app zones on one plan to one outline, and deletes them all with the room', async () => {
    org.tables.floorplanmarkedzone = [zoneRecord(), zoneRecord({ id: 4947 })]; // onboarding ran twice
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    expect(loaded.filter((u) => u.id === '819848')).toHaveLength(1);
    const placed = loaded.filter((u) => !u.unplaced);

    const reshaped = placed.map((u) => (u.id === '819848' ? { ...u, geom: { kind: 'poly' as const, pts: SQUARE } } : u));
    const r1 = await saveFloorplanZones(FLOOR, reshaped, placed);
    expect(r1.updated).toBe(2);
    expect(zones(org.update).map((u) => u.id).sort()).toEqual([4945, 4947]);

    const r2 = await saveFloorplanZones(FLOOR, [], reshaped);
    expect(r2.deleted).toBe(2);
    expect(org.remove.map((r) => r.id).sort()).toEqual([4945, 4947]);
  });
});

describe('saving room outlines', () => {
  /** Load the floor the way the app does; `placed` is what SELECT_FLOOR_DONE makes the saved snapshot. */
  async function loadFloor() {
    const mod = await fresh();
    const loaded = await new mod.FacilioApiDataSource().getUnits(FLOOR);
    return { ...mod, loaded, placed: loaded.filter((u) => !u.unplaced) };
  }

  it('creates a zone for a room traced onto the plan — app geoId, closed ring, never reservable', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();

    const result = await saveFloorplanZones(FLOOR, [...placed, traced('819849', SQUARE, { label: 'Meeting Room 2' })], placed);

    expect(result).toMatchObject({ plansSynced: 1, created: 1, updated: 0, deleted: 0, skipped: [], plansSkipped: 0, roomsNotWritten: [] });
    const [create] = zones(org.create);
    expect(create.data).toMatchObject({
      geoId: 'space-819849',
      type: 'Feature',
      label: 'Meeting Room 2',
      indoorfloorplan: { id: PLAN },
      space: { id: 819849 },
      recordId: 819849,
      zoneModuleId: SPACE_MODULE_ID,
      isReservable: false,
    });
    expect(JSON.parse(create.data.properties)).toEqual({ unitType: 'room', secondary: null });
    const ring: [number, number][] = JSON.parse(create.data.geometry).coordinates[0];
    expect(JSON.parse(create.data.geometry).type).toBe('Polygon');
    expect(ring).toHaveLength(5);
    expect(ring[4]).toEqual(ring[0]); // closed
    // (0.3, 0.3) of the plan, by hand from the quad: 0.3 of its width east of tl, 0.3 of its height south.
    expect(ring[2][0]).toBeCloseTo(-122.4194 + 0.3 * 0.00068189616, 10);
    expect(ring[2][1]).toBeCloseTo(37.7749 - 0.3 * 0.00038071547, 10);
    const [x, y] = lngLatToQuadFraction(quad, ring[2][0], ring[2][1]);
    expect(x).toBeCloseTo(0.3, 9);
    expect(y).toBeCloseTo(0.3, 9);
    // Nothing else was touched: the loaded room was unchanged, and no marker call was made.
    expect(org.update).toHaveLength(0);
    expect(org.remove).toHaveLength(0);
    expect(org.create.filter((c) => c.module !== 'floorplanmarkedzone')).toHaveLength(0);
  });

  it('takes zoneModuleId from the app zones already on the plan, and refuses a record in another module', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    await saveFloorplanZones(FLOOR, [...placed, traced('819849', SQUARE)], placed);
    expect(zones(org.create)[0].data.zoneModuleId).toBe(SPACE_MODULE_ID);

    // A desk read through `space`: SPACE-typed like every desk here, but in its own module.
    org.spaceTypes[819850] = { spaceTypeEnum: 'SPACE', moduleId: 99999 };
    const r = await saveFloorplanZones(FLOOR, [...placed, traced('819850', SQUARE, { label: 'WS-9' })], placed);
    expect(r.created).toBe(0);
    expect(r.roomsNotWritten).toEqual(['WS-9']);
    expect(zones(org.create)).toHaveLength(1);
  });

  it('never keeps a module id read from a record for the next zone', async () => {
    org.tables.floorplanmarkedzone = []; // no app zone to learn the space module id from
    const { saveFloorplanZones } = await loadFloor();
    org.spaceModuleId = 55555;
    await saveFloorplanZones(FLOOR, [traced('819849', SQUARE)]);
    org.spaceModuleId = SPACE_MODULE_ID;
    await saveFloorplanZones(FLOOR, [traced('819850', SQUARE)]);
    expect(zones(org.create).map((c) => [c.data.recordId, c.data.zoneModuleId])).toEqual([
      [819849, 55555],
      [819850, SPACE_MODULE_ID],
    ]);
  });

  it('writes nothing — and asks for nothing — for a room read back and saved unchanged', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    const { facilioApi } = await import('./facilioApi');
    const reads = vi.mocked(facilioApi.fetchAllRelatedList).mock.calls.length;
    const result = await saveFloorplanZones(FLOOR, placed, placed);
    expect(result).toMatchObject({ plansSynced: 0, created: 0, updated: 0, deleted: 0, roomsNotWritten: [] });
    expect(org.create.length + org.update.length + org.remove.length).toBe(0);
    expect(vi.mocked(facilioApi.fetchAllRelatedList).mock.calls.length).toBe(reads);
  });

  it('writes nothing on Discard or an unrelated save, though the zone changed in the org since the read', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: FLOOR, plan: 'workstation' };
    // Reshaped elsewhere (another tab, the onboarding's shape update) after this floor was read.
    const reshaped = JSON.stringify({ type: 'Polygon', coordinates: [[[-122.4189, 37.7748], [-122.4188, 37.7748], [-122.4188, 37.7747], [-122.4189, 37.7748]]] });
    org.tables.floorplanmarkedzone = [zoneRecord({ geometry: reshaped })];
    await saveFloorplanZones(FLOOR, placed, placed); // Discard's housekeeping
    await saveFloorplanZones(FLOOR, [...placed, desk], placed); // Save after placing one desk
    expect(org.update).toHaveLength(0);

    // Deleted elsewhere: not re-created by a save that did not touch the room.
    org.tables.floorplanmarkedzone = [];
    await saveFloorplanZones(FLOOR, placed, placed);
    await saveFloorplanZones(FLOOR, [...placed, desk], placed);
    expect(org.create).toHaveLength(0);
  });

  it('reads no count for the zone list on a floor load', async () => {
    await loadFloor();
    const { customGet } = await import('./facilioApi');
    expect(vi.mocked(customGet).mock.calls.filter(([path]) => String(path).includes('floorplanmarkedzone'))).toHaveLength(0);
  });

  it("updates the geometry and label of the room's own zone, and never sends isReservable", async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    const room = placed.find((u) => u.id === '819848')!;

    const result = await saveFloorplanZones(FLOOR, [{ ...room, label: 'Male Toilet', geom: { kind: 'poly', pts: SQUARE } }], placed);

    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    const [update] = zones(org.update);
    expect(update.id).toBe(4945);
    expect(update.data.label).toBe('Male Toilet');
    expect(JSON.parse(update.data.geometry).coordinates[0]).toHaveLength(5);
    expect('isReservable' in update.data).toBe(false);
    expect(org.create).toHaveLength(0);
  });

  it('deletes the zone of a room the user removed in the app', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();

    const result = await saveFloorplanZones(FLOOR, [], placed);

    expect(result.deleted).toBe(1);
    expect(org.remove).toEqual([{ module: 'floorplanmarkedzone', id: 4945 }]);
  });

  it('deletes nothing after a re-read that failed to load the outlines', async () => {
    // First read: the room is drawn. Then Refresh — and this time the zone list is down, so the
    // room reads as Unplaced and the new saved snapshot has no outline in it.
    const { FacilioApiDataSource, saveFloorplanZones, placed: first } = await loadFloor();
    expect(first.some((u) => u.id === '819848')).toBe(true);
    org.failZones = true;
    const again = await new FacilioApiDataSource().getUnits(FLOOR);
    const saved = again.filter((u) => !u.unplaced);
    expect(saved.some((u) => u.id === '819848')).toBe(false);
    org.failZones = false; // back up by the time the user saves

    const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: FLOOR, plan: 'workstation' };
    const result = await saveFloorplanZones(FLOOR, [...saved, desk], saved);
    expect(result.deleted).toBe(0);
    expect(org.remove).toHaveLength(0);
  });

  it('never deletes a zone drawn in Facilio, even one this session showed — and says so', async () => {
    // In frame, so it loads as a room — but its geoId is the editor's, not ours.
    org.tables.floorplanmarkedzone = [zoneRecord({ id: 6000, geoId: 'x7q', recordId: 819850, space: { id: 819850 }, label: 'Pantry' })];
    const { saveFloorplanZones, loaded, placed } = await loadFloor();
    expect(loaded.find((u) => u.id === '819850')?.unplaced).toBeUndefined();

    const result = await saveFloorplanZones(FLOOR, [], placed);
    expect(result.deleted).toBe(0);
    expect(org.remove).toHaveLength(0);
    expect(result.roomsNotWritten).toEqual(['Pantry']);
    expect(result.skipped.join(' ')).toMatch(/drawn in Facilio — not deleted/);
  });

  it('never deletes a zone this session did not load', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    // Written by someone else after this floor was read: ours by convention, but never shown here.
    org.tables.floorplanmarkedzone.push(zoneRecord({ id: 4950, geoId: 'space-819850', recordId: 819850, space: { id: 819850 } }));

    await saveFloorplanZones(FLOOR, [], placed);
    expect(org.remove).toEqual([{ module: 'floorplanmarkedzone', id: 4945 }]); // the one it showed, only
  });

  it('never deletes anything without a saved snapshot to diff against', async () => {
    const { saveFloorplanZones } = await loadFloor();
    const result = await saveFloorplanZones(FLOOR, []);
    expect(result.deleted).toBe(0);
    expect(org.remove).toHaveLength(0);
  });

  it('never deletes when the units saved are none of this floor (a demo seed over a real floor)', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    const seed = [traced('rm1', SQUARE, { floor: 'hqA3' }), traced('819849', SQUARE, { floor: 'hqA3' })];
    const result = await saveFloorplanZones(FLOOR, seed, placed);
    expect(result.deleted).toBe(0);
    expect(org.remove).toHaveLength(0);
  });

  it('does delete when the save holds other units of this floor (the guard is about the floor, not rooms)', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: FLOOR, plan: 'workstation' };
    const result = await saveFloorplanZones(FLOOR, [desk], placed);
    expect(result.deleted).toBe(1);
    expect(org.remove).toEqual([{ module: 'floorplanmarkedzone', id: 4945 }]);
  });

  it('leaves a room that already has an editor-drawn outline alone, and says so', async () => {
    org.tables.floorplanmarkedzone = [foreignOutOfFrame()]; // space 819860, drawn in the editor
    org.tables.space.push({ id: 819860, name: 'Editor room', spaceTypeEnum: 'SPACE' });
    const { saveFloorplanZones, loaded } = await loadFloor();
    expect(loaded.find((u) => u.id === '819860')?.unplaced).toBe(true); // out of frame: in the pool

    const result = await saveFloorplanZones(FLOOR, [traced('819860', SQUARE)]);
    expect(result.created + result.updated + result.deleted).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/drawn in Facilio/);
    expect(result.roomsNotWritten).toEqual(['Room 819860']);
    expect(org.create.length + org.update.length + org.remove.length).toBe(0);
  });

  it('writes no zone for a numeric id this floor never read as a room', async () => {
    // e.g. a room the connector tier minted through create-space, which may not be on this floor.
    const { saveFloorplanZones, placed } = await loadFloor();
    const result = await saveFloorplanZones(FLOOR, [...placed, traced('4242424', SQUARE, { label: 'New room' })], placed);
    expect(result.created).toBe(0);
    expect(result.roomsNotWritten).toEqual(['New room']);
    expect(org.create).toHaveLength(0);
  });

  it('writes no zone for a desk that read as a room, and never caches its module id', async () => {
    org.tables.floorplanmarkedzone = []; // no app zone to take zoneModuleId from
    org.tables.space.push({ id: 819851, name: 'WS-9', spaceTypeEnum: 'SPACE' }); // read as a room…
    // …and its `space` record says SPACE too, as every desk's does here — but it is a desk record.
    org.spaceTypes[819851] = { spaceTypeEnum: 'SPACE', moduleId: 99999 };
    org.pointRecords.desks = [819851];
    const { saveFloorplanZones } = await loadFloor();

    const result = await saveFloorplanZones(FLOOR, [traced('819851', SQUARE, { label: 'WS-9' }), traced('819849', SQUARE)]);

    expect(result.created).toBe(1);
    expect(result.roomsNotWritten).toEqual(['WS-9']);
    expect(zones(org.create).map((c) => [c.data.recordId, c.data.zoneModuleId])).toEqual([[819849, SPACE_MODULE_ID]]);
  });

  it('skips — and reports — a create whose space module id cannot be resolved', async () => {
    org.tables.floorplanmarkedzone = [];
    org.spaceModuleId = null;
    const { saveFloorplanZones } = await loadFloor();
    const result = await saveFloorplanZones(FLOOR, [traced('819849', SQUARE)]);
    expect(result.created).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/module id/);
    expect(result.roomsNotWritten).toEqual(['Room 819849']);
    expect(org.create).toHaveLength(0);
  });

  it('keeps rooms minted in the app local — no create for a non-numeric id', async () => {
    const { saveFloorplanZones } = await loadFloor();
    const result = await saveFloorplanZones(FLOOR, [traced('u1699000000', SQUARE)]);
    expect(result).toMatchObject({ created: 0, skipped: [], roomsNotWritten: [] });
    expect(org.create).toHaveLength(0);
  });

  it('never sends isReservable: true, on any write', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    const room = placed.find((u) => u.id === '819848')!;
    await saveFloorplanZones(
      FLOOR,
      [{ ...room, geom: { kind: 'poly', pts: SQUARE } }, traced('819849', SQUARE, { isReservable: true }), traced('819850', SQUARE, { type: 'delivery' })],
      placed,
    );
    expect(zones(org.create)).toHaveLength(2);
    for (const c of zones(org.create)) expect(c.data.isReservable).toBe(false);
    for (const u of zones(org.update)) expect('isReservable' in u.data).toBe(false);
  });

  it('the marker sync is unmoved by rooms — no marker is deleted because rooms are on the floor', async () => {
    const { saveFloorplanMarkers, placed } = await loadFloor();
    // One desk marker already on the plan, saved back where it is.
    const [lng, lat] = [-122.419, 37.7747];
    const [x, y] = lngLatToQuadFraction(quad, lng, lat);
    org.tables.floorplanmarker = [{ id: 777, geoId: '1001', label: 'WS-1', geometry: JSON.stringify({ type: 'Point', coordinates: [lng, lat] }) }];
    const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x, y }, floor: FLOOR, plan: 'workstation' };

    const result = await saveFloorplanMarkers(FLOOR, [...placed, traced('819849', SQUARE), desk]);

    expect(result.plansSynced).toBe(1);
    expect(org.remove).toHaveLength(0); // the desk's marker stays; rooms never count against markers
    expect(org.create).toHaveLength(0); // and no marker is minted for a room
    expect(zones([...org.create, ...org.update, ...org.remove])).toHaveLength(0);
  });
});

describe('a desk that reads as a room while its desk list failed', () => {
  it('is not a room the save may outline when the desk list failed outright', async () => {
    org.tables.desks = [{ id: 900005, name: 'WS-5' }];
    org.tables.space.push({ id: 900005, name: 'WS-5', spaceTypeEnum: 'SPACE' });
    org.failPages.desks = [1];
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    expect(loaded.find((u) => u.id === '900005')?.type).toBe('room'); // what the pool shows…
    const placed = loaded.filter((u) => !u.unplaced);
    const result = await saveFloorplanZones(FLOOR, [...placed, traced('900005', SQUARE, { label: 'WS-5' })], placed);
    expect(result.created).toBe(0); // …but not something to write a zone for
    expect(result.roomsNotWritten).toEqual(['WS-5']);
  });

  it('is not one either when a later page of desks failed', async () => {
    org.tables.desks = Array.from({ length: 600 }, (_, i) => ({ id: 900000 + i, name: `WS-${i}` }));
    org.tables.space.push(...org.tables.desks.map((d) => ({ id: d.id, name: d.name, spaceTypeEnum: 'SPACE' })));
    org.failPages.desks = [2];
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    let more: Unit[] | null = null;
    const first = await new FacilioApiDataSource().getUnits(FLOOR, (u) => (more = u));
    await vi.waitFor(() => expect(more).not.toBeNull());
    expect((more as unknown as Unit[]).find((u) => u.id === '900550')?.type).toBe('room');
    const placed = first.filter((u) => !u.unplaced);
    const result = await saveFloorplanZones(FLOOR, [...placed, traced('900550', SQUARE, { label: 'WS-550' })], placed);
    expect(result.created).toBe(0);
    expect(org.create).toHaveLength(0);
  });
});

describe('rooms the save cannot write are named, and only when changed', () => {
  async function loadWith(zone: Record<string, unknown>) {
    org.tables.floorplanmarkedzone = [zoneRecord(zone)];
    const mod = await fresh();
    const loaded = await new mod.FacilioApiDataSource().getUnits(FLOOR);
    return { ...mod, placed: loaded.filter((u) => !u.unplaced) };
  }
  const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: FLOOR, plan: 'workstation' };

  it('says nothing of an in-frame editor zone the user did not touch — and names it once reshaped', async () => {
    const { saveFloorplanZones, placed } = await loadWith({ id: 6000, geoId: 'x7q', recordId: 819850, space: { id: 819850 }, label: 'Pantry' });
    expect((await saveFloorplanZones(FLOOR, [...placed, desk], placed)).roomsNotWritten).toEqual([]);
    expect((await saveFloorplanZones(FLOOR, placed)).roomsNotWritten).toEqual([]); // no baseline: matches the org, still no news
    const reshaped = placed.map((u) => (u.id === '819850' ? { ...u, geom: { kind: 'poly' as const, pts: SQUARE } } : u));
    expect((await saveFloorplanZones(FLOOR, reshaped, placed)).roomsNotWritten).toEqual(['Pantry']);
    expect(org.create.length + org.update.length + org.remove.length).toBe(0);
  });

  it('names a reshaped or deleted zone that outlines no room, and writes neither', async () => {
    const { saveFloorplanZones, placed } = await loadWith({ id: 7000, geoId: 'k2p', recordId: null, space: null, label: 'Loading bay' });
    expect(placed.map((u) => u.id)).toEqual(['zone-7000']);
    expect((await saveFloorplanZones(FLOOR, [...placed, desk], placed)).roomsNotWritten).toEqual([]);
    const reshaped = placed.map((u) => ({ ...u, geom: { kind: 'poly' as const, pts: SQUARE } }));
    expect((await saveFloorplanZones(FLOOR, reshaped, placed)).roomsNotWritten).toEqual(['Loading bay']);
    expect((await saveFloorplanZones(FLOOR, [desk], placed)).roomsNotWritten).toEqual(['Loading bay']);
    expect(org.create.length + org.update.length + org.remove.length).toBe(0);
  });
});

describe('a room write the org refused comes back to be retried', () => {
  async function loadFloor() {
    const mod = await fresh();
    const loaded = await new mod.FacilioApiDataSource().getUnits(FLOOR);
    return { ...mod, placed: loaded.filter((u) => !u.unplaced) };
  }

  it('a failed delete', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    org.failWrites.delete = true;
    const r = await saveFloorplanZones(FLOOR, [], placed);
    expect(r).toMatchObject({ deleted: 0, retryIds: ['819848'] });
    expect(r.roomsNotWritten).toEqual(['HQ-BKC-2F-MALE TOILET Common Area']);
  });

  it('a failed create or update — but not a room that is simply not the app\'s to write', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    org.failWrites.create = true;
    org.failWrites.update = true;
    const reshaped = placed.map((u) => ({ ...u, geom: { kind: 'poly' as const, pts: SQUARE } }));
    const r = await saveFloorplanZones(FLOOR, [...reshaped, traced('819849', SQUARE), traced('4242424', SQUARE)], placed);
    expect(r.retryIds.sort()).toEqual(['819848', '819849']);
    expect(r.roomsNotWritten).toHaveLength(3);
  });

  it('every room on a plan whose zone list could not be read', async () => {
    const { saveFloorplanZones, placed } = await loadFloor();
    org.failZones = true;
    const r = await saveFloorplanZones(FLOOR, [], placed);
    expect(r).toMatchObject({ plansSynced: 0, plansSkipped: 1, retryIds: ['819848'] });
  });
});
