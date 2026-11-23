import { FacilioApiDataSource } from './facilioApiDataSource';
import { isFacilioApiConfigured } from './facilioApi';
import { ConnectorDataSource } from './connectorDataSource';
import { IncompleteListError, mapPooled } from './rateLimit';
import type { Asset } from './assets';
import type { Assignments, Booking, Building, Employee, Floor, FloorSearchHit, Site, Unit } from './types';

// Local dev data lives as editable JSON in src/data/*.json — change a file and the app uses it
// (Vite picks the JSON up on save). This is the seed the LocalJsonDataSource serves; session edits
// are layered on top in localStorage so a dev session survives reloads.
import { DEMO_DATA } from './featureFlags';
import portfolioJson from '../data/portfolio.json';
import employeesJson from '../data/employees.json';
import assetsJson from '../data/assets.json';
import unitsJson from '../data/units.json';
import assignmentsJson from '../data/assignments.json';
import bookingsJson from '../data/bookings.json';
import { noteRecordStates } from './recordStates';

/**
 * Data access contract for the Floorplan Manager (vibe-app build).
 *
 * Three live tiers, tried in order per call (see CompositeDataSource / defaultTiers):
 *
 * 1. FacilioApiDataSource — V3/V5 through the connected-app host bridge: module CRUD via the SDK's
 *    `api.*` wrappers, custom endpoints via `request.invokeFacilioAPI`. Leads because it answers a
 *    module in ONE call, and it is the only route to on-plan marker geometry (`floorplanmarker`),
 *    Moves, org forms and file previews.
 * 2. ConnectorDataSource — the `facilio-cmms` connection. Covers what V3 doesn't and is the whole
 *    data layer when the app runs outside a Facilio host; its list actions page at 200 rows.
 * 3. LocalJsonDataSource — the editable src/data/*.json seed plus localStorage, so `npm run dev`
 *    works with no backend at all.
 */
export interface FloorplanDataSource {
  readonly name: string;
  /** Sites only — children arrive via getBuildings / getFloors as the tree is expanded. */
  getPortfolio(): Promise<Site[]>;
  getBuildings(siteId: string): Promise<Building[]>;
  getFloors(buildingId: string): Promise<Floor[]>;
  /**
   * Every floor of a site in one read, keyed by building id — the Bookings floor filter ticks a
   * whole site at once, and one floor list per building is a request per building. Optional: the
   * composite falls back to getBuildings + getFloors where no tier answers it.
   */
  getSiteFloors?(siteId: string): Promise<Record<string, Floor[]>>;
  /** Floors whose name contains `query`, with the site/building path to open each one. */
  searchFloors(query: string): Promise<FloorSearchHit[]>;
  getEmployees(): Promise<Employee[]>;
  /** Catalog of assets that can be dropped onto a plan (Edit mode asset picker). */
  getAssets(): Promise<Asset[]>;
  /**
   * The floor's units. With `onMore`, a tier may answer with what its first pages hold and hand the
   * whole floor to `onMore` once the rest has arrived — so a big floor draws without waiting for
   * every page. Without it, the answer is always the whole floor.
   */
  getUnits(floorId: string, onMore?: (units: Unit[]) => void): Promise<Unit[]>;
  saveUnits(floorId: string, units: Unit[]): Promise<void>;
  /** As getUnits: with `onMore`, the holders of the records past the first pages arrive there. */
  getAssignments(floorId: string, onMore?: (more: Assignments) => void): Promise<Assignments>;
  /**
   * Who holds `unitIds` only — re-read after an assign or vacate, where the whole floor's holders
   * are a read of every desk for one or two that changed. An id missing from the answer is vacant.
   * Rejects (never answers in part) when the read fails, so the caller keeps what it shows.
   */
  getAssignmentsFor?(floorId: string, unitIds: string[]): Promise<Assignments>;
  assignUnit(unitId: string, contactId: string): Promise<void>;
  vacateUnit(unitId: string): Promise<void>;
  getBookings(floorId: string, date: string): Promise<Booking[]>;
  createBooking(input: Omit<Booking, 'id'>): Promise<Booking>;
  cancelBooking(id: string): Promise<void>;
  /**
   * Mint a genuinely-new record (desk/locker/parking/room). On the Facilio API tier this is a real
   * V3 create; on a demo floor the local tier just echoes the unit back with its local id so dev
   * works (on an org floor it throws — the record is the org's or nothing), and the on-plan position
   * is persisted separately by the caller via saveUnits. Amenities (assets/markers) aren't records
   * and are handled purely locally.
   */
  createUnit(loc: CreateSpaceLoc, unit: Unit): Promise<Unit>;
  /**
   * Optional fast path: everything a floor load needs in ONE round-trip. `file` is the stored
   * floorplan-file JSON string (see floorplanFileStore) or null. Tiers without it are skipped by
   * the composite; callers must be prepared to fall back to the per-call path.
   */
  getFloorData?(floorId: string, date: string, planId: string): Promise<FloorBundle>;
}

