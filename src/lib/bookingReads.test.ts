import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The org reads around bookings, under Facilio's rate limit (100 calls a minute per user and URI):
 * a read refused for rate is never sent again at once by a fallback meant for a rejected filter;
 * a burst of booking searches goes two at a time; a list that came back in part is not passed off
 * as whole (the bookable pool is not kept, the calendar can ask to be told); and the reads the app
 * repeats (the account, a floor search) are made once.
 */

const BUSY = { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' };

const org = vi.hoisted(() => ({
  tables: {} as Record<string, { id: number }[]>,
  /** Related-list errors by module, as the org answers a refused or failed read. */
  relatedErrors: {} as Record<string, unknown>,
  /** Answers each spacebooking page: return null for "no rows". */
  booking: (_filters: Record<string, any>, _page: number): { error: unknown; list: unknown[] | null } => ({ error: null, list: [] }),
  bookingCalls: [] as { filters: Record<string, any>; page: number }[],
  inFlight: 0,
  mostInFlight: 0,
  pool: (_module: string, _params: Record<string, any>): { error: unknown; list: unknown[] | null } => ({ error: null, list: [] }),
  poolCalls: [] as { module: string; params: Record<string, any> }[],
  get: (_path: string, _params?: Record<string, unknown>): unknown => null,
  getCalls: [] as { path: string; params?: Record<string, unknown> }[],
  getInFlight: 0,
  mostGetInFlight: 0,
}));

vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  customGet: vi.fn(async (path: string, params?: Record<string, unknown>) => {
    org.getCalls.push({ path, params });
    const count = /relatedList\/(\w+)\/\w+\/count$/.exec(path);
    if (count) return { code: 0, data: { count: (org.tables[count[1]] ?? []).length } };
    org.getInFlight++;
    org.mostGetInFlight = Math.max(org.mostGetInFlight, org.getInFlight);
    await new Promise((r) => setTimeout(r, 1));
    org.getInFlight--;
    return org.get(path, params);
  }),
  facilioApi: {
    fetchRecord: vi.fn(),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string }, params: { page: number; perPage: number }) => {
      if (org.relatedErrors[opts.relatedModuleName]) return { error: org.relatedErrors[opts.relatedModuleName], list: null };
      const all = org.tables[opts.relatedModuleName] ?? [];
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
    fetchAll: vi.fn(async (module: string, params: Record<string, any>) => {
      if (module === 'spacebooking') {
        const filters = JSON.parse(params.filters);
        org.bookingCalls.push({ filters, page: params.page });
        org.inFlight++;
        org.mostInFlight = Math.max(org.mostInFlight, org.inFlight);
        await new Promise((r) => setTimeout(r, 2));
        org.inFlight--;
        return org.booking(filters, params.page);
      }
      org.poolCalls.push({ module, params });
      return org.pool(module, params);
    }),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

async function load() {
  vi.resetModules();
  return import('./facilioApiDataSource');
}

const day = Date.parse('2026-10-22T09:00:00');
const row = (id: number, desk: number, extra: Record<string, unknown> = {}) => ({ id, desk: { id: desk }, bookingStartTime: day, bookingEndTime: day + 3_600_000, ...extra });

beforeEach(() => {
  org.tables = { desks: [], space: [], parkingstall: [] };
  org.relatedErrors = {};
  org.booking = () => ({ error: null, list: [] });
  org.bookingCalls.length = 0;
  org.inFlight = 0;
  org.mostInFlight = 0;
  org.pool = () => ({ error: null, list: [] });
  org.poolCalls.length = 0;
  org.get = (path) => (path === 'v2/fetchAccount' ? { result: { account: {} } } : null);
  org.getCalls.length = 0;
  org.getInFlight = 0;
  org.mostGetInFlight = 0;
});

describe('a booking search Facilio refused for rate', () => {
  it('is sent once — not again at once without the cancelled filter — and the cancelled states learnt are kept', async () => {
    const { fetchOrgBookingsForRange } = await load();
    // First read: a cancelled row teaches its state id.
    org.booking = () => ({ error: null, list: [row(1, 41, { isCancelled: true, moduleState: { id: 88, displayName: 'Cancelled' } })] });
    await fetchOrgBookingsForRange('2026-10-22', '2026-10-22');
    expect(org.bookingCalls[0].filters.moduleState).toBeUndefined();

    // Second read: refused.
    org.bookingCalls.length = 0;
    org.booking = () => ({ error: BUSY, list: null });
    await expect(fetchOrgBookingsForRange('2026-10-22', '2026-10-22')).rejects.toThrow();
    expect(org.bookingCalls).toHaveLength(1);

    // Third read: the learnt state is still left out at the source.
    org.bookingCalls.length = 0;
    org.booking = () => ({ error: null, list: [] });
    await fetchOrgBookingsForRange('2026-10-22', '2026-10-22');
    expect(org.bookingCalls[0].filters.moduleState).toEqual({ operatorId: 10, value: ['88'] });
  });

  it('still retries without the cancelled filter when the org REJECTED it (not for rate)', async () => {
    const { fetchOrgBookingsForRange } = await load();
    org.booking = (filters) => (filters.isCancelled ? { error: { code: 400, message: 'Invalid criteria' }, list: null } : { error: null, list: [row(5, 41)] });
    const bookings = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22');
    expect(org.bookingCalls).toHaveLength(2);
    expect(bookings.map((b) => b.id)).toEqual(['5']);
  });

  it('rejects with a RateLimitedError when the caller asked to be told (strict)', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const { RateLimitedError } = await import('./rateLimit');
    org.booking = () => ({ error: BUSY, list: null });
    await expect(fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { strict: true })).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('the plan’s day list on a floor of hundreds of desks', () => {
  it('has at most two spacebooking searches in flight, and still reads every id', async () => {
    const { FacilioApiDataSource } = await load();
    org.tables.desks = Array.from({ length: 600 }, (_, i) => ({ id: 10_000 + i }));
    org.tables.space = Array.from({ length: 400 }, (_, i) => ({ id: 20_000 + i }));
    await new FacilioApiDataSource().getBookings('4242', '2026-10-22');
    // 600 desks → 4 queries of ≤150, 400 spaces → 3.
    expect(org.bookingCalls).toHaveLength(7);
    expect(org.mostInFlight).toBeLessThanOrEqual(2);
    const named = org.bookingCalls.flatMap((c) => c.filters.desk?.value ?? []);
    expect(new Set(named).size).toBe(600);
  });
});

describe('the calendar filtered to floors', () => {
  const FLOORS = Array.from({ length: 10 }, (_, i) => String(500 + i));
  /** 150 desks on each floor. `space` is the base table desks live in too, so it lists them as well. */
  const desksOn = (floors: string[], perFloor = 150) =>
    floors.flatMap((f, fi) => Array.from({ length: perFloor }, (_, i) => ({ id: 100_000 + fi * 1000 + i, floor: { id: Number(f) } })));
  /** The org's module lists, honouring the `floor` filter and page/perPage. */
  const listsOn = (desks: { id: number; floor: { id: number } }[]) => (module: string, params: Record<string, any>) => {
    const wanted = new Set<string>(JSON.parse(params.filters ?? '{}').floor?.value ?? []);
    const all = module === 'desks' || module === 'space' ? desks : [];
    const on = all.filter((r) => wanted.has(String(r.floor.id)));
    return { error: null, list: on.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
  };
  const idReads = () => org.poolCalls.filter((c) => ['desks', 'space', 'parkingstall'].includes(c.module));

  it('reads each module once across ten floors — never a read per floor — then the range org-wide, keeping only those floors’ bookings', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const desks = desksOn(FLOORS);
    org.pool = listsOn(desks);
    org.booking = () => ({ error: null, list: [row(1, desks[0].id), row(2, desks[1499].id), row(3, 999_999)] });

    const bookings = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { floorIds: FLOORS, strict: true });

    // One booking read, org-wide (no record-id filter), where ~22 id-scoped searches used to go.
    expect(org.bookingCalls.length).toBeLessThanOrEqual(6);
    expect(org.bookingCalls.every((c) => !c.filters.desk && !c.filters.space && !c.filters.parkingStall)).toBe(true);
    // The booking on a desk elsewhere in the org is not on a chosen floor.
    expect(bookings.map((b) => b.id).sort()).toEqual(['1', '2']);
    // One list per module, each naming all ten floors: 1,500 desks are three pages of 500, and a
    // fourth that comes back empty to say the list has ended. Sixty-odd related-list reads before.
    expect(new Set(idReads().map((c) => c.module))).toEqual(new Set(['desks', 'space', 'parkingstall']));
    expect(idReads().every((c) => JSON.parse(c.params.filters).floor.value.length === 10)).toBe(true);
    expect(idReads().filter((c) => c.module === 'desks')).toHaveLength(4);
    expect(idReads().filter((c) => c.module === 'parkingstall')).toHaveLength(1);
  });

  it('stops at the first page and reads the floors one by one when the org ignored the floor filter — never paging through every desk', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const chosen = FLOORS.slice(0, 3);
    const elsewhere = desksOn(['900', '901'], 400);
    // The org answers every desk it has, whatever the filter said.
    org.pool = (module, params) => (module === 'desks' ? { error: null, list: elsewhere.slice((params.page - 1) * params.perPage, params.page * params.perPage) } : { error: null, list: [] });
    // Per floor, the related lists the read made before.
    org.tables = { desks: [{ id: 7001 }, { id: 7002 }] };
    org.booking = () => ({ error: null, list: [row(1, 7001), row(2, elsewhere[0].id)] });

    const bookings = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { floorIds: chosen, resourceField: 'desk', strict: true });

    expect(idReads().filter((c) => c.module === 'desks')).toHaveLength(1);
    expect(bookings.map((b) => b.id)).toEqual(['1']);
  });

  it('reads the floors one by one, too, when the org refuses the floor filter outright — and a refusal for rate stays "busy"', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const chosen = FLOORS.slice(0, 3);
    org.pool = (module) => (module === 'desks' ? { error: { code: 400, message: 'invalid filter' }, list: null } : { error: null, list: [] });
    org.tables = { desks: [{ id: 7001 }, { id: 7002 }] };
    org.booking = () => ({ error: null, list: [row(1, 7001), row(2, 123_456)] });

    const bookings = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { floorIds: chosen, resourceField: 'desk', strict: true });
    expect(bookings.map((b) => b.id)).toEqual(['1']);

    const { RateLimitedError } = await import('./rateLimit');
    org.pool = () => ({ error: BUSY, list: null });
    await expect(fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { floorIds: FLOORS.slice(3, 6), resourceField: 'desk', strict: true })).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('asks the floors’ desks by id when the org-wide read is capped — never only the rows a capped read happened to hold', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const desks = desksOn(FLOORS);
    org.pool = listsOn(desks);
    // Org-wide, every page is full (other floors' bookings): the read stops at its cap. By id, the
    // chosen floors' one booking comes back.
    org.booking = (filters: Record<string, any>, page: number) =>
      filters.desk?.operatorId === 36
        ? { error: null, list: filters.desk.value.includes(String(desks[7].id)) ? [row(77, desks[7].id)] : [] }
        : { error: null, list: Array.from({ length: 500 }, (_, i) => row(page * 1000 + i, 999_999)) };

    const bookings = await fetchOrgBookingsForRange('2026-10-01', '2026-10-31', { floorIds: FLOORS, resourceField: 'desk', strict: true });
    expect(bookings.map((b) => b.id)).toEqual(['77']);
    expect(org.bookingCalls.some((c) => c.filters.desk?.operatorId === 36)).toBe(true);
  });

  it('with Desks picked, reads only the desks — three pages for ten floors of 149 desks', async () => {
    const { fetchOrgBookingsForRange } = await load();
    org.pool = listsOn(desksOn(FLOORS, 149));
    await fetchOrgBookingsForRange('2026-10-22', '2026-10-28', { floorIds: FLOORS, resourceField: 'desk', strict: true });
    expect(idReads().length).toBe(3);
    expect(idReads().every((c) => c.module === 'desks')).toBe(true);
    expect(org.bookingCalls.length).toBeLessThanOrEqual(6);
  });

  it('keeps the floors’ ids for a minute: a week flip reads only bookings', async () => {
    const { fetchOrgBookingsForRange } = await load();
    org.pool = listsOn(desksOn(FLOORS));
    await fetchOrgBookingsForRange('2026-10-19', '2026-10-25', { floorIds: FLOORS });
    const reads = idReads().length;
    await fetchOrgBookingsForRange('2026-10-26', '2026-11-01', { floorIds: [...FLOORS].reverse() });
    expect(idReads().length).toBe(reads);
    expect(org.bookingCalls).toHaveLength(2);
  });

  it('still asks by record id for a couple of small floors', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const desks = desksOn(FLOORS.slice(0, 2), 20);
    org.pool = (module, params) => (module === 'desks' ? listsOn(desks)(module, params) : { error: null, list: [] });
    await fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { floorIds: FLOORS.slice(0, 2) });
    expect(org.bookingCalls).toHaveLength(1);
    expect(new Set(org.bookingCalls[0].filters.desk.value)).toEqual(new Set(desks.map((d) => String(d.id))));
  });

  it('says busy, and searches nothing, when a floor list is refused for rate', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const { RateLimitedError } = await import('./rateLimit');
    org.pool = (module) => (module === 'desks' ? { error: BUSY, list: null } : { error: null, list: [] });
    await expect(fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { floorIds: FLOORS, strict: true })).rejects.toBeInstanceOf(RateLimitedError);
    expect(org.bookingCalls).toHaveLength(0);
  });
});

