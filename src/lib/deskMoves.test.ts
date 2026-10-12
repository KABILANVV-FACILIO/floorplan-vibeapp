import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from './types';

/**
 * Assigning and vacating a DESK go through the org's `moves` module — a move record the org's
 * own create chain turns into the desk changes (see createDeskMove) — while a locker or parking
 * stall is still a field write. These pin the exact payloads, the margin on the move's time, and
 * that a refusal is reported with the org's reason rather than thrown into a drag.
 */

const org = vi.hoisted(() => ({
  refuseMoves: false,
  create: [] as { module: string; data: any }[],
  update: [] as { module: string; id: number; data: any }[],
}));

vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customPost: vi.fn(),
  customPatch: vi.fn(),
  fetchFilePreview: vi.fn(),
  customGet: vi.fn(async (path: string) => {
    // The locker's plan, for the marker-backed record resolution lockers still use.
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: { '1': { id: 26 }, '2': { id: 27 }, '3': { id: 28 } } } };
    return null;
  }),
  facilioApi: {
    fetchAll: vi.fn(async () => ({ error: null, list: [] })),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number | string }) => {
      if (module === 'floor') return { floor: { id, site: { id: 7 }, building: { id: 3 } } };
      if (module === 'indoorfloorplan') return { indoorfloorplan: { id, geometry: null } };
      return { error: { code: 1, message: `unexpected ${module}` } };
    }),
    fetchAllRelatedList: vi.fn(async (opts: { relatedModuleName: string }) => {
      if (opts.relatedModuleName === 'floorplanmarker') return { error: null, list: [{ id: 1, geoId: '6001', recordId: 6001 }] };
      return { error: null, list: [] };
    }),
    createRecord: vi.fn(async (module: string, { data }: { data: any }) => {
      org.create.push({ module, data });
      if (module === 'moves' && org.refuseMoves) return { error: { code: 400, message: 'Current desk of the employee does not match with the given data' } };
      return { [module]: { id: module === 'moves' ? 777 : 1 } };
    }),
    updateRecord: vi.fn(async (module: string, { id, data }: { id: number; data: any }) => {
      org.update.push({ module, id, data });
      return { [module]: { id } };
    }),
    deleteRecord: vi.fn(),
    uploadFiles: vi.fn(),
  },
}));

const desk: Unit = { id: '5001', type: 'workstation', label: 'WS-05', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: '42', plan: 'workstation' };
const locker: Unit = { id: '6001', type: 'locker', label: 'L-01', room: null, geom: { kind: 'point', x: 0.2, y: 0.2 }, floor: '42', plan: 'locker' };

async function load() {
  vi.resetModules();
  return import('./facilioApiDataSource');
}

beforeEach(() => {
  org.refuseMoves = false;
  org.create.length = 0;
  org.update.length = 0;
});

describe('a desk is assigned through a move record', () => {
  it('sends the person onto the desk as an instant move, stamped a minute back, with the site', async () => {
    const { assignUnitReal, MOVE_TIME_MARGIN_MS } = await load();
    const before = Date.now();
    expect(await assignUnitReal(desk, '812')).toEqual({ ok: true });
    const moves = org.create.filter((c) => c.module === 'moves');
    expect(moves).toHaveLength(1);
    const { timeOfMove, ...rest } = moves[0].data;
    expect(rest).toEqual({ to: { id: 5001 }, employee: { id: 812 }, moveType: 1, siteId: 7 });
    expect(rest).not.toHaveProperty('from');
    expect(rest).not.toHaveProperty('scheduledTime');
    // At or before the org's clock, whatever the browser's says: the move must execute, not wait forever.
    expect(before - timeOfMove).toBeGreaterThanOrEqual(MOVE_TIME_MARGIN_MS - 50);
    expect(Date.now() - timeOfMove).toBeLessThan(MOVE_TIME_MARGIN_MS + 5000);
    // The desk's own field is never written by hand — the org's move chain does that.
    expect(org.update.filter((u) => u.module === 'desks')).toEqual([]);
  });

  it('vacates a desk with a from-only move — the org reads the person off the desk', async () => {
    const { vacateUnitReal } = await load();
    expect(await vacateUnitReal(desk, '812')).toEqual({ ok: true });
    const moves = org.create.filter((c) => c.module === 'moves');
    expect(moves).toHaveLength(1);
    const { timeOfMove, ...rest } = moves[0].data;
    expect(rest).toEqual({ from: { id: 5001 }, moveType: 1, siteId: 7 });
    expect(rest).not.toHaveProperty('employee');
    expect(typeof timeOfMove).toBe('number');
    expect(org.update).toEqual([]);
  });

  it("reports the org's reason when it refuses the move, instead of throwing into a drag", async () => {
    org.refuseMoves = true;
    const { assignUnitReal, assignEmployeeToRecord } = await load();
    expect(await assignUnitReal(desk, '812')).toEqual({ ok: false, reason: 'Current desk of the employee does not match with the given data' });
    // The picker's path throws the same reason, so its toast can say it.
    await expect(assignEmployeeToRecord(desk, '812')).rejects.toThrow('Current desk of the employee does not match');
  });

  it('refuses a person who is not an org employee before sending anything', async () => {
    const { assignUnitReal } = await load();
    expect(await assignUnitReal(desk, 'c1')).toMatchObject({ ok: false });
    expect(org.create).toEqual([]);
  });
});

describe('lockers and parking stalls are still field writes', () => {
  it('assigns a locker by writing its employee, and never creates a move', async () => {
    const { assignUnitReal } = await load();
    expect(await assignUnitReal(locker, '812')).toEqual({ ok: true });
    expect(org.create.filter((c) => c.module === 'moves')).toEqual([]);
    expect(org.update).toEqual([{ module: 'lockers', id: 6001, data: { employee: { id: 812 } } }]);
  });

  it('vacates a locker by clearing its employee', async () => {
    const { vacateUnitReal } = await load();
    expect(await vacateUnitReal(locker, '812')).toEqual({ ok: true });
    expect(org.create.filter((c) => c.module === 'moves')).toEqual([]);
    expect(org.update).toEqual([{ module: 'lockers', id: 6001, data: { employee: null } }]);
  });
});
