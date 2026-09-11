import { CMMS_CONNECTION, isVibeApp, vibe } from './vibe';
import type { CreateSpaceLoc, FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Building, Employee, Floor, FloorSearchHit, Site, Unit } from './types';

/**
 * Facilio CMMS connector tier — the org's REAL records, read through the `facilio-cmms`
 * connection rather than direct V3 module CRUD.
 *
 * Why a connector at all when this app can also speak V3: a connector action is a stable,
 * permissioned contract the platform brokers (the vibe server mints a service token for the
 * signed-in user and proxies the call), so the browser never holds a bearer token and the action's
 * input/output shape survives module-schema churn. Where an action exists, it wins.
 *
 * Scope is the set of actions that exist. Dedicated actions cover the portfolio, the people
 * directory, the asset catalog and space creation; the generic custom-module actions additionally
 * reach `desks`, `lockers`, `parkingstall`, `spacebooking` and `indoorfloorplan` (verified against
 * ENEC CAFM), which is how getUnits reads the floor's real spaces.
 *
 * Hard-blocked, even generically: `floorplanmarker` (on-plan geometry) and `moves` (desk
 * assignment) both answer MODULE_NOT_FOUND. Also absent: file upload/preview and org forms. Those
 * methods throw so CompositeDataSource falls through to the connected-app V3 tier.
 *
 * `spacebooking` is readable but NOT wired yet — mapping a booking back to a unit needs the
 * resource lookup field confirmed against a real desk booking, and this org has only one sample.
 */
export class ConnectorDataSource implements FloorplanDataSource {
  readonly name = 'facilio-cmms-connector';

  private assertAvailable() {
    if (!isVibeApp) throw new Error('cmms-connector: not running as a vibe app');
  }

  private async action<T>(actionSlug: string, body: Record<string, unknown> = {}): Promise<T> {
    this.assertAvailable();
    return vibe.executeAction<T>(CMMS_CONNECTION, actionSlug, body);
  }

