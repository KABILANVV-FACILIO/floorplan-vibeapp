import { describe, expect, it, vi } from 'vitest';

/**
 * A floor's desks, lockers, parking stalls, rooms and plan markers are read through the org's
 * relatedList endpoint, which answers 50 rows unless asked for a page. These pin that every row
 * arrives — and that the pager stops, whatever the server does with `page` and `perPage`.
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

const { fetchAllRelatedPaged } = await import('./facilioApiDataSource');

const OPTS = { moduleName: 'floor', id: 1, relatedModuleName: 'desks', relatedFieldName: 'floor' };
const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

/** A server holding `total` rows that honours page and perPage. */
const honest = (total: number) =>
  vi.fn(async (page: number, perPage: number) => ({ error: null, list: rows((page - 1) * perPage, Math.max(0, Math.min(perPage, total - (page - 1) * perPage))) }));

describe('reading every row of a related list', () => {
  it('reads past the first 500 on a big floor', async () => {
    const fetchPage = honest(1234);
    const res = await fetchAllRelatedPaged(OPTS, fetchPage, 500);
    expect(res.list).toHaveLength(1234);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops after one request when everything fits', async () => {
    const fetchPage = honest(37);
    const res = await fetchAllRelatedPaged(OPTS, fetchPage, 500);
    expect(res.list).toHaveLength(37);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('keeps going when a server ignores perPage and answers its own 50 a page', async () => {
    const total = 180;
    const fetchPage = vi.fn(async (page: number) => ({ error: null, list: rows((page - 1) * 50, Math.max(0, Math.min(50, total - (page - 1) * 50))) }));
    const res = await fetchAllRelatedPaged(OPTS, fetchPage, 500);
    expect(res.list).toHaveLength(180);
  });

  it('stops when a server ignores page and sends page 1 again', async () => {
    const fetchPage = vi.fn(async () => ({ error: null, list: rows(0, 50) }));
    const res = await fetchAllRelatedPaged(OPTS, fetchPage, 500);
    expect(res.list).toHaveLength(50);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('reports a failed first page as a failure, and keeps what arrived when a later one fails', async () => {
    const failing = vi.fn(async () => ({ error: { code: 1, message: 'nope' }, list: null }));
    expect((await fetchAllRelatedPaged(OPTS, failing, 500)).error).toBeTruthy();

    const laterFails = vi.fn(async (page: number) => (page === 1 ? { error: null, list: rows(0, 500) } : { error: { code: 1, message: 'nope' }, list: null }));
    const res = await fetchAllRelatedPaged(OPTS, laterFails, 500);
    expect(res.error).toBeNull();
    expect(res.list).toHaveLength(500);
  });
});
