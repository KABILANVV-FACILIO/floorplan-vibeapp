import { apiOrigin, customGet, customPost, facilioApi, fetchFilePreview, isFacilioApiConfigured } from './facilioApi';
import { renderCadToDataUrl } from './cadPreview';
import { renderPdfToDataUrl } from './pdfPreview';
import { computeSyntheticGeometry, geometryStringToQuad, lngLatToQuadFraction, quadFittingPoints, quadToGeometryString, quadToLngLat } from './geoReference';
import type { CreateSpaceLoc, FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import { TYPE_META } from './types';
import type { Assignments, Booking, Building, Employee, Floor, FloorSearchHit, PlanId, PointGeom, Site, Unit, UnitType } from './types';

/**
 * `fetchOriginal=true` on `v2/files/preview` returns the ORIGINAL uploaded bytes — for a plain
 * raster image that's directly usable as an `<img>` source, but a floor's plan is often a DWG/
 * DXF/PDF source file (confirmed against a live org: `Content-Type: image/vnd.dwg`), which a
 * browser can't decode natively. Detect that from the response's real content-type (not the
 * `.dwg` extension, which isn't available here — this isn't a locally-picked `File`) and run it
 * through the same client-side CAD/PDF renderers the upload flow uses, so a floor plan that was
 * uploaded as a DWG still shows a rendered image, not a broken `<img>` icon.
 */
async function blobToRenderableDataUrl(blob: Blob, contentType: string | undefined): Promise<string> {
  const type = (contentType || blob.type || '').toLowerCase();
  if (type.includes('dwg') || type.includes('dxf')) {
    const file = new File([blob], `floorplan.${type.includes('dxf') ? 'dxf' : 'dwg'}`, { type });
    return renderCadToDataUrl(file);
  }
  if (type.includes('pdf')) {
    const file = new File([blob], 'floorplan.pdf', { type });
    return renderPdfToDataUrl(file);
  }
  return URL.createObjectURL(blob);
}

/**
 * `indoorfloorplan.floorPlanType` — one plan record per module, confirmed against a live org
 * (only 1/2/3 are accepted; there's no generic/custom type, so `custom` floors fall back to
 * the workstation plan).
 */
const FLOOR_PLAN_TYPE: Record<PlanId, number> = {
  workstation: 1,
  locker: 2,
  parking: 3,
  custom: 1,
};
const PLAN_ID_BY_TYPE: Record<number, PlanId> = { 1: 'workstation', 2: 'locker', 3: 'parking' };
const PLAN_NAME_BY_TYPE: Record<number, string> = { 1: 'Workstations', 2: 'Lockers', 3: 'Parking stalls' };

/**
 * Real Facilio backend tier (generic V3 module CRUD: `v3/modules/{moduleName}`) — see
 * `facilioApi.ts` for the connected-app-SDK vs. dev-mode-axios transport split.
 *
 * Scope: the portfolio, the employee directory and the asset catalog map cleanly onto plain module
 * records. On-plan POSITION lives in separate `floorplanmarker` (Point) records georeferenced by
 * `indoorfloorplan.geometry`; `getUnits` reads them back, and the explicit-save chokepoint
 * (`persistUnits` -> `saveFloorplanMarkers`) writes them. `ensurePlanGeoreference` seeds the quad
 * for plans created in Facilio's editor, which arrive without one.
 *
 * Still not wired here: room/zone polygons (`floorplanmarkedzone`), assignments (Moves-derived —
 * the WRITE path exists as `assignUnitReal`/`vacateUnitReal`, called separately by the context, but
 * reading current holders back is not) and bookings. Those throw, so CompositeDataSource falls
 * through to the tier below rather than this one guessing.
 */
export class FacilioApiDataSource implements FloorplanDataSource {
  readonly name = 'facilio-api';

  private assertConfigured() {
    if (!isFacilioApiConfigured) throw new Error('facilio-api: not configured (VITE_DEV_MODE / base URL / token)');
  }

  /**
   * The whole portfolio, PAGED. A bare `fetchAll` returns only the server's default first page,
   * and this org has 431 buildings and 587 floors — so embedded (this tier) a site whose buildings
   * fell outside page one rendered as expanded-but-empty, while standalone (the connector, which
   * pages) showed the full tree. Same org, two different answers, purely from page size.
   *
   * Sorted by name at every level so the tree — and therefore the auto-selected first floor — is
   * identical whichever tier answers; the two APIs return rows in different natural orders.
   */
  /**
   * SITES ONLY. The org has 431 buildings and 587 floors; fetching the whole tree up front was
   * either truncated (a bare fetchAll stops at the server's first page) or, once paged, ~9
   * requests at boot for data the user mostly never opens. Children load per level on expand —
   * see getBuildings / getFloors — through the REAL `relatedList` endpoint, the same verified
   * pattern the marker read uses, so no guessed filter-operator ids are involved.
   */
  async getPortfolio(): Promise<Site[]> {
    this.assertConfigured();
    const sites = await fetchAllPaged('site');
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] getPortfolio: ${sites.length} sites (buildings/floors load on expand)`);
    return sortByName(sites).map((s: any) => ({ id: String(s.id), name: s.name }));
  }

  async getBuildings(siteId: string): Promise<Building[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAllRelatedList<any>({ moduleName: 'site', id: siteId, relatedModuleName: 'building', relatedFieldName: 'site' });
    if (res.error) throw new Error(`facilio-api: buildings for site ${siteId} failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return sortByName(res.list ?? []).map((b: any) => ({ id: String(b.id), name: b.name }));
  }

  async getFloors(buildingId: string): Promise<Floor[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAllRelatedList<any>({ moduleName: 'building', id: buildingId, relatedModuleName: 'floor', relatedFieldName: 'building' });
    if (res.error) throw new Error(`facilio-api: floors for building ${buildingId} failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    // hasPlan unknown until getFloorPlanSummary runs; true keeps the canvas reachable rather than
    // hiding it behind "No floorplan yet" pre-emptively.
    return sortByName(res.list ?? []).map((f: any) => ({ id: String(f.id), name: f.name, hasPlan: true }));
  }

  /**
   * Search fetches a flat floor index ONCE (3 paged calls for 587 floors), on the first keystroke,
   * then filters in memory for the rest of the session. That avoids depending on a server-side
   * text operator whose id could not be confirmed, and costs nothing until someone searches.
   */
  async searchFloors(query: string): Promise<FloorSearchHit[]> {
    this.assertConfigured();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    if (!floorIndex) {
      floorIndex = Promise.all([fetchAllPaged('floor'), fetchAllPaged('building'), fetchAllPaged('site')]).then(([floors, buildings, sites]) => {
        const bName = new Map(buildings.map((b: any) => [String(b.id), String(b.name ?? '')]));
        const sName = new Map(sites.map((s: any) => [String(s.id), String(s.name ?? '')]));
        return floors.map((f: any) => {
          const buildingId = String(lookupId(f, 'building'));
          const siteId = String(lookupId(f, 'site'));
          return {
            floorId: String(f.id),
            floorName: String(f.name ?? ''),
            buildingId,
            buildingName: f.building?.name ?? bName.get(buildingId) ?? '',
            siteId,
            siteName: f.site?.name ?? sName.get(siteId) ?? '',
          } as FloorSearchHit;
        });
      });
      floorIndex.catch(() => {
        floorIndex = null; // transient failure — allow a retry on the next keystroke
      });
    }
    const all = await floorIndex;
    return all.filter((h) => h.floorName.toLowerCase().includes(q) || h.buildingName.toLowerCase().includes(q)).slice(0, 50);
  }

  /**
   * The people directory, PAGED — same reason the portfolio is (see getPortfolio). A bare
   * `fetchAll` returns only the server's default first page, so in an org this size the assign /
   * book-for pickers silently offered whichever employees happened to land on page one and had no
   * way to reach the rest.
   */
  async getEmployees(): Promise<Employee[]> {
    this.assertConfigured();
    const rows = await fetchAllPaged('employee');
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] getEmployees: ${rows.length} employees`);
    return sortByName(rows).map((e: any) => ({
      id: String(e.id),
      name: e.name,
    }));
  }

  /**
   * The asset catalog in ONE call, straight down the V3 list endpoint via `invokeFacilioAPI`.
   *
   * The connector's `list-assets` caps at 200 rows per action call, so paging this org's ~1800
   * assets cost ~10 round trips on every load. V3 answers the same question once. `perPage` is
   * bounded rather than unbounded because this feeds a search-and-drag picker, not a report.
   *
   * Throws on a bad envelope or an empty list so the connector tier below stays the safety net.
   */
  async getAssets(): Promise<Asset[]> {
    this.assertConfigured();
    const body = await customGet('v3/modules/asset', { page: 1, perPage: 200 });
    if (body?.code !== 0) throw new Error(`facilio-api: asset fetch failed (${body?.code ?? '?'} ${body?.message ?? ''})`.trim());
    // Raw REST envelope: rows live under `data.<module>` (see fetchAllRelatedList).
    const rows: any[] = body?.data?.asset ?? body?.asset ?? [];
    if (!rows.length) throw new Error('facilio-api: no assets returned');
    return rows.map((a: any) => ({
      id: String(a.id),
      name: a.name,
      category: a.category?.name ?? a.assetCategory?.name ?? 'Uncategorized',
      detail: [a.space?.name ?? a.spaceName, a.serialNumber].filter(Boolean).join(' · '),
    }));
  }

  /**
   * The floor's PLACED units, read back from the real `floorplanmarker` records.
   *
   * This is the counterpart of `saveFloorplanMarkers`, which has always written them. Markers store
   * an absolute lng/lat, georeferenced by the plan's `indoorfloorplan.geometry` quad, so each point
   * is converted back to the 0-1 image fraction the canvas draws in (see geoReference).
   *
   * A marker the app itself wrote carries `geoId` (its unit id) and a `properties` blob naming the
   * unit type; one placed by the org's own editor may carry neither, so the id falls back to the
   * marker's own record id and the type to the plan it sits on. A plan whose `geometry` was never
   * calibrated is skipped rather than guessed at — without the quad there is no sane fraction, and
   * inventing one would silently scatter markers across the plan.
   */
  async getUnits(floorId: string): Promise<Unit[]> {
    this.assertConfigured();
    // Throw rather than return [] — a demo floor's units belong to the local tier, and the
    // composite only falls through on a rejection. Returning empty would strand the canvas.
    if (!isRealFloorId(floorId)) throw new Error(`facilio-api: ${floorId} is not an org floor id`);
    const byType = await getFloorplanDetailsByType(floorId);
    const units: Unit[] = [];
    // Real records already represented by a marker — matched on the marker's `recordId`, which this
    // app sets when it creates the backing desk/locker/stall. A marker placed in the org's own
    // editor may lack it, in which case that record also appears as unplaced (logged below).
    const placedRecordIds = new Set<string>();
    let outOfFrame = 0;

    for (const [typeNum, summary] of Object.entries(byType)) {
      const planId = PLAN_ID_BY_TYPE[Number(typeNum)];
      const planRecordId = (summary as any)?.id;
      if (!planId || !planRecordId) continue;

      const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: planRecordId });
      const planRecord = recordOf<any>(recordRes, 'indoorfloorplan');
      const quad = geometryStringToQuad(planRecord?.geometry);
      if (!quad) {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] getUnits: plan ${planId} (#${planRecordId}) has no calibrated geometry — its markers are skipped, not guessed`);
        continue;
      }

      const markersRes = await facilioApi.fetchAllRelatedList<any>({
        moduleName: 'indoorfloorplan',
        id: planRecordId,
        relatedModuleName: 'floorplanmarker',
        relatedFieldName: 'indoorfloorplan',
      });
      if (markersRes.error) {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] getUnits: marker list failed for plan ${planId} (#${planRecordId}):`, markersRes.error);
        continue;
      }
      // eslint-disable-next-line no-console
      console.info(`[facilio-api] getUnits: plan ${planId} (#${planRecordId}) -> ${markersRes.list?.length ?? 0} markers`);

      for (const marker of markersRes.list ?? []) {
        if (marker.recordId) placedRecordIds.add(String(marker.recordId));
        const point = parsePointGeometry(marker.geometry);
        if (!point) continue; // polygons/zones live in floorplanmarkedzone, not here
        const [x, y] = lngLatToQuadFraction(quad, point[0], point[1]);
        // A marker written in some other coordinate space (e.g. by the org's own editor before this
        // plan had a quad) converts to a wildly out-of-frame fraction. Drop it and say so, rather
        // than pinning it to an edge where it looks like a real, mis-placed unit.
        if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) {
          outOfFrame++;
          continue;
        }
        const props = safeJson<{ unitType?: string; secondary?: string | null }>(marker.properties) ?? {};
        // `properties` is free-form JSON on the org's record — another app, an older build of this
        // one, or a hand-edited row can put anything in `unitType`. An unrecognised value used to
        // flow straight into a Unit, where every `TYPE_META[unit.type].name` lookup (the marker's
        // own status pill included) threw on undefined and took the whole canvas down with it.
        const type = asUnitType(props.unitType) ?? PLAN_UNIT_TYPE[planId] ?? 'workstation';
        units.push({
          id: String(marker.geoId || marker.id),
          type,
          label: marker.label ?? String(marker.id),
          ...(props.secondary ? { secondary: props.secondary } : {}),
          room: null,
          geom: { kind: 'point', x, y },
          floor: floorId,
          plan: planId,
        });
      }
    }

    // The floor's REAL desks / lockers / parking stalls / rooms that have no marker yet, via the same
    // verified relatedList pattern (floor -> <module> on the `floor` lookup). They enter the
    // "Available to place" pool so they can be dragged onto the plan. `space` is the base table
    // desks/lockers/stalls also live in, so rooms are whatever is left after excluding those ids and
    // anything that isn't a plain SPACE (buildings/floors also answer to `space`).
    const rel = (module: string) =>
      facilioApi
        .fetchAllRelatedList<any>({ moduleName: 'floor', id: floorId, relatedModuleName: module, relatedFieldName: 'floor' })
        .then((r) => (r.error ? [] : r.list ?? []))
        .catch(() => [] as any[]);
    const [desks, lockers, stalls, spaces] = await Promise.all([rel('desks'), rel('lockers'), rel('parkingstall'), rel('space')]);
    const pointIds = new Set([...desks, ...lockers, ...stalls].map((r: any) => String(r.id)));
    const rooms = spaces.filter((r: any) => !pointIds.has(String(r.id)) && (r.spaceTypeEnum ?? 'SPACE') === 'SPACE');

    let unmatchedMarkers = 0;
    const addUnplaced = (rows: any[], type: Unit['type']) => {
      for (const r of rows) {
        const id = String(r.id);
        if (placedRecordIds.has(id)) continue;
        if (units.some((u) => u.id === id)) {
          unmatchedMarkers++;
          continue;
        }
        units.push(toUnplacedUnit(r, type, floorId));
      }
    };
    addUnplaced(desks, 'workstation');
    addUnplaced(lockers, 'locker');
    addUnplaced(stalls, 'parking');
    addUnplaced(rooms, 'room');
    // eslint-disable-next-line no-console
    console.info(
      `[facilio-api] getUnits floor ${floorId}: ${units.filter((u) => !u.unplaced).length} placed markers; unplaced records: ${desks.length} desks, ${lockers.length} lockers, ${stalls.length} stalls, ${rooms.length} rooms (${placedRecordIds.size} already placed)` +
        (unmatchedMarkers ? ` — ${unmatchedMarkers} records also appear as markers without a recordId link` : '') +
        (outOfFrame ? ` — ${outOfFrame} markers dropped: outside the plan after conversion (written in another coordinate space?)` : '')
    );
    return units;
  }

  /**
   * Positions are persisted as real floorplanmarker records — the same path the save bar uses.
   * Throws when NOTHING could be written (no plan on this floor has a georeference yet), so
   * CompositeDataSource falls through to browser storage instead of treating a silent no-op as a
   * successful save and losing the placement on refresh.
   */
  /**
   * Deliberately NOT implemented here — throws so the composite falls through to browser storage.
   *
   * `saveUnits` runs on every micro-edit (each drag, each click-place). Syncing real markers that
   * often was measured overhead — re-fetching the plan geometry and the full marker list per
   * configured plan type on every edit — so the design keeps per-edit persistence local and pushes
   * real `floorplanmarker` records only at the explicit "Save changes" chokepoint
   * (`persistUnits` -> `saveFloorplanMarkers`). Doing it here too reintroduced that cost and raced
   * the chokepoint's own sync on the same geoIds. `getUnits` reads back whatever the last explicit
   * save wrote; unsaved edits are exactly what the "unsaved changes" bar guards.
   */
  async saveUnits(): Promise<void> {
    throw new Error('facilio-api: per-edit persistence is local; real markers sync at explicit save (persistUnits)');
  }
  /**
   * A real desk / locker / parking-stall record, created straight down V3.
   *
   * This used to throw so the composite fell through to the CMMS connector's `create-space`, and
   * that action drops the floor: checked in a live org, the two desks it made came back parented
   * to the SITE (`Resources.SPACE_ID` = the site id) with no `floor` at all, while every desk the
   * org's own editor created is parented to a space on the floor. A desk that isn't on the floor
   * never comes back from `relatedList floor -> desks`, so it vanishes from "Available to place"
   * and from Facilio's own floor views.
   *
   * `site` / `building` / `floor` are real lookup fields on the space base module (confirmed
   * against the org's `Fields`: SITE_ID / BUILDING_ID / FLOOR_ID), and they're read off the FLOOR
   * RECORD rather than the caller's `loc` — the portfolio tree loads lazily, so `loc` carries
   * whatever happened to be expanded, while the floor record always knows its own parents.
   */
  async createUnit(loc: CreateSpaceLoc, unit: Unit): Promise<Unit> {
    this.assertConfigured();
    const moduleName = REAL_SPACE_MODULE[unit.type];
    if (!moduleName) throw new Error(`facilio-api: no real module for ${unit.type}`);

    const floorId = unit.floor || loc.floorId;
    if (!isRealFloorId(floorId)) throw new Error(`facilio-api: createUnit needs an org floor id, got "${floorId}"`);
    const floorRes = await facilioApi.fetchRecord<any>('floor', { id: floorId });
    const floorRec = recordOf<any>(floorRes, 'floor');
    if (floorRes.error || !floorRec) throw new Error(`facilio-api: floor ${floorId} not found`);
    const siteId = lookupId(floorRec, 'site') ?? loc.siteId;
    const buildingId = lookupId(floorRec, 'building') ?? loc.buildingId;
    if (!siteId) throw new Error(`facilio-api: floor ${floorId} has no site`);

    const deskTypeInt = unit.type === 'workstation' ? DESK_TYPE_INT[unit.deskType ?? 'ASSIGNED'] : undefined;
    const res = await facilioApi.createRecord<any>(moduleName, {
      data: {
        name: unit.label,
        site: { id: siteId },
        ...(buildingId ? { building: { id: buildingId } } : {}),
        floor: { id: floorId },
        ...(deskTypeInt ? { deskType: deskTypeInt } : {}),
      },
    });
    const created = recordOf<any>(res, moduleName);
    if (res.error || !created?.id) {
      throw new Error(`facilio-api: could not create ${moduleName} (${res.error?.code ?? '?'} ${res.error?.message ?? ''})`.trim());
    }
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] createUnit: ${moduleName} #${created.id} "${unit.label}" on floor ${floorId} (site ${siteId}${buildingId ? `, building ${buildingId}` : ''})`);
    // The record id becomes the unit id — that is what makes the marker's geoId/recordId line up.
    return { ...unit, id: String(created.id) };
  }
  async getAssignments(): Promise<Assignments> {
    throw new Error('facilio-api: assignments (Moves-derived) not wired');
  }
  async assignUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  async vacateUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  async getBookings(): Promise<Booking[]> {
    throw new Error('facilio-api: spacebooking not wired');
  }
  async createBooking(): Promise<Booking> {
    throw new Error('facilio-api: spacebooking not wired');
  }
  async cancelBooking(): Promise<void> {
    throw new Error('facilio-api: spacebooking not wired');
  }
}

