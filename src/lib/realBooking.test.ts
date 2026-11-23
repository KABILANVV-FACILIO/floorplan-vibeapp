import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from './types';

/**
 * Making and cancelling a booking against the org. A booking is the org's own `spacebooking`
 * record — created through the form the user filled, with the resource in the lookup its type
 * books under, times on the ORG's clock and the breach marker sent explicitly — and cancelled only
 * through its own stateflow Cancel step. These pin what each sends, and what each refuses to send.
 */

const TZ = 'Asia/Dubai';
const org = vi.hoisted(() => ({
  created: [] as { module: string; data: Record<string, any> }[],
  refuseCreate: null as null | { code: number; message: string },
  markers: [{ id: 1, geoId: '5001', recordId: 5001 }] as { id: number; geoId: string; recordId?: number }[],
  markersFail: false,
  transitions: [] as { id: number; name: string }[],
  patches: [] as { path: string; body: any }[],
  gets: [] as string[],
}));

vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  isConnectedApp: true,
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  customGet: vi.fn(async (path: string) => {
    org.gets.push(path);
    if (path === 'v3/floorplan/getFloorplanDetailsByType') return { code: 0, data: { indoorFloorPlans: { '1': { id: 26 } } } };
    if (path === 'v2/fetchAccount') return { result: { account: { timezone: 'Asia/Dubai' } } };
    if (path === 'v2/statetransition/getAvailableState') return { responseCode: 0, result: { currentState: { displayName: 'Booked' }, states: org.transitions } };
    return null;
  }),
  customPatch: vi.fn(async (path: string, body: unknown) => {
    org.patches.push({ path, body });
    return { code: 0, data: {} };
  }),
  facilioApi: {
    fetchAll: vi.fn(),
    fetchRecord: vi.fn(async (module: string, { id }: { id: number }) => {
      if (module === 'floor') return { floor: { id, site: { id: 7 }, building: { id: 3 } } };
      if (module === 'desks') return { desks: { id, moduleId: 1101 } };
      if (module === 'space') return { space: { id, moduleId: 1102 } };
      return { error: { code: 1, message: `unexpected ${module}` } };
    }),
    fetchAllRelatedList: vi.fn(async () => (org.markersFail ? { error: { code: 500, message: 'down' }, list: null } : { error: null, list: org.markers })),
    createRecord: vi.fn(async (module: string, { data }: { data: Record<string, any> }) => {
      org.created.push({ module, data });
      if (org.refuseCreate) return { error: org.refuseCreate };
      return { [module]: { id: 9100 } };
    }),
    updateRecord: vi.fn(async () => ({ error: null })),
    deleteRecord: vi.fn(),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const desk: Unit = { id: '5001', type: 'workstation', label: 'WS-05', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: '42', plan: 'workstation' };
const room: Unit = { id: '7300', type: 'room', label: 'Board Room', room: null, geom: { kind: 'poly', pts: [] }, floor: '42', plan: 'workstation', orgRoom: true };
const locker: Unit = { id: '6001', type: 'locker', label: 'L-01', room: null, geom: { kind: 'point', x: 0.2, y: 0.2 }, floor: '42', plan: 'locker' };

async function load() {
  vi.resetModules();
  return {
    ...(await import('./facilioApiDataSource')),
    epochAtInTz: (await import('./orgTime')).epochAtInTz,
  };
}

beforeEach(() => {
  org.created.length = 0;
  org.refuseCreate = null;
  org.markers = [{ id: 1, geoId: '5001', recordId: 5001 }];
  org.markersFail = false;
  org.transitions = [];
  org.patches.length = 0;
  org.gets.length = 0;
});

describe('booking a desk in the org', () => {
  it('creates one spacebooking: the desk lookup, its module, the window on the org clock, the breach marker, the people', async () => {
    const { createRealBooking, epochAtInTz } = await load();
    const res = await createRealBooking(desk, '2026-11-24', 9 * 60, 11 * 60, {
      module: 'space',
      reservedBy: '812',
      host: '900',
      internalAttendees: ['44', 'c1'], // a mock id ("c1") is no org person — dropped
      externalAttendees: ['55'],
      formId: 77,
      extras: { purposeOfVisit: 'Audit', bookingStartTime: 1 }, // a mapped field always wins over an extra
    });
    expect(res).toEqual({ ok: true, id: 9100 });
    expect(org.created).toHaveLength(1);
    const { module, data } = org.created[0];
    expect(module).toBe('spacebooking');
    const start = epochAtInTz('2026-11-24', 9 * 60, TZ);
    expect(data).toEqual({
      purposeOfVisit: 'Audit',
      formId: 77,
      actionFormId: 77,
      desk: { id: 5001 },
      parentModuleId: 1101,
      bookingStartTime: start,
      bookingEndTime: epochAtInTz('2026-11-24', 11 * 60, TZ),
      bookingbreachtime: start + 30 * 60_000,
      noOfAttendees: 2,
      name: 'WS-05 booking',
      externalAttendees: [{ id: 55 }],
      // The reserver is always an attendee, first — spacebooking requires at least one.
      internalAttendees: [{ id: 812 }, { id: 44 }],
      reservedBy: { id: 812 },
      host: { id: 900 },
    });
  });

  it('ends on another day when the window runs past midnight', async () => {
    const { createRealBooking, epochAtInTz } = await load();
    await createRealBooking(desk, '2026-11-24', 22 * 60, 2 * 60, { module: 'space', endDateISO: '2026-11-25', name: 'Night shift' });
    expect(org.created[0].data.bookingEndTime).toBe(epochAtInTz('2026-11-25', 2 * 60, TZ));
    expect(org.created[0].data.name).toBe('Night shift');
  });

  it('refuses an end that is not after the start, and sends nothing', async () => {
    const { createRealBooking } = await load();
    expect(await createRealBooking(desk, '2026-11-24', 11 * 60, 9 * 60, { module: 'space' })).toEqual({ ok: false, reason: 'the end is not after the start' });
    expect(org.created).toHaveLength(0);
  });

  it("passes on the org's own reason when it refuses the booking", async () => {
    const { createRealBooking } = await load();
    org.refuseCreate = { code: 400, message: 'Desk already booked for this time' };
    expect(await createRealBooking(desk, '2026-11-24', 9 * 60, 10 * 60, { module: 'space' })).toEqual({ ok: false, reason: 'Desk already booked for this time' });
  });

  it('refuses when the desk has no org record it can resolve, and sends no booking', async () => {
    const { createRealBooking } = await load();
    org.markersFail = true;
    expect(await createRealBooking(desk, '2026-11-24', 9 * 60, 10 * 60, { module: 'space' })).toEqual({ ok: false, reason: 'no real backend record for this unit' });
    expect(org.created.filter((c) => c.module === 'spacebooking')).toHaveLength(0);
  });
});

describe('booking a room, and what cannot be booked', () => {
  it('books a room as its own space record', async () => {
    const { createRealBooking } = await load();
    expect(await createRealBooking(room, '2026-11-24', 14 * 60, 15 * 60, { module: 'space', reservedBy: '812' })).toEqual({ ok: true, id: 9100 });
    expect(org.created[0].data).toMatchObject({ space: { id: 7300 }, parentModuleId: 1102, name: 'Board Room booking', noOfAttendees: 1 });
    expect(org.created[0].data).not.toHaveProperty('desk');
  });

  it('refuses a room outline with no space behind it', async () => {
    const { createRealBooking } = await load();
    expect(await createRealBooking({ ...room, id: 'zone-12' }, '2026-11-24', 14 * 60, 15 * 60, { module: 'space' })).toEqual({ ok: false, reason: 'this room has no space record in the org' });
    expect(org.created).toHaveLength(0);
  });

  it('refuses a locker — spacebooking has no lookup for one', async () => {
    const { createRealBooking } = await load();
    expect(await createRealBooking(locker, '2026-11-24', 9 * 60, 10 * 60, { module: 'space' })).toEqual({ ok: false, reason: 'no spacebooking mapping for locker' });
    expect(org.created).toHaveLength(0);
  });

  it('leaves facility bookings alone until slots are provisioned', async () => {
    const { createRealBooking } = await load();
    const res = await createRealBooking(desk, '2026-11-24', 9 * 60, 10 * 60, { module: 'facility' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/slot provisioning/);
    expect(org.created).toHaveLength(0);
  });
});

describe('cancelling a booking in the org', () => {
  it('refuses a booking minted in this browser, without asking the org anything', async () => {
    const { cancelRealBooking } = await load();
    await expect(cancelRealBooking('b1730000000000')).rejects.toThrow('not a booking Facilio holds');
    expect(org.gets).toHaveLength(0);
    expect(org.patches).toHaveLength(0);
  });

  it('refuses when the booking’s state offers no Cancel step — and sends no transition', async () => {
    const { cancelRealBooking } = await load();
    org.transitions = [{ id: 3, name: 'Check In' }];
    await expect(cancelRealBooking('9100')).rejects.toThrow('cannot be cancelled in its current state');
    expect(org.patches).toHaveLength(0);
  });

  it('runs the Cancel step — exactly one transition, on the booking’s own path', async () => {
    const { cancelRealBooking } = await load();
    org.transitions = [{ id: 3, name: 'Check In' }, { id: 4, name: 'Cancel Booking' }];
    await cancelRealBooking('9100');
    expect(org.patches).toEqual([{ path: 'v3/action/spacebooking/9100/transition', body: { id: 9100, stateTransitionId: 4, data: {} } }]);
  });
});
