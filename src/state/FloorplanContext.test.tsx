import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import type { Booking, Employee, Site, Unit } from '../lib/types';
import type { AppState } from './types';

/**
 * The store's actions, run in the real provider over a fake org: what each one writes, what it
 * says, and what it leaves on screen when an answer arrives late or not at all. Each block pins one
 * finding of the v77 review (2026-11-20).
 */

const ctx = vi.hoisted(() => ({
  api: true,
  role: null as { id: string; name: string; isAdmin: boolean } | null,
  shared: null as unknown,
  imageUrl: null as string | null,
  colours: null as (() => Promise<unknown>) | null,
  settings: null as (() => Promise<unknown>) | null,
  /** When set, the app database's answer at boot (else `shared`, at once). */
  sharedRead: null as (() => Promise<unknown>) | null,
}));

const ds = vi.hoisted(() => ({
  getPortfolio: vi.fn(),
  getEmployees: vi.fn(),
  getUnits: vi.fn(),
  getAssignments: vi.fn(),
  getBookings: vi.fn(),
  getBuildings: vi.fn(),
  getFloors: vi.fn(),
  createUnit: vi.fn(),
  saveUnits: vi.fn(async () => {}),
  searchFloors: vi.fn(async () => []),
  cancelBooking: vi.fn(async () => {}),
  getAssignmentsFor: vi.fn(),
  assignUnit: vi.fn(async () => {}),
  vacateUnit: vi.fn(async () => {}),
}));
const org = vi.hoisted(() => ({
  ensurePlanGeoreference: vi.fn(async () => null),
  createUnit: vi.fn(),
  fetchOrgBookingsForRange: vi.fn(async () => []),
  createRealBooking: vi.fn(),
  cancelRealBooking: vi.fn(async () => {}),
  assignUnitReal: vi.fn(async () => ({ ok: true })),
  vacateUnitReal: vi.fn(async () => ({ ok: true })),
}));
const stores = vi.hoisted(() => ({
  saveSettings: vi.fn(async (_cfg: unknown) => {}),
  saveDepartmentColors: vi.fn(async (_scheme: unknown) => {}),
  persistUnits: vi.fn(async () => ({ roomsNotWritten: [], unitsNotWritten: [], toRetry: [] })),
  saveAppSettings: vi.fn(async (_cfg: unknown) => {}),
  savePrintSettings: vi.fn(async (_cfg: unknown) => {}),
  saveDepartmentColorScheme: vi.fn(async (_scheme: unknown) => {}),
}));

vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn(), cadWorkerUrls: vi.fn(), cadCanvasToLightSnapshot: vi.fn(), destroyViewer: vi.fn() }));
vi.mock('../lib/featureFlags', async (orig) => ({ ...(await orig<typeof import('../lib/featureFlags')>()), DEMO_DATA: false }));
vi.mock('../lib/facilioApi', async (orig) => {
  const real = await orig<typeof import('../lib/facilioApi')>();
  return {
    ...real,
    get isFacilioApiConfigured() {
      return ctx.api;
    },
  };
});
vi.mock('../lib/dataSource', () => ({ dataSource: ds, clearLocalData: vi.fn() }));
vi.mock('../lib/facilioApiDataSource', async (orig) => {
  const real = await orig<typeof import('../lib/facilioApiDataSource')>();
  return {
    ...real,
    fetchCurrentRole: vi.fn(async () => ctx.role),
    fetchDepartments: vi.fn(async () => []),
    fetchMyDesk: vi.fn(async () => null),
    fetchCurrentPeopleId: vi.fn(async () => null),
    fetchOrgTimezone: vi.fn(async () => null),
    getFloorPlanSummary: vi.fn(async () => [{ id: 'workstation', name: 'Workstations', recordId: 26 }]),
    // The image arrives a moment after the floor's lists, as it does over the network — by when the
    // viewer's role and the access grid, asked for at start-up, have answered.
    fetchFloorplanImage: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ctx.imageUrl;
    }),
    takeFloorReadFailure: () => false,
    takeRoomOutlineReadFailure: () => false,
    invalidateOrgCaches: vi.fn(),
    ensurePlanGeoreference: org.ensurePlanGeoreference,
    fetchOrgBookingsForRange: org.fetchOrgBookingsForRange,
    createRealBooking: org.createRealBooking,
    cancelRealBooking: org.cancelRealBooking,
    assignUnitReal: org.assignUnitReal,
    vacateUnitReal: org.vacateUnitReal,
    FacilioApiDataSource: class {
      createUnit(...a: unknown[]) {
        return org.createUnit(...a);
      }
    },
  };
});
vi.mock('../lib/geoReference', async (orig) => ({ ...(await orig<typeof import('../lib/geoReference')>()), measureImageDataUrl: vi.fn(async () => ({ width: 1600, height: 900 })) }));
vi.mock('../lib/floorplanFileStore', () => ({ listFloorplanFloorIds: vi.fn(async () => []), loadFloorplanFile: vi.fn(async () => null), persistFloorplanFile: vi.fn(async () => {}) }));
vi.mock('../lib/settingsStore', async (orig) => ({
  ...(await orig<typeof import('../lib/settingsStore')>()),
  loadSettings: vi.fn(() => (ctx.settings ? ctx.settings() : Promise.resolve(null))),
  saveSettings: stores.saveSettings,
}));
vi.mock('../lib/sharedSettings', async (orig) => ({
  ...(await orig<typeof import('../lib/sharedSettings')>()),
  loadSharedSettings: vi.fn(() => (ctx.sharedRead ? ctx.sharedRead() : Promise.resolve(ctx.shared))),
  saveAppSettings: stores.saveAppSettings,
  savePrintSettings: stores.savePrintSettings,
  saveDepartmentColorScheme: stores.saveDepartmentColorScheme,
}));
vi.mock('../lib/departmentColorStore', async (orig) => ({
  ...(await orig<typeof import('../lib/departmentColorStore')>()),
  loadDepartmentColors: vi.fn(() => (ctx.colours ? ctx.colours() : Promise.resolve({}))),
  saveDepartmentColors: stores.saveDepartmentColors,
}));
vi.mock('../lib/urlFloor', async (orig) => ({ ...(await orig<typeof import('../lib/urlFloor')>()), readUrlFloorId: vi.fn(async () => null), writeUrlFloorId: vi.fn() }));
vi.mock('./persistUnits', async (orig) => ({ ...(await orig<typeof import('./persistUnits')>()), persistUnits: stores.persistUnits }));