/** Real Facilio desk typing (`V3DeskContext.DeskType`): 1=ASSIGNED, 2=HOTEL, 3=HOT; -1/0 = unset. */
const DESK_TYPE_BY_INT: Record<number, Unit['deskType']> = { 1: 'ASSIGNED', 2: 'HOTEL', 3: 'HOT' };
const DESK_TYPE_INT: Record<NonNullable<Unit['deskType']>, number> = { ASSIGNED: 1, HOTEL: 2, HOT: 3 };

/**
 * A real org record with no marker -> an `unplaced` Unit for the "Available to place" pool. The
 * geometry is a placeholder: the pool never draws, and placing it supplies the real position.
 */
function toUnplacedUnit(record: any, type: Unit['type'], floorId: string): Unit {
  const deskType = type === 'workstation' ? DESK_TYPE_BY_INT[Number(record.deskType)] : undefined;
  const isZone = type === 'room';
  return {
    id: String(record.id),
    type,
    label: record.name ?? record.deskCode ?? String(record.id),
    room: null,
    geom: isZone ? { kind: 'poly', pts: [] } : { kind: 'point', x: 0, y: 0 },
    floor: floorId,
    plan: isZone ? 'custom' : POOL_PLAN[type] ?? 'custom',
    unplaced: true,
    ...(deskType ? { deskType } : {}),
  };
}