export interface FloorBundle {
  units: Unit[];
  assignments: Assignments;
  bookings: Booking[];
  file: string | null;
}

/** Where a new record is being created — its floor, plus the enclosing building/site. Resolved by
 *  the caller from the portfolio tree; used by a real-API create when that gets wired. */
export interface CreateSpaceLoc {
  siteId: string | null;
  buildingId: string | null;
  floorId: string;
}

// ---- seed data (editable JSON in src/data) ----
// Demo only (featureFlags.DEMO_DATA — the dev server, never a deployed build). Deployed, the local
// tier still keeps this browser's own edits, but it has no sample sites, people, desks or bookings
// to fall back to: an org list that comes back empty stays empty.
const SEED_PORTFOLIO = (DEMO_DATA ? portfolioJson : []) as unknown as Site[];
const SEED_EMPLOYEES = (DEMO_DATA ? employeesJson : []) as unknown as Employee[];
const SEED_ASSETS = (DEMO_DATA ? assetsJson : []) as unknown as Asset[];
const SEED_UNITS = (DEMO_DATA ? unitsJson : []) as unknown as Unit[];
const SEED_ASSIGNMENTS = (DEMO_DATA ? assignmentsJson : {}) as unknown as Assignments;
// Bookings are stored date-agnostic; getBookings stamps the requested day (demo behaviour).
const SEED_BOOKINGS = (DEMO_DATA ? bookingsJson : []) as unknown as Omit<Booking, 'date'>[];

// ---- local session persistence (localStorage) ----
const LS_KEY = 'facilio_floorplan_proto_v2';

interface PersistedShape {
  units: Unit[];
  assignments: Assignments;
  bookings: Booking[];
}

function loadPersisted(): PersistedShape | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedShape) : null;
  } catch {
    return null;
  }
}

function savePersisted(next: Partial<PersistedShape>) {
  try {
    const cur = loadPersisted() || { units: SEED_UNITS, assignments: SEED_ASSIGNMENTS, bookings: [] };
    localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...next }));
  } catch {
    /* ignore quota/serialization errors */
  }
}

/**
 * An ORG floor while the org is reachable: its id is a record id (numeric — the demo seed's are
 * slugs), and the Facilio API tier is configured. Such a floor's records are the org's, never this
 * browser's: they are not copied into localStorage on every edit (they would go stale, and outlive
 * a sign-out on a shared PC) and a copy is never served as the floor when the org tier fails.
 */
function isOrgFloor(floorId: string): boolean {
  return isFacilioApiConfigured && /^\d+$/.test(floorId);
}

/**
 * The local tier's answer for an org floor's data: none. An empty answer would stand in for the
 * org's own read that failed — a day with nothing booked, a floor whose desks nobody holds — and
 * the composite would hand it on as the floor. Thrown instead, the composite throws the org tier's
 * error and the caller keeps what it shows.
 */
function refuseOrgFloor(floorId: string, what: string): void {
  if (isOrgFloor(floorId)) throw new Error(`local-json: floor ${floorId} is the org's — this browser keeps no ${what} for it`);
}