const { FloorplanProvider, useFloorplan, COLOURS_LOADING, COLOURS_NOT_ALLOWED, COLOURS_NOT_LOADED, DAY_NOT_LOADED, FLOOR_BUSY, FLOOR_NOT_LOADED, NO_FLOORS_SHARED, SETTINGS_NOT_ALLOWED, SETTINGS_NOT_READY, SETTINGS_TOO_LARGE, SITES_NOT_LOADED } =
  await import('./FloorplanContext');
const { IncompleteListError, RateLimitedError } = await import('../lib/rateLimit');
const { spaceOfPerson } = await import('./selectors');

const portfolio: Site[] = [{ id: 's1', name: 'Barakah', buildings: [{ id: 'b1', name: 'Tower', floors: [{ id: '101', name: 'Floor 1' }, { id: '102', name: 'Floor 2' }] }] }] as Site[];
const people: Employee[] = [{ id: 'e1', name: 'Omar Al Marri' }];
const desk = (id: string, floor = '101'): Unit => ({ id, type: 'workstation', label: `WS-${id}`, room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor, plan: 'workstation', deskType: 'HOT' }) as Unit;
const room = (id: string, floor = '101'): Unit =>
  ({ id, type: 'room', label: `Room ${id}`, room: null, geom: { kind: 'poly', pts: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] }, floor, plan: 'workstation', isReservable: true }) as Unit;

let store: { state: AppState; actions: ReturnType<typeof useFloorplan>['actions'] };
/** The settings the last autosave sent. */
const lastSaved = () => stores.saveSettings.mock.calls[stores.saveSettings.mock.calls.length - 1][0];
function Probe() {
  store = useFloorplan();
  return null;
}
const now = () => store.state;
const toasts = () => (now().toast ?? '') as string;

