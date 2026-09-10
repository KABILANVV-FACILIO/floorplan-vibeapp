import { FLOORPLAN_FN, isVibeApp, vibe } from './vibe';
import type { FloorBundle, FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Employee, Site, Unit } from './types';

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
export class VibeDbDataSource implements FloorplanDataSource {
  readonly name = 'vibe-db';

  private call<T>(handler: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!isVibeApp) throw new Error('vibe-db: not running as a vibe app');
    return vibe.executeFunction<T>(FLOORPLAN_FN, handler, args);
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
  if (!isVibeApp) return null;
  return vibe.executeFunction<T | null>(FLOORPLAN_FN, 'get-settings');
}

export async function storeVibeSettings(config: unknown): Promise<void> {
  if (!isVibeApp) return;
  await vibe.executeFunction(FLOORPLAN_FN, 'save-settings', { configJson: JSON.stringify(config) });
}

/** Floorplan-file records (the vibe fileId plus render metadata), keyed by floor + plan type. */
export async function fetchVibeFloorplanFile<T>(floorId: string, planId: string): Promise<T | null> {
  if (!isVibeApp) return null;
  return vibe.executeFunction<T | null>(FLOORPLAN_FN, 'get-floorplan-file', { floorId, planId });
}

export async function storeVibeFloorplanFile(floorId: string, planId: string, file: unknown): Promise<void> {
  if (!isVibeApp) return;
  await vibe.executeFunction(FLOORPLAN_FN, 'save-floorplan-file', { floorId, planId, fileJson: JSON.stringify(file) });
}

export async function listVibeFloorplanFloors(): Promise<string[]> {
  if (!isVibeApp) return [];
  return (await vibe.executeFunction<string[]>(FLOORPLAN_FN, 'list-floorplan-floors')) ?? [];
}