/**
 * A value off an org record narrowed to a real `UnitType`, or null. `TYPE_META` is the contract
 * every surface indexes by type, so anything outside it must not become a Unit.
 */
function asUnitType(value: unknown): UnitType | null {
  return typeof value === 'string' && value in TYPE_META ? (value as UnitType) : null;
}

/**
 * Placeholder plan for a pool record, which never draws — the real one is decided when the user
 * places it, by whichever plan is on screen (`planForPlacement`).
 */
const POOL_PLAN: Partial<Record<UnitType, PlanId>> = { workstation: 'workstation', locker: 'locker', parking: 'parking' };

/** Which unit type a plan type implies, for markers that carry no `properties.unitType`. */
const PLAN_UNIT_TYPE: Partial<Record<PlanId, Unit['type']>> = {
  workstation: 'workstation',
  locker: 'locker',
  parking: 'parking',
};

/** A marker's stored GeoJSON -> [lng, lat]. Null for anything that isn't a Point. */
function parsePointGeometry(geometry: string | null | undefined): [number, number] | null {
  if (!geometry) return null;
  try {
    const parsed = JSON.parse(geometry);
    if (parsed?.type !== 'Point') return null;
    const c = parsed.coordinates;
    return Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[0], c[1]] : null;
  } catch {
    return null;
  }
}

function safeJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Session cache for searchFloors — the flat floor index, built on first search. */
let floorIndex: Promise<FloorSearchHit[]> | null = null;

/**
 * Every record of a module via `fetchAll`, paged. Guards against a server that ignores `page`
 * (a repeated first id means the same page came back — stop, don't spin) and against one that
 * ignores `perPage` (the short-page check still terminates; it just costs more round trips).
 */