async function boot() {
  render(
    <FloorplanProvider>
      <Probe />
    </FloorplanProvider>,
  );
  await waitFor(() => expect(now().loading).toBe(false));
  await waitFor(() => expect(now().floorImageLoading).toBe(false));
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx.api = true;
  ctx.role = null;
  ctx.shared = null;
  ctx.imageUrl = null;
  ctx.colours = null;
  ctx.settings = null;
  ctx.sharedRead = null;
  ds.getPortfolio.mockResolvedValue(portfolio);
  ds.getEmployees.mockResolvedValue(people);
  ds.getUnits.mockImplementation(async (floorId: string) => (floorId === '101' ? [desk('d1'), room('r1')] : [desk('d2', '102')]));
  ds.getAssignments.mockImplementation(async (floorId: string) => (floorId === '101' ? { d1: 'e1' } : {}));
  ds.getBookings.mockResolvedValue([]);
  org.fetchOrgBookingsForRange.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('department colours (Settings › Colour desks by › Save)', () => {
  it('saves two changed colours in ONE save holding both', async () => {
    await boot();
    act(() => store.actions.setDepartmentColors({ '10': { hex: '#B0006E', name: 'Finance' }, '20': { hex: '#0D9AA8', name: 'Engineering' } }));
    expect(stores.saveDepartmentColors).toHaveBeenCalledTimes(1);
    expect(stores.saveDepartmentColors).toHaveBeenCalledWith({ '10': { name: 'Finance', color: '#B0006E' }, '20': { name: 'Engineering', color: '#0D9AA8' } });
    expect(now().departmentColors).toEqual({ '10': '#B0006E', '20': '#0D9AA8' });
  });

  it('keeps the colours already stored in the one save', async () => {
    ctx.colours = async () => ({ '30': { name: 'Legal', color: '#3C229D' } });
    await boot();
    await waitFor(() => expect(now().departmentColors).toEqual({ '30': '#3C229D' }));
    act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
    expect(stores.saveDepartmentColors).toHaveBeenCalledWith({ '30': { name: '', color: '#3C229D' }, '10': { name: 'Finance', color: '#B0006E' } });
  });

  it('saves nothing, and says why, while the stored colours could not be read', async () => {
    ctx.colours = () => Promise.reject(new Error('503'));
    await boot();
    act(() => store.actions.setDepartmentColors({ '10': { hex: '#B0006E', name: 'Finance' } }));
    expect(stores.saveDepartmentColors).not.toHaveBeenCalled();
    expect(now().departmentColors).toEqual({});
    expect(toasts()).toBe(COLOURS_NOT_LOADED);
  });
});

describe('the settings blob', () => {
  it('is not saved over while it could not be read', async () => {
    ctx.settings = () => Promise.reject(new Error('listFiles 503'));
    await boot();
    act(() => store.actions.setModuleColor('workstation.free', '#123456'));
    await new Promise((r) => setTimeout(r, 650));
    expect(stores.saveSettings).not.toHaveBeenCalled();
  });

  it('is read once more after a pause, and saved to once that read works', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    ctx.settings = () => (++reads === 1 ? Promise.reject(new Error('listFiles 503')) : Promise.resolve({ colorBy: 'department' }));
    await boot();
    act(() => store.actions.setModuleColor('workstation.free', '#123456'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(stores.saveSettings).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(reads).toBe(2);
    // The stored settings are applied — they are the org's — and saving resumes from them.
    expect(now().colorBy).toBe('department');
    act(() => store.actions.setModuleColor('workstation.free', '#654321'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(stores.saveSettings).toHaveBeenCalled();
    expect(lastSaved()).toMatchObject({ colorBy: 'department', moduleColors: { 'workstation.free': '#654321' } });
  });

  it('is saved as before once a read worked — none stored counts', async () => {
    await boot();
    act(() => store.actions.setModuleColor('workstation.free', '#123456'));
    await waitFor(() => expect(stores.saveSettings).toHaveBeenCalled());
    expect(lastSaved()).toMatchObject({ moduleColors: { 'workstation.free': '#123456' } });
  });
});

/**
 * The settings blob, the print settings and the department colours moved behind the
 * floorplanResponders function (fp_app_setting), where a browser cannot write them. Each part's
 * source is the database once it holds that part, else the file store's copy; with no function to
 * ask, everything is as before.
 */
describe('the settings in the app database', () => {
  const ADMIN = { id: '3874', name: 'CAFM Administrator', isAdmin: true };
  /** A role the stored grid does not give Settings (only role 1 has it). */
  const STAFF = { id: '9', name: 'Employee', isAdmin: false };
  const NO_SETTINGS = { settings: { all: false, roles: ['1'] } };
  const REFUSED = new Error('floorplanResponders/save-app-settings failed: 500 — {"ok":false,"error":"Not saved: only admins and roles given Settings can change this"}');
  const shared = (over: Record<string, unknown> = {}) => ({ roles: [], responders: [], access: {}, appSettingsRead: true, appSettings: null, printSettings: null, departmentColors: null, ...over });
  /** A file-store read that lands after the database's answer. */
  const late = (value: unknown) => () => new Promise((r) => setTimeout(() => r(value), 30));
  const settled = () => new Promise((r) => setTimeout(r, 650));

  describe('loading', () => {
    it("takes the database's settings over the file store's, landing last — and the file's print settings while the database holds none", async () => {
      ctx.settings = late({ colorBy: 'status', moduleColors: { 'workstation.free': '#111111' }, printScope: 'view' });
      ctx.shared = shared({ appSettings: { colorBy: 'department', moduleColors: { 'workstation.free': '#222222' } } });
      await boot();
      await waitFor(() => expect(now().printScope).toBe('view'));
      expect(now().colorBy).toBe('department');
      expect(now().moduleColors['workstation.free']).toBe('#222222');
      expect(now().settingsDb).toEqual({ answered: true, settings: true, print: false, colors: false });
    });

    it("takes the database's print settings over the file store's", async () => {
      ctx.settings = async () => ({ colorBy: 'department', printScope: 'view' });
      ctx.shared = shared({ printSettings: { printScope: 'floor' } });
      await boot();
      await waitFor(() => expect(now().colorBy).toBe('department'));
      expect(now().printScope).toBe('floor');
    });

    it("keeps the file store's settings while the database holds none", async () => {
      ctx.settings = async () => ({ colorBy: 'department', printScope: 'view' });
      ctx.shared = shared();
      await boot();
      await waitFor(() => expect(now().colorBy).toBe('department'));
      expect(now().printScope).toBe('view');
      expect(now().settingsDb).toEqual({ answered: true, settings: false, print: false, colors: false });
    });

    it('reads the file store as before when there is no app database (not a vibe app), and saves there', async () => {
      ctx.role = ADMIN;
      ctx.settings = async () => ({ colorBy: 'department' });
      await boot();
      await waitFor(() => expect(now().colorBy).toBe('department'));
      expect(now().settingsDb.answered).toBe(false);
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await waitFor(() => expect(stores.saveSettings).toHaveBeenCalled());
      expect(lastSaved()).toMatchObject({ colorBy: 'department', moduleColors: { 'workstation.free': '#123456' } });
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      expect(stores.savePrintSettings).not.toHaveBeenCalled();
    });

    it('keeps the file store for the settings, reads and saves alike, while the function cannot read their table', async () => {
      ctx.role = ADMIN;
      ctx.settings = async () => ({ colorBy: 'department' });
      ctx.shared = shared({ appSettingsRead: false, access: { map: { all: true, roles: [] } } });
      await boot();
      await waitFor(() => expect(now().accessInDb).toBe(true));
      await waitFor(() => expect(now().colorBy).toBe('department'));
      expect(now().settingsDb.answered).toBe(false);
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await waitFor(() => expect(stores.saveSettings).toHaveBeenCalled());
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
      expect(stores.saveDepartmentColors).toHaveBeenCalled();
      expect(stores.saveDepartmentColorScheme).not.toHaveBeenCalled();
    });

    it("takes the database's colours over the file store's, landing last", async () => {
      ctx.colours = late({ '30': { name: 'Legal', color: '#000000' } });
      ctx.shared = shared({ departmentColors: { '30': { name: 'Legal', color: '#3C229D' } } });
      await boot();
      await new Promise((r) => setTimeout(r, 60));
      expect(now().departmentColors).toEqual({ '30': '#3C229D' });
    });
  });

  describe('saving', () => {
    it('holds a change made before both reads have answered — says so — and sends it, not the load, once they have', async () => {
      ctx.role = ADMIN;
      let answer!: (v: unknown) => void;
      ctx.sharedRead = () => new Promise((r) => (answer = r));
      await boot();
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await settled();
      expect(stores.saveSettings).not.toHaveBeenCalled();
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      expect(toasts()).toBe(SETTINGS_NOT_READY);
      await act(async () => answer(shared({ appSettings: { colorBy: 'department' }, printSettings: { printScope: 'floor' } })));
      await waitFor(() => expect(stores.saveAppSettings).toHaveBeenCalledTimes(1));
      expect(stores.saveAppSettings.mock.calls[0][0]).toMatchObject({ colorBy: 'department', moduleColors: { 'workstation.free': '#123456' } });
      // The print settings are as loaded: not sent.
      expect(stores.savePrintSettings).not.toHaveBeenCalled();
      act(() => store.actions.setModuleColor('workstation.free', '#654321'));
      await waitFor(() => expect(stores.saveAppSettings).toHaveBeenCalledTimes(2));
      expect(stores.saveAppSettings.mock.calls[1][0]).toMatchObject({ colorBy: 'department', moduleColors: { 'workstation.free': '#654321' } });
    });

    it('keeps — and sends — a change made before the reads answered, even when the load names the same setting', async () => {
      ctx.role = ADMIN;
      let answer!: (v: unknown) => void;
      ctx.sharedRead = () => new Promise((r) => (answer = r));
      await boot();
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await settled();
      await act(async () => answer(shared({ appSettings: { moduleColors: { 'workstation.free': '#000000' } }, printSettings: { printScope: 'floor' } })));
      await waitFor(() => expect(stores.saveAppSettings).toHaveBeenCalledTimes(1));
      expect(stores.saveAppSettings.mock.calls[0][0]).toMatchObject({ moduleColors: { 'workstation.free': '#123456' } });
      expect(now().moduleColors['workstation.free']).toBe('#123456');
    });

    it('sends nothing when nothing changed before the reads answered — the load is never sent back', async () => {
      ctx.role = ADMIN;
      let answer!: (v: unknown) => void;
      ctx.sharedRead = () => new Promise((r) => (answer = r));
      await boot();
      await act(async () => answer(shared({ appSettings: { colorBy: 'department' }, printSettings: { printScope: 'floor' } })));
      await settled();
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      expect(stores.savePrintSettings).not.toHaveBeenCalled();
      expect(stores.saveSettings).not.toHaveBeenCalled();
      expect(toasts()).not.toBe(SETTINGS_NOT_READY);
    });

    it('saves nothing to the file store while the database cannot be asked, and sends the change once it answers', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      ctx.role = ADMIN;
      ctx.settings = async () => ({ colorBy: 'department' });
      let reachable = false;
      ctx.sharedRead = () => (reachable ? Promise.resolve(shared()) : Promise.reject(new Error('function 502')));
      await boot();
      await waitFor(() => expect(now().colorBy).toBe('department'));
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(stores.saveSettings).not.toHaveBeenCalled();
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      expect(toasts()).toBe(SETTINGS_NOT_READY);
      reachable = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      await waitFor(() => expect(stores.saveAppSettings).toHaveBeenCalledTimes(1));
      expect(stores.saveAppSettings.mock.calls[0][0]).toMatchObject({ moduleColors: { 'workstation.free': '#123456' } });
    });

    it('still loads the print settings and the colours beside a settings row too large to read — and the colours can still be changed', async () => {
      ctx.role = ADMIN;
      ctx.settings = async () => ({ colorBy: 'department' });
      ctx.shared = shared({
        appSettingsRead: false,
        appSettingsError: 'too-large',
        printSettings: { printScope: 'view' },
        departmentColors: { '30': { name: 'Legal', color: '#3C229D' } },
        access: { map: { all: true, roles: [] } },
      });
      await boot();
      await waitFor(() => expect(now().departmentColors).toEqual({ '30': '#3C229D' }));
      expect(now().printScope).toBe('view');
      act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
      expect(stores.saveDepartmentColorScheme).toHaveBeenCalledTimes(1);
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await settled();
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      expect(stores.savePrintSettings).not.toHaveBeenCalled();
    });

    it('holds the settings for the session when their row is too large to read, and says why', async () => {
      ctx.role = ADMIN;
      ctx.settings = async () => ({ colorBy: 'department' });
      ctx.shared = shared({ appSettingsRead: false, appSettingsError: 'too-large', responders: [], access: { map: { all: true, roles: [] } } });
      await boot();
      await waitFor(() => expect(now().accessInDb).toBe(true));
      expect(toasts()).toBe(SETTINGS_TOO_LARGE);
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await settled();
      expect(stores.saveSettings).not.toHaveBeenCalled();
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
      expect(stores.saveDepartmentColors).not.toHaveBeenCalled();
      expect(stores.saveDepartmentColorScheme).not.toHaveBeenCalled();
    });

    it("sends an admin's change to the settings through the function, then writes the file store's copy", async () => {
      ctx.role = ADMIN;
      ctx.shared = shared();
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      act(() => store.actions.setColorBy('department'));
      await waitFor(() => expect(stores.saveSettings).toHaveBeenCalledTimes(1));
      expect(stores.saveAppSettings).toHaveBeenCalledTimes(1);
      const sent = stores.saveAppSettings.mock.calls[0][0] as Record<string, unknown>;
      expect(sent).toMatchObject({ colorBy: 'department' });
      expect(sent).not.toHaveProperty('printScope');
      expect(sent).not.toHaveProperty('printRegisters');
      expect(stores.savePrintSettings).not.toHaveBeenCalled();
      // The copy for the builds still deployed: the whole blob, as stored.
      expect(lastSaved()).toMatchObject({ colorBy: 'department', printScope: 'detail' });
      expect(now().settingsDb.settings).toBe(true);
    });

    it("sends a print change by someone without Settings through the print save alone", async () => {
      ctx.role = STAFF;
      ctx.shared = shared({ access: NO_SETTINGS });
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      act(() => store.actions.setPrintScope('floor'));
      await waitFor(() => expect(stores.savePrintSettings).toHaveBeenCalledTimes(1));
      expect(stores.savePrintSettings.mock.calls[0][0]).toMatchObject({ printScope: 'floor' });
      expect(stores.savePrintSettings.mock.calls[0][0]).not.toHaveProperty('colorBy');
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
    });

    it("builds the file store's copy after a print change from the database's settings as they are now, not as this tab loaded them", async () => {
      ctx.role = STAFF;
      ctx.shared = shared({ access: NO_SETTINGS, appSettings: { colorBy: 'status' } });
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      // An admin changed the settings since this tab opened.
      ctx.shared = shared({ access: NO_SETTINGS, appSettings: { colorBy: 'department' } });
      act(() => store.actions.setPrintScope('floor'));
      await waitFor(() => expect(stores.saveSettings).toHaveBeenCalledTimes(1));
      expect(lastSaved()).toMatchObject({ colorBy: 'department', printScope: 'floor' });
    });

    it("writes no file store copy after a print change when the database holds no settings to build it from", async () => {
      ctx.role = STAFF;
      ctx.shared = shared({ access: NO_SETTINGS });
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      act(() => store.actions.setPrintScope('floor'));
      await waitFor(() => expect(stores.savePrintSettings).toHaveBeenCalledTimes(1));
      await settled();
      expect(stores.saveSettings).not.toHaveBeenCalled();
    });

    it('sends no change to the settings from someone without Settings — a new marker from the Edit view — and says so', async () => {
      ctx.role = STAFF;
      ctx.shared = shared({ access: NO_SETTINGS });
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      act(() => store.actions.addCustomMarker({ id: 'm1', name: 'Defibrillator', color: '#C8102E' }));
      await waitFor(() => expect(toasts()).toBe(SETTINGS_NOT_ALLOWED));
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
      expect(stores.saveSettings).not.toHaveBeenCalled();
    });

    it("says why a save was refused, keeps the file store's copy as it was, and sends again with the next change", async () => {
      ctx.role = ADMIN;
      ctx.shared = shared();
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      stores.saveAppSettings.mockRejectedValueOnce(REFUSED);
      act(() => store.actions.setColorBy('department'));
      await waitFor(() => expect(toasts()).toBe("Couldn't save the settings — only admins and roles given Settings can change this."));
      await settled();
      expect(stores.saveSettings).not.toHaveBeenCalled();
      expect(now().settingsDb.settings).toBe(false);
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await waitFor(() => expect(stores.saveAppSettings).toHaveBeenCalledTimes(2));
      expect(stores.saveAppSettings.mock.calls[1][0]).toMatchObject({ colorBy: 'department', moduleColors: { 'workstation.free': '#123456' } });
    });

    it('sends department colours through the function, then writes the file store’s copy', async () => {
      ctx.role = ADMIN;
      ctx.shared = shared({ departmentColors: { '30': { name: 'Legal', color: '#3C229D' } } });
      await boot();
      await waitFor(() => expect(now().departmentColors).toEqual({ '30': '#3C229D' }));
      act(() => store.actions.setDepartmentColors({ '10': { hex: '#B0006E', name: 'Finance' } }));
      const scheme = { '30': { name: '', color: '#3C229D' }, '10': { name: 'Finance', color: '#B0006E' } };
      expect(stores.saveDepartmentColorScheme).toHaveBeenCalledWith(scheme);
      await waitFor(() => expect(stores.saveDepartmentColors).toHaveBeenCalledWith(scheme));
    });

    it('takes colour changes once the database holds the scheme, though the file store could not be read', async () => {
      ctx.role = ADMIN;
      ctx.colours = () => Promise.reject(new Error('503'));
      ctx.shared = shared({ departmentColors: { '30': { name: 'Legal', color: '#3C229D' } } });
      await boot();
      await waitFor(() => expect(now().settingsDb.colors).toBe(true));
      act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
      expect(stores.saveDepartmentColorScheme).toHaveBeenCalledTimes(1);
      expect(toasts()).not.toBe(COLOURS_NOT_LOADED);
    });

    it('sends no colour or settings change the function would refuse — a role no stored Settings rule names — and says so', async () => {
      ctx.role = { id: '9', name: 'Employee', isAdmin: false };
      ctx.shared = shared({ access: { map: { all: true, roles: [] } } });
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
      expect(stores.saveDepartmentColorScheme).not.toHaveBeenCalled();
      expect(now().departmentColors['10']).toBeUndefined();
      expect(toasts()).toBe(COLOURS_NOT_ALLOWED);
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await waitFor(() => expect(toasts()).toBe(SETTINGS_NOT_ALLOWED));
      expect(stores.saveAppSettings).not.toHaveBeenCalled();
    });

    it('sends them for a role the stored grid gives Settings', async () => {
      ctx.role = { id: '9', name: 'Facilities', isAdmin: false };
      ctx.shared = shared({ access: { settings: { all: false, roles: ['9'] } } });
      await boot();
      await waitFor(() => expect(now().accessInDb).toBe(true));
      act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
      expect(stores.saveDepartmentColorScheme).toHaveBeenCalledTimes(1);
      act(() => store.actions.setModuleColor('workstation.free', '#123456'));
      await waitFor(() => expect(stores.saveAppSettings).toHaveBeenCalledTimes(1));
    });

    it('says why a colour save was refused, and writes no copy', async () => {
      ctx.role = ADMIN;
      ctx.shared = shared();
      await boot();
      await waitFor(() => expect(now().settingsDb.answered).toBe(true));
      stores.saveDepartmentColorScheme.mockRejectedValueOnce(new Error(REFUSED.message.replace('save-app-settings', 'save-department-colors')));
      act(() => store.actions.setDepartmentColor('10', '#B0006E', 'Finance'));
      await waitFor(() => expect(toasts()).toBe("Couldn't save the department colours — only admins and roles given Settings can change this."));
      expect(stores.saveDepartmentColors).not.toHaveBeenCalled();
    });
  });
});

describe("a plan's georeference", () => {
  it('is written as before for someone with the Edit right', async () => {
    ctx.imageUrl = 'data:image/png;base64,AAAA';
    await boot();
    await waitFor(() => expect(org.ensurePlanGeoreference).toHaveBeenCalled());
    expect(org.ensurePlanGeoreference).toHaveBeenCalledWith('101', 'workstation', { width: 1600, height: 900 }, { write: true });
  });

  it("is written for a viewer without it only when fitted to the editor's markers (write: 'fitted')", async () => {
    ctx.imageUrl = 'data:image/png;base64,AAAA';
    ctx.role = { id: '9', name: 'Employee', isAdmin: false };
    ctx.shared = { roles: [], responders: [], access: { 'map.edit': { all: false, roles: ['1'] } } };
    await boot();
    await waitFor(() => expect(org.ensurePlanGeoreference).toHaveBeenCalled());
    expect(org.ensurePlanGeoreference).toHaveBeenCalledWith('101', 'workstation', { width: 1600, height: 900 }, { write: 'fitted' });
  });
});

describe('picking a day', () => {
  it('keeps the last pick when an earlier, slower read lands after it', async () => {
    await boot();
    let slow!: (b: Booking[]) => void;
    ds.getBookings.mockImplementationOnce(() => new Promise<Booking[]>((r) => (slow = r)));
    ds.getBookings.mockImplementationOnce(async () => [{ id: 'b2', unitId: 'd1', date: '2026-12-02', start: 540, end: 600 } as Booking]);
    let first!: Promise<void>;
    act(() => {
      first = store.actions.setDate('2026-12-01');
    });
    await act(async () => store.actions.setDate('2026-12-02'));
    expect(now().date).toBe('2026-12-02');
    await act(async () => {
      slow([{ id: 'b1', unitId: 'd1', date: '2026-12-01', start: 540, end: 600 } as Booking]);
      await first;
    });
    expect(now().date).toBe('2026-12-02');
    expect(now().bookings.map((b) => b.id)).toEqual(['b2']);
  });

  it('moves to a day whose bookings could not be read — none shown — and says so', async () => {
    await boot();
    ds.getBookings.mockRejectedValueOnce(new Error('spacebooking fetch failed'));
    await act(async () => store.actions.setDate('2026-12-03'));
    expect(now().date).toBe('2026-12-03');
    expect(now().bookings).toEqual([]);
    expect(toasts()).toBe(DAY_NOT_LOADED);
  });

  it('leaves the day on screen as it was when Facilio refused the read for rate', async () => {
    await boot();
    const before = now().date;
    ds.getBookings.mockRejectedValueOnce(new RateLimitedError('spacebooking refused'));
    await act(async () => store.actions.setDate('2026-12-04'));
    expect(now().date).toBe(before);
    expect(toasts()).toBe(FLOOR_BUSY);
  });
});

describe('"Create new desk" on an org floor', () => {
  const place = () => act(() => store.actions.placePoint('workstation', 0.4, 0.4));

  it('adds nothing when Facilio refuses the create, and says so', async () => {
    await boot();
    org.createUnit.mockRejectedValueOnce(new Error('facilio-api: could not create desks (403 Permission denied)'));
    place();
    await act(async () => store.actions.confirmPlacementCreate());
    expect(now().units.map((u) => u.id)).toEqual(['d1', 'r1']);
    expect(ds.saveUnits).not.toHaveBeenCalled();
    expect(ds.createUnit).not.toHaveBeenCalled();
    expect(toasts()).toBe('Not created in Facilio — could not create desks (403 Permission denied)');
  });

  it('adds the org’s record when Facilio takes it', async () => {
    await boot();
    org.createUnit.mockImplementationOnce(async (_loc: unknown, u: Unit) => ({ ...u, id: '9001' }));
    place();
    await act(async () => store.actions.confirmPlacementCreate());
    expect(now().units.map((u) => u.id)).toContain('9001');
    expect(toasts()).toMatch(/added$/);
  });

  it('is unchanged without an org: the local tier keeps it', async () => {
    ctx.api = false;
    await boot();
    ds.createUnit.mockImplementationOnce(async (_loc: unknown, u: Unit) => u);
    place();
    await act(async () => store.actions.confirmPlacementCreate());
    expect(org.createUnit).not.toHaveBeenCalled();
    expect(now().units).toHaveLength(3);
    expect(toasts()).toMatch(/added$/);
  });
});

describe('a floor that fails to load', () => {
  it('takes the skeleton down at boot and says Facilio is busy', async () => {
    ds.getUnits.mockRejectedValueOnce(new RateLimitedError('refused'));
    await boot();
    expect(now().floorId).toBe('101');
    expect(now().units).toEqual([]);
    expect(toasts()).toBe(FLOOR_BUSY);
  });

  it('goes back to the floor on screen when a switch fails', async () => {
    await boot();
    ds.getAssignments.mockRejectedValueOnce(new IncompleteListError([], false, 'desks list incomplete'));
    await act(async () => store.actions.selectFloor('102'));
    await waitFor(() => expect(now().loading).toBe(false));
    expect(now().floorId).toBe('101');
    expect(now().units.map((u) => u.id)).toEqual(['d1', 'r1']);
    expect(now().floorImageLoading).toBe(false);
    expect(toasts()).toBe(FLOOR_NOT_LOADED);
  });

  it('keeps the floor on screen when its Refresh fails', async () => {
    await boot();
    ds.getUnits.mockRejectedValueOnce(new RateLimitedError('refused'));
    await act(async () => store.actions.refreshFloor());
    expect(now().floorId).toBe('101');
    expect(now().units.map((u) => u.id)).toEqual(['d1', 'r1']);
    expect(now().loading).toBe(false);
    expect(now().floorImageLoading).toBe(false);
    expect(toasts()).toBe(FLOOR_BUSY);
  });
});

describe('the unsaved-changes dialog', () => {
  it('cannot be cancelled while "Save changes" runs, and switches once it lands', async () => {
    await boot();
    act(() => store.actions.setMode('edit'));
    act(() => store.actions.placeMarker('stairs', 0.3, 0.3));
    expect(now().unsavedChanges).toBe(1);
    act(() => store.actions.setMode('assign'));
    expect(now().pendingModeSwitch).toBe('assign');

    let land!: () => void;
    stores.persistUnits.mockImplementationOnce(() => new Promise((r) => (land = () => r({ roomsNotWritten: [], unitsNotWritten: [], toRetry: [] }))));
    let saving!: Promise<void>;
    act(() => {
      saving = store.actions.confirmSaveAndSwitch();
    });
    expect(now().saving).toBe(true);
    act(() => store.actions.cancelModeSwitch());
    expect(now().pendingModeSwitch).toBe('assign');
    await act(async () => {
      land();
      await saving;
    });
    expect(now().mode).toBe('assign');
    expect(now().pendingModeSwitch).toBeNull();
  });
});

describe('jumping to a desk', () => {
  it('keeps the newer desk pulsing when two jumps are within two seconds', async () => {
    await boot();
    ds.getUnits.mockResolvedValue([desk('d1'), desk('d3'), room('r1')]);
    await act(async () => store.actions.refreshFloor());
    vi.useFakeTimers();
    act(() => store.actions.focusUnit('d1', 1200, 700));
    act(() => vi.advanceTimersByTime(1500));
    act(() => store.actions.focusUnit('d3', 1200, 700));
    act(() => vi.advanceTimersByTime(600));
    expect(now().highlightUnitId).toBe('d3');
    act(() => vi.advanceTimersByTime(1500));
    expect(now().highlightUnitId).toBeNull();
  });
});

describe('bookings', () => {
  const bookingAccess = { roles: [], responders: [], access: { 'map.book': { all: true, roles: [] } } };
  const form = (over: Record<string, unknown> = {}) => ({ unitId: 'r1', date: '2026-12-01', start: 540, end: 600, name: 'Sync', description: '', host: 'e1', reservedBy: '', noOfAttendees: 1, internalAttendees: [], externalAttendees: [], ...over });

  it('cancelBooking says whether it went through', async () => {
    await boot();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await store.actions.cancelBooking('5001');
    });
    expect(ok).toBe(true);
    org.cancelRealBooking.mockRejectedValueOnce(new Error('no Cancel step'));
    await act(async () => {
      ok = await store.actions.cancelBooking('5002');
    });
    expect(ok).toBe(false);
    expect(toasts()).toBe('Not cancelled — no Cancel step');
  });

  it("checks for a clash with a strict read, against the bookings a part-way read did get", async () => {
    ctx.shared = bookingAccess;
    await boot();
    await waitFor(() => expect(now().planViews.book).toBe(true));
    act(() => store.actions.openBookingForm({ unitId: 'r1', date: '2026-12-01', start: 540, end: 600 }));
    org.fetchOrgBookingsForRange.mockRejectedValueOnce(new IncompleteListError([{ id: '1', unitId: 'r1', date: '2026-12-01', start: 570, end: 630, by: 'e9' } as Booking], true, 'page 2 refused'));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await store.actions.submitBooking(form());
    });
    expect(ok).toBe(false);
    expect(org.fetchOrgBookingsForRange).toHaveBeenCalledWith('2026-12-01', '2026-12-01', expect.objectContaining({ strict: true, resourceIds: ['r1'] }));
    expect(org.createRealBooking).not.toHaveBeenCalled();
    expect(toasts()).toBe('That window overlaps an existing booking');
  });

  it('carries the form’s host on the booking it adds, so the People list finds it for them', async () => {
    ctx.shared = bookingAccess;
    await boot();
    await waitFor(() => expect(now().planViews.book).toBe(true));
    await act(async () => store.actions.setDate('2026-12-01'));
    expect(now().date).toBe('2026-12-01');
    act(() => store.actions.openBookingForm({ unitId: 'r1', date: '2026-12-01', start: 540, end: 600 }));
    org.createRealBooking.mockResolvedValueOnce({ ok: true, id: 7001 });
    await act(async () => {
      await store.actions.submitBooking(form({ host: 'e4', reservedBy: 'e5' }));
    });
    expect(now().bookings.find((b) => b.id === '7001')).toMatchObject({ by: 'e5', host: 'e4' });
    act(() => store.actions.setTimeRange(540, 600));
    expect(spaceOfPerson(now(), 'e4')?.id).toBe('r1');
  });
});