/**
 * Local tier: serves the editable src/data/*.json seed and persists a session's edits to
 * localStorage so a dev/demo run survives reloads. Powers `npm run dev` with no backend, and is
 * the fallback under the real Facilio API tier in connected-app mode. To reset to the JSON seed,
 * clear the app's localStorage (Settings › Data & caches › Clear local data).
 *
 * An org floor with the org reachable (isOrgFloor) is not this tier's: it holds no units, holders
 * or bookings for it and keeps none. Its reads throw rather than answer empty (refuseOrgFloor), and
 * so does `createUnit`, so a create Facilio refused never "succeeds" in this browser. `saveUnits`
 * is a no-op there — it must still RESOLVE: the explicit save awaits it before writing to the org.
 */
export class LocalJsonDataSource implements FloorplanDataSource {
  readonly name = 'local-json';

  // The seed is small and already a full tree, so the local tier answers every level from memory.
  async getPortfolio(): Promise<Site[]> {
    return SEED_PORTFOLIO;
  }

  async getBuildings(siteId: string): Promise<Building[]> {
    return SEED_PORTFOLIO.find((s) => s.id === siteId)?.buildings ?? [];
  }

  async getFloors(buildingId: string): Promise<Floor[]> {
    for (const s of SEED_PORTFOLIO) {
      const b = s.buildings?.find((x) => x.id === buildingId);
      if (b) return b.floors ?? [];
    }
    return [];
  }

  /** A seed site's floors. Any other site is not this tier's — the composite reads it another way. */
  async getSiteFloors(siteId: string): Promise<Record<string, Floor[]>> {
    const site = SEED_PORTFOLIO.find((s) => s.id === siteId);
    if (!site) throw new Error(`local-json: site ${siteId} is not in the seed`);
    return Object.fromEntries((site.buildings ?? []).map((b) => [b.id, b.floors ?? []]));
  }

  async searchFloors(query: string): Promise<FloorSearchHit[]> {
    // Against the org, a search the org could not answer is a failure to say, never the seed's
    // floors (or "No floors match") in its place.
    if (isFacilioApiConfigured) throw new Error('local-json: the floor search is the org\'s');
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: FloorSearchHit[] = [];
    for (const s of SEED_PORTFOLIO)
      for (const b of s.buildings ?? [])
        for (const f of b.floors ?? [])
          if (f.name.toLowerCase().includes(q)) hits.push({ floorId: f.id, floorName: f.name, buildingId: b.id, buildingName: b.name, siteId: s.id, siteName: s.name });
    return hits;
  }

  async getEmployees(): Promise<Employee[]> {
    return SEED_EMPLOYEES;
  }

  async getAssets(): Promise<Asset[]> {
    return SEED_ASSETS;
  }

  async getUnits(floorId: string): Promise<Unit[]> {
    refuseOrgFloor(floorId, 'units');
    const saved = loadPersisted();
    const units = saved?.units ?? SEED_UNITS;
    return units.filter((u) => u.floor === floorId);
  }

  async saveUnits(floorId: string, units: Unit[]): Promise<void> {
    const saved = loadPersisted();
    // An org floor's units are not kept here — and a copy an older build left behind is dropped
    // the next time this browser saves anything, rather than carried forward.
    const others = (saved?.units ?? SEED_UNITS).filter((u) => u.floor !== floorId && !isOrgFloor(u.floor));
    if (isOrgFloor(floorId)) {
      if (saved?.units && others.length !== saved.units.length) savePersisted({ units: others });
      return;
    }
    savePersisted({ units: [...others, ...units] });
  }

  // No backend to create against — the record lives entirely in localStorage, persisted with its
  // position by the caller's saveUnits. Just echo the unit back with its local id. Not on an org
  // floor: a space there exists once Facilio has made it, and an echo would read as "created" for a
  // create Facilio refused.
  async createUnit(loc: CreateSpaceLoc, unit: Unit): Promise<Unit> {
    if (isOrgFloor(loc.floorId)) throw new Error(`local-json: floor ${loc.floorId} is the org's — a space on it is made in Facilio or not at all`);
    return unit;
  }

