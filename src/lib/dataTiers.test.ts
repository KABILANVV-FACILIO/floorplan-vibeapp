import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FloorplanDataSource } from './dataSource';
import type { Unit } from './types';

/**
 * Which tier answers, and what a tier keeps. A read Facilio refused for rate is not handed to a
 * weaker tier (the connector would draw a floor with every desk "Available to place"); a re-read of
 * who holds what that came back short fails rather than empty every desk; an org floor's records
 * are never copied into, or served from, this browser's storage while the org is reachable — so an
 * org read that failed fails with the org's own error, never as an empty floor or day.
 */

const org = vi.hoisted(() => ({
  lists: {} as Record<string, { id: number; employee?: { id: number }; moduleState?: { status: string } }[]>,
  failModule: '' as string,
  failPage: 1,
}));

vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('./vibe', () => ({ isVibeApp: false, CMMS_CONNECTION: 'facilio-cmms', RESPONDERS_FN: 'floorplanResponders', vibe: {} }));
vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  customGet: vi.fn(async (path: string) => {
    const count = /relatedList\/(\w+)\/\w+\/count$/.exec(path);
    if (count) return { code: 0, data: { count: (org.lists[count[1]] ?? []).length } };
    return null;
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string }, params: { page: number; perPage: number }) => {
      if (opts.relatedModuleName === org.failModule && params.page === org.failPage) return { error: { code: 500, message: 'boom' }, list: null };
      const all = org.lists[opts.relatedModuleName] ?? [];
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'debug').mockImplementation(() => {});

const { CompositeDataSource, LocalJsonDataSource } = await import('./dataSource');
const { FacilioApiDataSource } = await import('./facilioApiDataSource');
const { IncompleteListError, RateLimitedError } = await import('./rateLimit');
const { noteRecordStates, takeRecordStates } = await import('./recordStates');

/**
 * A tier that answers every call with `answer` (a value, or a thrown error). One mock per method,
 * kept, so a test can ask whether a method was called.
 */
const tier = (name: string, answer: () => unknown): FloorplanDataSource => {
  const fns = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  return new Proxy({ name } as FloorplanDataSource, {
    get: (target, key) => {
      if (key === 'name') return target.name;
      if (!fns.has(key)) fns.set(key, vi.fn(async () => answer()));
      return fns.get(key);
    },
  });
};

beforeEach(() => {
  org.lists = { desks: [], lockers: [], parkingstall: [] };
  org.failModule = '';
  org.failPage = 1;
  localStorage.clear();
});

