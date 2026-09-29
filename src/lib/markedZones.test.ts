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
  failZones: false,
  spaceModuleId: 128279 as number | null,
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
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: { '1': { id: 26 } } } };
    return { code: 1, message: `no count for ${path}` }; // counts unavailable: the loader pages on
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number }) => {
      if (module === 'indoorfloorplan') return { indoorfloorplan: { id, geometry: PLAN_GEOMETRY } };
      if (module === 'space') return org.spaceModuleId ? { space: { id, moduleId: org.spaceModuleId } } : { error: { code: 1, message: 'nope' } };
      return { error: { code: 1, message: `unexpected ${module}` } };
    }),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string }, params: { page: number; perPage: number }) => {
      if (opts.relatedModuleName === 'floorplanmarkedzone' && org.failZones) return { error: { code: 500, message: 'zone list down' }, list: null };
      const all = org.tables[opts.relatedModuleName] ?? [];
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
    createRecord: vi.fn(async (module: string, { data }: { data: any }) => {
      org.create.push({ module, data });
      const id = org.nextId++;
      return { error: null, [module]: { id, ...data } };
    }),
    updateRecord: vi.fn(async (module: string, { id, data }: { id: number; data: any }) => {
      org.update.push({ module, id, data });
      return { error: null };
    }),
    deleteRecord: vi.fn(async (module: string, id: number) => {
      org.remove.push({ module, id });
      return { error: null };
    }),
  },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

/** A fresh copy of the data source — its session memory (which zones were shown) starts empty. */
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
  org.failZones = false;
  org.spaceModuleId = SPACE_MODULE_ID;
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