  async getAssignments(floorId: string): Promise<Assignments> {
    refuseOrgFloor(floorId, 'holders');
    const saved = loadPersisted();
    const all = saved?.assignments ?? SEED_ASSIGNMENTS;
    const units = await this.getUnits(floorId);
    const ids = new Set(units.map((u) => u.id));
    // A seed unit may carry the org record's state (`state`), so the occupancy card's split can be
    // tried without an org (see recordStates).
    noteRecordStates(floorId, units as Array<Unit & { state?: unknown }>);
    return Object.fromEntries(Object.entries(all).filter(([unitId]) => ids.has(unitId)));
  }

  async assignUnit(unitId: string, contactId: string): Promise<void> {
    const saved = loadPersisted();
    const assignments = { ...(saved?.assignments ?? SEED_ASSIGNMENTS), [unitId]: contactId };
    savePersisted({ assignments });
  }

  async vacateUnit(unitId: string): Promise<void> {
    const saved = loadPersisted();
    const assignments = { ...(saved?.assignments ?? SEED_ASSIGNMENTS) };
    delete assignments[unitId];
    savePersisted({ assignments });
  }

  async getBookings(floorId: string, date: string): Promise<Booking[]> {
    refuseOrgFloor(floorId, 'bookings');
    const saved = loadPersisted();
    const bookings = saved?.bookings ?? SEED_BOOKINGS.map((b) => ({ ...b, date }));
    const units = await this.getUnits(floorId);
    const ids = new Set(units.map((u) => u.id));
    return bookings.filter((b) => ids.has(b.unitId) && b.date === date);
  }

  async createBooking(input: Omit<Booking, 'id'>): Promise<Booking> {
    const saved = loadPersisted();
    const bookings = saved?.bookings ?? SEED_BOOKINGS.map((b) => ({ ...b, date: input.date }));
    const booking: Booking = { ...input, id: 'b' + Date.now() };
    savePersisted({ bookings: [...bookings, booking] });
    return booking;
  }

  async cancelBooking(id: string): Promise<void> {
    const saved = loadPersisted();
    if (!saved?.bookings) return;
    savePersisted({ bookings: saved.bookings.filter((b) => b.id !== id) });
  }

  async getFloorData(floorId: string, date: string): Promise<FloorBundle> {
    const [units, assignments, bookings] = await Promise.all([
      this.getUnits(floorId),
      this.getAssignments(floorId),
      this.getBookings(floorId, date),
    ]);
    return { units, assignments, bookings, file: null };
  }
}