  /**
   * Every row of a list action. `page_size` is capped at 200 by the connector, so a portfolio
   * bigger than one page needs paging — stop on a short page, and bail at a page cap so a
   * misbehaving action can't spin forever.
   */
  private async listAll(actionSlug: string, body: Record<string, unknown> = {}): Promise<any[]> {
    const pageSize = 200;
    const out: any[] = [];
    for (let page = 1; page <= 25; page++) {
      const res = await this.action<{ data?: any[] }>(actionSlug, { ...body, page, page_size: pageSize });
      const rows = res?.data ?? [];
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  /** Sites only; buildings/floors load per level on expand. Sorted by name to match the V3 tier. */
  async getPortfolio(): Promise<Site[]> {
    const sites = await this.listAll('list-sites');
    return byName(sites).map((s: any) => ({ id: String(s.id), name: s.name }));
  }

  /** `filters=site=<id>` — the same `field=value` filter syntax verified on desks (`floor=<id>`). */
  async getBuildings(siteId: string): Promise<Building[]> {
    const rows = await this.listAll('list-buildings', { filters: `site=${siteId}` });
    return byName(rows).map((b: any) => ({ id: String(b.id), name: b.name }));
  }

  async getFloors(buildingId: string): Promise<Floor[]> {
    const rows = await this.listAll('list-floors', { filters: `building=${buildingId}` });
    return byName(rows).map((f: any) => ({ id: String(f.id), name: f.name, hasPlan: true }));
  }

  /** Flat floor index, fetched once on first search (3 paged calls), then filtered in memory. */
  async searchFloors(query: string): Promise<FloorSearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    if (!connectorFloorIndex) {
      connectorFloorIndex = Promise.all([this.listAll('list-floors', { expand: 'site,building' }), this.listAll('list-sites')]).then(([floors, sites]) => {
        const sName = new Map(sites.map((s: any) => [String(s.id), String(s.name ?? '')]));
        return floors.map((f: any) => {
          const siteId = String(lookupId(f.site));
          return {
            floorId: String(f.id),
            floorName: String(f.name ?? ''),
            buildingId: String(lookupId(f.building)),
            buildingName: nameOf(f.building),
            siteId,
            siteName: nameOf(f.site) || sName.get(siteId) || '',
          } as FloorSearchHit;
        });
      });
      connectorFloorIndex.catch(() => {
        connectorFloorIndex = null;
      });
    }
    const all = await connectorFloorIndex;
    return all.filter((h) => h.floorName.toLowerCase().includes(q) || h.buildingName.toLowerCase().includes(q)).slice(0, 50);
  }

  async getEmployees(): Promise<Employee[]> {
    const rows = await this.listAll('list-employees');
    return rows.map((e: any) => ({ id: String(e.id), name: e.name }));
  }

  /**
   * Deliberately ONE page, not `listAll`. This feeds a search-and-drag picker, where the first 200
   * rows are plenty; paging the full catalog cost ~10 requests against this org for a panel that is
   * opened rarely. The V3 tier above returns everything in a single call anyway.
   */
  async getAssets(): Promise<Asset[]> {
    const res = await this.action<{ data?: any[] }>('list-assets', { page: 1, page_size: 200, expand: 'category,space' });
    const rows = res?.data ?? [];
    return rows.map((a: any) => ({
      id: String(a.id),
      name: a.name,
      category: nameOf(a.category) || 'Uncategorized',
      detail: [nameOf(a.space), a.serialNumber].filter(Boolean).join(' · '),
    }));
  }

  /**
   * A genuinely-new desk/parking-stall/room record in the org, via `create-space`.
   *
   * The action's `spaceCategory` accepts Desk / Parking Stall / Room; a locker has no such
   * category, so lockers throw and fall through rather than being filed under the wrong one.
   * The returned id replaces the app's local id so the marker written later points at the real
   * record; the on-plan POSITION is stored separately (vibe db / floorplanmarker), since
   * `create-space` has nowhere to put it.
   */
  async createUnit(loc: CreateSpaceLoc, unit: Unit): Promise<Unit> {
    const spaceCategory = SPACE_CATEGORY[unit.type];
    if (!spaceCategory) throw new Error(`cmms-connector: no space category for ${unit.type}`);
    if (!loc.siteId) throw new Error('cmms-connector: create-space needs a site');

    const res = await this.action<{ data?: { id?: number | string } }>('create-space', {
      space: {
        name: unit.label,
        site: Number(loc.siteId) || loc.siteId,
        ...(loc.buildingId ? { building: Number(loc.buildingId) || loc.buildingId } : {}),
        floor: Number(loc.floorId) || loc.floorId,
        spaceCategory,
      },
    });
    const id = res?.data?.id;
    return id ? { ...unit, id: String(id) } : unit;
  }

  /**
   * The floor's REAL desk/locker/parking-stall records, via the connector's generic
   * custom-module read (`desks`, `lockers`, `parkingstall` all resolve; `floorplanmarker` and
   * `moves` do not).
   *
   * Every unit comes back `unplaced` with a 0,0 placeholder geometry, because the thing that
   * holds an on-plan POSITION is `floorplanmarker`, which the connector cannot reach. So these
   * list in the sidebar as the org's real spaces and stay off the canvas rather than being drawn
   * at a fabricated coordinate — the distinction `Unit.unplaced` already exists for.
   */
  async getUnits(floorId: string): Promise<Unit[]> {
    const filters = `floor=${floorId}`;
    const [desks, lockers, stalls] = await Promise.all([
      this.listAll('list-custom-module-records', { custom_module: 'desks', filters }),
      this.listAll('list-custom-module-records', { custom_module: 'lockers', filters }),
      this.listAll('list-custom-module-records', { custom_module: 'parkingstall', filters }),
    ]);

    const units: Unit[] = [
      ...desks.map((r: any) => toUnit(r, 'workstation', floorId)),
      ...lockers.map((r: any) => toUnit(r, 'locker', floorId)),
      ...stalls.map((r: any) => toUnit(r, 'parking', floorId)),
    ];
    // An empty floor is a legitimate answer, but so is "this tier can't help" — and the composite
    // can only tell them apart by a throw. A real floor with no spaces should NOT fall through to
    // the demo seed, so return the empty list rather than throwing.
    return units;
  }

  async saveUnits(): Promise<void> {
    // Positions live in floorplanmarker, which the connector can't reach.
    throw new Error('cmms-connector: on-plan geometry has no connector action');
  }
  async getAssignments(): Promise<Assignments> {
    throw new Error('cmms-connector: moves/assignments have no connector action');
  }
  async assignUnit(): Promise<void> {
    throw new Error('cmms-connector: moves/assignments have no connector action');
  }
  async vacateUnit(): Promise<void> {
    throw new Error('cmms-connector: moves/assignments have no connector action');
  }
  async getBookings(): Promise<Booking[]> {
    throw new Error('cmms-connector: bookings have no connector action');
  }
  async createBooking(): Promise<Booking> {
    throw new Error('cmms-connector: bookings have no connector action');
  }
  async cancelBooking(): Promise<void> {
    throw new Error('cmms-connector: bookings have no connector action');
  }
}

/** `create-space` space categories, per the action schema (Desk / Parking Stall / Room). */
const SPACE_CATEGORY: Partial<Record<Unit['type'], string>> = {
  workstation: 'Desk',
  parking: 'Parking Stall',
  room: 'Room',
  // A delivery area has no category of its own in the org — it is a room by another name.
  delivery: 'Room',
};

/**
 * Real Facilio desk typing, `V3DeskContext.DeskType`: 1=ASSIGNED, 2=HOTEL, 3=HOT. Records carry
 * `-1` (and sometimes 0) when it was never set, which the app treats as ASSIGNED by leaving
 * `deskType` undefined.
 */
const DESK_TYPE_BY_INT: Record<number, Unit['deskType']> = { 1: 'ASSIGNED', 2: 'HOTEL', 3: 'HOT' };

/**
 * One org space record → this app's Unit, listed but not drawn (see getUnits).
 *
 * Narrowed to the three point modules on purpose: each is also a valid PlanId, which is what lets
 * `plan` be set from `type`. Zones (rooms, delivery areas) are polygons and don't come from here.
 */
type PointModule = Extract<Unit['type'], 'workstation' | 'locker' | 'parking'>;

function toUnit(record: any, type: PointModule, floorId: string): Unit {
  const deskType = type === 'workstation' ? DESK_TYPE_BY_INT[Number(record.deskType)] : undefined;
  return {
    id: String(record.id),
    type,
    label: record.name ?? record.deskCode ?? String(record.id),
    room: null,
    // Placeholder: the real position lives in floorplanmarker, which is unreachable here.
    geom: { kind: 'point', x: 0, y: 0 },
    floor: floorId,
    plan: type,
    unplaced: true,
    ...(deskType ? { deskType } : {}),
  };
}

let connectorFloorIndex: Promise<FloorSearchHit[]> | null = null;

function byName(rows: any[]): any[] {
  return [...rows].sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, { numeric: true }));
}

/** A lookup field is a raw id when unexpanded and `{id, name}` when expanded — accept both. */
function lookupId(value: unknown): unknown {
  return value && typeof value === 'object' ? (value as { id?: unknown }).id : value;
}

function nameOf(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') return String((value as { name?: unknown }).name ?? '');
  return String(value);
}