describe('saving room outlines', () => {
  it('creates a zone for a room traced onto the plan — app geoId, closed ring, never reservable', async () => {
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    const placed = loaded.filter((u) => !u.unplaced);

    const result = await saveFloorplanZones(FLOOR, [...placed, traced('819849', SQUARE, { label: 'Meeting Room 2' })]);

    expect(result).toMatchObject({ plansSynced: 1, created: 1, updated: 0, deleted: 0, skipped: [] });
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
    const [x, y] = lngLatToQuadFraction(quad, ring[2][0], ring[2][1]);
    expect(x).toBeCloseTo(0.3, 9);
    expect(y).toBeCloseTo(0.3, 9);
    // Nothing else was touched: the loaded room was unchanged, and no marker call was made.
    expect(org.update).toHaveLength(0);
    expect(org.remove).toHaveLength(0);
    expect(org.create.filter((c) => c.module !== 'floorplanmarkedzone')).toHaveLength(0);
  });

  it('writes nothing for a room read back and saved unchanged', async () => {
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    const result = await saveFloorplanZones(FLOOR, loaded.filter((u) => !u.unplaced));
    expect(result).toMatchObject({ plansSynced: 1, created: 0, updated: 0, deleted: 0 });
    expect(org.create.length + org.update.length + org.remove.length).toBe(0);
  });

  it('updates the geometry and label of the room\'s own zone, and never sends isReservable', async () => {
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    const room = loaded.find((u) => u.id === '819848')!;

    const result = await saveFloorplanZones(FLOOR, [{ ...room, label: 'Male Toilet', geom: { kind: 'poly', pts: SQUARE } }]);

    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0 });
    const [update] = zones(org.update);
    expect(update.id).toBe(4945);
    expect(update.data.label).toBe('Male Toilet');
    expect(JSON.parse(update.data.geometry).coordinates[0]).toHaveLength(5);
    expect('isReservable' in update.data).toBe(false);
    expect(org.create).toHaveLength(0);
  });

  it('deletes the zone of a room the user removed in the app', async () => {
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    await new FacilioApiDataSource().getUnits(FLOOR);

    const result = await saveFloorplanZones(FLOOR, []);

    expect(result.deleted).toBe(1);
    expect(org.remove).toEqual([{ module: 'floorplanmarkedzone', id: 4945 }]);
  });

  it('never deletes a zone drawn in Facilio, even one this session showed', async () => {
    // In frame, so it loads as a room — but its geoId is the editor's, not ours.
    org.tables.floorplanmarkedzone = [zoneRecord({ id: 6000, geoId: 'x7q', recordId: 819850, space: { id: 819850 }, label: 'Pantry' })];
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    expect(loaded.find((u) => u.id === '819850')?.unplaced).toBeUndefined();

    const result = await saveFloorplanZones(FLOOR, []);
    expect(result.deleted).toBe(0);
    expect(org.remove).toHaveLength(0);
  });

  it('never deletes a zone this session did not load', async () => {
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    await new FacilioApiDataSource().getUnits(FLOOR);
    // Written by someone else after this floor was read: ours by convention, but never shown here.
    org.tables.floorplanmarkedzone.push(zoneRecord({ id: 4950, geoId: 'space-819850', recordId: 819850, space: { id: 819850 } }));

    await saveFloorplanZones(FLOOR, []);
    expect(org.remove).toEqual([{ module: 'floorplanmarkedzone', id: 4945 }]); // the one it showed, only
  });

  it('never deletes anything when the floor was never read in this session', async () => {
    const { saveFloorplanZones } = await fresh();
    const result = await saveFloorplanZones(FLOOR, []);
    expect(result.deleted).toBe(0);
    expect(org.remove).toHaveLength(0);
  });

  it('leaves a room that already has an editor-drawn outline alone, and says so', async () => {
    org.tables.floorplanmarkedzone = [foreignOutOfFrame()]; // space 819860, drawn in the editor
    const { saveFloorplanZones } = await fresh();
    const result = await saveFloorplanZones(FLOOR, [traced('819860', SQUARE)]);
    expect(result.created + result.updated + result.deleted).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/drawn in Facilio/);
    expect(org.create.length + org.update.length + org.remove.length).toBe(0);
  });

  it('skips — and reports — a create whose space module id cannot be resolved', async () => {
    org.spaceModuleId = null;
    const { saveFloorplanZones } = await fresh();
    const result = await saveFloorplanZones(FLOOR, [traced('819849', SQUARE)]);
    expect(result.created).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/module id/);
    expect(org.create).toHaveLength(0);
  });

  it('keeps rooms minted in the app local — no create for a non-numeric id', async () => {
    const { saveFloorplanZones } = await fresh();
    const result = await saveFloorplanZones(FLOOR, [traced('u1699000000', SQUARE)]);
    expect(result).toMatchObject({ created: 0, skipped: [] });
    expect(org.create).toHaveLength(0);
  });

  it('never sends isReservable: true, on any write', async () => {
    const { FacilioApiDataSource, saveFloorplanZones } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    const room = loaded.find((u) => u.id === '819848')!;
    await saveFloorplanZones(FLOOR, [
      { ...room, geom: { kind: 'poly', pts: SQUARE } },
      traced('819849', SQUARE, { isReservable: true }),
      traced('819850', SQUARE, { type: 'delivery' }),
    ]);
    expect(zones(org.create)).toHaveLength(2);
    for (const c of zones(org.create)) expect(c.data.isReservable).toBe(false);
    for (const u of zones(org.update)) expect('isReservable' in u.data).toBe(false);
  });

  it('the marker sync is unmoved by rooms — no marker is deleted because rooms are on the floor', async () => {
    const { FacilioApiDataSource, saveFloorplanMarkers } = await fresh();
    const loaded = await new FacilioApiDataSource().getUnits(FLOOR);
    // One desk marker already on the plan, saved back where it is.
    const [lng, lat] = [-122.419, 37.7747];
    const [x, y] = lngLatToQuadFraction(quad, lng, lat);
    org.tables.floorplanmarker = [{ id: 777, geoId: '1001', label: 'WS-1', geometry: JSON.stringify({ type: 'Point', coordinates: [lng, lat] }) }];
    const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x, y }, floor: FLOOR, plan: 'workstation' };

    const result = await saveFloorplanMarkers(FLOOR, [...loaded.filter((u) => !u.unplaced), traced('819849', SQUARE), desk]);

    expect(result.plansSynced).toBe(1);
    expect(org.remove).toHaveLength(0); // the desk's marker stays; rooms never count against markers
    expect(org.create).toHaveLength(0); // and no marker is minted for a room
    expect(zones([...org.create, ...org.update, ...org.remove])).toHaveLength(0);
  });
});
