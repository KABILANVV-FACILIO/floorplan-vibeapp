import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After an assign or vacate the plan re-reads who holds the desks that changed — not every desk,
 * locker and stall on the floor. One by-id read per module touched; the states of the other desks
 * are left as they are; and a read that fails is a stop, never "nobody holds these".
 */

const FLOOR = '4242';
const BUSY = { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' };

const org = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  listCalls: [] as { module: string; ids: string[] }[],
  listError: null as null | ((module: string) => unknown),
}));

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customGet: vi.fn(async () => ({ code: 1, message: 'no count here' })),
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  facilioApi: {
    fetchRecord: vi.fn(),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string }, params: { page: number; perPage: number }) => {
      const all = org.tables[opts.relatedModuleName] ?? [];
      return { error: null, list: all.slice((params.page - 1) * params.perPage, params.page * params.perPage) };
    }),
    fetchAll: vi.fn(async (module: string, params: { filters: string }) => {
      const ids: string[] = JSON.parse(params.filters).id.value;
      org.listCalls.push({ module, ids });
      const error = org.listError?.(module);
      if (error) return { error, list: null };
      return { error: null, list: (org.tables[module] ?? []).filter((r) => ids.includes(String(r.id))) };
    }),
  },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

async function fresh() {
  vi.resetModules();
  const mod = await import('./facilioApiDataSource');
  const { takeRecordStates } = await import('./recordStates');
  const { IncompleteListError } = await import('./rateLimit');
  return { ...mod, takeRecordStates, IncompleteListError };
}

const desk = (i: number, over: Record<string, unknown> = {}) => ({ id: 5000 + i, name: `WS-${i}`, employee: i % 2 ? { id: 900 + i } : null, moduleState: { status: i % 2 ? 'assigned' : 'vacant' }, ...over });

beforeEach(() => {
  org.tables = { desks: Array.from({ length: 400 }, (_, i) => desk(i)), lockers: [{ id: 7001, employee: null, moduleState: { status: 'vacant' } }], parkingstall: [] };
  org.listCalls.length = 0;
  org.listError = null;
});

/** A floor loaded the way the app loads it, its states taken. */
async function loaded() {
  const mod = await fresh();
  await new mod.FacilioApiDataSource().getAssignments(FLOOR, vi.fn());
  mod.takeRecordStates(FLOOR);
  return mod;
}

describe('who holds the desks that just changed', () => {
  it('an assign on a 400-desk floor: one by-id read of the desks, and only their states noted', async () => {
    const { FacilioApiDataSource, takeRecordStates } = await loaded();
    // Desk 4 was just assigned in the org.
    org.tables.desks[4] = desk(4, { employee: { id: 812 }, moduleState: { status: 'assigned' } });

    const holders = await new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['5004', '5005']);

    expect(org.listCalls).toEqual([{ module: 'desks', ids: ['5004', '5005'] }]);
    expect(holders).toEqual({ '5004': '812', '5005': '905' });
    // The other 398 desks' states are not touched: only these two are handed over, to merge.
    expect(takeRecordStates(FLOOR)).toEqual({ '5004': 'assigned', '5005': 'assigned' });
  });

  it("asks past the host page's cache — the holder just written, never the answer from before it", async () => {
    const { FacilioApiDataSource } = await loaded();
    const { facilioApi } = await import('./facilioApi');
    vi.mocked(facilioApi.fetchAll).mockClear();
    await new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['5004']);
    expect(vi.mocked(facilioApi.fetchAll).mock.calls.every((c) => (c[2] as { fresh?: boolean } | undefined)?.fresh === true)).toBe(true);
    expect(vi.mocked(facilioApi.fetchAll)).toHaveBeenCalled();
  });

  it('a vacate: the desk is missing from the answer — vacant', async () => {
    const { FacilioApiDataSource } = await loaded();
    org.tables.desks[5] = desk(5, { employee: null, moduleState: { status: 'temporarilyvacant' } });
    expect(await new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['5005'])).toEqual({});
  });

  it('reads each module touched once — a desk and a locker are two reads', async () => {
    const { FacilioApiDataSource } = await loaded();
    await new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['5001', '7001']);
    expect(org.listCalls.map((c) => c.module).sort()).toEqual(['desks', 'lockers']);
  });

  it('asks all three modules for a record the floor read did not see, and nothing for an id minted in this browser', async () => {
    const { FacilioApiDataSource } = await fresh();
    org.tables.desks.push(desk(900, { id: 9900, employee: { id: 77 } }));
    const holders = await new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['9900', 'u1699000000']);
    expect(org.listCalls.map((c) => c.module).sort()).toEqual(['desks', 'lockers', 'parkingstall']);
    expect(org.listCalls.every((c) => c.ids.length === 1 && c.ids[0] === '9900')).toBe(true);
    expect(holders).toEqual({ '9900': '77' });
  });

  it('rejects with an IncompleteListError — never "nobody" — when a read fails, and says when it was busy', async () => {
    const { FacilioApiDataSource, IncompleteListError } = await loaded();
    org.listError = () => BUSY;
    const busy = await new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['5004']).catch((e) => e);
    expect(busy).toBeInstanceOf(IncompleteListError);
    expect(busy.rateLimited).toBe(true);
    org.listError = () => ({ code: 500, message: 'down' });
    const down = await new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['5004']).catch((e) => e);
    expect(down).toBeInstanceOf(IncompleteListError);
    expect(down.rateLimited).toBe(false);
  });

  it('rejects when the org answered rows it was not asked for — an id filter that was not applied', async () => {
    const { FacilioApiDataSource, IncompleteListError } = await loaded();
    const { facilioApi } = await import('./facilioApi');
    vi.mocked(facilioApi.fetchAll).mockResolvedValueOnce({ error: null, list: org.tables.desks.slice(0, 50) });
    await expect(new FacilioApiDataSource().getAssignmentsFor(FLOOR, ['5004'])).rejects.toBeInstanceOf(IncompleteListError);
  });
});