async function fetchAllPaged(moduleName: string, perPage = 200): Promise<any[]> {
  const out: any[] = [];
  let lastFirstId: unknown;
  for (let page = 1; page <= 50; page++) {
    const res = await facilioApi.fetchAll(moduleName, { page, perPage });
    if (res.error) throw new Error(`facilio-api: ${moduleName} fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    const rows = res.list ?? [];
    if (!rows.length || rows[0]?.id === lastFirstId) break;
    lastFirstId = rows[0]?.id;
    out.push(...rows);
    if (rows.length < perPage) break;
  }
  return out;
}

function sortByName<T extends { name?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { numeric: true }));
}

/** Best-effort lookup-field id extraction: tries `{key}.id`, `{key}Id`, then the raw field. */
function lookupId(record: any, key: string): unknown {
  return record?.[key]?.id ?? record?.[`${key}Id`] ?? record?.[key];
}

/**
 * The single record out of a `fetchRecord`/`createRecord` result, whichever envelope answered.
 *
 * The SDK's `api.*` wrappers pre-unwrap to `res[moduleName]`; dev mode's axios path spreads the
 * raw REST body, which nests it at `res.data[moduleName]`. Reading only one of the two is what
 * made a successful request look like "record not found" — the same mistake that hid every
 * building. Both shapes, one place, so no call site has to remember which mode it is in.
 */
function recordOf<T = any>(res: any, moduleName: string): T | null {
  return (res?.[moduleName] ?? res?.data?.[moduleName] ?? null) as T | null;
}

/**
 * `GET v3/floorplan/getFloorplanDetailsByType` — the real FloorplanAction endpoint, confirmed
 * against a live org. Takes only `floorId` (no `floorPlanType` filter — passing one doesn't
 * narrow the result) and returns EVERY plan type configured for that floor in one call, keyed
 * by `floorPlanType` as a string ("1"=workstation, "2"=locker, "3"=parking). This is what the
 * plan-type switcher needs: which types have a floor plan on this floor, in one round trip,
 * rather than fetching every indoorfloorplan record org-wide and filtering client-side.
 *
 * Note: the records this returns omit `fileId`/`floor`/`building`/`site` (this endpoint's
 * projection is geared at plan customization, not the file) — use `id` from here with
 * `fetchRecord('indoorfloorplan', {id})` if the fileId is needed.
 */
async function fetchFloorplanDetailsByType(floorId: string): Promise<Record<string, any>> {
  const body = await customGet('v3/floorplan/getFloorplanDetailsByType', { floorId });
  if (body?.code !== 0) throw new Error(body?.message || `code ${body?.code ?? '?'}`);
  const plans = body?.data?.indoorFloorPlans ?? {};
  // Over the host bridge this call never appears in the iframe's network tab, so this line is the
  // only evidence it ran — and of what the org answered. An empty map is a floor with no floor
  // plan configured, which otherwise looks identical to the call never happening.
  // eslint-disable-next-line no-console
  console.info(`[facilio-api] getFloorplanDetailsByType(${floorId}) -> plan types: ${Object.keys(plans).join(',') || '(none configured)'}`, body?.data ? '' : `(unexpected body keys: ${Object.keys(body ?? {}).join(',')})`);
  return plans;
}

/**
 * Per-floor memo for the call above — it is the entry point of nearly every real-data path here
 * (getUnits, getFloorPlanSummary, fetchFloorplanImage, ensurePlanGeoreference,
 * saveFloorplanMarkers, ensureRealSpaceRecord), so one floor selection fired it four to six times
 * for an answer that is the same every time: which plan types this floor has, and their record
 * ids. That is the same redundant-fan-out shape as the asset list being fetched twenty times.
 *
 * Only the id set is cached, and only `uploadFloorplanFile` can change it (by creating an
 * `indoorfloorplan` record) — which invalidates explicitly. `ensurePlanGeoreference` mutates the
 * record's geometry, not the set, and every reader fetches the record itself for geometry anyway.
 */
const floorPlanTypeCache = new Map<string, Promise<Record<string, any>>>();

/**
 * Org floor ids are record ids — always numeric. The demo seed's are slugs (`hqA3`), and the app
 * can be sitting on one: it boots on the mock floor and only moves once a real portfolio resolves,
 * and a session whose portfolio never resolves stays there for good.
 *
 * Sending a slug to a floor-scoped endpoint is not a miss, it's a 500 —
 * `getFloorplanDetailsByType?floorId=hqA3` errors rather than answering "no plans". So the id is
 * checked before any such call: the demo floor belongs to the local tier, and this one declines it.
 */
export function isRealFloorId(floorId: string | null | undefined): boolean {
  return !!floorId && /^\d+$/.test(floorId);
}

function getFloorplanDetailsByType(floorId: string): Promise<Record<string, any>> {
  // No plan types for a floor the org doesn't have — and, crucially, no request.
  if (!isRealFloorId(floorId)) return Promise.resolve({});
  let pending = floorPlanTypeCache.get(floorId);
  if (!pending) {
    pending = fetchFloorplanDetailsByType(floorId);
    // A failure must not be cached — the next caller should retry rather than inherit a rejection
    // for the rest of the session.
    pending.catch(() => floorPlanTypeCache.delete(floorId));
    floorPlanTypeCache.set(floorId, pending);
  }
  return pending;
}

/** Drop the memo for a floor whose plan records were just created or changed. */
function invalidateFloorplanDetails(floorId: string): void {
  floorPlanTypeCache.delete(floorId);
}

export interface FloorPlanTypeSummary {
  id: PlanId;
  name: string;
  recordId: number;
}

/**
 * Which plan types are actually configured for ONE floor — called lazily when that floor is
 * selected (not eagerly for the whole portfolio, which would be an N-request fan-out across
 * every floor for data only the current one needs).
 */
export async function getFloorPlanSummary(floorId: string): Promise<FloorPlanTypeSummary[]> {
  if (!isFacilioApiConfigured || !isRealFloorId(floorId)) return [];
  const byType = await getFloorplanDetailsByType(floorId);
  return Object.entries(byType).map(([typeNum, rec]: [string, any]) => ({
    id: PLAN_ID_BY_TYPE[Number(typeNum)] ?? 'custom',
    name: PLAN_NAME_BY_TYPE[Number(typeNum)] ?? 'Plan',
    recordId: rec.id,
  }));
}

/**
 * The uploaded image for a floor+plan-type, fetched via `POST .../v3/floorplan/viewerData`
 * (confirmed against a live org — returns `{indoorfloorplan: {fileId, ...}, marker, spaceZone,
 * floorplanlayers, floorplanMappedmodules}`; only `fileId` is used here).
 *
 * Requested as an ABSOLUTE URL off `apiOrigin` (in dev mode) rather than a path relative to the
 * configured axios baseURL — that baseURL already carries a `/api` suffix (for the generic
 * `v3/modules/...` calls), and this route lives directly off the bare origin, not nested under
 * `/api` — a relative path here doubles into `/api/maintenance/api/...` and 404s. Connected-app
 * mode doesn't need this: `customPost` resolves the path itself via the SDK bridge.
 *
 * `marker`/`spaceZone` in the same response are the real per-unit geometry this app's
 * `getUnits` still declines to render (see the class doc comment) — worth revisiting now that
 * a live shape is confirmed, but out of scope for this change (which only needed the file).
 */
export async function fetchFloorplanImage(floorId: string, planId: PlanId): Promise<string | null> {
  if (!isFacilioApiConfigured || !apiOrigin || !isRealFloorId(floorId)) return null;
  const byType = await getFloorplanDetailsByType(floorId);
  const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
  if (!summary?.id) {
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] fetchFloorplanImage: no ${planId} plan on floor ${floorId} (types present: ${Object.keys(byType).join(',') || 'none'})`);
    return null;
  }

  const viewerBody = await customPost(
    'v3/floorplan/viewerData',
    { floorplanId: summary.id, viewMode: 'ASSIGNMENT' },
    { devAbsoluteUrl: `${apiOrigin}/maintenance/api/v3/floorplan/viewerData` }
  );
  const fileId = viewerBody?.data?.indoorfloorplan?.fileId;
  if (!fileId) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] fetchFloorplanImage: viewerData for plan #${summary.id} carried no fileId (body keys: ${Object.keys(viewerBody?.data ?? viewerBody ?? {}).join(',')})`);
    return null;
  }

  const preview = await fetchFilePreview(fileId, { original: true });
  if (preview.dataUrl) return preview.dataUrl;
  if (!preview.blob) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] fetchFloorplanImage: file ${fileId} yielded no bytes`);
    return null;
  }
  // DWG/DXF/PDF go through the same client-side renderers the upload flow uses; a plain image
  // becomes an object URL. Either way the canvas gets something it can draw.
  const url = await blobToRenderableDataUrl(preview.blob, preview.contentType);
  // eslint-disable-next-line no-console
  console.info(`[facilio-api] fetchFloorplanImage: floor ${floorId}/${planId} -> file ${fileId} (${preview.contentType}) rendered`);
  return url;
}

export interface FloorplanFileUploadResult {
  fileId: number;
  /** Object URL of the ORIGINAL uploaded bytes (a valid <img> src only for plain images). */
  previewUrl: string;
  /**
   * Object URL of Facilio's SERVER-RENDERED preview of the file (`v2/files/preview/{fileId}`
   * without `fetchOriginal`) — a rasterized image for formats the browser can't draw itself
   * (PDF, and DWG/DXF where the server rasterizes CAD). Null when the server returned non-image
   * bytes (i.e. it couldn't render that file). This is what lets a browser-unrenderable DWG still
   * be shown: upload → fileId → server image.
   */
  serverImageUrl: string | null;
  /** False when the fileId couldn't be attached to an `indoorfloorplan` record (e.g. `floorId` isn't a real floor id) — the upload+preview still succeeded. */
  attachedToFloorPlan: boolean;
  attachError?: string;
}

/**
 * Fetch Facilio's server-rendered preview image for a stored file id. `v2/files/preview/{id}`
 * WITHOUT `fetchOriginal` rasterizes supported documents (PDF pages, and CAD where the server
 * renders it) to an image. Returns an object URL only when the response is actually an image;
 * otherwise null (the file isn't server-renderable, so callers fall back). Best-effort.
 */
export async function fetchRenderedFileImage(fileId: number): Promise<string | null> {
  if (!isFacilioApiConfigured) return null;
  try {
    const preview = await fetchFilePreview(fileId);
    if (preview.dataUrl) return preview.dataUrl;
    if (!preview.blob) return null;
    const type = (preview.contentType || preview.blob.type || '').toLowerCase();
    if (type.startsWith('image/')) return URL.createObjectURL(preview.blob);
    return null;
  } catch {
    return null;
  }
}

/**
 * Uploads a floorplan source file (image/PDF/DXF/whatever) to Facilio's real file storage
 * (`POST v3/modules/data/files` in dev mode, `api.uploadFile` in connected-app mode — see
 * `facilioApi.ts`), then attaches that `fileId` to the floor's `indoorfloorplan` record for
 * this `planId` (creating one if it doesn't exist yet). Also fetches the uploaded bytes back
 * for a preview via `fetchFilePreview` (dev: raw blob off `GET v2/files/preview/{fileId}
 * ?fetchOriginal=true`; connected: `common.toBase64`).
 *
 * `indoorfloorplan` requires `floor`/`building`/`site` as `{id}` lookups (not raw ids) plus a
 * `floorPlanType` int (confirmed against a live org: 1=workstation, 2=locker, 3=parking — no
 * generic/custom type). `building`/`site` aren't tracked per-floor in this app's own state, so
 * they're read off the `floor` record itself, which carries both as `{id}` lookups already.
 *
 * The attach step is best-effort and non-fatal: `facilioApi` returns `{error}` rather than
 * throwing on a failed request, so it's checked explicitly rather than trusted to reject —
 * a bad `floorId` (e.g. one that doesn't correspond to a real floor record) fails the attach
 * without discarding the (real, working) uploaded file/preview.
 *
 * `imageDimensions`, when known (the caller already rendered a preview to measure), seeds a
 * synthetic geo-reference quad (`indoorfloorplan.geometry` — see `geoReference.ts`) sized to the
 * image's actual aspect ratio, so `saveFloorplanMarkers` has something to convert this plan's
 * unit-fraction positions against later. Always overwritten on re-upload to stay in sync with
 * whatever image is currently attached.
 */
export async function uploadFloorplanFile(
  floorId: string,
  planId: PlanId,
  file: File,
  imageDimensions?: { width: number; height: number }
): Promise<FloorplanFileUploadResult> {
  if (!isFacilioApiConfigured) throw new Error('facilio-api: not configured');
  if (!isRealFloorId(floorId)) throw new Error(`facilio-api: ${floorId} is not an org floor — nothing to attach a plan to`);

  const uploadRes = await facilioApi.uploadFiles([file]);
  if (uploadRes.error || !uploadRes.ids?.length) {
    throw new Error(uploadRes.error?.message || 'facilio-api: file upload failed');
  }
  const fileId = Number(uploadRes.ids[0]);

  const preview = await fetchFilePreview(fileId, { original: true });
  const previewUrl = preview.dataUrl ?? URL.createObjectURL(preview.blob!);
  // Also grab the server-RENDERED image (no fetchOriginal) — the display source for files the
  // browser can't draw (PDF, DWG/DXF). Null when the server didn't rasterize it.
  const serverImageUrl = await fetchRenderedFileImage(fileId);

  let attachedToFloorPlan = false;
  let attachError: string | undefined;
  try {
    // `fetchRecord`'s resolved value nests the record under `res[moduleName]` (e.g. `res.floor`),
    // NOT `res.data` — confirmed live: `res.data` is always undefined, which silently failed
    // every attach as "floor not found" regardless of whether the floor actually existed.
    const floorRes = await facilioApi.fetchRecord<any>('floor', { id: floorId });
    const floorRec = recordOf<any>(floorRes, 'floor');
    if (floorRes.error || !floorRec) throw new Error(floorRes.error?.message || `floor ${floorId} not found`);
    const siteId = lookupId(floorRec, 'site');
    const buildingId = lookupId(floorRec, 'building');
    if (!siteId || !buildingId) throw new Error('floor record has no site/building lookup');

    const floorPlanType = FLOOR_PLAN_TYPE[planId];
    const geometry = imageDimensions ? quadToGeometryString(computeSyntheticGeometry(imageDimensions.width, imageDimensions.height)) : undefined;
    const existingByType = await getFloorplanDetailsByType(floorId);
    const existing = existingByType[String(floorPlanType)];
    const attachRes = existing
      ? await facilioApi.updateRecord('indoorfloorplan', { id: existing.id, data: { fileId, ...(geometry ? { geometry } : {}) } })
      : await facilioApi.createRecord('indoorfloorplan', {
          data: {
            floor: { id: floorId },
            building: { id: buildingId },
            site: { id: siteId },
            fileId,
            name: file.name,
            floorPlanType,
            ...(geometry ? { geometry } : {}),
          },
        });
    if (attachRes.error) throw new Error(attachRes.error.message || `code ${attachRes.error.code}`);
    // A create adds a plan type to this floor; a geometry update changes what the readers below
    // will find. Either way the memo is now stale.
    invalidateFloorplanDetails(floorId);
    attachedToFloorPlan = true;
  } catch (err) {
    attachError = (err as Error).message || 'attach failed';
  }

  return { fileId, previewUrl, serverImageUrl, attachedToFloorPlan, attachError };
}

/**
 * Syncs this app's placed desks/lockers/parking-stalls (point units only — room/zone polygons
 * need a real `space` module record via `floorplanmarkedzone.space`, which this app doesn't
 * create, so those stay local-only) to real `floorplanmarker` records, confirmed against a live
 * org: required fields are `geoId, geometry, indoorfloorplan, properties, type` (`geoId` doubles
 * as our idempotency key — this app's own stable unit id — so re-saving updates in place instead
 * of duplicating).
 *
 * Skipped per plan-type when `indoorfloorplan.geometry` isn't set yet (no synthetic
 * geo-reference — see `geoReference.ts` — has been computed, e.g. a floor plan uploaded before
 * this existed): there's no sane lng/lat to convert a unit's 0-1 fraction position into, and
 * guessing would silently misplace it rather than fail loudly.
 */
export interface MarkerSaveResult {
  /** Plan types whose markers were actually synced to the org. */
  plansSynced: number;
  /** Plan types skipped, with the reason — surfaced so a silent no-op is never mistaken for a save. */
  skipped: string[];
}

export async function saveFloorplanMarkers(floorId: string, units: Unit[]): Promise<MarkerSaveResult> {
  const result: MarkerSaveResult = { plansSynced: 0, skipped: [] };
  if (!isFacilioApiConfigured) return result;
  if (!isRealFloorId(floorId)) {
    result.skipped.push(`${floorId} is not an org floor — markers stay in this browser`);
    return result;
  }
  const pointUnits = units.filter(
    (u): u is Unit & { geom: PointGeom } => u.geom.kind === 'point' && (u.type === 'workstation' || u.type === 'locker' || u.type === 'parking')
  );
  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);

  const byPlan = new Map<PlanId, (Unit & { geom: PointGeom })[]>();
  for (const u of pointUnits) {
    const list = byPlan.get(u.plan) ?? [];
    list.push(u);
    byPlan.set(u.plan, list);
  }
  const configuredPlanIds = Object.keys(byType)
    .map((t) => PLAN_ID_BY_TYPE[Number(t)])
    .filter((p): p is PlanId => !!p);
  const allPlanIds = new Set<PlanId>([...byPlan.keys(), ...configuredPlanIds]);

  for (const planId of allPlanIds) {
    const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
    if (!summary?.id) {
      result.skipped.push(`${planId}: no plan configured`);
      continue;
    }
    try {
      const synced = await syncMarkersForIndoorFloorPlan(summary.id, byPlan.get(planId) ?? []);
      if (synced) result.plansSynced++;
      else result.skipped.push(`${planId}: plan #${summary.id} has no georeference`);
    } catch (err) {
      result.skipped.push(`${planId}: ${(err as Error)?.message ?? err}`);
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] marker sync failed for plan ${planId}`, err);
    }
  }
  // eslint-disable-next-line no-console
  console.info(`[facilio-api] saveFloorplanMarkers floor ${floorId}: synced ${result.plansSynced} plan(s)` + (result.skipped.length ? `; skipped ${result.skipped.join('; ')}` : ''));
  return result;
}

/**
 * Give a plan the georeference quad this app's marker model needs, if it has none.
 *
 * Plans created in Facilio's own editor arrive with `geometry` empty (7 of this org's 8 do), and
 * without a quad positions can neither be written nor read back — a placement "saved" into
 * nothing and vanished on refresh. The upload flow already seeds a synthetic quad sized to the
 * image; this does the same for plans the app didn't upload, the moment their image renders and
 * the pixel size is known. Idempotent: an existing valid quad is left untouched, so it never
 * re-projects markers that already have one.
 */
export async function ensurePlanGeoreference(floorId: string, planId: PlanId, imageDimensions: { width: number; height: number }): Promise<void> {
  if (!isFacilioApiConfigured || !isRealFloorId(floorId)) return;
  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
  if (!summary?.id) return;
  const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: summary.id });
  const record = recordOf<any>(recordRes, 'indoorfloorplan');
  if (recordRes.error || !record) return;
  if (geometryStringToQuad(record.geometry)) return; // already georeferenced

  // Prefer a quad that fits the markers this plan ALREADY has (placed in Facilio's own editor,
  // which leaves `geometry` null and writes points in a small implicit space around [0,0]).
  // Inventing the synthetic quad over the top of those makes every one of them out-of-frame, so
  // the app shows an empty plan for a floor that really does have desks on it.
  const existing = await facilioApi
    .fetchAllRelatedList<any>({ moduleName: 'indoorfloorplan', id: summary.id, relatedModuleName: 'floorplanmarker', relatedFieldName: 'indoorfloorplan' })
    .then((r) => (r.error ? [] : r.list ?? []))
    .catch(() => [] as any[]);
  const existingPoints = existing.map((m: any) => parsePointGeometry(m.geometry)).filter((p): p is [number, number] => !!p);
  const fitted = quadFittingPoints(existingPoints, imageDimensions.width, imageDimensions.height);
  if (fitted) {
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] plan #${summary.id} has ${existingPoints.length} existing marker(s) — fitting its georeference to them instead of seeding a synthetic quad`);
  }
  const geometry = quadToGeometryString(fitted ?? computeSyntheticGeometry(imageDimensions.width, imageDimensions.height));
  const res = await facilioApi.updateRecord('indoorfloorplan', { id: summary.id, data: { geometry } });
  if (res.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] could not georeference plan #${summary.id}:`, res.error);
    return;
  }
  // eslint-disable-next-line no-console
  console.info(`[facilio-api] georeferenced plan #${summary.id} (${planId}) to ${imageDimensions.width}x${imageDimensions.height} — markers can now be saved and read back`);
}

