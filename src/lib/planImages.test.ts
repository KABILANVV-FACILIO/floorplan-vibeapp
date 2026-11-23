import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A floor open reads its plan once: the plan image is kept for the session (a Blob, given out under
 * a fresh object URL each time — the app revokes the old ones), re-checked after a Refresh by file
 * id, and the plan record read by the floor's own load answers the georeference check too.
 */

const PLAN_GEOMETRY =
  '{"type":"Polygon","coordinates":[[[-122.4194,37.7749],[-122.41871810384222,37.7749],[-122.41871810384222,37.77451928452979],[-122.4194,37.77451928452979],[-122.4194,37.7749]]]}';

const org = vi.hoisted(() => ({
  /** floor id -> plan record id (workstation plan). */
  plans: { '101': 11, '102': 12 } as Record<string, number>,
  /** plan record id -> file id. */
  files: { 11: 501, 12: 502 } as Record<number, number>,
  geometry: null as string | null,
  contentType: 'image/png',
}));

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customGet: vi.fn(async (path: string, params?: { floorId?: string }) => {
    if (path === 'v3/floorplan/getFloorplanDetailsByType') {
      const id = org.plans[String(params?.floorId)];
      return { code: 0, data: { indoorFloorPlans: id ? { '1': { id } } : {} } };
    }
    return { code: 1, message: `unexpected ${path}` };
  }),
  customPost: vi.fn(async (_path: string, data: { floorplanId: number }) => ({ data: { indoorfloorplan: { fileId: org.files[data.floorplanId] } } })),
  fetchFilePreview: vi.fn(async () => ({ dataUrl: null, blob: new Blob(['plan'], { type: org.contentType }), contentType: org.contentType })),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number }) => (module === 'indoorfloorplan' ? { indoorfloorplan: { id, geometry: org.geometry } } : { error: { code: 1, message: 'unexpected' } })),
    fetchAllRelatedList: vi.fn(async () => ({ error: null, list: [] })),
    uploadFiles: vi.fn(async () => ({ error: null, ids: [777] })),
    updateRecord: vi.fn(async (module: string, { id }: { id: number }) => ({ [module]: { id } })),
    createRecord: vi.fn(),
  },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn(async () => 'data:image/png;base64,CAD') }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

