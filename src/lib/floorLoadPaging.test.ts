import { describe, expect, it, vi } from 'vitest';
import { computeSyntheticGeometry, quadToGeometryString, quadToLngLat } from './geoReference';

/**
 * A whole floor load against a mocked org holding more than one page of everything: the floor
 * must come back from its FIRST pages, and the rest must arrive through `onMore` — not by making
 * the load wait for it. The org is simulated as RelatedDataAction answers: `page`/`perPage` honoured,
 * and `…/count` returning `{ data: { count } }`.
 */

const FLOOR = '4242';
const PLAN = 77;
const DESKS = 1200;
const MARKERS = 700;
const quad = computeSyntheticGeometry(1492, 1054);

const desks = Array.from({ length: DESKS }, (_, i) => ({
  id: 10_000 + i,
  name: `E-1-WS${i}`,
  department: i % 2 ? { id: 5, name: '10000264-Investment Executive Program' } : null,
  employee: i % 3 === 0 ? { id: 900 + i } : null,
}));
// The first 700 desks have markers on the plan.
const markers = desks.slice(0, MARKERS).map((d, i) => {
  const [lng, lat] = quadToLngLat(quad, ((i % 40) + 1) / 42, (Math.floor(i / 40) + 1) / 20);
  return { id: 50_000 + i, geoId: String(d.id), recordId: d.id, label: d.name, geometry: JSON.stringify({ type: 'Point', coordinates: [lng, lat] }) };
});
// `space` is the base table desks live in too, and it pages in its own order: desks 700–1199
// come first here, so its first page holds desk rows whose desk records are on later pages.
const spaces = [...desks.slice(MARKERS), ...desks.slice(0, MARKERS)].map((d) => ({ id: d.id, name: d.name, spaceTypeEnum: 'SPACE' }));
// No room outlines on this plan — but a real (empty) list, so the zone read takes its normal path
// rather than failing and being swallowed by loadPlanZones.
const tables: Record<string, unknown[]> = { desks, lockers: [], parkingstall: [], space: spaces, floorplanmarker: markers, floorplanmarkedzone: [] };

const calls: string[] = [];
let releasePageTwo: () => void = () => {};
const pageTwoGate = new Promise<void>((r) => (releasePageTwo = r));

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  customGet: vi.fn(async (path: string) => {
    calls.push(path);
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: { '1': { id: PLAN } } } };
    const count = /relatedList\/(\w+)\/\w+\/count$/.exec(path);
    if (count) return { code: 0, data: { count: tables[count[1]].length } };
    return { code: 1, message: `unexpected ${path}` };
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(async () => ({ indoorfloorplan: { id: PLAN, geometry: quadToGeometryString(quad) } })),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string }, params: { page: number; perPage: number }) => {
      calls.push(`${opts.relatedModuleName} p${params.page}`);
      // Hold the later pages until the test has seen the first answer.
      if (params.page > 1) await pageTwoGate;
      const all = tables[opts.relatedModuleName];
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
  },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

const { FacilioApiDataSource } = await import('./facilioApiDataSource');

describe('loading a floor bigger than one page', () => {
  it('draws from the first pages, and hands over the rest when it arrives', async () => {
    const ds = new FacilioApiDataSource();
    let full: unknown[] | null = null;
    let moreHolders: Record<string, string> | null = null;
    const onMore = vi.fn((u: unknown[]) => (full = u));

    const [units, assignments] = await Promise.all([ds.getUnits(FLOOR, onMore), ds.getAssignments(FLOOR, (m) => (moreHolders = m))]);

    // Answered while every page past the first is still held back.
    const placed = units.filter((u) => !u.unplaced);
    expect(placed).toHaveLength(500); // the plan's first 500 markers
    // Nothing unplaced yet — not the desks whose markers are on page 2, and no desk read as a room
    // off the first page of `space`. The pool comes with the rest.
    expect(units.filter((u) => u.unplaced)).toHaveLength(0);
    expect(units.filter((u) => u.type === 'room')).toHaveLength(0);
    expect(Object.keys(assignments)).toHaveLength(167); // holders among the first 500 desks
    expect(onMore).not.toHaveBeenCalled();

    // Each list asked for its count; the desks list was read ONCE for both calls.
    expect(calls.filter((c) => c === 'desks p1')).toHaveLength(1);
    expect(calls.some((c) => c.endsWith('/relatedList/desks/floor/count'))).toBe(true);

    releasePageTwo();
    await vi.waitFor(() => expect(full).not.toBeNull());
    const all = full as unknown as { unplaced?: boolean; department?: string }[];
    expect(all.filter((u) => !u.unplaced)).toHaveLength(MARKERS);
    expect(all.filter((u) => u.unplaced)).toHaveLength(DESKS - MARKERS);
    expect(all.filter((u) => (u as { type?: string }).type === 'room')).toHaveLength(0);
    // Pages 2 and 3 of the desks, and page 2 of the markers — asked for together.
    expect(calls.filter((c) => /^desks p[23]$/.test(c))).toHaveLength(2);
    expect(calls.filter((c) => c === 'floorplanmarker p2')).toHaveLength(1);
    await vi.waitFor(() => expect(moreHolders).not.toBeNull());
    expect(Object.keys(moreHolders!)).toHaveLength(233); // holders among desks 501–1200
    // The zone list was read, and read cleanly — no failure quietly absorbed on the way.
    expect(calls.filter((c) => c === 'floorplanmarkedzone p1')).toHaveLength(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('floorplanmarkedzone'))).toHaveLength(0);
  });
});