/**
 * `floorplanmarker.type` — the GeoJSON object kind. Every marker Facilio's own editor wrote in
 * the live org uses "Feature" (the point itself lives in `geometry`); this app wrote "Point",
 * which is not what the platform's floorplan viewer reads. The app never reads this field —
 * `parsePointGeometry` looks at `geometry.type` — so aligning it costs nothing here.
 */
const MARKER_GEOJSON_TYPE = 'Feature';

/**
 * The link from a marker back to the real record it represents: `recordId` plus
 * `markerModuleId` (the module those ids belong to). Both are real fields on `floorplanmarker`,
 * and every marker the org's own editor created sets them — this app set neither, so its markers
 * were orphans: Facilio's floorplan screens could not resolve them to a desk/locker/stall, and
 * `getUnits`' placed-vs-unplaced reconciliation (which matches on `recordId`) never matched.
 *
 * A unit backed by a real record carries that record's id as its own `unit.id` (createUnit
 * returns it, and pool records arrive with it), so a numeric id IS the record id. App-local ids
 * like `u1699…` are not, and get no link rather than a fabricated one.
 */
async function markerRecordLink(unit: Unit): Promise<{ recordId?: number; markerModuleId?: number }> {
  const moduleName = REAL_SPACE_MODULE[unit.type];
  const recordId = Number(unit.id);
  if (!moduleName || !Number.isInteger(recordId) || recordId <= 0) return {};
  const markerModuleId = await moduleIdFor(moduleName, recordId).catch(() => null);
  return markerModuleId ? { recordId, markerModuleId } : { recordId };
}