describe('the plan’s day list while Facilio is busy', () => {
  it('rejects with a RateLimitedError when the first page of bookings is refused — never "nothing booked"', async () => {
    const { FacilioApiDataSource } = await load();
    const { RateLimitedError } = await import('./rateLimit');
    org.tables.desks = [{ id: 41 }];
    org.booking = () => ({ error: BUSY, list: null });
    await expect(new FacilioApiDataSource().getBookings('4242', '2026-10-22')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('rejects with a RateLimitedError when the request for the first page THROWS a refusal (a dev-mode 429)', async () => {
    const { FacilioApiDataSource } = await load();
    const { RateLimitedError } = await import('./rateLimit');
    org.tables.desks = [{ id: 41 }];
    org.booking = () => {
      throw Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });
    };
    await expect(new FacilioApiDataSource().getBookings('4242', '2026-10-22')).rejects.toBeInstanceOf(RateLimitedError);
    expect(org.bookingCalls).toHaveLength(1);
  });

  it('rejects with a RateLimitedError when a floor list is refused, and searches nothing', async () => {
    const { FacilioApiDataSource } = await load();
    const { RateLimitedError } = await import('./rateLimit');
    org.tables.desks = [{ id: 41 }];
    org.relatedErrors.space = BUSY;
    await expect(new FacilioApiDataSource().getBookings('4242', '2026-10-22')).rejects.toBeInstanceOf(RateLimitedError);
    expect(org.bookingCalls).toHaveLength(0);
  });

  it('still fails plainly — for the next tier — when the org answered something other than busy', async () => {
    const { FacilioApiDataSource } = await load();
    const { IncompleteListError } = await import('./rateLimit');
    org.tables.desks = [{ id: 41 }];
    org.booking = () => ({ error: { code: 500, message: 'boom' }, list: null });
    const err = await new FacilioApiDataSource().getBookings('4242', '2026-10-22').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(IncompleteListError);
  });
});

describe('which bookings a range read asks for', () => {
  /** The org's table, answered the way BETWEEN (inclusive) filters it. */
  const answer = (table: ReturnType<typeof row>[]) => (filters: Record<string, any>) => {
    const within = (v: number, f?: { value: string[] }) => !f || (v >= Number(f.value[0]) && v <= Number(f.value[1]));
    return { error: null, list: table.filter((r) => within(r.bookingStartTime, filters.bookingStartTime) && within(r.bookingEndTime, filters.bookingEndTime)) };
  };

  it('every booking that overlaps the range, and no look-back before it', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const { epochAtInTz } = await import('./orgTime');
    const from = epochAtInTz('2026-10-22', 0, null);
    const to = epochAtInTz('2026-10-22', 24 * 60, null);
    const DAY = 86_400_000;
    org.booking = answer([
      row(1, 41, { bookingStartTime: from + 9 * 3_600_000, bookingEndTime: from + 10 * 3_600_000 }), // in the day
      row(2, 42, { bookingStartTime: from - 40 * DAY, bookingEndTime: from + 12 * 3_600_000 }), // began 40 days earlier, runs into it
      row(3, 43, { bookingStartTime: from - 3 * DAY, bookingEndTime: from - 2 * DAY }), // over before it
      row(4, 44, { bookingStartTime: to, bookingEndTime: to + 3_600_000 }), // starts as it ends
    ]);
    const bookings = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22');
    expect([...new Set(bookings.map((b) => b.id))].sort()).toEqual(['1', '2']);
    const { filters } = org.bookingCalls[0];
    // Starts before the range ends, ends after it starts — nothing reaches back before the range.
    expect(Number(filters.bookingStartTime.value[1])).toBe(to - 1);
    expect(Number(filters.bookingEndTime.value[0])).toBe(from + 1);
    expect(Number(filters.bookingStartTime.value[0])).toBe(0);
    expect(filters.bookingStartTime.operatorId).toBe(20);
    expect(filters.bookingEndTime.operatorId).toBe(20);
  });

  it('falls back to the start-only shape, a month back, when the org refuses the overlap filter — and keeps to it', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const { epochAtInTz } = await import('./orgTime');
    const from = epochAtInTz('2026-10-22', 0, null);
    const table = [row(1, 41, { bookingStartTime: from + 9 * 3_600_000, bookingEndTime: from + 10 * 3_600_000 })];
    org.booking = (filters) => (filters.bookingEndTime ? { error: { code: 400, message: 'bad filter' }, list: null } : answer(table)(filters));

    const bookings = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22');
    expect(bookings.map((b) => b.id)).toEqual(['1']);
    const last = org.bookingCalls[org.bookingCalls.length - 1].filters;
    expect(last.bookingEndTime).toBeUndefined();
    expect(Number(last.bookingStartTime.value[0])).toBe(from - 31 * 86_400_000);

    // The next read asks the shape that answered, not the refused one first.
    org.bookingCalls.length = 0;
    await fetchOrgBookingsForRange('2026-10-23', '2026-10-23');
    expect(org.bookingCalls.every((c) => !c.filters.bookingEndTime)).toBe(true);
  });

  it('a refusal for rate is not taken as a refused filter', async () => {
    const { fetchOrgBookingsForRange } = await load();
    org.booking = () => ({ error: BUSY, list: null });
    await fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { strict: true }).catch(() => null);
    expect(org.bookingCalls).toHaveLength(1);
    expect(org.bookingCalls[0].filters.bookingEndTime).toBeTruthy();
  });

  it('a last page full at the cap is not passed off as all of them (strict)', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const { IncompleteListError } = await import('./rateLimit');
    org.booking = (_f, page) => ({ error: null, list: Array.from({ length: 500 }, (_, i) => row(page * 1000 + i, 41)) });
    const err = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { strict: true }).catch((e) => e);
    expect(org.bookingCalls).toHaveLength(6);
    expect(err).toBeInstanceOf(IncompleteListError);
    expect(err.rateLimited).toBe(false);
    expect(err.rows).toHaveLength(3000);
    // Not strict: the rows that came, as before.
    expect(await fetchOrgBookingsForRange('2026-10-22', '2026-10-22')).toHaveLength(3000);
  });
});

