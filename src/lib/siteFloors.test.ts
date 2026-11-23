import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A whole site's floors for the Bookings floor filter: one `floor` list filtered by site, grouped by
 * building — not a floor list per building. A list that failed is a rejection, never "no floors".
 */

const org = vi.hoisted(() => ({
  floors: [] as { id: number; name: string; site: { id: number }; building: { id: number; name: string } }[],
  calls: [] as { module: string; params: Record<string, any> }[],
  fail: null as null | ((page: number) => { code: number; message: string } | null),
}));

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customGet: vi.fn(),
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  facilioApi: {
    fetchRecord: vi.fn(),
    fetchAllRelatedList: vi.fn(),
    fetchAll: vi.fn(async (module: string, params: Record<string, any>) => {
      org.calls.push({ module, params });
      const error = org.fail?.(params.page) ?? null;
      if (error) return { error, list: null };
      const site = JSON.parse(params.filters ?? '{}').site?.value?.[0];
      const all = org.floors.filter((f) => site == null || String(f.site.id) === site);
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
  },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { FacilioApiDataSource } = await import('./facilioApiDataSource');
const { IncompleteListError } = await import('./rateLimit');

/** `buildings` buildings of `perBuilding` floors on site 7 (named out of order), plus another site's. */
function seed(buildings: number, perBuilding: number) {
  org.floors = [];
  let id = 1;
  for (let b = 0; b < buildings; b++)
    for (let f = perBuilding; f >= 1; f--) org.floors.push({ id: id++, name: `Level ${f}`, site: { id: 7 }, building: { id: 300 + b, name: `B${b}` } });
  org.floors.push({ id: 9999, name: 'Elsewhere', site: { id: 8 }, building: { id: 800, name: 'Other' } });
}

beforeEach(() => {
  org.calls.length = 0;
  org.fail = null;
});

describe("a site's floors, at once", () => {
  it('reads one floor list for a site of ten buildings, grouped by building and sorted by name', async () => {
    seed(10, 6);
    const byBuilding = await new FacilioApiDataSource().getSiteFloors('7');

    expect(org.calls.length).toBeGreaterThanOrEqual(1);
    expect(org.calls.length).toBeLessThanOrEqual(2);
    expect(org.calls.every((c) => c.module === 'floor' && JSON.parse(c.params.filters).site.operatorId === 36)).toBe(true);
    expect(Object.keys(byBuilding).sort()).toEqual(Array.from({ length: 10 }, (_, b) => String(300 + b)).sort());
    expect(byBuilding['300'].map((f) => f.name)).toEqual(['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5', 'Level 6']);
    expect(byBuilding['300'].every((f) => f.hasPlan === true && typeof f.id === 'string')).toBe(true);
    expect(byBuilding['800']).toBeUndefined();
  });

  it('pages on for a site of more floors than a page holds', async () => {
    seed(60, 10);
    const byBuilding = await new FacilioApiDataSource().getSiteFloors('7');
    // Pages of 200, as every module list here is read: 600 floors fill three, and a fourth comes
    // back empty.
    expect(org.calls).toHaveLength(4);
    expect(Object.values(byBuilding).flat()).toHaveLength(600);
  });

  it('answers {} only for a site with no floors', async () => {
    seed(0, 0);
    expect(await new FacilioApiDataSource().getSiteFloors('7')).toEqual({});
  });

  it('rejects — never an empty map — when the list fails, and keeps a refusal for rate visible', async () => {
    seed(10, 6);
    org.fail = () => ({ code: 500, message: 'down' });
    await expect(new FacilioApiDataSource().getSiteFloors('7')).rejects.toThrow(/floor/);
    org.fail = () => ({ code: 6, message: 'You have reached the maximum number of allowed requests for this API.' });
    const err = await new FacilioApiDataSource().getSiteFloors('7').catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteListError);
    expect(err.rateLimited).toBe(true);
  });

  it('rejects when a later page fails, rather than answering the floors before it', async () => {
    seed(60, 10);
    org.fail = (page) => (page === 2 ? { code: 500, message: 'down' } : null);
    await expect(new FacilioApiDataSource().getSiteFloors('7')).rejects.toBeInstanceOf(IncompleteListError);
  });
});