/** Returns false when the plan has no georeference and nothing could be written. */
async function syncMarkersForIndoorFloorPlan(indoorFloorPlanId: number, units: (Unit & { geom: PointGeom })[]): Promise<boolean> {
  const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: indoorFloorPlanId });
  const record = recordOf<any>(recordRes, 'indoorfloorplan');
  if (recordRes.error || !record) return false;
  const quad = geometryStringToQuad(record.geometry);
  if (!quad) return false;

  const existingRes = await facilioApi.fetchAllRelatedList<any>({
    moduleName: 'indoorfloorplan',
    id: indoorFloorPlanId,
    relatedModuleName: 'floorplanmarker',
    relatedFieldName: 'indoorfloorplan',
  });
  if (existingRes.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] fetching existing markers failed for plan ${indoorFloorPlanId}`, existingRes.error);
    throw new Error('marker list unavailable'); // bail rather than risk duplicates against a list we couldn't verify
  }
  const existing = existingRes.list ?? [];
  const existingByGeoId = new Map(existing.map((m) => [m.geoId, m]));
  const seenGeoIds = new Set<string>();

  for (const unit of units) {
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const geometry = JSON.stringify({ type: 'Point', coordinates: [lng, lat] });
    const properties = JSON.stringify({ unitType: unit.type, secondary: unit.secondary ?? null });
    const link = await markerRecordLink(unit);
    seenGeoIds.add(unit.id);
    const match = existingByGeoId.get(unit.id);
    if (match) {
      const linkMissing = link.recordId != null && (match.recordId == null || match.markerModuleId == null);
      if (match.geometry !== geometry || match.label !== unit.label || linkMissing) {
        // `facilioApi` resolves (doesn't reject) on a failed request — the failure shows up
        // as `res.error`, not a rejected promise, so a bare `.catch()` here would never catch
        // a real validation error; check `.error` explicitly and log it instead.
        const res = await facilioApi.updateRecord('floorplanmarker', {
          id: match.id,
          data: { geometry, properties, label: unit.label, type: MARKER_GEOJSON_TYPE, ...link },
        });
        if (res.error) {
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] marker update failed for unit ${unit.id}`, res.error);
        }
      }
    } else {
      const res = await facilioApi.createRecord('floorplanmarker', {
        data: { geoId: unit.id, geometry, properties, type: MARKER_GEOJSON_TYPE, label: unit.label, indoorfloorplan: { id: indoorFloorPlanId }, ...link },
      });
      if (res.error) {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] marker create failed for unit ${unit.id}`, res.error);
      }
    }
  }
  for (const m of existing) {
    if (m.geoId && !seenGeoIds.has(m.geoId)) {
      const res = await facilioApi.deleteRecord('floorplanmarker', m.id);
      if (res.error) {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] marker delete failed for id ${m.id}`, res.error);
      }
    }
  }
  return true;
}

/**
 * Real module a placed unit's employee-assignment backs onto, confirmed against a live org.
 * Desks use `moves` — Lockers/Parking Stall are a plain `employee` field update with no move
 * record (confirmed via the org's own module docs: "Moves are the reassignment mechanism for
 * Desks only").
 */
const REAL_SPACE_MODULE: Partial<Record<Unit['type'], string>> = {
  workstation: 'desks',
  locker: 'lockers',
  parking: 'parkingstall',
};

interface RealSpaceRef {
  recordId: number;
  /** The floor's site id — sent on `moves` records to match the real web app's payload shape. */
  siteId?: number;
}

/**
 * `unit.id` -> real desks/lockers/parkingstall record ref, once resolved. Assign/vacate are
 * booking-adjacent actions the user can repeat often (reassign, then vacate, then reassign) —
 * without this, EVERY one of those re-ran the full indoorfloorplan+marker-list lookup below just
 * to re-derive the same id. Cleared on full page reload only (session-lifetime cache); that's
 * fine since a unit's backing record never changes once created.
 */
const realSpaceRecordCache = new Map<string, RealSpaceRef>();

/**
 * Finds the real desks/lockers/parkingstall record backing a placed unit — joined via the
 * unit's `floorplanmarker.recordId` (set here the first time a unit is actually assigned; units
 * that are never assigned never get a real space record, only their marker). If the marker
 * itself doesn't exist yet — the normal case when a unit was just placed and assigned BEFORE
 * hitting "Save changes" (marker sync is deliberately save-only) — it's created inline here, so
 * an assignment always produces its Move/desk record instead of silently skipping.
 */
async function ensureRealSpaceRecord(unit: Unit): Promise<RealSpaceRef | null> {
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return null;
  const cached = realSpaceRecordCache.get(unit.id);
  if (cached) return cached;

  const byType = await getFloorplanDetailsByType(unit.floor).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(FLOOR_PLAN_TYPE[unit.plan])];
  if (!summary?.id) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] no configured floor plan for unit ${unit.id} (${unit.plan} on floor ${unit.floor}) — assignment not persisted to backend`);
    return null;
  }

  const markersRes = await facilioApi.fetchAllRelatedList<any>({
    moduleName: 'indoorfloorplan',
    id: summary.id,
    relatedModuleName: 'floorplanmarker',
    relatedFieldName: 'indoorfloorplan',
  });
  if (markersRes.error) return null;
  let marker = (markersRes.list ?? []).find((m) => m.geoId === unit.id);

  if (!marker) {
    if (unit.geom.kind !== 'point') return null;
    const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: summary.id });
    const quad = geometryStringToQuad(recordOf<any>(recordRes, 'indoorfloorplan')?.geometry);
    if (!quad) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] floor plan ${summary.id} has no geo-reference — assignment for unit ${unit.id} not persisted to backend`);
      return null;
    }
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const createMarkerRes = await facilioApi.createRecord<any>('floorplanmarker', {
      data: {
        geoId: unit.id,
        geometry: JSON.stringify({ type: 'Point', coordinates: [lng, lat] }),
        properties: JSON.stringify({ unitType: unit.type, secondary: unit.secondary ?? null }),
        type: MARKER_GEOJSON_TYPE,
        label: unit.label,
        indoorfloorplan: { id: summary.id },
        ...(await markerRecordLink(unit)),
      },
    });
    const createdMarker = recordOf<any>(createMarkerRes, 'floorplanmarker');
    if (createMarkerRes.error || !createdMarker?.id) return null;
    marker = createdMarker;
  }

  const floorRes = await facilioApi.fetchRecord<any>('floor', { id: unit.floor });
  const floorRec = recordOf<any>(floorRes, 'floor');
  if (floorRes.error || !floorRec) return null;
  const siteId = Number(lookupId(floorRec, 'site')) || undefined;
  const buildingId = lookupId(floorRec, 'building');

  if (marker.recordId) {
    const ref = { recordId: marker.recordId, siteId };
    realSpaceRecordCache.set(unit.id, ref);
    return ref;
  }

  const createRes = await facilioApi.createRecord<any>(moduleName, {
    data: { name: unit.label, site: { id: siteId }, building: { id: buildingId }, floor: { id: unit.floor } },
  });
  const createdSpace = recordOf<any>(createRes, moduleName);
  if (createRes.error || !createdSpace?.id) return null;
  const recordId = createdSpace.id;
  // `markerModuleId` alongside `recordId` — the pair is what the platform's own markers carry, and
  // a recordId without the module it belongs to is not resolvable.
  const markerModuleId = await moduleIdFor(moduleName, recordId).catch(() => null);
  await facilioApi
    .updateRecord('floorplanmarker', { id: marker.id, data: { recordId, ...(markerModuleId ? { markerModuleId } : {}) } })
    .catch(() => {});
  const ref = { recordId, siteId };
  realSpaceRecordCache.set(unit.id, ref);
  return ref;
}

/**
 * Which site and building a floor sits under, straight off the floor record.
 *
 * The portfolio tree loads one level at a time, so nothing below the sites exists at boot. To
 * open on a floor that isn't the first one (the user's own desk, say) the tree has to be told
 * that floor's path first — and the floor record is the authoritative source for it.
 */
export async function fetchFloorPath(floorId: string): Promise<{ siteId: string | null; buildingId: string | null } | null> {
  if (!isFacilioApiConfigured || !isRealFloorId(floorId)) return null;
  const res = await facilioApi.fetchRecord<any>('floor', { id: floorId });
  const rec = recordOf<any>(res, 'floor');
  if (res.error || !rec) return null;
  const siteId = lookupId(rec, 'site');
  const buildingId = lookupId(rec, 'building');
  return { siteId: siteId != null ? String(siteId) : null, buildingId: buildingId != null ? String(buildingId) : null };
}

/**
 * Which org module holds a unit's record. Wider than `REAL_SPACE_MODULE` (which is about where an
 * ASSIGNMENT lands): zones are real `space` records too, they just aren't assignable.
 */
const RECORD_MODULE: Partial<Record<UnitType, string>> = {
  workstation: 'desks',
  locker: 'lockers',
  parking: 'parkingstall',
  room: 'space',
  delivery: 'space',
};

/**
 * The fields worth surfacing per module, in display order. Every name here is the org's own
 * (`Fields.NAME`, read off this org's metadata) — nothing invented, and anything the record leaves
 * empty is dropped rather than shown blank.
 */
const RECORD_FIELDS: Record<string, { name: string; label: string }[]> = {
  desks: [
    { name: 'deskCode', label: 'Desk code' },
    { name: 'department', label: 'Department' },
    { name: 'isActive', label: 'Active' },
  ],
  lockers: [],
  parkingstall: [
    { name: 'parkingType', label: 'Parking type' },
    { name: 'parkingMode', label: 'Parking mode' },
  ],
  space: [
    { name: 'spaceCategory', label: 'Category' },
    { name: 'area', label: 'Area' },
    { name: 'maxOccupancy', label: 'Capacity' },
    { name: 'reservable', label: 'Reservable' },
  ],
};

/** On the space base module, so every type above can carry them. */
const COMMON_RECORD_FIELDS: { name: string; label: string }[] = [{ name: 'approvalStatus', label: 'Approval' }];

/**
 * A V3 field value as a display string, or null when there is nothing to show. Lookups arrive as
 * objects, picklists as either a label or a raw id, booleans as booleans — all of which have to
 * render as text without inventing a value for an empty field.
 */
function formatFieldValue(raw: unknown): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const name = o.displayName ?? o.name ?? o.value ?? o.label;
    return typeof name === 'string' && name ? name : null;
  }
  return null;
}

export interface UnitRecordInfo {
  /** The record's own state, from its stateflow — distinct from the app's occupancy view of it. */
  status: string | null;
  /**
   * The record's `employee` — who the ORG says holds this desk/locker/stall. First-class rather
   * than one row among many: it is what "Assigned to" means, and the app's own assignment map is
   * only a local view of it.
   */
  employee: string | null;
  fields: { label: string; value: string }[];
}