// jsdom has no object URLs: each call mints a new one, as a browser does.
let minted = 0;
const hadCreate = 'createObjectURL' in URL;
(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => `blob:plan-${++minted}`;
afterAll(() => {
  if (!hadCreate) delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
});

async function fresh() {
  vi.resetModules();
  const mod = await import('./facilioApiDataSource');
  const api = await import('./facilioApi');
  return { ...mod, api };
}

beforeEach(() => {
  vi.clearAllMocks(); // the mocked modules outlive vi.resetModules: their call counts are per test
  org.plans = { '101': 11, '102': 12 };
  org.files = { 11: 501, 12: 502 };
  org.geometry = null;
  org.contentType = 'image/png';
});

describe('a floor plan image already fetched this session', () => {
  it('opening A, then B, then A downloads each plan once — and A comes back under a fresh object URL', async () => {
    const { fetchFloorplanImage, api } = await fresh();
    const a1 = await fetchFloorplanImage('101', 'workstation');
    const b = await fetchFloorplanImage('102', 'workstation');
    const a2 = await fetchFloorplanImage('101', 'workstation');

    expect(vi.mocked(api.fetchFilePreview).mock.calls.map(([fileId]) => fileId)).toEqual([501, 502]);
    // The way back to A asks nothing at all — not even which file the plan shows.
    expect(vi.mocked(api.customPost)).toHaveBeenCalledTimes(2);
    expect([a1, b, a2].every((u) => typeof u === 'string' && u.startsWith('blob:'))).toBe(true);
    // Never the URL handed out before, which the app may have revoked since.
    expect(a2).not.toBe(a1);
  });

  it('after a Refresh, asks which file the plan shows — and downloads only a file that changed', async () => {
    const { fetchFloorplanImage, invalidateOrgCaches, api } = await fresh();
    await fetchFloorplanImage('101', 'workstation');
    await fetchFloorplanImage('102', 'workstation');
    invalidateOrgCaches();
    org.files[12] = 602; // B's plan was pointed at a new file elsewhere
    await fetchFloorplanImage('101', 'workstation');
    await fetchFloorplanImage('102', 'workstation');
    expect(vi.mocked(api.customPost)).toHaveBeenCalledTimes(4);
    expect(vi.mocked(api.fetchFilePreview).mock.calls.map(([fileId]) => fileId)).toEqual([501, 502, 602]);
  });

  it('keeps a rendered DWG as its data URL, rendered once', async () => {
    org.contentType = 'image/vnd.dwg';
    const { fetchFloorplanImage } = await fresh();
    const { renderCadToDataUrl } = await import('./cadPreview');
    expect(await fetchFloorplanImage('101', 'workstation')).toBe('data:image/png;base64,CAD');
    expect(await fetchFloorplanImage('101', 'workstation')).toBe('data:image/png;base64,CAD');
    expect(vi.mocked(renderCadToDataUrl)).toHaveBeenCalledTimes(1);
  });

  it('is fetched again once a new plan file is uploaded for the floor', async () => {
    const { fetchFloorplanImage, uploadFloorplanFile, api } = await fresh();
    await fetchFloorplanImage('101', 'workstation');
    vi.mocked(api.facilioApi.fetchRecord).mockImplementationOnce(async () => ({ floor: { id: 101, site: { id: 1 }, building: { id: 2 } } }) as never);
    await uploadFloorplanFile('101', 'workstation', new File(['x'], 'new.png', { type: 'image/png' }));
    org.files[11] = 777;
    vi.mocked(api.fetchFilePreview).mockClear();
    await fetchFloorplanImage('101', 'workstation');
    expect(vi.mocked(api.fetchFilePreview).mock.calls.map(([fileId]) => fileId)).toEqual([777]);
  });

  it('a failed download is not kept', async () => {
    const { fetchFloorplanImage, api } = await fresh();
    vi.mocked(api.fetchFilePreview).mockResolvedValueOnce({ dataUrl: null });
    expect(await fetchFloorplanImage('101', 'workstation')).toBeNull();
    expect(await fetchFloorplanImage('101', 'workstation')).toMatch(/^blob:/);
    expect(vi.mocked(api.fetchFilePreview)).toHaveBeenCalledTimes(2);
  });
});

describe('the plan record on a floor open', () => {
  const planReads = (api: Awaited<ReturnType<typeof fresh>>['api']) => vi.mocked(api.facilioApi.fetchRecord).mock.calls.filter(([m]) => m === 'indoorfloorplan').length;

  it('is read once for a plan with a quad: the georeference check takes the floor read’s word', async () => {
    org.geometry = PLAN_GEOMETRY;
    const { FacilioApiDataSource, ensurePlanGeoreference, api } = await fresh();
    await new FacilioApiDataSource().getUnits('101');
    expect(await ensurePlanGeoreference('101', 'workstation', { width: 1600, height: 900 })).toBeNull();
    expect(planReads(api)).toBe(1);
    expect(vi.mocked(api.facilioApi.updateRecord)).not.toHaveBeenCalled();
  });

  it('is read again by the check after a Refresh, and for a plan the floor read found without a quad', async () => {
    org.geometry = PLAN_GEOMETRY;
    const { FacilioApiDataSource, ensurePlanGeoreference, invalidateOrgCaches, api } = await fresh();
    await new FacilioApiDataSource().getUnits('101');
    invalidateOrgCaches();
    await ensurePlanGeoreference('101', 'workstation', { width: 1600, height: 900 });
    expect(planReads(api)).toBe(2);

    org.geometry = null;
    await new FacilioApiDataSource().getUnits('101');
    const res = await ensurePlanGeoreference('101', 'workstation', { width: 1600, height: 900 });
    expect(planReads(api)).toBe(4);
    expect(res?.written).toBe(true);
  });
});

describe("a floor's lists", () => {
  it('a 300-desk floor is read with no count request — every list fits its first page', async () => {
    const { FacilioApiDataSource, api } = await fresh();
    const desks = Array.from({ length: 300 }, (_, i) => ({ id: 5000 + i, name: `WS-${i}`, employee: i % 2 ? { id: 900 + i } : null }));
    vi.mocked(api.facilioApi.fetchAllRelatedList).mockImplementation(async (opts: { relatedModuleName: string }) => ({ error: null, list: opts.relatedModuleName === 'desks' ? desks : [] }) as never);
    const ds = new FacilioApiDataSource();
    const [units, holders] = await Promise.all([ds.getUnits('101', vi.fn()), ds.getAssignments('101', vi.fn())]);
    expect(units.filter((u) => u.unplaced)).toHaveLength(300);
    expect(Object.keys(holders)).toHaveLength(150);
    await ds.getAssignments('101'); // and a re-read after a change
    expect(vi.mocked(api.customGet).mock.calls.filter(([path]) => String(path).endsWith('/count'))).toHaveLength(0);
    vi.mocked(api.facilioApi.fetchAllRelatedList).mockImplementation(async () => ({ error: null, list: [] }) as never);
  });
});
