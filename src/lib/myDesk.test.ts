import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "My desk" against the org: the session's people id from the account payload, then the desk
 * whose `employee` is that id — the same field the plan reads every assignment from — with the
 * employee portal's home endpoint only as the fallback. What these pin is the ORDER and the
 * filter sent; the payload shapes are what the org answers today and are asserted as data.
 */

/** What the fake org answers; each test sets it before importing the module afresh. */
const org: {
  account: any;
  fetchAccount: any;
  desksByEmployee: Record<string, any[]>;
  portalHome: any;
  desksFail?: boolean;
} = { account: null, fetchAccount: null, desksByEmployee: {}, portalHome: null };
const calls: { path: string; params?: unknown }[] = [];
const fetchAllCalls: { module: string; params: any }[] = [];

// The data source pulls in the PDF/CAD previewers, which want a browser canvas the test runtime has no use for.
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  isFacilioApiConfigured: true,
  customPost: vi.fn(),
  customPatch: vi.fn(),
  fetchFilePreview: vi.fn(),
  customGet: vi.fn(async (path: string, params?: unknown) => {
    calls.push({ path, params });
    if (path === 'v2/fetchAccount') return org.fetchAccount;
    if (path === 'v2/account') return org.account;
    if (path === 'v2/servicePortalHome') return org.portalHome;
    return null;
  }),
  facilioApi: {
    fetchAll: vi.fn(async (module: string, params: any) => {
      fetchAllCalls.push({ module, params });
      if (module !== 'desks') return { error: { code: 1, message: `unexpected ${module}` }, list: null };
      if (org.desksFail) return { error: { code: 500, message: 'desks down' }, list: null };
      const filters = JSON.parse(params.filters ?? '{}');
      const employee = filters.employee?.value?.[0];
      return { error: null, list: employee ? (org.desksByEmployee[employee] ?? []) : [] };
    }),
    fetchRecord: vi.fn(),
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    deleteRecord: vi.fn(),
    fetchAllRelatedList: vi.fn(),
    uploadFiles: vi.fn(),
  },
}));

async function load() {
  vi.resetModules();
  return import('./facilioApiDataSource');
}

beforeEach(() => {
  org.account = null;
  org.fetchAccount = null;
  org.desksByEmployee = {};
  org.portalHome = null;
  org.desksFail = false;
  calls.length = 0;
  fetchAllCalls.length = 0;
});

describe('fetchCurrentPeopleId', () => {
  it('reads the people id off the account payload, trying fetchAccount before account', async () => {
    org.fetchAccount = { result: { account: { user: { id: 7, peopleId: 812 } } } };
    const { fetchCurrentPeopleId } = await load();
    expect(await fetchCurrentPeopleId()).toBe(812);
    expect(calls.map((c) => c.path)).toEqual(['v2/fetchAccount']);
  });

  it('falls back to v2/account, and answers null when neither names a person', async () => {
    org.account = { account: { user: { peopleId: 44 } } };
    let mod = await load();
    expect(await mod.fetchCurrentPeopleId()).toBe(44);
    expect(calls.map((c) => c.path)).toEqual(['v2/fetchAccount', 'v2/account']);

    org.account = { account: { user: { id: 7 } } };
    mod = await load();
    expect(await mod.fetchCurrentPeopleId()).toBeNull();
  });
});

describe('fetchMyDesk', () => {
  it('finds the desk whose employee is the session user, by the same field the plan reads', async () => {
    org.fetchAccount = { result: { account: { user: { peopleId: 812 } } } };
    org.desksByEmployee['812'] = [{ id: 5001, name: 'WS-05', floor: { id: 42 }, employee: { id: 812 } }];
    const { fetchMyDesk } = await load();
    expect(await fetchMyDesk()).toEqual({ recordId: 5001, name: 'WS-05', floorId: '42', booked: false });
    expect(fetchAllCalls).toHaveLength(1);
    expect(JSON.parse(fetchAllCalls[0].params.filters)).toEqual({ employee: { operatorId: 36, value: ['812'] } });
    // The portal endpoint is not consulted when the desk is found.
    expect(calls.some((c) => c.path === 'v2/servicePortalHome')).toBe(false);
  });

  it('falls back to the portal home endpoint when no desk is assigned — a booked hot desk counts', async () => {
    org.fetchAccount = { result: { account: { user: { peopleId: 812 } } } };
    org.portalHome = { result: { desks: [], bookedDesks: [{ id: 6002, name: 'HD-12', floorId: 43 }] } };
    const { fetchMyDesk } = await load();
    expect(await fetchMyDesk()).toEqual({ recordId: 6002, name: 'HD-12', floorId: '43', booked: true });
  });

  it('still reaches the portal endpoint when the desks read fails or the session has no people id', async () => {
    org.fetchAccount = { result: { account: { user: { peopleId: 812 } } } };
    org.desksFail = true;
    org.portalHome = { result: { desks: [{ id: 7003, name: 'WS-09', floor: { id: 44 } }] } };
    let mod = await load();
    expect(await mod.fetchMyDesk()).toEqual({ recordId: 7003, name: 'WS-09', floorId: '44', booked: false });

    org.desksFail = false;
    org.fetchAccount = { result: { account: { user: { id: 1 } } } };
    mod = await load();
    expect(await mod.fetchMyDesk()).toEqual({ recordId: 7003, name: 'WS-09', floorId: '44', booked: false });
    expect(fetchAllCalls).toHaveLength(1); // no people id — no desks read at all on the second run
  });

  it('answers null when nothing names a desk', async () => {
    org.fetchAccount = { result: { account: { user: { peopleId: 812 } } } };
    org.portalHome = { result: { desks: [], bookedDesks: [] } };
    const { fetchMyDesk } = await load();
    expect(await fetchMyDesk()).toBeNull();
  });
});
