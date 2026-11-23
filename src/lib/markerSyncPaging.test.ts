import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from './types';

/**
 * A plan's existing markers are read WHOLE before a save diffs against them. On a big plan they
 * come a page at a time, and a later page Facilio refused used to come back as a shorter list —
 * which the save took for the whole one, creating a second copy of every marker on the missing
 * page. These pin that a list read in part writes nothing, and that a whole one writes as before.
 */

const PLAN = 31;
const PLAN_GEOMETRY =
  '{"type":"Polygon","coordinates":[[[-122.4194,37.7749],[-122.41871810384222,37.7749],[-122.41871810384222,37.77451928452979],[-122.4194,37.77451928452979],[-122.4194,37.7749]]]}';

const org = vi.hoisted(() => ({
  markers: [] as { id: number; geoId: string; geometry: string; label: string; recordId?: number; markerModuleId?: number }[],
  /** The page of the marker list that answers with a refusal, if any. */
  refusePage: 0,
  writes: [] as { kind: 'create' | 'update' | 'delete'; module: string }[],
}));

vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  customGet: vi.fn(async (path: string) => {
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: { '1': { id: PLAN } } } };
    return null;
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number }) => {
      if (module === 'indoorfloorplan') return { indoorfloorplan: { id, geometry: PLAN_GEOMETRY } };
      return { [module]: { id, moduleId: 9001 } };
    }),
    fetchAllRelatedList: vi.fn(async (_opts: unknown, { page, perPage }: { page: number; perPage: number }) => {
      if (page === org.refusePage) return { error: { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' }, list: null };
      return { error: null, list: org.markers.slice((page - 1) * perPage, page * perPage) };
    }),
    createRecord: vi.fn(async (module: string) => {
      org.writes.push({ kind: 'create', module });
      return { [module]: { id: 1 } };
    }),
    updateRecord: vi.fn(async (module: string) => {
      org.writes.push({ kind: 'update', module });
      return { [module]: { id: 1 } };
    }),
    deleteRecord: vi.fn(async (module: string) => {
      org.writes.push({ kind: 'delete', module });
      return { error: null };
    }),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { saveFloorplanMarkers } = await import('./facilioApiDataSource');
const { geometryStringToQuad, quadToLngLat } = await import('./geoReference');
const quad = geometryStringToQuad(PLAN_GEOMETRY)!;

/** 600 desks already placed — more than one 500-row page of markers — each exactly where it is on screen. */
const DESKS: Unit[] = Array.from({ length: 600 }, (_, i) => ({
  id: String(70_000 + i),
  type: 'workstation',
  label: `WS-${i}`,
  room: null,
  geom: { kind: 'point', x: (i % 30) / 30 + 0.01, y: Math.floor(i / 30) / 20 + 0.01 },
  floor: '42',
  plan: 'workstation',
}));
const markerOf = (u: Unit, i: number) => {
  const [lng, lat] = quadToLngLat(quad, (u.geom as { x: number }).x, (u.geom as { y: number }).y);
  return { id: 50_000 + i, geoId: u.id, geometry: JSON.stringify({ type: 'Point', coordinates: [lng, lat] }), label: u.label, recordId: Number(u.id), markerModuleId: 9001 };
};

beforeEach(() => {
  org.markers = DESKS.map(markerOf);
  org.refusePage = 0;
  org.writes.length = 0;
});

describe("saving a plan's markers against a list read in pages", () => {
  it('writes nothing when a later page of the existing markers was refused — no second copies', async () => {
    org.refusePage = 2;
    const result = await saveFloorplanMarkers('42', DESKS);
    expect(org.writes).toEqual([]);
    expect(result.plansSynced).toBe(0);
    expect(result.skipped.join(' ')).toMatch(/marker list unavailable/);
    // Kept unsaved, so the next Save tries them again.
    expect(result.retryIds).toHaveLength(DESKS.length);
  });

  it('writes nothing for a floor already as the org has it, across both pages', async () => {
    const result = await saveFloorplanMarkers('42', DESKS);
    expect(org.writes).toEqual([]);
    expect(result.plansSynced).toBe(1);
    expect(result.unitsNotWritten).toEqual([]);
  });

  it('creates only the desk that is new, once the whole list is in', async () => {
    const extra: Unit = { ...DESKS[0], id: '79999', label: 'WS-new', geom: { kind: 'point', x: 0.5, y: 0.5 } };
    await saveFloorplanMarkers('42', [...DESKS, extra]);
    expect(org.writes).toEqual([{ kind: 'create', module: 'floorplanmarker' }]);
  });
});
