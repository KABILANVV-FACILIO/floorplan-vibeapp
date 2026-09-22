import { FLOORPLAN_FN, isVibeApp, vibe } from './vibe';
import type { FloorBundle, FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Building, Employee, Floor, FloorSearchHit, Site, Unit } from './types';

/**
 * Vibe DB tier — this app's own records, held in its per-app Postgres schema.
 *
 * The browser cannot reach that schema directly; every call here is a handler on the `floorplanApi`
 * Studio Function (see `functions/floorplanApi/code.ts`), which is the only thing with database
 * credentials. Handler parameters may only be strings or numbers, so composite payloads are sent
 * as JSON strings.
 *
 * This tier owns what the org has no home for — on-plan placement geometry, the app's assignments
 * and bookings. Real org records come from the connector tier, and the real-side effects that
 * mirror an assignment or booking into the org (Moves, spacebooking) still go through the
 * connected-app V3 tier, which those methods deliberately do not replace.
 */
/**
 * Session circuit breaker for the `floorplanApi` function.
 *
 * The function is not deployable in every region — Azure AE has no ai-agents-server, so
 * `vibe fn create` is rejected and the function simply does not exist there. Without this, every
 * floor load fired doomed POSTs to /api/runtime/functions/floorplanApi/handlers/... before falling
 * through, adding a round trip per call for a tier that can never answer.
 *
 * One failure marks it unavailable for the rest of the session and every later call short-circuits.
 * It resets on reload, so deploying the function makes the tier come back with no code change.
 */
let floorplanFnUnavailable = false;

function callFloorplanFn<T>(handler: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isVibeApp) return Promise.reject(new Error('vibe-db: not running as a vibe app'));
  if (floorplanFnUnavailable) {
    return Promise.reject(new Error(`vibe-db: ${FLOORPLAN_FN} is not deployed in this org (skipping)`));
  }
  return vibe.executeFunction<T>(FLOORPLAN_FN, handler, args).catch((err) => {
    // Any failure trips it: the function either exists or it doesn't, and retrying a missing one
    // on every subsequent call costs a round trip each time for no possible gain.
    floorplanFnUnavailable = true;
    // eslint-disable-next-line no-console
    console.warn(`[vibe-db] ${FLOORPLAN_FN}.${handler} failed; disabling the vibe-db tier for this session:`, (err as Error)?.message ?? err);
    throw err;
  });
}

export class VibeDbDataSource implements FloorplanDataSource {
  readonly name = 'vibe-db';

  private call<T>(handler: string, args: Record<string, unknown> = {}): Promise<T> {
    return callFloorplanFn<T>(handler, args);
  }

  /**
   * One round trip for a whole floor. CompositeDataSource prefers this over the three separate
   * calls below, which exist for the paths that need a single slice.
   */
  async getFloorData(floorId: string, date: string, planId: string): Promise<FloorBundle> {
    const res = await this.call<{ units: Unit[]; assignments: Assignments; bookings: Booking[]; file: string | null }>('get-floor-data', {
      floorId,
      date,
      planId,
    });
    return {
      units: res.units ?? [],
      assignments: res.assignments ?? {},
      bookings: res.bookings ?? [],
      file: res.file ?? null,
    };
  }

  async getUnits(floorId: string): Promise<Unit[]> {
    return (await this.call<Unit[]>('get-units', { floorId })) ?? [];
  }

  async saveUnits(floorId: string, units: Unit[]): Promise<void> {
    await this.call('save-units', { floorId, unitsJson: JSON.stringify(units) });
  }

  async getAssignments(floorId: string): Promise<Assignments> {
    return (await this.call<Assignments>('get-assignments', { floorId })) ?? {};
  }

  async assignUnit(unitId: string, employeeId: string): Promise<void> {
    await this.call('assign-unit', { unitId, employeeId });
  }

  async vacateUnit(unitId: string): Promise<void> {
    await this.call('vacate-unit', { unitId });
  }

  async getBookings(floorId: string, date: string): Promise<Booking[]> {
    return (await this.call<Booking[]>('get-bookings', { floorId, date })) ?? [];
  }