/** Session cache: a record's details don't change while you look at them, and the popover reopens a lot. */
const unitRecordCache = new Map<string, Promise<UnitRecordInfo | null>>();

/**
 * The org record a unit stands for — module name plus numeric id — or null when there isn't one
 * (an amenity, or a unit whose id is still app-local because nothing created it in the org yet).
 * Stateflow, approvals and the record read all need exactly this pair.
 */
export function resolveUnitRecord(unit: Pick<Unit, 'id' | 'type'>): { moduleName: string; recordId: number } | null {
  const moduleName = RECORD_MODULE[unit.type];
  const recordId = Number(unit.id);
  if (!moduleName || !Number.isInteger(recordId) || recordId <= 0) return null;
  return { moduleName, recordId };
}

/** Forget a cached record — after a transition, its state is exactly what changed. */
export function invalidateUnitRecordInfo(unit: Pick<Unit, 'id' | 'type'>): void {
  const ref = resolveUnitRecord(unit);
  if (ref) unitRecordCache.delete(`${ref.moduleName}:${ref.recordId}`);
}

/**
 * The org record behind a placed unit — its state and the fields the org actually filled in.
 *
 * The popover could only ever show what this app carries on a Unit (label, type, deskType), which
 * is a fraction of the record and says nothing about its STATE. This reads the record itself.
 */
export function fetchUnitRecordInfo(unit: Pick<Unit, 'id' | 'type'>): Promise<UnitRecordInfo | null> {
  const ref = resolveUnitRecord(unit);
  if (!isFacilioApiConfigured || !ref) return Promise.resolve(null);
  const { moduleName, recordId: id } = ref;

  const key = `${moduleName}:${id}`;
  let pending = unitRecordCache.get(key);
  if (!pending) {
    pending = facilioApi
      .fetchRecord<any>(moduleName, { id })
      .then((res) => {
        const rec = recordOf<any>(res, moduleName);
        if (res.error || !rec) return null;
        const specs = [...(RECORD_FIELDS[moduleName] ?? []), ...COMMON_RECORD_FIELDS];
        const fields = specs
          .map((f) => ({ label: f.label, value: formatFieldValue(rec[f.name]) }))
          .filter((f): f is { label: string; value: string } => f.value !== null);
        return { status: formatFieldValue(rec.moduleState), employee: formatFieldValue(rec.employee), fields };
      })
      .catch(() => null);
    // A failed read shouldn't be cached as "this record has nothing".
    pending.then((v) => {
      if (!v) unitRecordCache.delete(key);
    });
    unitRecordCache.set(key, pending);
  }
  return pending;
}

export interface MyDeskInfo {
  recordId: number;
  name: string;
  floorId: string | null;
  /** True when this came from `bookedDesks` (a hot-desk booking) rather than a permanent assignment. */
  booked: boolean;
}

/**
 * The logged-in user's assigned (or booked) desk, via the employee portal's own home endpoint:
 * `GET maintenance/api/v2/servicePortalHome?fetchOnlyDesk=true&count=1[&recordId={employeeId}]`
 * (captured from a live portal session). Without `recordId` the backend resolves the employee
 * from the session user. Returns null when the user has no desk or the endpoint isn't
 * accessible for the current token.
 */
export async function fetchMyDesk(employeeId?: number): Promise<MyDeskInfo | null> {
  if (!isFacilioApiConfigured || !apiOrigin) return null;
  const body = await customGet(
    'v2/servicePortalHome',
    { fetchOnlyDesk: true, count: 1, ...(employeeId ? { recordId: employeeId } : {}) },
    { devAbsoluteUrl: `${apiOrigin}/maintenance/api/v2/servicePortalHome` }
  );
  const result = body?.result;
  const assigned = result?.desks?.[0];
  const bookedDesk = result?.bookedDesks?.[0];
  const desk = assigned ?? bookedDesk;
  if (!desk?.id) return null;
  const floorId = desk.floorId ?? desk.floor?.id;
  return { recordId: desk.id, name: desk.name ?? 'Your desk', floorId: floorId != null ? String(floorId) : null, booked: !assigned };
}

/**
 * Maps a real desk record back to this app's own unit id, via the floor's workstation-plan
 * markers (`marker.recordId` -> `marker.geoId`, which is the local unit id for markers this app
 * created). Returns null for desks placed outside this app (no geoId convention) — callers fall
 * back to just navigating to the floor.
 */
export async function findUnitIdForDeskRecord(floorId: string, deskRecordId: number): Promise<string | null> {
  if (!isFacilioApiConfigured || !isRealFloorId(floorId)) return null;
  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);
  const summary = byType[String(FLOOR_PLAN_TYPE.workstation)];
  if (!summary?.id) return null;
  const markersRes = await facilioApi.fetchAllRelatedList<any>({
    moduleName: 'indoorfloorplan',
    id: summary.id,
    relatedModuleName: 'floorplanmarker',
    relatedFieldName: 'indoorfloorplan',
  });
  if (markersRes.error) return null;
  const marker = (markersRes.list ?? []).find((m) => m.recordId === deskRecordId);
  return marker?.geoId ?? null;
}

/**
 * Assigns an employee to a placed workstation/locker/parking-stall for real, confirmed
 * against a live org: for desks, creates a `moves` record (`to` + `employee`, `timeOfMove`
 * at-or-before now so the reassignment executes immediately — the backend auto-unassigns
 * whatever desk that employee previously held, per the org's documented Moves flow); for
 * lockers/parking stalls, a plain `employee` field update (no Moves involvement there).
 *
 * The moves payload mirrors the real web app's, captured from a live session:
 * `{to, timeOfMove, employee, scheduledTime: null, moveType: 1, siteId}`.
 */
export async function assignUnitReal(unit: Unit, contactId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const id = Number(contactId);
  if (!Number.isFinite(id)) return; // mock employee ids (e.g. "c1") aren't real backend ids.

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;

  if (unit.type === 'workstation') {
    const res = await facilioApi.createRecord('moves', {
      data: {
        to: { id: ref.recordId },
        timeOfMove: Date.now(),
        employee: { id },
        scheduledTime: null,
        moveType: 1,
        ...(ref.siteId ? { siteId: ref.siteId } : {}),
      },
    });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] assign move failed for unit ${unit.id}`, res.error);
    }
  } else {
    const res = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { employee: { id } } });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] assign update failed for unit ${unit.id}`, res.error);
    }
  }
}

/**
 * Vacates a placed workstation/locker/parking-stall for real — for desks, a `moves` record with
 * only `from` set (confirmed live: clears the desk's `employee` field); for lockers/parking
 * stalls, clears the `employee` field directly.
 */
export async function vacateUnitReal(unit: Unit, contactId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const id = Number(contactId);
  if (!Number.isFinite(id)) return;

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;

  if (unit.type === 'workstation') {
    const res = await facilioApi.createRecord('moves', {
      data: {
        from: { id: ref.recordId },
        timeOfMove: Date.now(),
        employee: { id },
        scheduledTime: null,
        moveType: 1,
        ...(ref.siteId ? { siteId: ref.siteId } : {}),
      },
    });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] vacate move failed for unit ${unit.id}`, res.error);
    }
  } else {
    const res = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { employee: null } });
    if (res.error) {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] vacate update failed for unit ${unit.id}`, res.error);
    }
  }
}

/** moduleName -> its numeric moduleId (spacebooking's `parentModuleId`). Session cache. */
const moduleIdCache = new Map<string, number>();
async function moduleIdFor(moduleName: string, sampleRecordId: number): Promise<number | null> {
  const cached = moduleIdCache.get(moduleName);
  if (cached) return cached;
  const res = await facilioApi.fetchRecord<any>(moduleName, { id: sampleRecordId });
  const id = recordOf<any>(res, moduleName)?.moduleId;
  if (typeof id === 'number') moduleIdCache.set(moduleName, id);
  return typeof id === 'number' ? id : null;
}

/** (dateISO, minutesFromMidnight) -> epoch millis in the browser's local timezone. */
function epochAt(dateISO: string, minutes: number): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
}

/** Which spacebooking lookup field carries the booked resource, per real module. */
const SPACEBOOKING_LOOKUP: Record<string, string> = { desks: 'desk', parkingstall: 'parkingStall' };

export interface RealBookingResult {
  ok: boolean;
  reason?: string;
  id?: number;
}

/**
 * Creates a booking in the real Facilio backend for a placed unit, routed by the org's booking
 * module setting:
 *
 * - `space`  -> `spacebooking` (confirmed live): `{[desk|parkingStall]:{id}, parentModuleId,
 *   bookingStartTime, bookingEndTime, reservedBy/host/internalAttendees, noOfAttendees, name}`.
 *   The unit must resolve to a real desks/parkingstall record (via `ensureRealSpaceRecord`, i.e.
 *   a real geo-referenced floor with a synced marker) — on mock/unmapped floors this returns
 *   `{ok:false}` and the caller keeps only the local booking.
 * - `facility` -> `facilitybooking`. Facility bookings are SLOT-based (a `facility` record with
 *   generated slots), which this app doesn't yet provision, so this is a marked TODO that returns
 *   `{ok:false, reason}` for now rather than posting an invalid record.
 *
 * Best-effort and non-fatal: the caller always saves locally regardless (see the
 * `LOCAL-BOOKING-FALLBACK` markers in FloorplanContext) — this is the forward path that should
 * become the source of truth once every floor is real-backed.
 */
