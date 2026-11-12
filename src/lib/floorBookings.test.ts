import { describe, expect, it, vi } from 'vitest';

/**
 * The plan's day list asks the org for this floor's bookings only. `spacebooking` has no floor
 * field, so "this floor" is its desks', spaces' and stalls' ids, each lookup in a query of its own,
 * at most BOOKING_IDS_PER_QUERY ids to a query (the filter rides in the request URL). It used to
 * read the whole org's last month of bookings on every floor load and date change, then keep this
 * floor's in the browser.
 */

const FLOOR = '4242';
const DESK_IDS = Array.from({ length: 320 }, (_, i) => 10_000 + i);
const SPACE_IDS = Array.from({ length: 12 }, (_, i) => 20_000 + i);
const tables: Record<string, { id: number }[]> = {
  desks: DESK_IDS.map((id) => ({ id })),
  space: SPACE_IDS.map((id) => ({ id })),
  parkingstall: [],
};

let failSpaceList = false;
const bookingQueries: Record<string, { operatorId: number; value: string[] }>[] = [];

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  customGet: vi.fn(async (path: string) => {
    const count = /relatedList\/(\w+)\/\w+\/count$/.exec(path);
    if (count) return { code: 0, data: { count: tables[count[1]].length } };
    return { code: 0, data: {} }; // the account read for the org clock: no zone, the browser's applies
  }),
  facilioApi: {
    fetchRecord: vi.fn(),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string }, params: { page: number; perPage: number }) => {
      if (failSpaceList && opts.relatedModuleName === 'space') return { error: { code: 500, message: 'boom' }, list: [] };
      const all = tables[opts.relatedModuleName];
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
    fetchAll: vi.fn(async (module: string, params: { filters: string }) => {
      if (module !== 'spacebooking') return { error: null, list: [] };
      const filters = JSON.parse(params.filters);
      bookingQueries.push(filters);
      // One real booking, on the first desk, returned by whichever query names that desk.
      const desk = filters.desk?.value ?? [];
      const day = Date.parse('2026-10-22T09:00:00');
      return { error: null, list: desk.includes(String(DESK_IDS[0])) ? [{ id: 77, desk: { id: DESK_IDS[0] }, bookingStartTime: day, bookingEndTime: day + 3_600_000 }] : [] };
    }),
  },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { FacilioApiDataSource } = await import('./facilioApiDataSource');

describe("the plan's bookings for a day", () => {
  it("asks only for this floor's desks, spaces and stalls, in queries of at most 150 ids", async () => {
    const bookings = await new FacilioApiDataSource().getBookings(FLOOR, '2026-10-22');

    expect(bookingQueries.length).toBeGreaterThan(0);
    const named: Record<string, string[]> = { desk: [], space: [], parkingStall: [] };
    for (const q of bookingQueries) {
      const fields = ['desk', 'space', 'parkingStall'].filter((f) => q[f]);
      // Every query is scoped to records — none reads the org at large.
      expect(fields).toHaveLength(1);
      expect(q[fields[0]].operatorId).toBe(36);
      expect(q[fields[0]].value.length).toBeLessThanOrEqual(150);
      named[fields[0]].push(...q[fields[0]].value);
    }
    expect(named.desk.sort()).toEqual(DESK_IDS.map(String).sort());
    expect(named.space.sort()).toEqual(SPACE_IDS.map(String).sort());
    // The floor has no stalls, so no stall query is sent at all.
    expect(named.parkingStall).toEqual([]);
    // 320 desks → three desk queries; 12 spaces → one.
    expect(bookingQueries.filter((q) => q.desk)).toHaveLength(3);
    expect(bookingQueries.filter((q) => q.space)).toHaveLength(1);

    expect(bookings.map((b) => [b.id, b.unitId])).toEqual([['77', String(DESK_IDS[0])]]);
  });

  it('fails the read when a floor list cannot be read, rather than calling the floor unbooked', async () => {
    failSpaceList = true;
    await expect(new FacilioApiDataSource().getBookings('5151', '2026-10-22')).rejects.toThrow();
    failSpaceList = false;
  });
});
