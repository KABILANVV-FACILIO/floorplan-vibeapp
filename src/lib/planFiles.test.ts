import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A floor's plan in the org: uploading its file (stored, then made the floor's plan of that type —
 * created, or the existing plan pointed at it, with a georeference sized to the image) and giving
 * a plan drawn in Facilio's editor the georeference this app's markers need. Both write org records
 * every user sees, so these pin exactly what is written, and when nothing is.
 */

const PLAN_GEOMETRY =
  '{"type":"Polygon","coordinates":[[[-122.4194,37.7749],[-122.41871810384222,37.7749],[-122.41871810384222,37.77451928452979],[-122.4194,37.77451928452979],[-122.4194,37.7749]]]}';

const org = vi.hoisted(() => ({
  plans: {} as Record<string, { id: number }>,
  planGeometry: null as string | null,
  markers: [] as { id: number; geometry: string }[],
  markersFail: false,
  floorMissing: false,
  uploadFail: false,
  writes: [] as { kind: 'create' | 'update'; module: string; id?: number; data: Record<string, any> }[],
  previews: [] as { fileId: number; original: boolean }[],
}));

vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customPost: vi.fn(),
  customGet: vi.fn(async (path: string) => {
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: org.plans } };
    return null;
  }),
  fetchFilePreview: vi.fn(async (fileId: number, opts?: { original?: boolean }) => {
    org.previews.push({ fileId, original: !!opts?.original });
    return { dataUrl: null, blob: new Blob(['x'], { type: 'image/png' }), contentType: 'image/png' };
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    uploadFiles: vi.fn(async () => (org.uploadFail ? { error: new Error('upload refused') } : { error: null, ids: [555] })),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number }) => {
      if (module === 'floor') return org.floorMissing ? { error: { code: 404, message: 'no such floor' } } : { floor: { id, site: { id: 7 }, building: { id: 3 } } };
      if (module === 'indoorfloorplan') return { indoorfloorplan: { id, geometry: org.planGeometry } };
      return { error: { code: 1, message: `unexpected ${module}` } };
    }),
    fetchAllRelatedList: vi.fn(async () => (org.markersFail ? { error: { code: 500, message: 'down' }, list: null } : { error: null, list: org.markers })),
    createRecord: vi.fn(async (module: string, { data }: { data: Record<string, any> }) => {
      org.writes.push({ kind: 'create', module, data });
      return { [module]: { id: 31 } };
    }),
    updateRecord: vi.fn(async (module: string, { id, data }: { id: number; data: Record<string, any> }) => {
      org.writes.push({ kind: 'update', module, id, data });
      return { [module]: { id } };
    }),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
// jsdom has no object URLs; the module hands them back as the plan's preview.
const createObjectURL = vi.fn(() => 'blob:preview');
const hadCreate = 'createObjectURL' in URL;
(URL as unknown as { createObjectURL: () => string }).createObjectURL = createObjectURL;
afterAll(() => {
  if (!hadCreate) delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
});

const { ensurePlanGeoreference, planGeoreference, uploadFloorplanFile } = await import('./facilioApiDataSource');
const { computeSyntheticGeometry, quadToGeometryString } = await import('./geoReference');

const file = new File(['plan'], 'level-3.png', { type: 'image/png' });

beforeEach(() => {
  org.plans = {};
  org.planGeometry = null;
  org.markers = [];
  org.markersFail = false;
  org.floorMissing = false;
  org.uploadFail = false;
  org.writes.length = 0;
  org.previews.length = 0;
});