  async createBooking(input: Omit<Booking, 'id'>): Promise<Booking> {
    return this.call<Booking>('create-booking', { bookingJson: JSON.stringify(input) });
  }

  async cancelBooking(id: string): Promise<void> {
    await this.call('cancel-booking', { id });
  }

  // ---- Org records, not app records: the connector tier answers these. ----
  async getPortfolio(): Promise<Site[]> {
    throw new Error('vibe-db: portfolio comes from the CMMS connector');
  }
  async getBuildings(): Promise<Building[]> {
    throw new Error('vibe-db: buildings come from the org tiers');
  }
  async getFloors(): Promise<Floor[]> {
    throw new Error('vibe-db: floors come from the org tiers');
  }
  async searchFloors(): Promise<FloorSearchHit[]> {
    throw new Error('vibe-db: floor search runs on the org tiers');
  }
  async getEmployees(): Promise<Employee[]> {
    throw new Error('vibe-db: the people directory comes from the CMMS connector');
  }
  async getAssets(): Promise<Asset[]> {
    throw new Error('vibe-db: the asset catalog comes from the CMMS connector');
  }
  async createUnit(): Promise<Unit> {
    throw new Error('vibe-db: space creation goes through the CMMS connector');
  }
}

/** Settings blob, stored as a single row by the same function. */
export async function fetchVibeSettings<T>(): Promise<T | null> {
  if (!isVibeApp || floorplanFnUnavailable) return null;
  return callFloorplanFn<T | null>('get-settings');
}

/** True when the row was actually written — false when this tier can't answer, so callers fall through. */
export async function storeVibeSettings(config: unknown): Promise<boolean> {
  if (!isVibeApp || floorplanFnUnavailable) return false;
  await callFloorplanFn('save-settings', { configJson: JSON.stringify(config) });
  return true;
}

export interface DepartmentColorRow {
  departmentId: string;
  departmentName: string;
  color: string;
}

/**
 * The org's department -> marker colour scheme, from its own table (`fp_department_color`).
 *
 * Deliberately not part of the settings blob: it is keyed by the department's record id in the
 * org, and anything else that needs the scheme — a report, another app — can read the table as
 * data rather than unpacking this app's settings.
 */
export async function fetchDepartmentColors(): Promise<DepartmentColorRow[]> {
  if (!isVibeApp || floorplanFnUnavailable) return [];
  return (await callFloorplanFn<DepartmentColorRow[] | null>('get-department-colors')) ?? [];
}

/** True when the row was actually written — false when this tier can't answer. */
export async function storeDepartmentColor(departmentId: string, departmentName: string, color: string): Promise<boolean> {
  if (!isVibeApp || floorplanFnUnavailable) return false;
  await callFloorplanFn('save-department-color', { departmentId, departmentName, color });
  return true;
}

/** Drop a department's colour so it falls back to the app's default wheel. */
export async function clearDepartmentColor(departmentId: string): Promise<boolean> {
  if (!isVibeApp || floorplanFnUnavailable) return false;
  await callFloorplanFn('clear-department-color', { departmentId });
  return true;
}

/** Floorplan-file records (the vibe fileId plus render metadata), keyed by floor + plan type. */
export async function fetchVibeFloorplanFile<T>(floorId: string, planId: string): Promise<T | null> {
  if (!isVibeApp || floorplanFnUnavailable) return null;
  return callFloorplanFn<T | null>('get-floorplan-file', { floorId, planId });
}

/** True when the row was actually written — false when this tier can't answer, so callers can fall back. */
export async function storeVibeFloorplanFile(floorId: string, planId: string, file: unknown): Promise<boolean> {
  if (!isVibeApp || floorplanFnUnavailable) return false;
  await callFloorplanFn('save-floorplan-file', { floorId, planId, fileJson: JSON.stringify(file) });
  return true;
}

export async function listVibeFloorplanFloors(): Promise<string[]> {
  if (!isVibeApp || floorplanFnUnavailable) return [];
  return (await callFloorplanFn<string[]>('list-floorplan-floors')) ?? [];
}
