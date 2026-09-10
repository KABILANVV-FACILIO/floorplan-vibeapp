import { CMMS_CONNECTION, isVibeApp, vibe } from './vibe';
import type { CreateSpaceLoc, FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Employee, Site, Unit } from './types';

/**
 * Facilio CMMS connector tier — the org's REAL records, read through the `facilio-cmms`
 * connection rather than direct V3 module CRUD.
 *
 * Why a connector at all when this app can also speak V3: a connector action is a stable,
 * permissioned contract the platform brokers (the vibe server mints a service token for the
 * signed-in user and proxies the call), so the browser never holds a bearer token and the action's
 * input/output shape survives module-schema churn. Where an action exists, it wins.
 *
 * Scope is exactly the set of actions that exist. Portfolio, the people directory, the asset
 * catalog and space creation are covered. Everything else this app needs — on-plan marker geometry
 * (`floorplanmarker`), desk Moves, booking records, file upload/preview and org forms — has no
 * connector action (`moves` and `floorplanmarker` aren't even reachable through the generic
 * custom-module actions), so those methods throw and CompositeDataSource falls through to the
 * connected-app V3 tier that does implement them.
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

  async getPortfolio(): Promise<Site[]> {
    const [sites, buildings, floors] = await Promise.all([
      this.listAll('list-sites'),
      this.listAll('list-buildings'),
      this.listAll('list-floors'),
    ]);
    // Lookup fields come back as raw ids unless named in `expand`, which is exactly what the
    // grouping below wants — no `expand` is requested for that reason.
    return sites.map((s: any) => ({
      id: String(s.id),
      name: s.name,
      buildings: buildings
        .filter((b: any) => String(lookupId(b.site)) === String(s.id))
        .map((b: any) => ({
          id: String(b.id),
          name: b.name,
          floors: floors
            .filter((f: any) => String(lookupId(f.building)) === String(b.id))
            .map((f: any) => ({
              id: String(f.id),
              name: f.name,
              // Unknown until the floor is actually opened; true keeps the canvas available
              // rather than pre-emptively showing "No floorplan yet".
              hasPlan: true,
            })),
        })),
    }));
  }

  async getEmployees(): Promise<Employee[]> {
    const rows = await this.listAll('list-employees');
    return rows.map((e: any) => ({ id: String(e.id), name: e.name }));
  }

  async getAssets(): Promise<Asset[]> {
    const rows = await this.listAll('list-assets', { expand: 'category,space' });
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

  // ---- No connector action exists for anything below: fall through to the V3 tier. ----
  async getUnits(): Promise<Unit[]> {
    throw new Error('cmms-connector: on-plan geometry has no connector action');
  }
  async saveUnits(): Promise<void> {
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

/** A lookup field is a raw id when unexpanded and `{id, name}` when expanded — accept both. */
function lookupId(value: unknown): unknown {
  return value && typeof value === 'object' ? (value as { id?: unknown }).id : value;
}

function nameOf(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') return String((value as { name?: unknown }).name ?? '');
  return String(value);
}