export interface RealBookingInput {
  module: 'space' | 'facility';
  name?: string;
  description?: string;
  host?: string;
  reservedBy?: string;
  noOfAttendees?: number;
  internalAttendees?: string[];
  externalAttendees?: string[];
  /** The org form the booking was filled through (v2/forms) — stored on the record so backend form rules apply. */
  formId?: number;
  /** Values of org-form fields this app doesn't model natively — passed through verbatim. */
  extras?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Org booking forms (v2/forms): the booking modal renders the org's ACTUAL
// configured form for spacebooking / facilitybooking instead of a hardcoded
// field list. Forms are per resource type (e.g. default_deskbooking_web_* for
// desks), so resolution is (module, unit type) -> formId, then a detail fetch
// for the section fields. Ids are org-specific — never hardcode them.
// ---------------------------------------------------------------------------

export interface BookingFormFieldMeta {
  name: string;
  label: string;
  required: boolean;
  /** Facilio displayTypeEnum: TEXTBOX / TEXTAREA / NUMBER / DATETIME / LOOKUP_SIMPLE / MULTI_LOOKUP / … */
  type: string;
  /** Lookup target module (people, desks, space, …) when the field is a lookup. */
  lookupModule?: string;
  sequence: number;
}

export interface BookingFormMeta {
  id: number;
  name: string;
  displayName: string;
  moduleName: 'spacebooking' | 'facilitybooking';
  fields: BookingFormFieldMeta[];
}

/** Form-name preferences per module + unit type (system form names follow these patterns). */
const FORM_NAME_PREFERENCE: Record<'spacebooking' | 'facilitybooking', Partial<Record<UnitType | 'default', RegExp[]>>> = {
  spacebooking: {
    workstation: [/deskbooking/i],
    parking: [/parkingbooking/i],
    default: [/default_spacebooking/i, /spacebooking/i],
  },
  facilitybooking: {
    workstation: [/hot_desk/i],
    parking: [/parkingbooking/i],
    room: [/^space_/i],
    default: [/default_facilitybooking/i],
  },
};

export interface BookingFormSummary {
  id: number;
  name: string;
  displayName: string;
  hideInList?: boolean | null;
}

/** The module's default form for a unit type — what the modal auto-selects before any switching. */
export function pickDefaultBookingForm(forms: BookingFormSummary[], module: 'space' | 'facility', unitType: UnitType): BookingFormSummary | null {
  if (forms.length === 0) return null;
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  const prefs = FORM_NAME_PREFERENCE[moduleName];
  const patterns = [...(prefs[unitType] ?? []), ...(prefs.default ?? [])];
  for (const re of patterns) {
    const hit = forms.find((f) => re.test(f.name ?? ''));
    if (hit) return hit;
  }
  return forms[0];
}

const bookingFormListCache = new Map<string, Promise<BookingFormSummary[]>>();
const bookingFormDetailCache = new Map<string, Promise<BookingFormMeta | null>>();

/**
 * All of the module's forms (`v2/forms?moduleName=`) — the modal's switcher when there's more
 * than one. Cached per module for the session; resolves [] when unconfigured or on API failure
 * so the modal can fall back to its built-in field list.
 */
export function fetchBookingFormList(module: 'space' | 'facility'): Promise<BookingFormSummary[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  let pending = bookingFormListCache.get(moduleName);
  if (!pending) {
    // v2/forms answers the plain {responseCode, result} envelope — customGet returns the body verbatim.
    pending = customGet('v2/forms', { moduleName })
      .then((body: { result?: { forms?: BookingFormSummary[] } }) => (body?.result?.forms ?? []).filter((f) => !f.hideInList))
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[facilio-api] booking form list fetch failed', err);
        bookingFormListCache.delete(moduleName); // transient failure — allow a retry on next open
        return [];
      });
    bookingFormListCache.set(moduleName, pending);
  }
  return pending;
}

/** One form's field layout (`v2/forms/getForm`), cached per form for the session. */
export function fetchBookingFormById(module: 'space' | 'facility', formId: number): Promise<BookingFormMeta | null> {
  if (!isFacilioApiConfigured) return Promise.resolve(null);
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  const key = `${moduleName}:${formId}`;
  let pending = bookingFormDetailCache.get(key);
  if (!pending) {
    pending = loadBookingFormDetail(module, moduleName, formId).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[facilio-api] booking form fetch failed', err);
      bookingFormDetailCache.delete(key); // transient failure — allow a retry on next open
      return null;
    });
    bookingFormDetailCache.set(key, pending);
  }
  return pending;
}

/** Convenience: the default form for a module + unit type, fields included. */
export async function fetchBookingForm(module: 'space' | 'facility', unitType: UnitType): Promise<BookingFormMeta | null> {
  const forms = await fetchBookingFormList(module);
  const chosen = pickDefaultBookingForm(forms, module, unitType);
  return chosen ? fetchBookingFormById(module, chosen.id) : null;
}

async function loadBookingFormDetail(module: 'space' | 'facility', moduleName: 'spacebooking' | 'facilitybooking', formId: number): Promise<BookingFormMeta | null> {
  const detailBody = await customGet('v2/forms/getForm', { formId, moduleName });
  const form = detailBody?.result?.form;
  if (!form) {
    // Detail endpoint came back empty — keep the id usable with the list's naming.
    const summary = (await fetchBookingFormList(module)).find((f) => f.id === formId);
    return summary ? { id: summary.id, name: summary.name, displayName: summary.displayName, moduleName, fields: [] } : null;
  }

  interface RawFormField {
    displayName?: string;
    fieldName?: string;
    required?: boolean;
    sequenceNumber?: number;
    displayTypeEnum?: string;
    field?: { name?: string; displayName?: string; displayTypeEnum?: string; lookupModule?: { name?: string } };
  }
  const fields: BookingFormFieldMeta[] = ((form.sections ?? []) as { fields?: RawFormField[] }[])
    .flatMap((s) => s.fields ?? [])
    .map((ff) => ({
      name: ff.field?.name ?? ff.fieldName ?? '',
      label: ff.displayName ?? ff.field?.displayName ?? '',
      required: !!ff.required,
      type: ff.displayTypeEnum ?? ff.field?.displayTypeEnum ?? 'TEXTBOX',
      lookupModule: ff.field?.lookupModule?.name,
      sequence: ff.sequenceNumber ?? 0,
    }))
    .filter((f) => f.name)
    .sort((a, b) => a.sequence - b.sequence);

  return { id: form.id, name: form.name, displayName: form.displayName, moduleName, fields };
}

/** Numeric backend ids only — mock ids like "c1" aren't real employees and are dropped. */
function realIds(ids?: string[]): { id: number }[] {
  return (ids ?? []).map(Number).filter(Number.isFinite).map((id) => ({ id }));
}

export async function createRealBooking(unit: Unit, dateISO: string, start: number, end: number, input: RealBookingInput): Promise<RealBookingResult> {
  if (!isFacilioApiConfigured) return { ok: false, reason: 'not configured' };

  if (input.module === 'facility') {
    // TODO(real-facility-booking): facilitybooking needs a `facility` record + a generated slot
    // (facility.slotDuration / slotGeneratedUpto) and books by slot, not arbitrary start/end.
    // Provisioning facilities + resolving the slot for a window is out of scope until the
    // facility layer is wired; skip cleanly so the local booking still stands.
    return { ok: false, reason: 'facility booking requires slot provisioning (not yet wired)' };
  }

  const lookupField = SPACEBOOKING_LOOKUP[REAL_SPACE_MODULE[unit.type] ?? ''];
  if (!lookupField) return { ok: false, reason: `no spacebooking mapping for ${unit.type}` };

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return { ok: false, reason: 'no real backend record for this unit' };

  const moduleName = REAL_SPACE_MODULE[unit.type]!;
  const parentModuleId = await moduleIdFor(moduleName, ref.recordId);
  if (!parentModuleId) return { ok: false, reason: 'could not resolve parentModuleId' };

  const reservedBy = Number(input.reservedBy);
  const host = Number(input.host);
  const internal = realIds(input.internalAttendees);
  // spacebooking requires at least one internal attendee — default to the reserver when the
  // form left it empty (matches how the real form auto-adds the reserver).
  if (Number.isFinite(reservedBy) && !internal.some((a) => a.id === reservedBy)) internal.unshift({ id: reservedBy });

  const res = await facilioApi.createRecord<any>('spacebooking', {
    data: {
      // Unknown org-form fields first, so the mapped fields below always win on collision.
      ...(input.extras ?? {}),
      // Route the create through the org form the user filled — backend form rules apply.
      ...(input.formId ? { formId: input.formId } : {}),
      [lookupField]: { id: ref.recordId },
      parentModuleId,
      bookingStartTime: epochAt(dateISO, start),
      bookingEndTime: epochAt(dateISO, end),
      noOfAttendees: input.noOfAttendees && input.noOfAttendees > 0 ? input.noOfAttendees : Math.max(1, internal.length),
      name: input.name || `${unit.label} booking`,
      ...(input.description ? { description: input.description } : {}),
      externalAttendees: realIds(input.externalAttendees),
      internalAttendees: internal,
      ...(Number.isFinite(reservedBy) ? { reservedBy: { id: reservedBy } } : {}),
      ...(Number.isFinite(host) ? { host: { id: host } } : {}),
    },
  });
  if (res.error) return { ok: false, reason: res.error.message || `code ${res.error.code}` };
  return { ok: true, id: recordOf<any>(res, 'spacebooking')?.id };
}