describe('a later page of bookings that fails', () => {
  const full = Array.from({ length: 500 }, (_, i) => row(1000 + i, 41));
  it('answers the bookings that came, as before, by default', async () => {
    const { fetchOrgBookingsForRange } = await load();
    org.booking = (_f, page) => (page === 1 ? { error: null, list: full } : { error: BUSY, list: null });
    expect(await fetchOrgBookingsForRange('2026-10-22', '2026-10-22')).toHaveLength(500);
  });

  it('rejects with them kept when the caller asked to be told (strict)', async () => {
    const { fetchOrgBookingsForRange } = await load();
    const { IncompleteListError } = await import('./rateLimit');
    org.booking = (_f, page) => (page === 1 ? { error: null, list: full } : { error: BUSY, list: null });
    const err = await fetchOrgBookingsForRange('2026-10-22', '2026-10-22', { strict: true }).catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteListError);
    expect(err.rows).toHaveLength(500);
    expect(err.rateLimited).toBe(true);
  });
});

describe('every bookable desk and room in the org', () => {
  it('stops at a refusal for rate instead of asking again unfiltered at once', async () => {
    const { fetchOrgBookableResources } = await load();
    org.pool = () => ({ error: BUSY, list: null });
    // Nothing read is a failure the calendar says (with Retry), not an org with nothing bookable.
    await expect(fetchOrgBookableResources()).rejects.toThrow(/could not be read/);
    // One filtered read per module, and no unfiltered second ask.
    expect(org.poolCalls).toHaveLength(2);
    expect(org.poolCalls.every((c) => c.params.filters)).toBe(true);
  });

  it('rejects when every read failed, and asks again on the next open', async () => {
    const { fetchOrgBookableResources } = await load();
    org.pool = () => ({ error: { code: 500, message: 'boom' }, list: null });
    await expect(fetchOrgBookableResources()).rejects.toThrow(/could not be read/);
    const before = org.poolCalls.length;
    org.pool = (module) => ({ error: null, list: module === 'desks' ? [{ id: 1, deskType: 3, floor: { id: 42 } }] : [] });
    expect(await fetchOrgBookableResources()).toHaveLength(1);
    expect(org.poolCalls.length).toBeGreaterThan(before);
  });

  it('is not kept when a page of it failed, so the next open reads it again', async () => {
    const { fetchOrgBookableResources } = await load();
    org.pool = (module, params) =>
      module === 'desks' && params.page === 1 ? { error: null, list: Array.from({ length: 500 }, (_, i) => ({ id: i + 1, floor: { id: 42 } })) } : { error: { code: 500, message: 'boom' }, list: null };
    expect(await fetchOrgBookableResources()).toHaveLength(500);
    const before = org.poolCalls.length;
    await fetchOrgBookableResources();
    expect(org.poolCalls.length).toBeGreaterThan(before);
  });

  it('is read once for two opens of the form within a minute — `force` re-reads only an older pool', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { fetchOrgBookableResources } = await load();
      org.pool = (module) => ({ error: null, list: module === 'desks' ? [{ id: 1, deskType: 3, floor: { id: 42 } }] : [] });
      await fetchOrgBookableResources({ force: true });
      const once = org.poolCalls.length;
      await fetchOrgBookableResources({ force: true });
      expect(org.poolCalls.length).toBe(once);
      vi.setSystemTime(Date.now() + 61_000);
      await fetchOrgBookableResources({ force: true });
      expect(org.poolCalls.length).toBeGreaterThan(once);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a lookup's picklist", () => {
  it('does not ask again without `default` when the first read was refused for rate', async () => {
    const { fetchPicklist } = await load();
    org.get = (path) => (path.startsWith('v3/picklist/') ? BUSY : null);
    expect(await fetchPicklist('department', { defaultIds: ['7'] })).toBeNull();
    expect(org.getCalls.filter((c) => c.path.startsWith('v3/picklist/'))).toHaveLength(1);
  });

  it('still asks again without `default` when the server refused the parameter', async () => {
    const { fetchPicklist } = await load();
    org.get = (path, params) => (path.startsWith('v3/picklist/') ? (params?.default ? { code: 400, message: 'bad param' } : { code: 0, data: { pickList: [{ value: 1, label: 'HR' }] } }) : null);
    expect(await fetchPicklist('department', { defaultIds: ['7'] })).toEqual({ options: [{ value: '1', label: 'HR' }], more: false });
    expect(org.getCalls.filter((c) => c.path.startsWith('v3/picklist/'))).toHaveLength(2);
  });
});

describe('the reads the app repeats', () => {
  it('downloads the account once at boot, for the clock, the role and the people id together', async () => {
    const mod = await load();
    org.get = (path) => (path === 'v2/fetchAccount' ? { result: { account: { timezone: 'Asia/Dubai', user: { peopleId: 812, role: { roleId: 3874, name: 'CAFM Administrator', isPrevileged: true } } } } } : null);
    const [tz, role, people] = await Promise.all([mod.fetchOrgTimezone(), mod.fetchCurrentRole(), mod.fetchCurrentPeopleId()]);
    expect(tz).toBe('Asia/Dubai');
    expect(role).toEqual({ id: '3874', name: 'CAFM Administrator', isAdmin: true });
    expect(people).toBe(812);
    expect(org.getCalls.filter((c) => c.path === 'v2/fetchAccount')).toHaveLength(1);
  });

  it('asks again for an account read that failed, rather than keep the failure', async () => {
    const mod = await load();
    org.get = () => BUSY;
    expect(await mod.fetchCurrentPeopleId()).toBeNull();
    org.get = (path) => (path === 'v2/fetchAccount' ? { result: { account: { user: { peopleId: 9 } } } } : null);
    expect(await mod.fetchCurrentRole()).toBeNull(); // no role in it — but it was asked for afresh
    expect(org.getCalls.filter((c) => c.path === 'v2/fetchAccount')).toHaveLength(2);
  });

  it('reads the org time zone again after an account read Facilio refused — the refusal is not kept as "no zone"', async () => {
    const mod = await load();
    org.get = () => BUSY;
    expect(await mod.fetchOrgTimezone()).toBeNull();
    org.get = (path) => (path === 'v2/fetchAccount' ? { result: { account: { timezone: 'Asia/Dubai' } } } : null);
    expect(await mod.fetchOrgTimezone()).toBe('Asia/Dubai');
    expect(org.getCalls.filter((c) => c.path === 'v2/fetchAccount')).toHaveLength(2);
    // Read once it answered: kept.
    await mod.fetchOrgTimezone();
    expect(org.getCalls.filter((c) => c.path === 'v2/fetchAccount')).toHaveLength(2);
  });

  it('reads the viewer role and people id again after a refused account — but keeps an account that named neither', async () => {
    const mod = await load();
    org.get = () => BUSY;
    expect(await mod.fetchCurrentRole()).toBeNull();
    expect(await mod.fetchCurrentPeopleId()).toBeNull();
    org.get = (path) => (path === 'v2/fetchAccount' ? { result: { account: { user: { peopleId: 812, role: { roleId: 4215, name: 'Staff' } } } } } : null);
    expect(await mod.fetchCurrentRole()).toEqual({ id: '4215', name: 'Staff', isAdmin: false });
    expect(await mod.fetchCurrentPeopleId()).toBe(812);

    const again = await load();
    org.getCalls.length = 0;
    org.get = (path) => (path === 'v2/fetchAccount' ? { result: { account: { user: {} } } } : null);
    expect(await again.fetchCurrentRole()).toBeNull();
    expect(await again.fetchCurrentRole()).toBeNull();
    // A real answer with no role in it is kept: one account read (and v2/account, null, asked once).
    expect(org.getCalls.filter((c) => c.path === 'v2/fetchAccount')).toHaveLength(1);
  });

  it('asks again for a booking form, the form list and the employee filter fields after a refused read', async () => {
    const mod = await load();
    org.get = () => BUSY;
    expect(await mod.fetchBookingFormList('space')).toEqual([]);
    expect(await mod.fetchEmployeeFilterFields()).toBeNull();
    const types = await mod.resolveFormResourceTypes('space', [{ id: 9, name: 'default_deskbooking_web', displayName: 'Desk' }]);
    expect(types.get(9)).toBeNull();

    org.getCalls.length = 0;
    org.get = (path, params) => {
      if (path === 'v2/forms') return { result: { forms: [{ id: 9, name: 'default_deskbooking_web', displayName: 'Desk' }] } };
      if (path === 'v2/forms/getForm') return { result: { form: { id: params?.formId, name: 'f', displayName: 'F', sections: [{ fields: [{ field: { name: 'desk', lookupModule: { name: 'desks' } } }] }] } } };
      if (path === 'v2/filter/advanced/fields/employee') return { result: { fields: [{ name: 'department', displayName: 'Department', dataType: 'LOOKUP', lookupModule: { name: 'department' } }] } };
      return null;
    };
    expect((await mod.fetchBookingFormList('space')).map((f) => f.id)).toEqual([9]);
    expect(await mod.fetchEmployeeFilterFields()).not.toBeNull();
    expect((await mod.resolveFormResourceTypes('space', [{ id: 9, name: 'default_deskbooking_web', displayName: 'Desk' }])).get(9)).toBe('workstation');
    // Each asked afresh — none of the refusals was kept as the answer.
    const asked = (path: string) => org.getCalls.filter((c) => c.path === path).length;
    expect(asked('v2/forms')).toBe(1);
    expect(asked('v2/forms/getForm')).toBe(1);
    expect(asked('v2/filter/advanced/fields/employee')).toBe(1);
  });

  it('answers the same floor search typed again within half a minute from the first answer', async () => {
    const { FacilioApiDataSource } = await load();
    org.pool = (module) => (module === 'floor' ? { error: null, list: [{ id: 5, name: 'Level 3', building: { id: 2, name: 'Block B' }, site: { id: 1, name: 'HQ' } }] } : { error: null, list: [] });
    const ds = new FacilioApiDataSource();
    const first = await ds.searchFloors('Level');
    const again = await ds.searchFloors('Level');
    expect(again).toEqual(first);
    expect(org.poolCalls.filter((c) => c.module === 'floor')).toHaveLength(1);
  });

  it('says busy for a floor search Facilio refused for rate — one call, and no floor index read at once', async () => {
    const { FacilioApiDataSource } = await load();
    const { RateLimitedError } = await import('./rateLimit');
    const ds = new FacilioApiDataSource();
    org.pool = () => ({ error: BUSY, list: null });
    await expect(ds.searchFloors('Level')).rejects.toBeInstanceOf(RateLimitedError);
    expect(org.poolCalls).toHaveLength(1);
    // Not kept as the answer: the same search typed again asks again.
    org.pool = (module) => (module === 'floor' ? { error: null, list: [{ id: 5, name: 'Level 3', building: { id: 2, name: 'Block B' }, site: { id: 1, name: 'HQ' } }] } : { error: null, list: [] });
    expect((await ds.searchFloors('Level')).map((h) => h.floorId)).toEqual(['5']);
    expect(org.poolCalls).toHaveLength(2);
  });

  it('reads the booking forms’ details two at a time', async () => {
    const { resolveFormResourceTypes } = await load();
    org.get = (path, params) => (path === 'v2/forms/getForm' ? { result: { form: { id: params?.formId, name: 'f', displayName: 'F', sections: [] } } } : null);
    const forms = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `form_${i}`, displayName: `Form ${i}` }));
    const types = await resolveFormResourceTypes('space', forms);
    expect(types.size).toBe(12);
    expect(org.getCalls.filter((c) => c.path === 'v2/forms/getForm')).toHaveLength(12);
    expect(org.mostGetInFlight).toBeLessThanOrEqual(2);
  });
});