describe('a read Facilio refused for rate', () => {
  it('is not handed to the next tier — the caller keeps what it shows', async () => {
    const weaker = tier('connector', () => [{ id: '1' }]);
    const ds = new CompositeDataSource([tier('facilio-api', () => Promise.reject(new RateLimitedError('busy'))), weaker]);
    await expect(ds.getUnits('42')).rejects.toBeInstanceOf(RateLimitedError);
    expect((weaker.getUnits as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('while any other failure still falls through, as before', async () => {
    const ds = new CompositeDataSource([tier('facilio-api', () => Promise.reject(new Error('not configured'))), tier('local', () => [])]);
    await expect(ds.getUnits('42')).resolves.toEqual([]);
  });
});

describe('re-reading who holds what after a change', () => {
  const floor = '4242';
  beforeEach(() => {
    org.lists.desks = [
      { id: 1, employee: { id: 812 }, moduleState: { status: 'occupied' } },
      { id: 2, moduleState: { status: 'temporarilyvacant' } },
    ];
  });

  it('answers the holders when every list came back', async () => {
    expect(await new FacilioApiDataSource().getAssignments(floor)).toEqual({ '1': '812' });
    expect(takeRecordStates(floor)).toEqual({ '1': 'occupied', '2': 'temporarilyvacant' });
  });

  it('fails — and no tier answers "nobody" in its place — when a list could not be read', async () => {
    org.failModule = 'lockers';
    const local = new LocalJsonDataSource();
    const getAssignments = vi.spyOn(local, 'getAssignments');
    const ds = new CompositeDataSource([new FacilioApiDataSource(), local]);
    await expect(ds.getAssignments(floor)).rejects.toBeInstanceOf(IncompleteListError);
    expect(getAssignments).not.toHaveBeenCalled();
  });

  it('fails when a LATER page of a list could not be read, too', async () => {
    org.lists.desks = Array.from({ length: 700 }, (_, i) => ({ id: i + 1, employee: { id: 900 + i } }));
    org.failModule = 'desks';
    org.failPage = 2;
    await expect(new FacilioApiDataSource().getAssignments(floor)).rejects.toBeInstanceOf(IncompleteListError);
  });

  it('on a floor LOAD (with a listener for the rest) a failed list still costs only its rows', async () => {
    org.failModule = 'lockers';
    const more = vi.fn();
    expect(await new FacilioApiDataSource().getAssignments('4343', more)).toEqual({ '1': '812' });
  });

  it('starts from nothing: states an earlier read noted and nobody took are not mixed in', async () => {
    noteRecordStates(floor, [{ id: 99, moduleState: { status: 'reserved' } }]);
    await new FacilioApiDataSource().getAssignments(floor);
    expect(takeRecordStates(floor)).toEqual({ '1': 'occupied', '2': 'temporarilyvacant' });
  });
});

describe("this browser's storage, with the org reachable", () => {
  const LS_KEY = 'facilio_floorplan_proto_v2';
  const unit = (id: string, floor: string): Unit => ({ id, type: 'workstation', label: id, room: null, geom: { kind: 'point', x: 0.1, y: 0.1 }, floor, plan: 'workstation' });

  it('keeps no copy of an org floor’s units, and the save still resolves', async () => {
    const local = new LocalJsonDataSource();
    await expect(local.saveUnits('4242', [unit('5001', '4242')])).resolves.toBeUndefined();
    const stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{"units":[]}');
    expect(stored.units.filter((u: Unit) => u.floor === '4242')).toEqual([]);
  });

  it('never serves units, holders or bookings for an org floor — not even a copy an older build left behind', async () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ units: [unit('5001', '4242')], assignments: { '5001': '812' }, bookings: [{ id: 'b1', unitId: '5001', date: '2026-11-23', start: 540, end: 600, by: 'Omar', purpose: '' }] }),
    );
    const local = new LocalJsonDataSource();
    // Refused, not answered empty: an empty answer would stand in for the org's read.
    await expect(local.getUnits('4242')).rejects.toThrow(/local-json/);
    await expect(local.getAssignments('4242')).rejects.toThrow(/local-json/);
    await expect(local.getBookings('4242', '2026-11-23')).rejects.toThrow(/local-json/);
    await expect(local.getFloorData('4242', '2026-11-23')).rejects.toThrow(/local-json/);
  });

  it('drops such an old copy the next time it saves', async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ units: [unit('5001', '4242'), unit('u1', 'hqA3')], assignments: {}, bookings: [] }));
    await new LocalJsonDataSource().saveUnits('4242', [unit('5001', '4242')]);
    expect(JSON.parse(localStorage.getItem(LS_KEY)!).units.map((u: Unit) => u.id)).toEqual(['u1']);
  });

  it('keeps a demo floor’s units exactly as before', async () => {
    const local = new LocalJsonDataSource();
    await local.saveUnits('hqA3', [unit('u1', 'hqA3'), unit('u2', 'hqA3')]);
    expect((await local.getUnits('hqA3')).map((u) => u.id)).toEqual(['u1', 'u2']);
  });

  it('lets the explicit save’s browser step resolve through the composite on an org floor', async () => {
    const ds = new CompositeDataSource([new FacilioApiDataSource(), new LocalJsonDataSource()]);
    await expect(ds.saveUnits('4242', [unit('5001', '4242')])).resolves.toBeUndefined();
  });
});