/** Wipe the local session store so the next load re-seeds from the src/data/*.json files. */
export function clearLocalData(): void {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Tier order, first to resolve wins: connected-app V3 → vibe DB → CMMS connector → local JSON.
 *
 * V3 leads because this app is hosted as a connected app: the host bridge answers each module in
 * ONE call, where the connector's list actions cap at 200 rows and must be paged. Against this org
 * that was ~9 requests for the asset catalog alone, repeated on every load — same data, an order
 * of magnitude more round trips.
 *
 * The connector keeps everything V3 can't do (the asset catalog when the module name differs, the
 * floor's real space records) and is the whole data layer when the app runs outside a Facilio host.
 */
function defaultTiers(): FloorplanDataSource[] {
  // An app-database tier (VibeDbDataSource, over a `floorplanApi` function) once sat between V3 and
  // the connector. The function could never be deployed — it ran DDL the app's database login may
  // not — so the tier was taken out of this list and later removed with it; on-plan geometry lives
  // in the org's own `floorplanmarker` records.
  return [new FacilioApiDataSource(), new ConnectorDataSource(), new LocalJsonDataSource()];
}

/** ` (12 items)` for a list, ` (3 keys)` for a map — an empty answer from a real tier looks identical to "never called" without this. */
function describe(result: unknown): string {
  if (Array.isArray(result)) return ` (${result.length} items)`;
  if (result && typeof result === 'object') return ` (${Object.keys(result as object).length} keys)`;
  return '';
}

/**
 * Tries each tier in order for every call; first to resolve wins, logging which did. When every
 * tier fails, the FIRST tier's error is thrown: the tiers run strongest first, so that is the org's
 * own reason (busy, refused, not found), where the last is only the local tier's "not mine".
 */
export class CompositeDataSource implements FloorplanDataSource {
  readonly name = 'composite';
  private tiers: FloorplanDataSource[];

  constructor(tiers: FloorplanDataSource[] = defaultTiers()) {
    this.tiers = tiers;
  }

  private async run<K extends keyof FloorplanDataSource>(
    method: K,
    ...args: FloorplanDataSource[K] extends (...a: infer A) => any ? A : never
  ): Promise<any> {
    let firstErr: unknown;
    for (const tier of this.tiers) {
      try {
        // @ts-expect-error - dynamic dispatch across the shared interface
        const result = await tier[method](...args);
        // Empty portfolio/employees counts as a MISS, not an answer: the whole app is built
        // on those two datasets, and an empty-but-successful response from the API tier (e.g. the
        // real employee fetch coming back [] for a permission-limited user) would otherwise
        // mask the local seed. NOT applied to per-floor data (units/bookings/assignments), where
        // empty is a legitimate answer — falling through there would paint seed markers over a
        // genuinely empty real floor.
        if ((method === 'getPortfolio' || method === 'getEmployees') && Array.isArray(result) && result.length === 0) {
          throw new Error(`${tier.name}: ${String(method)} returned no records`);
        }
        // Visible by default, not console.debug: which tier answered is the single most useful
        // fact when the app is embedded in a host and the network tab shows nothing (connected-app
        // calls ride a postMessage bridge, so they never appear as requests).
        // eslint-disable-next-line no-console
        console.info(`[dataSource] ${String(method)} <- ${tier.name}${describe(result)}`);
        return result;
      } catch (err) {
        // The org answered in part (lib/rateLimit): its rows, and its own way to finish, are the
        // answer. Another tier's would mix sources, and is refused by the same limit anyway. That
        // covers a read Facilio refused for rate outright (RateLimitedError, a stop with no rows) and
        // a re-read of who holds what that came back short — answered by the local tier it would
        // read as "nobody", and wipe the plan's holders. The caller keeps what it shows and says so.
        if (err instanceof IncompleteListError) throw err;
        firstErr ??= err;
        // eslint-disable-next-line no-console
        console.warn(`[dataSource] ${String(method)} unavailable on "${tier.name}", falling back:`, (err as Error)?.message ?? err);
      }
    }
    throw firstErr;
  }

  /**
   * Portfolio is first-non-empty-wins (NOT a union): the org's real tree from the Facilio API is
   * authoritative and stands ALONE. `run()` treats an empty portfolio as a miss and falls through,
   * so the API wins when it has sites and the local JSON seed only answers when the API tier is
   * empty/unavailable (offline dev with no backend).
   */
  getPortfolio(): Promise<Site[]> {
    return this.run('getPortfolio');
  }
  getBuildings(siteId: string): Promise<Building[]> {
    return this.run('getBuildings', siteId);
  }
  getFloors(buildingId: string): Promise<Floor[]> {
    return this.run('getFloors', buildingId);
  }
  /**
   * The first tier that reads a site's floors at once answers. A refusal for rate (or a list that
   * stopped part-way) is the answer — a request per building would meet the same limit. Any other
   * failure, an org that will not take the site filter included, and outside a Facilio host where
   * no tier reads a site at once, falls back to listing floors building by building, two at a time.
   */
  async getSiteFloors(siteId: string): Promise<Record<string, Floor[]>> {
    let firstErr: unknown;
    for (const tier of this.tiers) {
      if (!tier.getSiteFloors) continue;
      try {
        const result = await tier.getSiteFloors(siteId);
        // eslint-disable-next-line no-console
        console.info(`[dataSource] getSiteFloors <- ${tier.name}${describe(result)}`);
        return result;
      } catch (err) {
        if (err instanceof IncompleteListError) throw err;
        firstErr ??= err;
      }
    }
    if (firstErr) {
      // eslint-disable-next-line no-console
      console.warn(`[dataSource] getSiteFloors: ${(firstErr as Error)?.message ?? firstErr} — reading site ${siteId} building by building`);
    }
    const buildings = await this.getBuildings(siteId);
    const floors = await mapPooled(buildings, 2, (b) => this.getFloors(b.id));
    return Object.fromEntries(buildings.map((b, i) => [b.id, floors[i]]));
  }
  searchFloors(query: string): Promise<FloorSearchHit[]> {
    return this.run('searchFloors', query);
  }
  getEmployees() {
    return this.run('getEmployees');
  }
  getAssets() {
    return this.run('getAssets');
  }
  getUnits(floorId: string, onMore?: (units: Unit[]) => void) {
    return this.run('getUnits', floorId, onMore);
  }
  /**
   * Fast path across tiers that implement it; callers fall back to the per-call path on throw. As
   * run: a partial answer from the org is the answer, and when every tier fails the first one's
   * error is thrown.
   */
  async getFloorData(floorId: string, date: string, planId: string): Promise<FloorBundle> {
    let firstErr: unknown;
    for (const tier of this.tiers) {
      if (!tier.getFloorData) continue;
      try {
        return await tier.getFloorData(floorId, date, planId);
      } catch (err) {
        if (err instanceof IncompleteListError) throw err;
        firstErr ??= err;
        // eslint-disable-next-line no-console
        console.debug(`[dataSource] getFloorData unavailable on "${tier.name}", falling back`, err);
      }
    }
    throw firstErr ?? new Error('no tier implements getFloorData');
  }
  saveUnits(floorId: string, units: Unit[]) {
    return this.run('saveUnits', floorId, units);
  }
  /**
   * API-first by tier order: a real create wins when an org tier makes one; on a demo floor the
   * local tier otherwise echoes the unit back so dev stays interactive. On an org floor the local
   * tier refuses, so a create no org tier made fails with the first tier's reason. The on-plan
   * position is persisted separately via saveUnits (+ saveFloorplanMarkers to the real API when
   * configured).
   */
  createUnit(loc: CreateSpaceLoc, unit: Unit) {
    return this.run('createUnit', loc, unit) as Promise<Unit>;
  }
  getAssignments(floorId: string, onMore?: (more: Assignments) => void) {
    return this.run('getAssignments', floorId, onMore);
  }
  /**
   * On an org floor with the org reachable, its tier reads the holders by id, and a failure is never
   * another tier's answer. Otherwise (a demo floor, or the connector outside a Facilio host) the
   * floor's holders are read as before and cut down to `unitIds`.
   */
  async getAssignmentsFor(floorId: string, unitIds: string[]): Promise<Assignments> {
    const tier = isOrgFloor(floorId) ? this.tiers.find((t) => t.getAssignmentsFor) : undefined;
    if (tier?.getAssignmentsFor) {
      const result = await tier.getAssignmentsFor(floorId, unitIds);
      // eslint-disable-next-line no-console
      console.info(`[dataSource] getAssignmentsFor <- ${tier.name}${describe(result)}`);
      return result;
    }
    const all: Assignments = await this.getAssignments(floorId);
    const wanted = new Set(unitIds);
    return Object.fromEntries(Object.entries(all).filter(([unitId]) => wanted.has(unitId)));
  }
  assignUnit(unitId: string, contactId: string) {
    return this.run('assignUnit', unitId, contactId);
  }
  vacateUnit(unitId: string) {
    return this.run('vacateUnit', unitId);
  }
  getBookings(floorId: string, date: string) {
    return this.run('getBookings', floorId, date);
  }
  createBooking(input: Omit<Booking, 'id'>) {
    return this.run('createBooking', input);
  }
  cancelBooking(id: string) {
    return this.run('cancelBooking', id);
  }
}

export const dataSource: FloorplanDataSource = new CompositeDataSource();