describe('plan images', () => {
  it('revokes an object URL once nothing shows it, and never one still on screen', async () => {
    const revoke = vi.fn();
    const had = URL.revokeObjectURL;
    URL.revokeObjectURL = revoke;
    try {
      await boot();
      vi.useFakeTimers();
      act(() => store.actions.setFloorImage('101', 'workstation', 'blob:first'));
      act(() => store.actions.setFloorImage('102', 'workstation', 'blob:other-floor'));
      act(() => store.actions.setFloorImage('101', 'workstation', 'blob:second'));
      act(() => vi.advanceTimersByTime(29_000));
      expect(revoke).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(2_000));
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith('blob:first');
    } finally {
      URL.revokeObjectURL = had;
    }
  });
});

describe('the view-less store', () => {
  it('does not re-render the print sheet — always mounted — when the plan is panned', async () => {
    const { PrintSheet } = await import('../components/print/PrintSheet');
    let renders = 0;
    render(
      <FloorplanProvider>
        <Probe />
        <Profiler id="sheet" onRender={() => (renders += 1)}>
          <PrintSheet />
        </Profiler>
      </FloorplanProvider>,
    );
    await waitFor(() => expect(now().loading).toBe(false));
    await waitFor(() => expect(now().floorImageLoading).toBe(false));
    const before = renders;
    act(() => store.actions.setView({ tx: 40, ty: 20, z: 0.7 }));
    act(() => store.actions.setView({ tx: 80, ty: 40, z: 0.7 }));
    expect(now().view.tx).toBe(80);
    expect(renders).toBe(before);
    // …and does when the floor's data changes.
    act(() => store.actions.setModuleColor('workstation.free', '#123456'));
    expect(renders).toBeGreaterThan(before);
  });
});