describe('an org floor read that failed, with the org reachable', () => {
  const LS_KEY = 'facilio_floorplan_proto_v2';
  const unit = (id: string, floor: string, type: Unit['type'] = 'workstation'): Unit => ({ id, type, label: id, room: null, geom: { kind: 'point', x: 0.1, y: 0.1 }, floor, plan: 'workstation' });
  const date = '2026-11-23';
  /** The org tier failing with a plain error (not a rate stop), and the connector with its own. */
  const failing = () => {
    const apiErr = new Error('facilio-api: spacebooking fetch failed (500 boom)');
    return {
      apiErr,
      api: tier('facilio-api', () => Promise.reject(apiErr)),
      connector: tier('facilio-cmms-connector', () => Promise.reject(new Error('cmms-connector: bookings have no connector action'))),
    };
  };

  it('fails with the org tier’s error — this browser answers no units, holders or bookings in its place', async () => {
    // A copy an older build left behind is not served either.
    localStorage.setItem(LS_KEY, JSON.stringify({ units: [unit('5001', '4242')], assignments: { '5001': '812' }, bookings: [{ id: 'b1', unitId: '5001', date, start: 540, end: 600, by: 'Omar', purpose: '' }] }));
    const { apiErr, api, connector } = failing();
    const local = new LocalJsonDataSource();
    const localUnits = vi.spyOn(local, 'getUnits');
    const localBookings = vi.spyOn(local, 'getBookings');
    const ds = new CompositeDataSource([api, connector, local]);
    await expect(ds.getUnits('4242')).rejects.toBe(apiErr);
    await expect(ds.getBookings('4242', date)).rejects.toBe(apiErr);
    await expect(ds.getAssignments('4242')).rejects.toBe(apiErr);
    // Asked, and refused — never an empty floor or an empty day.
    expect(localUnits).toHaveBeenCalledTimes(1);
    await expect(localUnits.mock.results[0].value).rejects.toThrow(/local-json/);
    expect(localBookings).toHaveBeenCalledTimes(1);
    await expect(localBookings.mock.results[0].value).rejects.toThrow(/local-json/);
  });

  it('fails the one-call floor bundle with the org tier’s error too', async () => {
    const { apiErr, api } = failing();
    await expect(new CompositeDataSource([api, new LocalJsonDataSource()]).getFloorData('4242', date, 'workstation')).rejects.toBe(apiErr);
  });

  it('keeps a demo floor answered by this browser exactly as before', async () => {
    const { api, connector } = failing();
    const ds = new CompositeDataSource([api, connector, new LocalJsonDataSource()]);
    await ds.saveUnits('hqA3', [unit('u1', 'hqA3'), unit('u2', 'hqA3')]);
    expect((await ds.getUnits('hqA3')).map((u: Unit) => u.id)).toEqual(['u1', 'u2']);
    await expect(ds.getBookings('hqA3', date)).resolves.toBeInstanceOf(Array);
    await expect(ds.getAssignments('hqA3')).resolves.toBeInstanceOf(Object);
    expect((await ds.getFloorData('hqA3', date, 'workstation')).units.map((u) => u.id)).toEqual(['u1', 'u2']);
  });

  it('still lets the explicit save’s browser step resolve on an org floor', async () => {
    const { api, connector } = failing();
    const ds = new CompositeDataSource([api, connector, new LocalJsonDataSource()]);
    await expect(ds.saveUnits('4242', [unit('5001', '4242')])).resolves.toBeUndefined();
  });

  it('never "creates" a space on an org floor in this browser when the org tiers refused it', async () => {
    const { apiErr, api, connector } = failing();
    const room = unit('u77', '4242', 'room');
    const loc = { siteId: '1', buildingId: '2', floorId: '4242' };
    await expect(new LocalJsonDataSource().createUnit(loc, room)).rejects.toThrow(/local-json/);
    await expect(new CompositeDataSource([api, connector, new LocalJsonDataSource()]).createUnit(loc, room)).rejects.toBe(apiErr);
  });

  it('still echoes a new space back on a demo floor', async () => {
    const { api, connector } = failing();
    const desk = unit('u78', 'hqA3');
    await expect(new CompositeDataSource([api, connector, new LocalJsonDataSource()]).createUnit({ siteId: 'hq', buildingId: 'hqA', floorId: 'hqA3' }, desk)).resolves.toBe(desk);
  });
});

describe("a site's floors, and the floor search, with the org reachable", () => {
  const orgTier = (siteFloors: () => Promise<unknown>) =>
    ({
      name: 'facilio-api',
      getSiteFloors: vi.fn(siteFloors),
      getBuildings: vi.fn(async () => [{ id: 'b1', name: 'Block A' }]),
      getFloors: vi.fn(async () => [{ id: 'f1', name: 'Ground', hasPlan: true }]),
    }) as unknown as FloorplanDataSource;

  it('reads building by building when the one site-filtered list fails for anything but rate', async () => {
    const api = orgTier(() => Promise.reject(new Error('facilio-api: floor fetch failed on page 1 (400 bad filter)')));
    const ds = new CompositeDataSource([api, new LocalJsonDataSource()]);
    expect(await ds.getSiteFloors('7')).toEqual({ b1: [{ id: 'f1', name: 'Ground', hasPlan: true }] });
    expect(api.getBuildings).toHaveBeenCalledWith('7');
  });

  it('keeps a refusal for rate as the answer — a request per building would meet the same limit', async () => {
    const api = orgTier(() => Promise.reject(new RateLimitedError('busy')));
    const ds = new CompositeDataSource([api, new LocalJsonDataSource()]);
    await expect(ds.getSiteFloors('7')).rejects.toBeInstanceOf(RateLimitedError);
    expect(api.getBuildings).not.toHaveBeenCalled();
  });

  it("fails a floor search the org could not answer, rather than answering the seed's floors", async () => {
    const ds = new CompositeDataSource([tier('facilio-api', () => Promise.reject(new Error('down'))), new LocalJsonDataSource()]);
    await expect(ds.searchFloors('Third')).rejects.toThrow('down');
  });
});
