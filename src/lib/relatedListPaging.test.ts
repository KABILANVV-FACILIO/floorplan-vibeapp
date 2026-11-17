import { describe, expect, it, vi } from 'vitest';

/**
 * A floor's desks, lockers, parking stalls, rooms and plan markers are read through the org's
 * relatedList endpoint, which answers 50 rows unless asked for a page. These pin the loader: the
 * count and the first page come together, the floor can be drawn from that first page, and every
 * other page follows — two at a time when the count says how many, one by one when it can't.
 */

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customGet: vi.fn(),
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  facilioApi: { fetchAll: vi.fn(), fetchAllRelatedList: vi.fn() },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

const { fetchAllRelatedPaged, loadRelated } = await import('./facilioApiDataSource');

const OPTS = { moduleName: 'floor', id: 1, relatedModuleName: 'desks', relatedFieldName: 'floor' };
const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

/** A server holding `total` rows that honours page and perPage (as RelatedDataAction does). */
const server = (total: number) =>
  vi.fn(async (page: number, perPage: number) => ({ error: null, list: rows((page - 1) * perPage, Math.max(0, Math.min(perPage, total - (page - 1) * perPage))) }));

describe('the first page, then the rest', () => {
  it('answers with the first page and the count, and loads the rest without being awaited', async () => {
    const fetchPage = server(1234);
    const load = await loadRelated(OPTS, { fetchPage, fetchCount: async () => 1234, perPage: 500 });
    expect(load.first).toHaveLength(500);
    expect(load).toMatchObject({ total: 1234, hasMore: true });
    expect(await load.rest).toHaveLength(734);
  });

  it('reads the remaining pages two at a time when the count says how many, keeping their order', async () => {
    // Every page is the same URI to Facilio's limiter (100 a minute): a big floor must not spend
    // the whole minute in one second. 2,600 rows at 500 a page is page 1 and five more.
    let inFlight = 0;
    let most = 0;
    const honest = server(2600);
    const fetchPage = vi.fn(async (page: number, perPage: number) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return honest(page, perPage);
    });
    const load = await loadRelated(OPTS, { fetchPage, fetchCount: async () => 2600, perPage: 500 });
    const rest = await load.rest;
    expect(fetchPage).toHaveBeenCalledTimes(6);
    expect(most).toBe(2); // never more than two in flight (page 1 and the count go together)
    expect([...load.first, ...rest].map((r) => r.id)).toEqual(rows(0, 2600).map((r) => r.id));
  });

  it('makes one request when everything fits the first page', async () => {
    const fetchPage = server(37);
    const load = await loadRelated(OPTS, { fetchPage, fetchCount: async () => 37, perPage: 500 });
    expect(load).toMatchObject({ hasMore: false });
    expect(load.first).toHaveLength(37);
    expect(await load.rest).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('pages on one by one when the count is unavailable', async () => {
    const fetchPage = server(1100);
    const load = await loadRelated(OPTS, { fetchPage, fetchCount: async () => null, perPage: 500 });
    expect(load).toMatchObject({ total: null, hasMore: true });
    expect(await load.rest).toHaveLength(600);
  });

  it('stops when a server ignores page and sends page 1 again', async () => {
    const fetchPage = vi.fn(async () => ({ error: null, list: rows(0, 500) }));
    const load = await loadRelated(OPTS, { fetchPage, fetchCount: async () => null, perPage: 500 });
    expect(await load.rest).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('keeps what arrived when a later page fails', async () => {
    const fetchPage = vi.fn(async (page: number) => (page === 1 ? { error: null, list: rows(0, 500) } : { error: { code: 1, message: 'nope' }, list: null }));
    const load = await loadRelated(OPTS, { fetchPage, fetchCount: async () => 900, perPage: 500 });
    expect(load.first).toHaveLength(500);
    expect(await load.rest).toEqual([]);
  });
});

describe('everything, awaited (for saving)', () => {
  it('returns every row', async () => {
    const res = await fetchAllRelatedPaged(OPTS, { fetchPage: server(1234), fetchCount: async () => 1234, perPage: 500 });
    expect(res.list).toHaveLength(1234);
  });

  it('reports a failed first page as a failure', async () => {
    const failing = vi.fn(async () => ({ error: { code: 1, message: 'nope' }, list: null }));
    expect((await fetchAllRelatedPaged(OPTS, { fetchPage: failing, fetchCount: async () => null, perPage: 500 })).error).toBeTruthy();
  });
});
