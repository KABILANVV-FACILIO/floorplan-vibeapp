import { describe, expect, it, vi } from 'vitest';

/**
 * The employee roster (and the site / floor lists) read a page at a time. A refused page must not
 * cost the pages already read, and a refusal for rate must wait out Facilio's window before asking
 * again — at most twice — rather than drop the roster and leave the plan without names.
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

const { fetchAllPaged } = await import('./facilioApiDataSource');
const { IncompleteListError, RATE_LIMIT_WAIT_MS } = await import('./rateLimit');
const { CompositeDataSource } = await import('./dataSource');

const PER_PAGE = 2;
const page = (n: number) => [{ id: n * 10 + 1 }, { id: n * 10 + 2 }];
const RATE = { code: 6, message: 'You have reached the maximum number of allowed requests for this API. Please wait and try again later.' };

/** Five full pages and a short sixth; `refuse` says which calls (1-based) are refused, and how. */
function server(refuse: Record<number, { code: number | string; message: string }>) {
  let call = 0;
  return vi.fn(async (p: number) => {
    call++;
    if (refuse[call]) return { error: refuse[call], list: null };
    return { error: null, list: p <= 5 ? page(p) : [{ id: 61 }] };
  });
}

describe('a roster read refused part-way', () => {
  it('keeps the pages read, waits out the window once, and carries on from the refused page', async () => {
    const fetchPage = server({ 3: RATE });
    const sleep = vi.fn(async () => {});
    const stop = await fetchAllPaged('employee', PER_PAGE, { fetchPage, sleep }).catch((e) => e);
    expect(stop).toBeInstanceOf(IncompleteListError);
    expect(stop.rows.map((r: { id: number }) => r.id)).toEqual([11, 12, 21, 22]);
    expect(stop.rateLimited).toBe(true);
    expect(sleep).not.toHaveBeenCalled(); // nothing waits until someone asks to finish

    const all = await stop.resume();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
    expect(all.map((r: { id: number }) => r.id)).toEqual([11, 12, 21, 22, 31, 32, 41, 42, 51, 52, 61]);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 3, 4, 5, 6]); // page 3 asked again, nothing before it
  });

  it('gives up after two waits, still holding every row it got', async () => {
    const fetchPage = server({ 2: RATE, 3: RATE, 4: RATE });
    const sleep = vi.fn(async () => {});
    const first = await fetchAllPaged('employee', PER_PAGE, { fetchPage, sleep }).catch((e) => e);
    const second = await first.resume().catch((e: unknown) => e);
    const third = await second.resume().catch((e: unknown) => e);
    expect(third).toBeInstanceOf(IncompleteListError);
    expect(third.resume).toBeUndefined();
    expect(third.rows.map((r: { id: number }) => r.id)).toEqual([11, 12]);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('keeps the pages read before any other refusal, with nothing to wait for', async () => {
    const stop = await fetchAllPaged('employee', PER_PAGE, { fetchPage: server({ 2: { code: 403, message: 'Permission denied' } }), sleep: vi.fn() }).catch((e) => e);
    expect(stop).toBeInstanceOf(IncompleteListError);
    expect(stop).toMatchObject({ rateLimited: false, resume: undefined });
    expect(stop.rows).toHaveLength(2);
  });

  it('reports a first page refused for anything but rate as a plain failure, as before', async () => {
    const err = await fetchAllPaged('employee', PER_PAGE, { fetchPage: server({ 1: { code: 403, message: 'Permission denied' } }) }).catch((e) => e);
    expect(err).not.toBeInstanceOf(IncompleteListError);
    expect(String(err.message)).toContain('employee fetch failed on page 1');
  });
});

describe('the data source', () => {
  it('answers with the org’s partial roster rather than trying the next tier', async () => {
    const stop = new IncompleteListError([{ id: '1', name: 'Omar' }], true, 'refused');
    const org = { name: 'org', getEmployees: vi.fn(async () => Promise.reject(stop)) };
    const other = { name: 'other', getEmployees: vi.fn(async () => [{ id: '9', name: 'Someone else' }]) };
    const ds = new CompositeDataSource([org, other] as never);
    await expect(ds.getEmployees()).rejects.toBe(stop);
    expect(other.getEmployees).not.toHaveBeenCalled();
  });
});