describe('uploading a floor plan', () => {
  it("creates the floor's plan of that type: the file, the floor's own site and building, a georeference sized to the image", async () => {
    const res = await uploadFloorplanFile('42', 'locker', file, { width: 2000, height: 1000 });
    expect(res).toEqual({ fileId: 555, previewUrl: 'blob:preview', serverImageUrl: 'blob:preview', attachedToFloorPlan: true, attachError: undefined });
    expect(org.previews).toEqual([
      { fileId: 555, original: true },
      { fileId: 555, original: false },
    ]);
    expect(org.writes).toEqual([
      {
        kind: 'create',
        module: 'indoorfloorplan',
        data: { floor: { id: '42' }, building: { id: 3 }, site: { id: 7 }, fileId: 555, name: 'level-3.png', floorPlanType: 2, geometry: quadToGeometryString(computeSyntheticGeometry(2000, 1000)) },
      },
    ]);
  });

  it('points an existing plan of that type at the new file instead, and leaves its geometry alone without a size', async () => {
    org.plans = { '1': { id: 26 } };
    await uploadFloorplanFile('43', 'workstation', file);
    expect(org.writes).toEqual([{ kind: 'update', module: 'indoorfloorplan', id: 26, data: { fileId: 555 } }]);
  });

  it('keeps the uploaded file when the plan cannot be attached, and says why', async () => {
    org.floorMissing = true;
    const res = await uploadFloorplanFile('44', 'workstation', file);
    expect(res.fileId).toBe(555);
    expect(res.attachedToFloorPlan).toBe(false);
    expect(res.attachError).toBe('no such floor');
    expect(org.writes).toHaveLength(0);
  });

  it('makes nothing the floor’s plan once cancelled after the upload', async () => {
    const ctl = new AbortController();
    const { fetchFilePreview } = await import('./facilioApi');
    vi.mocked(fetchFilePreview).mockImplementationOnce(async () => {
      ctl.abort();
      return { dataUrl: null, blob: new Blob(['x'], { type: 'image/png' }), contentType: 'image/png' };
    });
    await expect(uploadFloorplanFile('45', 'workstation', file, undefined, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(org.writes).toHaveLength(0);
  });

  it('refuses a floor the org does not have, and a refused upload, before writing anything', async () => {
    await expect(uploadFloorplanFile('hqA3', 'workstation', file)).rejects.toThrow(/not an org floor/);
    org.uploadFail = true;
    await expect(uploadFloorplanFile('46', 'workstation', file)).rejects.toThrow('upload refused');
    expect(org.writes).toHaveLength(0);
  });
});

describe("giving a plan drawn in Facilio's editor its georeference", () => {
  it('leaves a plan that already has a valid one alone', async () => {
    org.plans = { '1': { id: 26 } };
    org.planGeometry = PLAN_GEOMETRY;
    expect(await ensurePlanGeoreference('50', 'workstation', { width: 1600, height: 900 })).toBeNull();
    expect(org.writes).toHaveLength(0);
  });

  it('writes one update — the synthetic quad sized to the image — for a plan with none and no markers', async () => {
    org.plans = { '1': { id: 26 } };
    const res = await ensurePlanGeoreference('51', 'workstation', { width: 1600, height: 900 });
    const geometry = quadToGeometryString(computeSyntheticGeometry(1600, 900));
    expect(org.writes).toEqual([{ kind: 'update', module: 'indoorfloorplan', id: 26, data: { geometry } }]);
    expect(res).toEqual({ planRecordId: 26, geometry, written: true });
  });

  it('fits the quad to the markers the plan already has', async () => {
    org.plans = { '1': { id: 26 } };
    org.markers = [
      { id: 1, geometry: JSON.stringify({ type: 'Point', coordinates: [0.001, 0.002] }) },
      { id: 2, geometry: JSON.stringify({ type: 'Point', coordinates: [0.004, 0.0005] }) },
      { id: 3, geometry: JSON.stringify({ type: 'Point', coordinates: [0.0025, 0.001] }) },
    ];
    await ensurePlanGeoreference('52', 'workstation', { width: 1600, height: 900 });
    expect(org.writes).toHaveLength(1);
    expect(org.writes[0].data.geometry).toBe(planGeoreference(org.markers, { width: 1600, height: 900 }));
    expect(org.writes[0].data.geometry).not.toBe(quadToGeometryString(computeSyntheticGeometry(1600, 900)));
  });

  it('writes nothing when the plan’s markers cannot be read — a quad laid over unread markers would hide them for good', async () => {
    org.plans = { '1': { id: 26 } };
    org.markersFail = true;
    expect(await ensurePlanGeoreference('53', 'workstation', { width: 1600, height: 900 })).toBeNull();
    expect(org.writes).toHaveLength(0);
  });

  it('works the quad out without writing it when asked not to (write: false)', async () => {
    org.plans = { '1': { id: 26 } };
    const res = await ensurePlanGeoreference('54', 'workstation', { width: 1600, height: 900 }, { write: false });
    expect(res).toEqual({ planRecordId: 26, geometry: quadToGeometryString(computeSyntheticGeometry(1600, 900)), written: false });
    expect(org.writes).toHaveLength(0);
  });

  it("for a viewer (write: 'fitted'): writes the quad fitted to markers placed in Facilio's editor — without it nobody sees them", async () => {
    org.plans = { '1': { id: 26 } };
    org.markers = [
      { id: 1, geometry: JSON.stringify({ type: 'Point', coordinates: [0.001, 0.002] }) },
      { id: 2, geometry: JSON.stringify({ type: 'Point', coordinates: [0.004, 0.0005] }) },
    ];
    const res = await ensurePlanGeoreference('56', 'workstation', { width: 1600, height: 900 }, { write: 'fitted' });
    expect(org.writes).toHaveLength(1);
    expect(org.writes[0].data.geometry).toBe(planGeoreference(org.markers, { width: 1600, height: 900 }));
    expect(res?.written).toBe(true);
  });

  it("for a viewer (write: 'fitted'): leaves a plan with no markers for an editor — the synthetic quad shows them nothing", async () => {
    org.plans = { '1': { id: 26 } };
    const res = await ensurePlanGeoreference('57', 'workstation', { width: 1600, height: 900 }, { write: 'fitted' });
    expect(org.writes).toHaveLength(0);
    expect(res).toEqual({ planRecordId: 26, geometry: quadToGeometryString(computeSyntheticGeometry(1600, 900)), written: false });
  });

  it('does nothing for a plan type the floor does not have', async () => {
    org.plans = { '1': { id: 26 } };
    expect(await ensurePlanGeoreference('55', 'parking', { width: 1600, height: 900 })).toBeNull();
    expect(org.writes).toHaveLength(0);
  });
});