describe('fix round 2 (review 2026-11-23)', () => {
  const ADMIN = { id: '3874', name: 'CAFM Administrator', isAdmin: true };
  const shared = (over: Record<string, unknown> = {}) => ({ roles: [], responders: [], access: {}, appSettingsRead: true, appSettings: null, printSettings: null, departmentColors: null, ...over });

  describe('the files the database already holds', () => {
    it('downloads neither the settings file nor the colour file when the database holds every part', async () => {
      const { loadSettings } = await import('../lib/settingsStore');
      const { loadDepartmentColors } = await import('../lib/departmentColorStore');
      ctx.shared = shared({ appSettings: { colorBy: 'department' }, printSettings: { printScope: 'floor' }, departmentColors: { '30': { name: 'Legal', color: '#3C229D' } } });
      await boot();
      await waitFor(() => expect(now().settingsDb).toEqual({ answered: true, settings: true, print: true, colors: true }));
      expect(loadSettings).not.toHaveBeenCalled();
      expect(loadDepartmentColors).not.toHaveBeenCalled();
    });

    it('still reads the file for the parts the database does not hold', async () => {
      const { loadSettings } = await import('../lib/settingsStore');
      const { loadDepartmentColors } = await import('../lib/departmentColorStore');
      ctx.shared = shared({ appSettings: { colorBy: 'department' } });
      await boot();
      await waitFor(() => expect(loadSettings).toHaveBeenCalledTimes(1));
      expect(loadDepartmentColors).toHaveBeenCalledTimes(1);
    });
  });

  describe('department colours', () => {
    it('puts the colours back when the database refuses the save', async () => {
      ctx.role = ADMIN;
      ctx.shared = shared({ departmentColors: { '30': { name: 'Legal', color: '#3C229D' } } });
      await boot();
      await waitFor(() => expect(now().departmentColors).toEqual({ '30': '#3C229D' }));
      stores.saveDepartmentColorScheme.mockRejectedValueOnce(new Error('Not saved: only admins and roles given Settings can change this'));
      await act(async () => {
        store.actions.setDepartmentColors({ '30': { hex: '#B0006E', name: 'Legal' }, '10': { hex: '#0D9AA8', name: 'Finance' } });
        await new Promise((r) => setTimeout(r, 0));
      });
      await waitFor(() => expect(now().departmentColors).toEqual({ '30': '#3C229D' }));
      expect(toasts()).toMatch(/^Couldn't save the department colours/);
    });

    it('says "still loading", not "couldn\u2019t load", while the database has not answered yet', async () => {
      ctx.sharedRead = () => new Promise(() => {});
      await boot();
      act(() => store.actions.setDepartmentColors({ '10': { hex: '#B0006E', name: 'Finance' } }));
      expect(toasts()).toBe(COLOURS_LOADING);
      expect(stores.saveDepartmentColors).not.toHaveBeenCalled();
    });
  });

  describe('a failed floor switch', () => {
    it("goes back with the floor's record states, search and filters as they were", async () => {
      const { noteRecordStates } = await import('../lib/recordStates');
      // The floor's read notes its records' states, as the org tier does.
      ds.getAssignments.mockImplementationOnce(async (floorId: string) => {
        noteRecordStates(floorId, [{ id: 'd1', moduleState: { status: 'Temporarily Vacant' } }]);
        return { d1: 'e1' };
      });
      await boot();
      expect(now().recordStates).toEqual({ d1: 'temporarilyvacant' });
      act(() => store.actions.setSpaceSearch('WS'));
      const before = { recordStates: now().recordStates, spaceSearch: now().spaceSearch, spaceFilter: now().spaceFilter, spaceDepartments: now().spaceDepartments };
      ds.getUnits.mockRejectedValueOnce(new RateLimitedError('desks refused'));
      act(() => store.actions.selectFloor('102'));
      await waitFor(() => expect(toasts()).toBe(FLOOR_BUSY));
      expect(now().floorId).toBe('101');
      expect({ recordStates: now().recordStates, spaceSearch: now().spaceSearch, spaceFilter: now().spaceFilter, spaceDepartments: now().spaceDepartments }).toEqual(before);
    });
  });

  describe('boot with no floor to open', () => {
    it('takes the skeleton down and says the sites could not be loaded', async () => {
      ds.getPortfolio.mockRejectedValueOnce(new Error('site list 503'));
      render(
        <FloorplanProvider>
          <Probe />
        </FloorplanProvider>,
      );
      await waitFor(() => expect(now().floorImageLoading).toBe(false));
      expect(toasts()).toBe(SITES_NOT_LOADED);
    });

    it('says no floors are shared when the site list is empty', async () => {
      ds.getPortfolio.mockResolvedValueOnce([]);
      render(
        <FloorplanProvider>
          <Probe />
        </FloorplanProvider>,
      );
      await waitFor(() => expect(now().floorImageLoading).toBe(false));
      expect(toasts()).toBe(NO_FLOORS_SHARED);
    });
  });

  describe('a floor load that never answers', () => {
    it('gives up after the timeout, takes the skeleton down and says so', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await boot();
      ds.getUnits.mockImplementationOnce(() => new Promise(() => {}));
      act(() => store.actions.selectFloor('102'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(46_000);
      });
      expect(now().loading).toBe(false);
      expect(now().floorImageLoading).toBe(false);
      expect(now().floorId).toBe('101');
      expect(toasts()).toBe(FLOOR_NOT_LOADED);
    });
  });

  describe('floor search', () => {
    it('says Facilio is busy, not "no floors match", when the search is refused', async () => {
      await boot();
      ds.searchFloors.mockRejectedValueOnce(new RateLimitedError('floor search refused'));
      await act(async () => store.actions.setPortfolioSearch('Tower'));
      expect(now().portfolioSearchFailed).toBe('busy');
      expect(now().portfolioSearchResults).toEqual([]);
    });

    it('clears the failure with the next search', async () => {
      await boot();
      ds.searchFloors.mockRejectedValueOnce(new Error('500'));
      await act(async () => store.actions.setPortfolioSearch('Tower'));
      expect(now().portfolioSearchFailed).toBe('error');
      ds.searchFloors.mockResolvedValueOnce([]);
      await act(async () => store.actions.setPortfolioSearch('Towers'));
      expect(now().portfolioSearchFailed).toBeNull();
    });
  });

  describe('assign and vacate', () => {
    const everyone = { all: true, roles: [] };
    beforeEach(() => {
      ctx.shared = shared({ access: { map: everyone, 'map.assign': everyone } });
    });
    it('re-reads only the desk and the desks the person held — not the whole floor — and announces just those', async () => {
      ctx.role = ADMIN;
      ds.getUnits.mockImplementation(async () => [desk('d1'), desk('d2'), desk('d3')]);
      ds.getAssignments.mockImplementation(async () => ({ d1: 'e1' }));
      ds.getAssignmentsFor.mockImplementation(async () => ({ d3: 'e1' }));
      await boot();
      await waitFor(() => expect(now().planViews.assign).toBe(true));
      ds.getAssignments.mockClear();
      await act(async () => store.actions.assign('e1', 'd3'));
      expect(ds.getAssignmentsFor).toHaveBeenCalledTimes(1);
      expect(ds.getAssignmentsFor.mock.calls[0][0]).toBe('101');
      expect([...ds.getAssignmentsFor.mock.calls[0][1]].sort()).toEqual(['d1', 'd3']);
      expect(ds.getAssignments).not.toHaveBeenCalled();
      // The org moved them: d1 cleared, d3 theirs.
      expect(now().assignments).toEqual({ d3: 'e1' });
      expect(now().recordVersions).toMatchObject({ d1: 1, d3: 1 });
      expect(now().recordVersions.d2).toBeUndefined();
    });

    it('re-reads only the vacated desk', async () => {
      ctx.role = ADMIN;
      ds.getAssignmentsFor.mockImplementation(async () => ({}));
      await boot();
      await waitFor(() => expect(now().planViews.assign).toBe(true));
      ds.getAssignments.mockClear();
      await act(async () => store.actions.vacate('d1'));
      expect(ds.getAssignmentsFor).toHaveBeenCalledWith('101', ['d1']);
      expect(ds.getAssignments).not.toHaveBeenCalled();
      expect(now().assignments).toEqual({});
      expect(now().recordVersions).toEqual({ d1: 1 });
    });

    it("re-reads the floor's holders the old way when the by-id read itself fails (not for rate)", async () => {
      ctx.role = ADMIN;
      ds.getAssignmentsFor.mockRejectedValue(new IncompleteListError([], false, 'desks: the id filter was not applied'));
      await boot();
      await waitFor(() => expect(now().planViews.assign).toBe(true));
      ds.getAssignments.mockClear();
      ds.getAssignments.mockResolvedValueOnce({ r1: 'e1' });
      await act(async () => store.actions.assign('e1', 'r1'));
      expect(ds.getAssignments).toHaveBeenCalledTimes(1);
      expect(now().assignments).toEqual({ r1: 'e1' });
    });

    it('keeps the holders on screen when the re-read fails', async () => {
      ctx.role = ADMIN;
      ds.getAssignmentsFor.mockRejectedValue(new IncompleteListError([], true, 'refused'));
      await boot();
      await waitFor(() => expect(now().planViews.assign).toBe(true));
      await act(async () => store.actions.assign('e1', 'r1'));
      expect(now().assignments).toEqual({ d1: 'e1', r1: 'e1' });
    });
  });

  describe('drawing a room on an org floor', () => {
    const draw = () =>
      act(() => {
        store.actions.pushDraftPoint([0.1, 0.1]);
        store.actions.pushDraftPoint([0.3, 0.1]);
        store.actions.pushDraftPoint([0.3, 0.3]);
      });

    it('adds nothing, keeps the outline and says so when Facilio refuses the create', async () => {
      await boot();
      draw();
      ds.createUnit.mockRejectedValueOnce(new Error('facilio-api: could not create space (403)'));
      await act(async () => store.actions.closeDraft());
      expect(now().units.map((u) => u.id)).toEqual(['d1', 'r1']);
      expect(now().draft.length).toBe(3);
      expect(ds.saveUnits).not.toHaveBeenCalled();
      expect(toasts()).toBe('Not created in Facilio — could not create space (403)');
    });

    it('adds the room when Facilio takes it', async () => {
      await boot();
      draw();
      ds.createUnit.mockImplementationOnce(async (_loc: unknown, u: Unit) => ({ ...u, id: '7001' }));
      await act(async () => store.actions.closeDraft());
      expect(now().units.map((u) => u.id)).toContain('7001');
    });
  });

  describe("a floor whose day's bookings cannot be read", () => {
    it('still opens — spaces and holders — with no bookings, and says the day could not be read', async () => {
      await boot();
      ds.getBookings.mockRejectedValueOnce(new Error('spacebooking: permission denied'));
      act(() => store.actions.selectFloor('102'));
      await waitFor(() => expect(now().loading).toBe(false));
      expect(now().floorId).toBe('102');
      expect(now().units.map((u) => u.id)).toEqual(['d2']);
      expect(now().bookings).toEqual([]);
      await waitFor(() => expect(toasts()).toBe(DAY_NOT_LOADED));
    });

    it('says Facilio is busy when the bookings read was refused for rate', async () => {
      await boot();
      ds.getBookings.mockRejectedValueOnce(new RateLimitedError('spacebooking refused'));
      act(() => store.actions.selectFloor('102'));
      await waitFor(() => expect(now().floorId).toBe('102'));
      await waitFor(() => expect(toasts()).toBe(FLOOR_BUSY));
      expect(now().units.map((u) => u.id)).toEqual(['d2']);
    });
  });

  describe('a day picked while a floor loads', () => {
    it("keeps the picked day's bookings when the floor's load, read for the day before, lands after", async () => {
      await boot();
      let finish!: (b: Booking[]) => void;
      ds.getBookings.mockImplementationOnce(() => new Promise<Booking[]>((r) => (finish = r)));
      let refreshing!: Promise<unknown>;
      act(() => {
        refreshing = store.actions.refreshFloor();
      });
      ds.getBookings.mockImplementationOnce(async () => [{ id: 'new-day', unitId: 'd1', date: '2026-12-05', start: 540, end: 600 } as Booking]);
      await act(async () => store.actions.setDate('2026-12-05'));
      await act(async () => {
        finish([{ id: 'old-day', unitId: 'd1', date: '2026-11-23', start: 540, end: 600 } as Booking]);
        await refreshing;
      });
      expect(now().date).toBe('2026-12-05');
      expect(now().bookings.map((b) => b.id)).toEqual(['new-day']);
    });
  });
});
