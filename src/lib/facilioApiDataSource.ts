import { apiOrigin, customGet, customPost, facilioApi, fetchFilePreview, isFacilioApiConfigured } from './facilioApi';
import type { FacilioApiListResult } from './facilioApi';
import { renderCadToDataUrl } from './cadPreview';
import { executeStateTransition, fetchAvailableStates, findCancelTransition, runAssignTransition } from './stateflowApi';
import { epochAtInTz, isValidTimezone, setOrgTimezone } from './orgTime';
import { bookingSegmentsFromRow, cancelledStateIdOf, clipSegmentsToRange, isoPlusDays } from './bookingRows';
import type { SpaceBookingRow } from './bookingRows';
import { renderPdfToDataUrl } from './pdfPreview';
import { computeSyntheticGeometry, geometryStringToQuad, lngLatToQuadFraction, quadFittingPoints, quadToGeometryString, quadToLngLat } from './geoReference';
import type { CreateSpaceLoc, FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import { isRoomLike, TYPE_META } from './types';
import { ROOM_OUTLINE_WRITES } from './featureFlags';
import type { Assignments, Booking, Building, Employee, Floor, FloorSearchHit, PlanId, PointGeom, PolyGeom, Site, Unit, UnitType } from './types';
import { buildEmployeeFilters, mapFilterFields } from './employeeFilters';
import { byDepartmentName, byPersonName } from './displayNames';
import type { AppliedFilter, FilterFieldDef } from './employeeFilters';

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
 * for plans created in Facilio's editor, which arrive without one. Room OUTLINES live in
 * `floorplanmarkedzone` (Polygon) records in the same georeferenced frame: `getUnits` reads them as
 * placed rooms, and the same chokepoint writes them back (`saveFloorplanZones`) — only once
 * `ROOM_OUTLINE_WRITES` (featureFlags.ts) is on; it ships off, so for now outlines are read-only.
 *
 * Still not wired here: assignments (Moves-derived —
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
    const res = await fetchAllRelatedPaged<any>({ moduleName: 'site', id: siteId, relatedModuleName: 'building', relatedFieldName: 'site' });
    if (res.error) throw new Error(`facilio-api: buildings for site ${siteId} failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return sortByName(res.list ?? []).map((b: any) => ({ id: String(b.id), name: b.name }));
  }

  async getFloors(buildingId: string): Promise<Floor[]> {
    this.assertConfigured();
    const res = await fetchAllRelatedPaged<any>({ moduleName: 'building', id: buildingId, relatedModuleName: 'floor', relatedFieldName: 'building' });
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

    // ASK THE ORG first. This used to go straight to the in-memory index below because the
    // contains operator's id could not be confirmed; it can now (5 — see CONTAINS), so the
    // question goes to the server, where the answer actually lives. A floor added since this tab
    // opened is findable, and nothing has to be pulled down to look for it.
    const live = await facilioApi
      .fetchAll('floor', { filters: containsFilter(['name'], query.trim()), perPage: 50 })
      .then((r) => (r.error ? null : r.list))
      .catch(() => null);
    if (live && live.length) {
      const hits = await hydrateFloorHits(live);
      if (hits.length) return hits;
    }

    // The index remains the fallback: an org whose floors are named only inside their building
    // ("3" under "Building A") answers nothing useful to a name filter, and matching locally on
    // the building and site names still finds it.
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
    console.info(`[facilio-api] getEmployees: ${rows.length} employees`, rows[0] ? `(fields seen: ${Object.keys(rows[0]).join(', ')})` : '');
    return rows.map(mapEmployee).sort(byPersonName);
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
   *
   * Each plan's room outlines (`floorplanmarkedzone`) are read in the same pass and the same way —
   * first page now, the rest through `onMore` — and become placed rooms (see buildFloorUnits). A
   * zone list that fails is logged and the floor loads without outlines (see loadPlanZones).
   *
   * Which org rooms this read produced is recorded per floor (see orgRoomIdsByFloor) — cleared
   * here before anything is awaited, so a read that fails part-way leaves nothing from an earlier
   * one behind for the save path to act on.
   */
  async getUnits(floorId: string, onMore?: (units: Unit[]) => void): Promise<Unit[]> {
    this.assertConfigured();
    // Throw rather than return [] — a demo floor's units belong to the local tier, and the
    // composite only falls through on a rejection. Returning empty would strand the canvas.
    if (!isRealFloorId(floorId)) throw new Error(`facilio-api: ${floorId} is not an org floor id`);
    orgRoomIdsByFloor.delete(floorId);
    roomOutlineReadFailures.delete(floorId);

    // Everything the floor needs, asked for at once: the floor's desks, lockers, stalls and spaces
    // (started before anything is awaited, so getAssignments — asked for alongside — shares these
    // requests rather than repeating them), and each plan type's record (for its georeference) and
    // markers. Each list answers with its first page and its count straight away; the rest of a big
    // list follows in the background.
    const listsP = Promise.all(['desks', 'lockers', 'parkingstall', 'space'].map((m) => loadFloorList(floorId, m)));
    const byType = await getFloorplanDetailsByType(floorId);
    const plansP = Promise.all(
      Object.entries(byType).map(async ([typeNum, summary]) => {
        const planId = PLAN_ID_BY_TYPE[Number(typeNum)];
        const planRecordId = (summary as any)?.id;
        if (!planId || !planRecordId) return null;
        const [recordRes, markers, zones] = await Promise.all([
          facilioApi.fetchRecord<any>('indoorfloorplan', { id: planRecordId }),
          loadRelated<any>({ moduleName: 'indoorfloorplan', id: planRecordId, relatedModuleName: 'floorplanmarker', relatedFieldName: 'indoorfloorplan' }),
          loadPlanZones(planRecordId),
        ]);
        const quad = geometryStringToQuad(recordOf<any>(recordRes, 'indoorfloorplan')?.geometry);
        if (!quad) {
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] getUnits: plan ${planId} (#${planRecordId}) has no calibrated geometry — its markers are skipped, not guessed`);
          return null;
        }
        if (markers.error) {
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] getUnits: marker list failed for plan ${planId} (#${planRecordId}):`, markers.error);
          return null;
        }
        // eslint-disable-next-line no-console
        console.info(
          `[facilio-api] getUnits: plan ${planId} (#${planRecordId}) -> ${markers.first.length}${markers.hasMore ? ` of ${markers.total ?? '?'} (rest loading)` : ''} markers`,
        );
        if (zones.first.length) {
          // eslint-disable-next-line no-console
          console.info(
            `[facilio-api] getUnits: plan ${planId} (#${planRecordId}) -> ${zones.first.length}${zones.hasMore ? ` of ${zones.total ?? '?'} (rest loading)` : ''} room outlines`,
          );
        }
        return { planId, quad, markers, zones };
      }),
    );
    const [lists, plansRaw] = await Promise.all([listsP, plansP]);
    const plans = plansRaw.filter((p): p is NonNullable<typeof p> => !!p);
    const [desks, lockers, stalls, spaces] = lists;
    for (const p of plans) noteSpaceModuleId(p.zones.first);
    if (plans.some((p) => p.zones.error)) roomOutlineReadFailures.add(floorId);
    // The Rooms pool is `space` less the floor's desks, lockers and stalls — so it holds rooms only
    // while those three lists are whole. One that failed (its first page, or any later one) leaves
    // its rows reading as rooms, and the save path must not take them for rooms it may outline.
    const pointListsRead = [desks, lockers, stalls].every((l) => !l.error);

    const units = buildFloorUnits(floorId, {
      plans: plans.map((p) => ({ planId: p.planId, quad: p.quad, markers: p.markers.first, zones: p.zones.first })),
      desks: desks.first,
      lockers: lockers.first,
      stalls: stalls.first,
      spaces: spaces.first,
    });

    const pending = [...plans.map((p) => p.markers), ...plans.map((p) => p.zones), ...lists].filter((l) => l.hasMore);
    rememberFloorRooms(floorId, units, !pending.length && pointListsRead);
    if (pending.length) {
      // What is placed can be drawn from the first pages; what is NOT placed can't be told yet — a
      // desk whose marker is on a later page would read as unplaced, and a desk row on the first
      // page of `space` whose desk record is on a later page of `desks` would read as a room. So the
      // first answer carries the placed units only, and the "Available to place" pool comes with
      // the rest.
      // The rest of the floor: never awaited here, so a floor of 2,000 desks draws as soon as its
      // first pages are in. With a listener it arrives through `onMore`; without one (a caller that
      // needs the whole floor) this waits for it after all.
      const full = Promise.all([
        Promise.all(plans.map((p) => p.markers.rest)),
        Promise.all(lists.map((l) => l.rest)),
        // A later page of room outlines that fails costs those rooms (they read as unplaced), never
        // the floor — the same rule as the first page (see loadPlanZones).
        Promise.all(plans.map((p) => p.zones.rest.catch(() => [] as any[]))),
        Promise.all([desks, lockers, stalls].map((l) => l.complete ?? Promise.resolve(true))),
        // Whether every page of outlines came back — one that didn't is the user's to know about.
        Promise.all(plans.map((p) => (p.zones.error ? Promise.resolve(true) : (p.zones.complete ?? Promise.resolve(true)).catch(() => false)))),
      ]).then(([markerRests, listRests, zoneRests, pointListsWhole, zonesWhole]) => {
        if (!zonesWhole.every(Boolean)) roomOutlineReadFailures.add(floorId);
        const all = buildFloorUnits(floorId, {
          plans: plans.map((p, i) => ({
            planId: p.planId,
            quad: p.quad,
            markers: [...p.markers.first, ...markerRests[i]],
            zones: [...p.zones.first, ...zoneRests[i]],
          })),
          desks: [...desks.first, ...listRests[0]],
          lockers: [...lockers.first, ...listRests[1]],
          stalls: [...stalls.first, ...listRests[2]],
          spaces: [...spaces.first, ...listRests[3]],
        });
        for (let i = 0; i < plans.length; i++) noteSpaceModuleId(zoneRests[i]);
        rememberFloorRooms(floorId, all, pointListsRead && pointListsWhole.every(Boolean));
        // eslint-disable-next-line no-console
        console.info(`[facilio-api] getUnits floor ${floorId}: rest of the floor loaded in the background — ${units.length} → ${all.length} units`);
        return all;
      });
      if (!onMore) return full;
      full.then(onMore, (err) => {
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] getUnits floor ${floorId}: background pages failed; the floor shows its first pages`, err);
      });
      return units.filter((u) => !u.unplaced);
    }
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
  /**
   * Who holds each unit on this floor, read off the records' own `employee` field.
   *
   * This used to throw, so the app fell through to browser storage and only ever knew about
   * assignments made in this app, on this device. A desk assigned in Facilio showed as free — no
   * initials on its marker, no "Assigned · …" in the sidebar — and an assignment made here
   * vanished for everyone else. `employee` is a real field on desks, lockers and parking stalls,
   * and it is what this app now writes, so it is what it should read.
   *
   * Keyed by RECORD id, which is also the unit id for anything org-backed (see `toUnplacedUnit`
   * and `createUnit`), so the map lines up with `state.units` without a translation step.
   */
  async getAssignments(floorId: string, onMore?: (more: Assignments) => void): Promise<Assignments> {
    this.assertConfigured();
    if (!isRealFloorId(floorId)) throw new Error(`facilio-api: ${floorId} is not an org floor id`);

    // The same three lists getUnits reads, shared while in flight (loadFloorList) — during a floor
    // load. Without `onMore` this is a re-read after a change (an assignment, a transition), and a
    // load still in flight from before that change would answer with who held the desk before it.
    const lists = await Promise.all(
      ['desks', 'lockers', 'parkingstall'].map((m) =>
        onMore ? loadFloorList(floorId, m) : loadRelated<any>({ moduleName: 'floor', id: floorId, relatedModuleName: m, relatedFieldName: 'floor' }),
      ),
    );
    const held = (records: any[]): Assignments => {
      const out: Assignments = {};
      for (const record of records) {
        const employeeId = lookupId(record, 'employee');
        if (employeeId != null && employeeId !== '') out[String(record.id)] = String(employeeId);
      }
      return out;
    };
    const out = held(lists.flatMap((l) => l.first));
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] getAssignments floor ${floorId}: ${Object.keys(out).length} held of ${lists.reduce((n, l) => n + l.first.length, 0)} records`);

    if (lists.some((l) => l.hasMore)) {
      // Who holds the desks past the first page — only THOSE, so an assignment changed on screen
      // meanwhile is never overwritten by what the org said a moment ago.
      const more = Promise.all(lists.map((l) => l.rest)).then((rests) => held(rests.flat()));
      if (!onMore) return more.then((m) => ({ ...out, ...m }));
      more.then(onMore, () => {});
    }
    return out;
  }
  async assignUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  async vacateUnit(): Promise<void> {
    throw new Error('facilio-api: assignment writes go through Moves — not wired');
  }
  /**
   * The org's spacebooking records for one day, scoped to this floor's desks, spaces and stalls.
   * Throws on error so the composite falls through to the local tier, as before this was wired.
   */
  async getBookings(floorId: string, date: string): Promise<Booking[]> {
    this.assertConfigured();
    return fetchSpaceBookingsForRange(date, date, floorId);
  }
  // Creation goes through createRealBooking (the org-form-aware create) from the context; this
  // tier's createBooking throws so a local-mode caller falls through to the local store.
  async createBooking(): Promise<Booking> {
    throw new Error('facilio-api: booking creation goes through createRealBooking');
  }
  /**
   * Cancel = the record's own stateflow Cancel transition (the record stays, as Cancelled, with its
   * history — never a hard delete). A booking whose current state offers no Cancel cannot be
   * cancelled from here; locally-minted ids ("b…") fall through to the local tier.
   */
  async cancelBooking(id: string): Promise<void> {
    this.assertConfigured();
    if (!/^\d+$/.test(id)) throw new Error('facilio-api: not a backend booking id');
    const { transitions } = await fetchAvailableStates('spacebooking', Number(id));
    const cancel = findCancelTransition(transitions);
    if (!cancel) throw new Error('facilio-api: this booking has no Cancel transition in its current state');
    await executeStateTransition('spacebooking', Number(id), cancel.id);
  }
}

/** Real Facilio desk typing (`V3DeskContext.DeskType`): 1=ASSIGNED, 2=HOTEL, 3=HOT; -1/0 = unset. */
const DESK_TYPE_BY_INT: Record<number, Unit['deskType']> = { 1: 'ASSIGNED', 2: 'HOTEL', 3: 'HOT' };
const DESK_TYPE_INT: Record<NonNullable<Unit['deskType']>, number> = { ASSIGNED: 1, HOTEL: 2, HOT: 3 };

/**
 * A real org record with no marker -> an `unplaced` Unit for the "Available to place" pool. The
 * geometry is a placeholder: the pool never draws, and placing it supplies the real position.
 */
/**
 * A floor's units from its rows — placed ones from each plan's markers, then the desks, lockers,
 * stalls and rooms with no marker yet as the "Available to place" pool. A function of the rows
 * alone, so the floor can be built from its first pages and again, identically, once the rest
 * have arrived.
 */
/**
 * Rooms come from each plan's `floorplanmarkedzone` records (the outlines the org already holds —
 * 353 of them on this org, written by onboarding), read in the same pass: every zone that converts
 * cleanly becomes a PLACED room on the plan it sits on, and its space leaves the pool. Before this,
 * every room read as "Unplaced" and no outline was ever drawn, though the org had them all.
 */
function buildFloorUnits(
  floorId: string,
  rows: {
    plans: { planId: PlanId; quad: NonNullable<ReturnType<typeof geometryStringToQuad>>; markers: any[]; zones?: any[] }[];
    desks: any[];
    lockers: any[];
    stalls: any[];
    spaces: any[];
  },
): Unit[] {
  const units: Unit[] = [];
  // Real records already represented by a marker — matched on the marker's `recordId`, which this
  // app sets when it creates the backing desk/locker/stall. A marker placed in the org's own
  // editor may lack it, in which case that record also appears as unplaced (logged below).
  const placedRecordIds = new Set<string>();
  let outOfFrame = 0;

  for (const { planId, quad, markers } of rows.plans) {
    for (const marker of markers) {
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

  const { desks, lockers, stalls, spaces } = rows;

  // Room outlines. Converted through the SAME quad as the plan's markers — zones are stored in the
  // marker frame — and held to the same out-of-frame rule, because a zone drawn in Facilio's own
  // editor sits in a different frame (near 0,0) and would otherwise draw as a sliver pinned to a
  // corner. A zone whose space already has an outline on this floor (a duplicate row, or the same
  // room outlined on a second plan type) is left out rather than drawn twice under one unit id:
  // every surface keys units by id, and two units with one id is two rooms answering to one click.
  const spaceNames = new Map<string, string>();
  // Whether each space may be booked, from the space record itself — the zone's own flag is what
  // the app's onboarding wrote (always false) and says nothing about the room.
  const spaceReservable = new Map<string, boolean>();
  for (const r of spaces as any[]) {
    if (r?.id == null) continue;
    if (r.name) spaceNames.set(String(r.id), String(r.name));
    if (typeof r.reservable === 'boolean') spaceReservable.set(String(r.id), r.reservable);
  }
  // The floor's REAL desks / lockers / parking stalls — `space` is the base table they also live
  // in, so a room is whatever `space` row is none of these (see `rooms` below), and a zone tied to
  // one of them is not a room's outline (see the zone loop).
  const pointIds = new Set([...desks, ...lockers, ...stalls].map((r: any) => String(r.id)));
  // A zone is also left out when it names a desk, locker or stall (`pointIds`): in this org a desk
  // is a space too, so Facilio's editor can tie a zone to one, and a room unit under that desk's id
  // would stand in for the desk on every surface keyed by id. On a paged floor it is worse than a
  // wrong shape: the desk's marker, arriving on a later page, finds its id taken and is never added
  // (FLOOR_UNITS_MORE), so a Save sends no marker for it and the marker sync DELETES it. Neither
  // is its record taken out of the pool — the desk is not placed by an outline.
  const markerUnitIds = new Set(units.map((u) => u.id));
  const zoneUnitIds = new Set<string>();
  let zonesOutOfFrame = 0;
  let zonesMalformed = 0;
  let zonesDuplicate = 0;
  let zonesOnPointRecords = 0;
  for (const { planId, quad, zones } of rows.plans) {
    // The space module id as this plan's own app zones carry it, else as seen this session — what
    // lets a zone's bare `recordId` be read as a space id (see zoneSpaceId).
    const spaceModuleId = appZoneModuleId(zones) ?? spaceModuleIdCache.id;
    for (const zone of zones ?? []) {
      const read = markedZoneToUnit(zone, quad, floorId, planId, spaceNames, spaceModuleId, spaceReservable);
      if ('skipped' in read) {
        if (read.skipped === 'outOfFrame') zonesOutOfFrame++;
        else zonesMalformed++;
        continue;
      }
      const { unit } = read;
      const spaceId = zoneSpaceId(zone, spaceModuleId);
      if (spaceId && pointIds.has(spaceId)) {
        zonesOnPointRecords++;
        continue;
      }
      if (zoneUnitIds.has(unit.id) || markerUnitIds.has(unit.id)) {
        zonesDuplicate++;
        continue;
      }
      zoneUnitIds.add(unit.id);
      if (spaceId) placedRecordIds.add(spaceId);
      units.push(unit);
    }
  }

  // The floor's REAL desks / lockers / parking stalls / rooms that have no marker yet (floor ->
  // <module> on the `floor` lookup) enter the "Available to place" pool so they can be dragged
  // onto the plan. Rooms are whatever `space` rows are left after excluding the point records and
  // anything that isn't a plain SPACE (buildings/floors also answer to `space`).

  // The desk rows carry `department` — the field the plan needs to colour by who sits where.
  // Stamp it onto the markers built from the marker list, which never saw the record behind them.
  // `department` is a LOOKUP, so the row carries the whole related record: its id is what the
  // colour is stored against (a department can be renamed and must keep its colour), and its
  // name is what a person reads.
  const deptById = new Map<string, { id: string; name: string }>();
  for (const r of desks as any[]) {
    const d = r.department;
    if (!d) continue;
    const name = typeof d === 'string' ? d : (d.displayName ?? d.name ?? null);
    const id = typeof d === 'object' && d.id != null ? String(d.id) : null;
    if (name) deptById.set(String(r.id), { id: id ?? departmentFallbackId(String(name)), name: String(name) });
  }
  if (deptById.size) {
    for (const u of units) {
      const dept = deptById.get(u.id);
      if (dept) {
        u.department = dept.name;
        u.departmentId = dept.id;
      }
    }
  }
  const rooms = spaces.filter((r: any) => !pointIds.has(String(r.id)) && (r.spaceTypeEnum ?? 'SPACE') === 'SPACE');

  let unmatchedMarkers = 0;
  const placedIds = new Set(units.map((u) => u.id));
  const addUnplaced = (list: any[], type: Unit['type']) => {
    for (const r of list) {
      const id = String(r.id);
      if (placedRecordIds.has(id)) continue;
      if (placedIds.has(id)) {
        unmatchedMarkers++;
        continue;
      }
      const unit = toUnplacedUnit(r, type, floorId);
      const dept = deptById.get(id);
      if (dept) {
        unit.department = dept.name;
        unit.departmentId = dept.id;
      }
      units.push(unit);
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
      (outOfFrame ? ` — ${outOfFrame} markers dropped: outside the plan after conversion (written in another coordinate space?)` : '') +
      (zoneUnitIds.size ? ` — ${zoneUnitIds.size} room outlines from marked zones` : '') +
      (zonesOutOfFrame ? ` — ${zonesOutOfFrame} room outlines dropped: outside the plan after conversion (drawn in Facilio's editor, another coordinate space?)` : '') +
      (zonesMalformed ? ` — ${zonesMalformed} room outlines dropped: not a polygon of 3+ points` : '') +
      (zonesDuplicate ? ` — ${zonesDuplicate} room outlines skipped: that room already has an outline on this floor` : '') +
      (zonesOnPointRecords ? ` — ${zonesOnPointRecords} outlines skipped: tied to a desk, locker or stall, not a room` : ''),
  );
  return units;
}

/**
 * The room (space) a marked zone outlines: `space.id`, or the zone's own `recordId`, which
 * onboarding sets to the same id. Null for a zone tied to no record — Facilio's editor can draw
 * one of those.
 *
 * `recordId` alone is trusted only when the zone says the record IS a space: its `zoneModuleId`
 * is the org's space module (`spaceModuleId` — learnt from the app's own zones, see
 * appZoneModuleId), or its geoId is the app's own `space-<recordId>`. Facilio's editor can tie a
 * zone to a record of ANY module, and that record's id means nothing in the space id namespace —
 * read as a space id it could be a desk's, and a room unit under a desk's id takes that desk off
 * the plan (and a Save then deletes the desk's marker; see buildFloorUnits and FLOOR_UNITS_MORE).
 * Such a zone reads as `zone-<id>` instead, which the save path never writes back as a record.
 */
function zoneSpaceId(zone: any, spaceModuleId: number | null = spaceModuleIdCache.id): string | null {
  const space = zone?.space?.id;
  if (space != null && space !== '') return String(space);
  const record = zone?.recordId;
  if (record == null || record === '') return null;
  if (zone?.geoId === `${APP_ZONE_GEOID_PREFIX}${record}`) return String(record);
  if (spaceModuleId && Number(zone?.zoneModuleId) === spaceModuleId) return String(record);
  return null;
}

/**
 * The unit id a zone reads back as. The space id when there is one — the SAME id the Rooms pool
 * gives that room (see `toUnplacedUnit`), which is what makes a placed outline and its record one
 * unit rather than an outline beside an "Unplaced" row. A zone with no space gets a prefixed stand-in
 * that can never be mistaken for an org record id, so the save path never writes it back as one.
 */
function zoneUnitId(zone: any, spaceModuleId?: number | null): string | null {
  const spaceId = zoneSpaceId(zone, spaceModuleId ?? undefined);
  if (spaceId) return spaceId;
  return zone?.id != null ? `zone-${zone.id}` : null;
}

/**
 * The geoId convention this app (and the onboarding that wrote the org's outlines) uses for a
 * zone: `space-<spaceId>`. Anything else — Facilio's editor mints short random ones like "3fp" —
 * is someone else's zone, and this app never modifies or deletes it.
 */
const APP_ZONE_GEOID_PREFIX = 'space-';
function isAppZoneGeoId(geoId: unknown): boolean {
  return typeof geoId === 'string' && geoId.startsWith(APP_ZONE_GEOID_PREFIX) && geoId.length > APP_ZONE_GEOID_PREFIX.length;
}

/**
 * A zone's stored GeoJSON -> its OUTER ring as [lng, lat] points, with the closing point (GeoJSON
 * repeats the first point last) dropped. Null for anything that isn't a Polygon of 3+ finite
 * points. Accepts the string the API stores, or a Feature wrapping the polygon.
 */
function parsePolygonRing(geometry: unknown): [number, number][] | null {
  let parsed: any = geometry;
  if (typeof geometry === 'string') {
    try {
      parsed = JSON.parse(geometry);
    } catch {
      return null;
    }
  }
  if (parsed?.type === 'Feature') parsed = parsed.geometry;
  if (parsed?.type !== 'Polygon' || !Array.isArray(parsed.coordinates) || !Array.isArray(parsed.coordinates[0])) return null;
  const ring: [number, number][] = [];
  for (const p of parsed.coordinates[0]) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    ring.push([p[0], p[1]]);
  }
  if (ring.length > 1) {
    const [f, l] = [ring[0], ring[ring.length - 1]];
    if (Math.abs(f[0] - l[0]) < 1e-12 && Math.abs(f[1] - l[1]) < 1e-12) ring.pop();
  }
  return ring.length >= 3 ? ring : null;
}

/**
 * One `floorplanmarkedzone` record -> a PLACED room Unit on `planId`, or the reason it can't be one.
 *
 * `malformed`: no polygon of 3+ points, or no id to hang it on. `outOfFrame`: a point converts
 * outside the plan (same tolerance as markers) — in practice a zone drawn in Facilio's own editor,
 * which works in a different frame; it is skipped, never re-projected or "fixed".
 *
 * Type is `room` unless the zone's `properties.unitType` names another room-like type the app has
 * (`delivery`); any other value there — a desk type, junk — still reads as a room, since a zone
 * is an outline and only room-like units are drawn as one.
 */
export function markedZoneToUnit(
  zone: any,
  quad: NonNullable<ReturnType<typeof geometryStringToQuad>>,
  floorId: string,
  planId: PlanId,
  spaceNames?: Map<string, string>,
  spaceModuleId?: number | null,
  /** Each space's own `reservable` flag — what decides whether the room is bookable. */
  spaceReservable?: Map<string, boolean>,
): { unit: Unit } | { skipped: 'malformed' | 'outOfFrame' } {
  const id = zoneUnitId(zone, spaceModuleId);
  const ring = parsePolygonRing(zone?.geometry);
  if (!id || !ring) return { skipped: 'malformed' };
  const pts: [number, number][] = [];
  for (const [lng, lat] of ring) {
    const [x, y] = lngLatToQuadFraction(quad, lng, lat);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return { skipped: 'outOfFrame' };
    pts.push([x, y]);
  }
  const props = safeJson<{ unitType?: string; secondary?: string | null }>(zone.properties) ?? {};
  const named = asUnitType(props.unitType);
  const type: UnitType = named && isRoomLike(named) ? named : 'room';
  const spaceId = zoneSpaceId(zone, spaceModuleId ?? undefined);
  const label = zone.label || zone.space?.name || (spaceId ? spaceNames?.get(spaceId) : undefined) || spaceId || String(zone.id);
  // Bookable when the SPACE record says so; the zone's own flag only stands in where the space
  // was not read. `orgRoom` marks it as the org's: bookable on that flag, never assignable here.
  const reservable = (spaceId ? spaceReservable?.get(spaceId) : undefined) ?? (typeof zone.isReservable === 'boolean' ? (zone.isReservable as boolean) : undefined);
  return {
    unit: {
      id,
      type,
      label: String(label),
      ...(props.secondary ? { secondary: props.secondary } : {}),
      ...(typeof reservable === 'boolean' ? { isReservable: reservable } : {}),
      orgRoom: true,
      room: null,
      geom: { kind: 'poly', pts },
      floor: floorId,
      plan: planId,
    },
  };
}

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
    // An org room, however it later gets onto the plan: bookable only when its space record says
    // so (`reservable`), never assignable here.
    ...(isZone ? { orgRoom: true } : {}),
    ...(isZone && typeof record.reservable === 'boolean' ? { isReservable: record.reservable } : {}),
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
 * Floor rows -> search hits, naming each floor's building and site. The rows carry their parents
 * as lookups, so this is a shape change rather than another round trip; a lookup that answered
 * with only an id leaves the name blank rather than inventing one.
 */
async function hydrateFloorHits(rows: any[]): Promise<FloorSearchHit[]> {
  return rows.map((f: any) => ({
    floorId: String(f.id),
    floorName: String(f.name ?? ''),
    buildingId: String(lookupId(f, 'building') ?? ''),
    buildingName: String(f.building?.name ?? f.building?.displayName ?? ''),
    siteId: String(lookupId(f, 'site') ?? ''),
    siteName: String(f.site?.name ?? f.site?.displayName ?? ''),
  }));
}

/**
 * Every record of a module via `fetchAll`, paged. Guards against a server that ignores `page`
 * (a repeated first id means the same page came back — stop, don't spin) and against one that
 * ignores `perPage` (the short-page check still terminates; it just costs more round trips).
 */
/**
 * SERVER-SIDE search, the way the org's own lists do it: a V3 `filters` payload rather than
 * pulling every row down and matching in the browser.
 *
 * It matters beyond tidiness. The in-memory path can only match what was fetched — the employee
 * picker holds the roster, but the desk search only ever held the floor you had open, so
 * searching a desk number from another floor found nothing. A filter asks the org.
 *
 * The operator id is 5, read off the backend rather than guessed: `StringOperators.CONTAINS(5,
 * "contains")` in facilio-framework (com/facilio/db/criteria/operators/StringOperators.java:85).
 * Operator codes share ONE flat namespace across every operator type — the same file notes "Max
 * operator code is 141" — so 5 is the id the API expects, with no per-type offset. Nothing else
 * in that package claims 5.
 *
 * This is why the floor search in this file avoided server-side text search: the id could not be
 * confirmed at the time. It can now. The fallback below stays anyway — an org whose field names
 * differ still degrades to matching what is already loaded rather than reporting "nobody matches".
 */
const CONTAINS = 5;

function containsFilter(fields: string[], query: string): string {
  return JSON.stringify(Object.fromEntries(fields.map((f) => [f, { operatorId: CONTAINS, value: [query] }])));
}

/**
 * The roster, read now rather than remembered from boot.
 *
 * `state.employees` is fetched once when the app starts and never again, so a person added in
 * Facilio since this tab opened is invisible to every picker — and, once search went to the API,
 * findable by search yet missing from the list beside it. Surfaces that show people call this on
 * open instead; it is one paged read, and it answers with what the org has right now.
 */
export async function fetchEmployees(limit = 200): Promise<Employee[] | null> {
  if (!isFacilioApiConfigured) return null;
  const res = await facilioApi.fetchAll('employee', { perPage: limit }).catch(() => null);
  if (!res || res.error || !res.list) return null;
  return res.list.map(mapEmployee).sort(byPersonName);
}

/**
 * Employees matching a query on any of the identifiers a person is actually looked up by: name,
 * email, HRMS Employee ID — in ONE request (see employeeFilters.searchClause).
 */
export async function searchEmployees(query: string, limit = 50): Promise<Employee[] | null> {
  if (!query.trim()) return isFacilioApiConfigured ? [] : null;
  return queryEmployees({ query, applied: [], fields: [] }, limit);
}

/**
 * Employees matching the search AND the filter panel, in one request: `buildEmployeeFilters`
 * puts the search clause and one key per ticked field into a single V3 `filters` payload.
 *
 * `hrmsEmployeeId` is the org's confirmed field name, so it is the only id field the search sends.
 * The alternates in HRMS_ID_KEYS stay for READING a record (a missing property costs nothing), but
 * one unknown field in the payload fails the whole request.
 */
export async function queryEmployees(
  req: { query: string; applied: AppliedFilter[]; fields: FilterFieldDef[] },
  limit = 50,
): Promise<Employee[] | null> {
  if (!isFacilioApiConfigured) return null;
  const filters = buildEmployeeFilters(req.query, req.applied, req.fields);
  const params: Record<string, unknown> = { perPage: limit };
  if (Object.keys(filters).length) params.filters = JSON.stringify(filters);
  const res = await facilioApi.fetchAll('employee', params).catch(() => null);
  // A failed request, not an empty answer: the caller decides what to show instead, rather than
  // a list that looks like "nobody matches".
  if (!res || res.error || !res.list) return null;
  return res.list.map(mapEmployee).sort(byPersonName);
}

let employeeFilterFields: Promise<FilterFieldDef[] | null> | null = null;

/**
 * The employee fields the org lets a list be filtered by, with each field's own operators —
 * `v2/filter/advanced/fields/employee`, the endpoint the Employee list page reads, so the panel
 * offers exactly what that page does (custom fields included). Read once per session.
 */
export function fetchEmployeeFilterFields(): Promise<FilterFieldDef[] | null> {
  if (!isFacilioApiConfigured) return Promise.resolve(null);
  if (!employeeFilterFields) {
    employeeFilterFields = customGet('v2/filter/advanced/fields/employee')
      .then((body: any) => {
        const raw = body?.result?.fields ?? body?.data?.fields ?? body?.fields;
        const fields = mapFilterFields(raw);
        return fields.length ? fields : null;
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[filters] could not read the employee filter fields', err);
        employeeFilterFields = null; // let the next open try again
        return null;
      });
  }
  return employeeFilterFields;
}

/**
 * The choices for a lookup field other than Department (which the app already holds, with its
 * colours): the first page of that module's records, by name. Enough for the pickers people
 * filter a roster with — a module too big for one page is better searched than ticked.
 */
export async function fetchLookupOptions(moduleName: string, limit = 200): Promise<{ value: string; label: string }[] | null> {
  if (!isFacilioApiConfigured) return null;
  const res = await facilioApi.fetchAll(moduleName, { perPage: limit }).catch(() => null);
  if (!res || res.error || !res.list) return null;
  return sortByName(res.list)
    .map((r: any) => ({ value: String(r.id), label: String(r.name ?? r.displayName ?? r.id) }));
}

/**
 * Desks matching a query across the whole org rather than the open floor — by desk name, or by
 * the department on the record.
 */
export async function searchDesks(query: string, limit = 50): Promise<{ id: string; label: string; department?: string }[] | null> {
  if (!isFacilioApiConfigured) return null;
  const q = query.trim();
  if (!q) return [];
  const res = await facilioApi
    .fetchAll('desks', { filters: containsFilter(['name'], q), perPage: limit })
    .catch(() => null);
  if (!res || res.error || !res.list) return null;
  return res.list.map((r: any) => ({
    id: String(r.id),
    label: String(r.name ?? ''),
    department: typeof r.department === 'string' ? r.department : (r.department?.displayName ?? r.department?.name ?? undefined),
  }));
}

/**
 * The HRMS Employee ID — the number the org's HR system knows a person by, and what people here
 * search on.
 *
 * It is a CUSTOM field: the `employee` module ships `name`, `email`, `phone`, `mobile`, `language`,
 * `timezone` and `currency` and nothing resembling a staff number (V3PeopleContext in bmsconsole),
 * so this name belongs to the org rather than the product — another org would call it something
 * else entirely.
 *
 * `hrmsEmployeeId` leads rather than being the only answer: a custom field's API name is usually
 * its label camel-cased but not guaranteed to be, and each alternate costs one property lookup.
 * `getEmployees` logs the field names a real record actually carries, which settles it if this
 * list ever misses.
 */
const HRMS_ID_KEYS = ['hrmsEmployeeId', 'hrmsEmployeeID', 'hrmsEmpId', 'hrmsId', 'employeeNumber', 'employeeId', 'empId'];

function firstString(row: any, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** One employee row -> the app's Employee, with the searchable identifiers the org exposes. */
export function mapEmployee(e: any): Employee {
  const dept = e?.department;
  return {
    id: String(e.id),
    name: e.name,
    hrmsEmployeeId: firstString(e, HRMS_ID_KEYS),
    email: firstString(e, ['email', 'emailId', 'primaryEmail']),
    department: typeof dept === 'string' ? dept : (dept?.displayName ?? dept?.name ?? undefined),
  };
}

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

/**
 * Rows per related-list page. The relatedList endpoint pages with `page`/`perPage` (V3's
 * RelatedDataAction → V3Util.fetchList, no upper cap) and answers 50 when `perPage` isn't sent —
 * which is what cut every workspace module on a floor at 50. 500 loads nearly every floor in one
 * page.
 */
const RELATED_PAGE_SIZE = 500;
/** A backstop for the page loop when the count is unavailable. */
const MAX_RELATED_PAGES = 200;

type RelatedOpts = { moduleName: string; id: string | number; relatedModuleName: string; relatedFieldName: string };
type RelatedPage<T> = (page: number, perPage: number) => Promise<FacilioApiListResult<T>>;

/**
 * A related list as it arrives: the first page now, and the rest behind it.
 *
 * `first` is what the caller draws from straight away. `rest` is every row after it — the other
 * pages, fetched together once the count says how many there are — and resolves to [] when the
 * first page was all of it (`hasMore` false). A caller that needs every row awaits `rest`; one
 * that only needs to get the screen up does not.
 */
export interface RelatedLoad<T> {
  error: FacilioApiListResult<T>['error'] | null;
  first: T[];
  /** The org's own count, or null when the count call failed. */
  total: number | null;
  hasMore: boolean;
  rest: Promise<T[]>;
  /**
   * Resolves with `rest`: true when every page came back (a first-page failure, or a later page
   * that failed and cost its rows, is false). What the rows ARE is `rest`'s answer; this says
   * whether they are ALL of them — see getUnits, which trusts its pool only when they are.
   */
  complete?: Promise<boolean>;
}

/** `GET …/relatedList/<module>/<field>/count` → `{ data: { count } }` (RelatedDataAction, type=count). */
async function fetchRelatedCount(opts: RelatedOpts): Promise<number | null> {
  try {
    const body = await customGet(`v3/modules/${opts.moduleName}/${opts.id}/relatedList/${opts.relatedModuleName}/${opts.relatedFieldName}/count`);
    const count = Number(body?.data?.count ?? body?.count);
    return body?.code === 0 && Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * Load a related list: its COUNT and its FIRST page together (neither waits on the other), then —
 * without anyone waiting on them — every remaining page at once, however many the count says.
 *
 * Without a count (the call failed) the pages are read one after another while they come back
 * full, and a page with nothing new (a server ignoring `page`) stops the loop. Rows are de-duplicated
 * by id throughout. A later page that fails costs its rows, not the ones already here.
 */
export async function loadRelated<T = any>(
  opts: RelatedOpts,
  deps: { fetchPage?: RelatedPage<T>; fetchCount?: () => Promise<number | null>; perPage?: number } = {},
): Promise<RelatedLoad<T>> {
  const perPage = deps.perPage ?? RELATED_PAGE_SIZE;
  const fetchPage: RelatedPage<T> = deps.fetchPage ?? ((page, n) => facilioApi.fetchAllRelatedList<T>(opts, { page, perPage: n }));
  const [total, firstRes] = await Promise.all([(deps.fetchCount ?? (() => fetchRelatedCount(opts)))(), fetchPage(1, perPage)]);
  if (firstRes.error) return { error: firstRes.error, first: [], total, hasMore: false, rest: Promise.resolve([]), complete: Promise.resolve(false) };

  const seen = new Set<string>();
  const fresh = (rows: T[] | null | undefined) =>
    (rows ?? []).filter((r) => {
      const key = String((r as { id?: unknown })?.id ?? JSON.stringify(r));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const first = fresh(firstRes.list);
  const firstLen = firstRes.list?.length ?? 0;
  const hasMore = total !== null ? total > first.length && firstLen >= perPage : firstLen >= perPage;
  if (!hasMore) return { error: null, first, total, hasMore, rest: Promise.resolve([]), complete: Promise.resolve(true) };

  let pageFailed = false;
  const failed = () => {
    pageFailed = true;
    return null;
  };
  const page = (n: number) => fetchPage(n, perPage).then((r) => (r.error ? failed() : r.list ?? []), failed);
  const rest: Promise<T[]> =
    total !== null
      ? // The count says how many pages: ask for all of them at once.
        Promise.all(Array.from({ length: Math.min(MAX_RELATED_PAGES, Math.ceil(total / perPage)) - 1 }, (_, i) => page(i + 2))).then((lists) =>
          lists.flatMap((l) => fresh(l)),
        )
      : // No count: page on while pages come back full and bring something new.
        (async () => {
          const out: T[] = [];
          for (let n = 2; n <= MAX_RELATED_PAGES; n++) {
            const rows = await page(n);
            if (!rows) break;
            const added = fresh(rows);
            out.push(...added);
            if (!added.length || rows.length < perPage) break;
          }
          return out;
        })();
  return { error: null, first, total, hasMore, rest, complete: rest.then(() => !pageFailed, () => false) };
}

/**
 * EVERY row of a related list — the first page and the rest, awaited. For the paths that must see
 * the whole list before acting: saving markers diffs against the existing ones, and a missing one
 * would be created twice.
 */
export async function fetchAllRelatedPaged<T = any>(opts: RelatedOpts, deps?: Parameters<typeof loadRelated<T>>[1]): Promise<FacilioApiListResult<T>> {
  // These callers wait for every row anyway, and most of their lists (a site's buildings, a plan's
  // markers) fit one page — so no count call: one request when it fits, the next page only when
  // the first came back full.
  const load = await loadRelated<T>(opts, { fetchCount: async () => null, ...deps });
  if (load.error) return { error: load.error, list: null } as FacilioApiListResult<T>;
  return { error: null, list: [...load.first, ...(await load.rest)] } as FacilioApiListResult<T>;
}

/**
 * The floor's desks, lockers, stalls and spaces, shared by `getUnits` and `getAssignments`. The
 * two are asked for together on every floor load and need the same three lists; without this each
 * list was read twice. Kept only while its pages are in flight.
 */
const floorListLoads = new Map<string, Promise<RelatedLoad<any>>>();
function loadFloorList(floorId: string, module: string): Promise<RelatedLoad<any>> {
  const key = `${floorId}:${module}`;
  const hit = floorListLoads.get(key);
  if (hit) return hit;
  const load = loadRelated<any>({ moduleName: 'floor', id: floorId, relatedModuleName: module, relatedFieldName: 'floor' }).catch(
    (): RelatedLoad<any> => ({ error: { message: 'request failed' }, first: [], total: null, hasMore: false, rest: Promise.resolve([]), complete: Promise.resolve(false) }),
  );
  floorListLoads.set(key, load);
  void load.then((l) => l.rest).finally(() => floorListLoads.delete(key));
  return load;
}

/**
 * A plan's room outlines (`indoorfloorplan -> floorplanmarkedzone`), paged like its markers.
 *
 * Never rejects and never fails the floor: rooms are the one thing on a plan the floor can be drawn
 * without, so a zone list that errors (or a request that throws) is logged and answers as an empty
 * list — the rooms then read as "Unplaced", exactly as they did before outlines were read at all.
 * The empty list still carries the `error`, though: to the user a floor whose outlines failed to
 * load looks exactly like one that has none, and they may set about re-tracing rooms the org
 * already has. getUnits notes it for the floor (see takeRoomOutlineReadFailure), so the app can
 * say so.
 */
function loadPlanZones(planRecordId: string | number): Promise<RelatedLoad<any>> {
  const empty = (error: RelatedLoad<any>['error']): RelatedLoad<any> => ({ error, first: [], total: 0, hasMore: false, rest: Promise.resolve([]), complete: Promise.resolve(false) });
  // No count call: a plan's outlines (a few dozen) fit one page, and a full first page still pages
  // on, one page at a time, so a very long list still loads whole — as fetchAllRelatedPaged does.
  const opts = { moduleName: 'indoorfloorplan', id: planRecordId, relatedModuleName: 'floorplanmarkedzone', relatedFieldName: 'indoorfloorplan' };
  return loadRelated<any>(opts, { fetchCount: async () => null }).then(
    (load) => {
      if (!load.error) return load;
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] getUnits: room outline (floorplanmarkedzone) list failed for plan #${planRecordId} — the floor loads without them:`, load.error);
      return empty(load.error);
    },
    (err) => {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] getUnits: room outline (floorplanmarkedzone) list failed for plan #${planRecordId} — the floor loads without them:`, err);
      return empty({ message: err instanceof Error ? err.message : 'request failed' } as RelatedLoad<any>['error']);
    },
  );
}

/**
 * The floors whose latest read could not load every room outline — a plan's zone list that failed
 * outright, or a later page of it. Set by getUnits (cleared when a read starts, like
 * orgRoomIdsByFloor) and TAKEN by the app once per load, which then tells the user the outlines
 * did not load (instead of letting every room silently read as "Unplaced").
 */
const roomOutlineReadFailures = new Set<string>();
/** Whether `floorId`'s latest read failed to load some room outlines — true once, then forgotten. */
export function takeRoomOutlineReadFailure(floorId: string): boolean {
  return roomOutlineReadFailures.delete(floorId);
}

/**
 * The org rooms each floor's LATEST read produced, by floor id: the space ids of the rooms drawn
 * from its marked zones, plus — once the whole floor is in — the room records in its "Available to
 * place" pool. The zone sync writes an outline only for a room in here (see saveFloorplanZones):
 * a numeric id alone is not enough, because a room created through the connector tier's
 * `create-space` also gets one, and that record may not sit on this floor at all.
 *
 * Replaced, never added to, on every read (see getUnits), and cleared when a read starts, so it
 * never outlives the load that is on screen. It only ever ALLOWS a write; nothing is deleted on
 * its say-so — deletes are decided from the units themselves (the saved snapshot against the one
 * being saved), not from any memory kept here.
 */
const orgRoomIdsByFloor = new Map<string, Set<string>>();
function rememberFloorRooms(floorId: string, units: Unit[], includePool: boolean): void {
  const ids = new Set<string>();
  for (const u of units) {
    if (!isRoomLike(u.type) || !/^\d+$/.test(u.id)) continue;
    // The pool is only trustworthy once every page is in, and came back: on a first page, or with a
    // page of `desks` that failed, a desk whose desk record is missing still reads as a room (see
    // getUnits).
    if (u.unplaced && !includePool) continue;
    ids.add(u.id);
  }
  orgRoomIdsByFloor.set(floorId, ids);
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

/**
 * Forget everything remembered about the org, so the next read goes to it.
 *
 * Behind the Refresh control: the point of pressing it is to get the org's current answer, and a
 * memo that survived the press would quietly serve the stale one — which is the failure the button
 * exists to fix.
 */
export function invalidateOrgCaches(): void {
  floorPlanTypeCache.clear();
  realSpaceRecordCache.clear();
  moduleIdCache.clear();
  spaceModuleIdCache.id = null;
  bookingFormListCache.clear();
  bookingFormDetailCache.clear();
  floorIdsCache.clear();
  orgResourcesCache = null;
  floorIndex = null;
  employeeFilterFields = null;
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
  const existing = await fetchAllRelatedPaged<any>({ moduleName: 'indoorfloorplan', id: summary.id, relatedModuleName: 'floorplanmarker', relatedFieldName: 'indoorfloorplan' })
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

  const existingRes = await fetchAllRelatedPaged<any>({
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
 * What a room-outline save did — reported next to `MarkerSaveResult` so a skipped room is as
 * visible as a skipped plan of markers. `skipped` names each plan or room that was NOT written and
 * why; a room minted in this app (an app-local `u…` id, no org record yet) is not a skip, it is
 * simply local. A `zone-…` room IS an org record — a zone drawn in Facilio's editor for no room —
 * and a change to one is reported, since it is never written. `roomsNotWritten` is the same news
 * per room, by label — what the save toast names, so a room whose outline did not reach the org is
 * never simply called "saved". `retryIds` are the rooms whose write was attempted and FAILED (a
 * create, update or delete the org refused, or a plan whose zone list could not be read): the
 * caller keeps them unsaved, so the next Save tries them again.
 */
export interface ZoneSaveResult {
  /** Plans whose zones were diffed against the org and written. */
  plansSynced: number;
  created: number;
  updated: number;
  deleted: number;
  skipped: string[];
  /** Plan-level failures (no plan, no georeference, the zone list unreadable) — not per-room skips. */
  plansSkipped: number;
  roomsNotWritten: string[];
  retryIds: string[];
}

/**
 * Room-like, placed, traced (3+ points), and carrying a real org record id — a room the org COULD
 * hold. Whether this floor's read actually produced that room is a second question, asked by the
 * zone sync itself (see orgRoomIdsByFloor). Shared with `persistUnits`, so "is there an org room
 * on this save" has one answer.
 */
export function isOrgZoneUnit(u: Unit): u is Unit & { geom: PolyGeom } {
  return isRoomLike(u.type) && !u.unplaced && u.geom.kind === 'poly' && u.geom.pts.length >= 3 && /^\d+$/.test(u.id) && Number(u.id) > 0;
}

/** `custom` is the legacy plan tag for zones; it lives on the workstation plan (see `unitOnPlan`). */
function zonePlan(plan: PlanId): PlanId {
  return plan === 'custom' ? 'workstation' : plan;
}

/** A unit's outline as the closed GeoJSON Polygon a zone stores, in the plan's lng/lat frame. */
function zoneGeometryString(quad: NonNullable<ReturnType<typeof geometryStringToQuad>>, pts: [number, number][]): string {
  const ring = pts.map(([x, y]) => quadToLngLat(quad, x, y));
  return JSON.stringify({ type: 'Polygon', coordinates: [[...ring, ring[0]]] });
}

/**
 * Whether a stored zone already has this outline. Compared point by point within ~0.1 mm of
 * lng/lat, not as strings: an outline read back through the quad and written out again differs in
 * the last float digits, and a string compare would rewrite every room on the floor on every save.
 */
function sameZoneRing(storedGeometry: unknown, nextGeometry: string): boolean {
  const a = parsePolygonRing(storedGeometry);
  const b = parsePolygonRing(nextGeometry);
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-9 && Math.abs(p[1] - b[i][1]) < 1e-9);
}

/** Placed room outlines in `units` on `floorId`, by plan -> id -> label. */
function roomOutlinesByPlan(floorId: string, units: Unit[]): Map<PlanId, Map<string, string>> {
  const out = new Map<PlanId, Map<string, string>>();
  for (const u of units) {
    if (u.floor !== floorId || !isRoomLike(u.type) || u.unplaced || u.geom.kind !== 'poly') continue;
    const plan = zonePlan(u.plan);
    out.set(plan, (out.get(plan) ?? new Map<string, string>()).set(u.id, u.label));
  }
  return out;
}

/**
 * Whether a room is exactly as the saved snapshot had it — the same outline, label, type and plan.
 * Such a room is not the user's change, and a save writes only the user's changes: comparing it
 * against the org instead would push the snapshot back over a zone reshaped or deleted elsewhere
 * since the floor was read (another tab, an onboarding script).
 */
function sameOutline(a: Unit, b: Unit): boolean {
  if (a.geom.kind !== 'poly' || b.geom.kind !== 'poly' || !!a.unplaced !== !!b.unplaced) return false;
  return (
    JSON.stringify(a.geom.pts) === JSON.stringify(b.geom.pts) &&
    a.label === b.label &&
    a.type === b.type &&
    (a.secondary ?? null) === (b.secondary ?? null) &&
    zonePlan(a.plan) === zonePlan(b.plan)
  );
}

/**
 * The rooms whose ORG outline differs between `baseline` (the saved snapshot) and `units` (what is
 * being saved), by label: traced or placed since, reshaped, relabelled, retyped, moved to another
 * plan, deleted, or rebound to another record (the old record's outline reads as deleted, the new
 * one's as added). An org outline is a placed room standing for a real space (`isOrgZoneUnit`) or
 * one read from a zone that names no room (`zone-…`); rooms minted in the app are browser-only
 * either way and are not listed.
 *
 * This is what a save with ROOM_OUTLINE_WRITES off has to own up to: none of these reached
 * Facilio, and a reload will draw the org's outline again. Same per-room test as the zone sync
 * (`sameOutline`), so "changed" has one answer whichever way the flag is set. Discard (units ===
 * baseline) lists nothing.
 */
export function roomOutlineChanges(floorId: string, units: Unit[], baseline: Unit[] = []): string[] {
  const isOrgOutline = (u: Unit) =>
    u.floor === floorId && (isOrgZoneUnit(u) || (isRoomLike(u.type) && !u.unplaced && u.geom.kind === 'poly' && u.geom.pts.length >= 3 && u.id.startsWith('zone-')));
  const now = new Map(units.filter(isOrgOutline).map((u) => [u.id, u]));
  const before = new Map(baseline.filter(isOrgOutline).map((u) => [u.id, u]));
  // One entry per ROOM (by id), not per label: two rooms both called "Store", both reshaped, are
  // two changes that did not reach Facilio, and a Set of labels counted them as one.
  const changed = new Map<string, string>();
  for (const [id, u] of now) {
    const b = before.get(id);
    if (!b || !sameOutline(b, u)) changed.set(id, u.label);
  }
  for (const [id, b] of before) if (!now.has(id)) changed.set(id, b.label);
  return [...changed.values()];
}

/**
 * Room outlines -> real `floorplanmarkedzone` records, at the explicit-save chokepoint only
 * (`persistUnits`), next to `saveFloorplanMarkers`. Before this a room traced in the app lived in
 * browser storage and was never read back on a real floor.
 *
 * Only what the user CHANGED is written: a room exactly as `baseline` has it is left out before
 * anything else, so Discard (units === baseline) and a Save of one moved desk write no zone. Then,
 * per plan, for each changed placed room whose id is a real org record id AND that this floor's
 * latest read produced (a zone it drew, or a room in its pool — see orgRoomIdsByFloor):
 *  - no zone for that space on the plan -> CREATE one (geoId `space-<id>`, `isReservable: false` —
 *    true would make Facilio create a bookable Facility for the space) — only once the record is
 *    confirmed to be a plain space, never a desk/locker/stall;
 *  - the app's own zone(s) for it (geoId `space-…`) -> UPDATE geometry/label when they changed,
 *    every copy alike, and never send `isReservable` on an update;
 *  - only a zone drawn in Facilio's editor for it -> left exactly as it is, and reported.
 *
 * DELETES are decided from the units alone — `baseline`, the snapshot the user last had on screen
 * as saved (`state.savedUnits`), against `units`, the one being saved. A room outlined on plan P in
 * the baseline and outlined nowhere on P now is a room the user removed here; only THEN are its
 * zones on P deleted, and only those carrying the app's geoId. There is no memory of "zones shown"
 * to go stale: a re-read that failed to draw the outlines leaves them out of the baseline too, so a
 * save after it deletes nothing. A room removed from the floor altogether loses its app zones on the
 * floor's other plans too — a second copy there was hidden as a duplicate, and would otherwise draw
 * the room again on the next read. Without a baseline (a caller that isn't diffing a saved
 * snapshot) nothing is deleted; no space is ever created.
 *
 * Rooms with app-local ids stay in browser storage, as before. Desks/lockers/stalls are untouched:
 * they are `saveFloorplanMarkers`' business, and it never sees a polygon.
 */
export async function saveFloorplanZones(floorId: string, units: Unit[], baseline: Unit[] = []): Promise<ZoneSaveResult> {
  const result: ZoneSaveResult = { plansSynced: 0, created: 0, updated: 0, deleted: 0, skipped: [], plansSkipped: 0, roomsNotWritten: [], retryIds: [] };
  if (!isFacilioApiConfigured) return result;
  // Belt and braces: `persistUnits` does not call this at all while room outline writes are off
  // (see featureFlags.ts), and nothing else may write zones either. Not one request — no plan
  // read, no zone list, no `space` probe — only the rooms whose changes did not reach the org.
  if (!ROOM_OUTLINE_WRITES) {
    result.roomsNotWritten = roomOutlineChanges(floorId, units, baseline);
    return result;
  }
  if (!isRealFloorId(floorId)) {
    if (units.some(isOrgZoneUnit)) {
      result.skipped.push(`${floorId} is not an org floor — room outlines stay in this browser`);
      result.plansSkipped++;
    }
    return result;
  }
  const notWritten = (label: string, why: string) => {
    result.skipped.push(`"${label}": ${why}`);
    result.roomsNotWritten.push(label);
  };

  // Only this floor's units speak for this floor. A list that holds units but none of this floor's
  // (a demo seed saved over a real floor) says nothing about which rooms the user removed, so it
  // may create/update but never delete.
  const floorUnits = units.filter((u) => u.floor === floorId);
  const mayDelete = !(units.length > 0 && floorUnits.length === 0);
  const known = orgRoomIdsByFloor.get(floorId) ?? new Set<string>();
  const saved = new Map(baseline.filter((u) => u.floor === floorId).map((u) => [u.id, u]));
  const byPlan = new Map<PlanId, (Unit & { geom: PolyGeom })[]>();
  for (const u of floorUnits.filter(isOrgZoneUnit)) {
    const before = saved.get(u.id);
    if (before && sameOutline(before, u)) continue; // not the user's change: nothing to write
    if (!known.has(u.id)) {
      // A numeric id this floor never read as a room — a record the connector tier created, or a
      // desk that read as a room while its desk page failed. Not written as a zone.
      notWritten(u.label, `#${u.id} is not a room this floor loaded from the org — outline kept in this browser`);
      continue;
    }
    const plan = zonePlan(u.plan);
    byPlan.set(plan, [...(byPlan.get(plan) ?? []), u]);
  }
  // Every room-like outline still on a plan, by id — local ones included, so a zone is never
  // deleted for a room that is still there under an id this sync doesn't write.
  const presentByPlan = roomOutlinesByPlan(floorId, floorUnits);
  // Rooms the baseline had outlined on a plan that no longer have an outline there.
  const removedByPlan = new Map<PlanId, Map<string, string>>();
  if (mayDelete) {
    for (const [plan, before] of roomOutlinesByPlan(floorId, baseline)) {
      const now = presentByPlan.get(plan);
      const gone = new Map([...before].filter(([id]) => /^\d+$/.test(id) && !now?.has(id)));
      if (gone.size) removedByPlan.set(plan, gone);
    }
  }
  // A room gone from the floor altogether: its app zones on the floor's OTHER plans go too. The
  // read draws a room once, from the first plan that outlines it, so a copy on a second plan was
  // never on screen — left in place, it would draw the room there on the next read.
  const presentAnywhere = new Set([...presentByPlan.values()].flatMap((m) => [...m.keys()]));
  const goneFromFloor = new Map<string, string>();
  for (const gone of removedByPlan.values()) for (const [id, label] of gone) if (!presentAnywhere.has(id)) goneFromFloor.set(id, label);

  // A room read from a zone that names no room (`zone-…`, drawn in Facilio's editor) is never
  // written — the change is reported, so the user is not told it was saved.
  if (mayDelete) {
    const now = new Map(floorUnits.map((u) => [u.id, u]));
    for (const [id, before] of saved) {
      if (!id.startsWith('zone-') || before.unplaced || before.geom.kind !== 'poly') continue;
      const after = now.get(id);
      if (after && sameOutline(before, after)) continue;
      notWritten(before.label, `drawn in Facilio without a room — ${after ? 'change' : 'delete'} not written to the org`);
    }
  }

  const byType = await getFloorplanDetailsByType(floorId).catch(() => ({}) as Record<string, any>);
  const configuredPlanIds = Object.keys(byType)
    .map((t) => PLAN_ID_BY_TYPE[Number(t)])
    .filter((p): p is PlanId => !!p);
  for (const planId of new Set<PlanId>([...byPlan.keys(), ...configuredPlanIds])) {
    const wanted = byPlan.get(planId) ?? [];
    const removed = removedByPlan.get(planId) ?? new Map<string, string>();
    // The same rooms' copies on this plan, when the user took them off the floor from another one.
    const sweep = new Map([...goneFromFloor].filter(([id]) => !removed.has(id)));
    const summary = byType[String(FLOOR_PLAN_TYPE[planId])];
    if (!summary?.id) {
      if (wanted.length) {
        result.skipped.push(`${planId}: no plan configured — ${wanted.length} room outline(s) not written`);
        result.plansSkipped++;
        result.roomsNotWritten.push(...wanted.map((u) => u.label));
      }
      continue;
    }
    const planRecordId = Number(summary.id);
    // Nothing to write and nothing the user removed here: no request at all.
    if (!wanted.length && !removed.size && !sweep.size) continue;
    // Only a sweep for copies that were never on screen: a plan that can't be read for it is noted,
    // not called a failed save — the rooms were removed where the user saw them.
    const sweepOnly = !wanted.length && !removed.size;
    try {
      const r = await syncZonesForIndoorFloorPlan(planRecordId, wanted, presentByPlan.get(planId) ?? new Map<string, string>(), removed, sweep);
      if (!r.synced) {
        result.skipped.push(`${planId}: plan #${planRecordId} has no georeference — room outlines not written`);
        if (sweepOnly) continue;
        result.plansSkipped++;
        result.roomsNotWritten.push(...wanted.map((u) => u.label), ...removed.values());
        continue;
      }
      result.plansSynced++;
      result.created += r.created;
      result.updated += r.updated;
      result.deleted += r.deleted;
      result.skipped.push(...r.skipped.map((s) => `${planId}: ${s}`));
      result.roomsNotWritten.push(...r.roomsNotWritten);
      result.retryIds.push(...r.retryIds);
    } catch (err) {
      result.skipped.push(`${planId}: ${(err as Error)?.message ?? err}`);
      if (sweepOnly) {
        result.roomsNotWritten.push(...sweep.values());
        continue;
      }
      result.plansSkipped++;
      result.roomsNotWritten.push(...wanted.map((u) => u.label), ...removed.values());
      result.retryIds.push(...wanted.map((u) => u.id), ...removed.keys());
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] room outline sync failed for plan ${planId}`, err);
    }
  }
  // eslint-disable-next-line no-console
  console.info(
    `[facilio-api] saveFloorplanZones floor ${floorId}: synced ${result.plansSynced} plan(s) — ${result.created} created, ${result.updated} updated, ${result.deleted} deleted` +
      (result.skipped.length ? `; skipped ${result.skipped.join('; ')}` : ''),
  );
  return result;
}

/**
 * The org's `space` module id, as the app's own zones carry it in `zoneModuleId` (onboarding wrote
 * every one of them with it). Learnt only from those zones — never from a record read, because a
 * desk, locker or stall read through `space` answers with its OWN module's id, and one wrong value
 * kept here would stamp every zone created after it.
 */
const spaceModuleIdCache: { id: number | null } = { id: null };
function appZoneModuleId(zones: any[] | null | undefined): number | null {
  const z = (zones ?? []).find((r) => isAppZoneGeoId(r?.geoId) && typeof r?.zoneModuleId === 'number' && r.zoneModuleId > 0);
  return z ? z.zoneModuleId : null;
}
function noteSpaceModuleId(zones: any[] | null | undefined): void {
  const id = appZoneModuleId(zones);
  if (id && !spaceModuleIdCache.id) spaceModuleIdCache.id = id;
}

/** The records a room id must NOT be before it gets an outline: the modules desks/lockers/stalls live in. */
const POINT_RECORD_MODULES = ['desks', 'lockers', 'parkingstall'];

/**
 * The module id a new zone's `zoneModuleId` names — the org's `space` module — and the check that
 * the room really is a plain space. Rooms are told from desks by MODULE, not `spaceTypeEnum`: in
 * this org a desk is a SPACE-typed space too, so the type says nothing.
 *
 * With the space module id known (an app zone on this plan, or one seen this session), the room's
 * record read through `space` must answer with that same module id; a desk answers with its own.
 * Without it, the room is asked for as a desk, a locker and a stall, and a record that answers as
 * any of them gets no outline; otherwise the record's own module id is used for this one zone and
 * not kept.
 */
async function zoneModuleIdFor(existing: any[], spaceId: number): Promise<{ moduleId: number } | { skipped: string }> {
  const res = await facilioApi.fetchRecord<any>('space', { id: spaceId }).catch(() => null);
  const record = res && !res.error ? recordOf<any>(res, 'space') : null;
  if (!record) return { skipped: 'its space record could not be read — space module id could not be resolved, outline not created' };
  if ((record.spaceTypeEnum ?? 'SPACE') !== 'SPACE') return { skipped: `it is a ${String(record.spaceTypeEnum).toLowerCase()}, not a room — outline not created` };
  noteSpaceModuleId(existing);
  const known = appZoneModuleId(existing) ?? spaceModuleIdCache.id;
  if (known) {
    if (typeof record.moduleId === 'number' && record.moduleId !== known) return { skipped: `its record is in module #${record.moduleId}, not the space module — not a room, outline not created` };
    return { moduleId: known };
  }
  for (const module of POINT_RECORD_MODULES) {
    const probe = await facilioApi.fetchRecord<any>(module, { id: spaceId }).catch(() => null);
    if (probe && !probe.error && recordOf<any>(probe, module)) return { skipped: `it is a ${module === 'parkingstall' ? 'parking stall' : module.replace(/s$/, '')} record, not a room — outline not created` };
  }
  if (typeof record.moduleId !== 'number') return { skipped: 'space module id could not be resolved — outline not created' };
  return { moduleId: record.moduleId };
}

/**
 * One plan's zone diff. `present` is every room outline id (-> label) still on this plan; `removed`
 * the org rooms the user took off this plan since the saved snapshot; `sweep` rooms taken off the
 * floor from another plan, whose app zones here go too (an editor zone of theirs here is left, and
 * not reported — it was never on screen). Throws when the existing list can't be read — writing
 * blind would create a second zone for a room that already has one.
 */
async function syncZonesForIndoorFloorPlan(
  indoorFloorPlanId: number,
  rooms: (Unit & { geom: PolyGeom })[],
  present: Map<string, string>,
  removed: Map<string, string>,
  sweep: Map<string, string> = new Map(),
): Promise<{ synced: boolean; created: number; updated: number; deleted: number; skipped: string[]; roomsNotWritten: string[]; retryIds: string[] }> {
  const out = { synced: false, created: 0, updated: 0, deleted: 0, skipped: [] as string[], roomsNotWritten: [] as string[], retryIds: [] as string[] };
  const notWritten = (label: string, id: string, why: string) => {
    out.skipped.push(`"${label}" (#${id}): ${why}`);
    out.roomsNotWritten.push(label);
  };
  /** A write the org refused: reported, and kept unsaved so the next Save tries it again. */
  const failed = (label: string, id: string, why: string) => {
    notWritten(label, id, why);
    out.retryIds.push(id);
  };
  const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: indoorFloorPlanId });
  const quad = geometryStringToQuad(recordOf<any>(recordRes, 'indoorfloorplan')?.geometry);
  if (recordRes.error || !quad) return out;

  const existingRes = await fetchAllRelatedPaged<any>({
    moduleName: 'indoorfloorplan',
    id: indoorFloorPlanId,
    relatedModuleName: 'floorplanmarkedzone',
    relatedFieldName: 'indoorfloorplan',
  });
  if (existingRes.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] fetching existing room outlines failed for plan ${indoorFloorPlanId}`, existingRes.error);
    throw new Error('room outline list unavailable');
  }
  out.synced = true;
  const existing = existingRes.list ?? [];
  noteSpaceModuleId(existing);
  const bySpace = new Map<string, any[]>();
  for (const z of existing) {
    // Looser than the read on purpose: a zone tied to the room's id by a bare `recordId` of some
    // other module is not drawn as that room (see zoneSpaceId), but here it still counts as the
    // room's existing zone — the cautious side for a WRITE, which then leaves an editor zone alone
    // and reports it rather than creating a second outline beside it.
    const sid = zoneSpaceId(z) ?? (z?.recordId != null && z.recordId !== '' ? String(z.recordId) : null);
    if (sid) bySpace.set(sid, [...(bySpace.get(sid) ?? []), z]);
  }
  const errText = (e: any) => `${e?.code ?? '?'} ${e?.message ?? ''}`.trim();

  for (const room of rooms) {
    const geometry = zoneGeometryString(quad, room.geom.pts);
    const properties = JSON.stringify({ unitType: room.type, secondary: room.secondary ?? null });
    const zones = bySpace.get(room.id) ?? [];
    // Every app-geoId zone for this space on this plan is the same room — onboarding run twice
    // leaves two — so they are all kept to the one outline; rewriting only the first would leave a
    // stale copy that draws the old shape again on the next read.
    const own = zones.filter((z) => isAppZoneGeoId(z.geoId));
    if (own.length) {
      for (const z of own) {
        if (sameZoneRing(z.geometry, geometry) && z.label === room.label) continue;
        // No `isReservable` here, ever — an update must not flip the space's bookability either way.
        const res = await facilioApi.updateRecord('floorplanmarkedzone', { id: z.id, data: { geometry, label: room.label, properties } });
        if (res.error) {
          failed(room.label, room.id, `update failed (${errText(res.error)})`);
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] room outline update failed for ${room.id}`, res.error);
        } else out.updated++;
      }
      continue;
    }
    if (zones.length) {
      // Only a zone someone drew in Facilio's editor: not ours to rewrite, and a second zone for the
      // same space would leave the org with two outlines for one room. Said only when the room
      // differs from it — one that matches needs nothing written, and is no news.
      if (!zones.some((z) => sameZoneRing(z.geometry, geometry) && z.label === room.label)) {
        notWritten(room.label, room.id, 'its outline on this plan was drawn in Facilio — left unchanged');
      }
      continue;
    }
    const spaceId = Number(room.id);
    const moduleId = await zoneModuleIdFor(existing, spaceId);
    if ('skipped' in moduleId) {
      notWritten(room.label, room.id, moduleId.skipped);
      continue;
    }
    const res = await facilioApi.createRecord<any>('floorplanmarkedzone', {
      data: {
        geoId: `${APP_ZONE_GEOID_PREFIX}${room.id}`,
        geometry,
        properties,
        type: MARKER_GEOJSON_TYPE,
        label: room.label,
        indoorfloorplan: { id: indoorFloorPlanId },
        space: { id: spaceId },
        recordId: spaceId,
        zoneModuleId: moduleId.moduleId,
        isReservable: false,
      },
    });
    if (res.error) {
      failed(room.label, room.id, `create failed (${errText(res.error)})`);
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] room outline create failed for ${room.id}`, res.error);
      continue;
    }
    out.created++;
  }

  // Removed rooms: every app-geoId zone of theirs on this plan goes (duplicates too — leaving one
  // would draw the room again on the next read). A zone drawn in Facilio's editor is never
  // deleted; the room it outlines comes back on the next read, and the user is told so.
  const removals: [string, string, boolean][] = [...[...removed].map(([id, label]): [string, string, boolean] => [id, label, false]), ...[...sweep].map(([id, label]): [string, string, boolean] => [id, label, true])];
  for (const [spaceId, label, swept] of removals) {
    if (present.has(spaceId)) continue;
    const zones = bySpace.get(spaceId) ?? [];
    for (const z of zones) {
      if (!isAppZoneGeoId(z.geoId)) continue;
      const res = await facilioApi.deleteRecord('floorplanmarkedzone', z.id);
      if (res.error) {
        // A copy that was never on screen is reported, not retried: the room it outlines is off
        // the plan the user saw it on either way.
        (swept ? notWritten : failed)(label, spaceId, `zone #${z.id}: delete failed (${errText(res.error)})`);
        // eslint-disable-next-line no-console
        console.warn(`[facilio-api] room outline delete failed for zone ${z.id}`, res.error);
        continue;
      }
      out.deleted++;
    }
    if (!swept && zones.some((z) => !isAppZoneGeoId(z.geoId))) notWritten(label, spaceId, 'its outline on this plan was drawn in Facilio — not deleted');
  }
  return out;
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

  const markersRes = await fetchAllRelatedPaged<any>({
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
const RECORD_FIELDS: Record<string, { name: string; label: string; enum?: boolean }[]> = {
  desks: [
    { name: 'deskCode', label: 'Desk code' },
    { name: 'department', label: 'Department' },
  ],
  lockers: [],
  parkingstall: [
    // Picklists: the API sometimes answers with the raw option id rather than its label.
    { name: 'parkingType', label: 'Parking type', enum: true },
    { name: 'parkingMode', label: 'Parking mode', enum: true },
  ],
  space: [
    { name: 'spaceCategory', label: 'Category' },
    { name: 'area', label: 'Area' },
    { name: 'maxOccupancy', label: 'Capacity' },
    { name: 'reservable', label: 'Reservable' },
  ],
};

/**
 * The org's OWN departments, from the `department` module — the master list, not the set that
 * happens to appear on the floor currently loaded. Settings colours departments the org has, so
 * a team whose desks are all on another floor still gets a colour, and the list does not change
 * shape as you walk the building.
 *
 * Returns an empty list when the API isn't configured (the local tier), and the caller falls back
 * to the departments actually seen on the plan.
 */
export async function fetchDepartments(): Promise<{ id: string; name: string }[]> {
  if (!isFacilioApiConfigured) return [];
  const res = await facilioApi.fetchAll('department', { perPage: 500 }).catch(() => null);
  const rows = (res && !res.error ? res.list : null) ?? [];
  return rows
    .map((r: any) => ({ id: String(r.id), name: String(r.name ?? r.displayName ?? '').trim() }))
    .filter((d: { id: string; name: string }) => d.name)
    .sort(byDepartmentName);
}

/**
 * A stand-in id for a department the record named but did not identify — the local tier, or a
 * lookup that answered with a bare string. Prefixed so it can never be mistaken for a real
 * record id, and derived from the name so it is stable.
 */
export function departmentFallbackId(name: string): string {
  return 'name:' + name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** On the space base module, so every type above can carry them. */
const COMMON_RECORD_FIELDS: { name: string; label: string; enum?: boolean }[] = [{ name: 'approvalStatus', label: 'Approval' }];

/**
 * A V3 field value as a display string, or null when there is nothing to show. Lookups arrive as
 * objects, picklists as either a label or a raw id, booleans as booleans — all of which have to
 * render as text without inventing a value for an empty field.
 */
function formatFieldValue(raw: unknown, isEnum = false): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  // A picklist answered with its raw option id tells the reader nothing — "Parking mode  1" is
  // worse than no row at all. Numbers are still shown for real numeric fields (area, capacity).
  if (typeof raw === 'number') return isEnum ? null : String(raw);
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

/**
 * Drop everything held about a record, so the next read goes to the org.
 *
 * Called after any action. The record read itself is never cached — its state is precisely what an
 * action changes — but the plan/type lookups around it are, and a transition can move a record
 * between them.
 */
export function invalidateUnitRecordInfo(unit: Pick<Unit, 'id' | 'type'>): void {
  realSpaceRecordCache.delete(unit.id);
  floorPlanTypeCache.clear();
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

  // Deliberately NOT cached. This is the live state of a record the user is acting on — a
  // transition, an assignment or an edit changes it, and a card showing a remembered answer after
  // a button click is worse than one extra read.
  return facilioApi
    .fetchRecord<any>(moduleName, { id })
    .then((res) => {
      const rec = recordOf<any>(res, moduleName);
      if (res.error || !rec) return null;
      const specs = [...(RECORD_FIELDS[moduleName] ?? []), ...COMMON_RECORD_FIELDS];
      const fields = specs
        .map((f) => ({ label: f.label, value: formatFieldValue(rec[f.name], f.enum) }))
        .filter((f): f is { label: string; value: string } => f.value !== null);
      return { status: formatFieldValue(rec.moduleState), employee: formatFieldValue(rec.employee), fields };
    })
    .catch(() => null);
}

/**
 * Writes an employee onto the record itself — `desks.employee`, `lockers.employee`,
 * `parkingstall.employee` (all real fields on those modules) — and then lets the record's own
 * stateflow catch up.
 *
 * Writing the field alone does NOT move the state: a desk stays "Yet to Assign" with a holder on
 * it, so the flow keeps offering Assign and never offers Vacate. `runAssignTransition` fires the
 * flow's own assign step if the current state still has one, which is why it runs after the write
 * rather than instead of it.
 */
export async function assignEmployeeToRecord(unit: Unit, employeeId: string): Promise<void> {
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) throw new Error(`facilio-api: ${unit.type} has no assignable record`);
  const id = Number(employeeId);
  if (!Number.isFinite(id)) throw new Error(`facilio-api: "${employeeId}" is not a real employee id`);

  // Resolves the backing record, creating one when the unit was placed but never given a record.
  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) throw new Error(`facilio-api: could not resolve an org record for ${unit.label}`);

  const res = await facilioApi.updateRecord(moduleName, { id: ref.recordId, data: { employee: { id } } });
  if (res.error) throw new Error(res.error.message || `assign failed (code ${res.error.code ?? '?'})`);
  await runAssignTransition(moduleName, ref.recordId).catch((err) => {
    // The holder is written either way; the state just didn't move.
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] assigned ${moduleName} #${ref.recordId} but its state did not advance`, err);
  });
  invalidateUnitRecordInfo(unit);
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
  const markersRes = await fetchAllRelatedPaged<any>({
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
 * Assigns an employee to a placed workstation/locker/parking-stall for real — a plain `employee`
 * field write on the record, for every type.
 *
 * Desks used to go through a `moves` record instead. That is the org's reassignment mechanism and
 * it auto-unassigns whatever desk the employee already held, so handing someone a second desk
 * quietly took away their first. One person may hold any number of desks, which rules Moves out.
 */
export async function assignUnitReal(unit: Unit, contactId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  if (!REAL_SPACE_MODULE[unit.type]) return;
  if (!Number.isFinite(Number(contactId))) return; // mock employee ids (e.g. "c1") aren't real backend ids.
  // Same write as the picker's, best-effort: the drag-and-drop flow treats the local assignment as
  // done and must not throw into it.
  await assignEmployeeToRecord(unit, contactId).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] assign failed for unit ${unit.id}`, err);
  });
}

/**
 * Vacates a placed workstation/locker/parking-stall for real — clears `employee` on that record,
 * for every type. It releases THIS unit and nothing else, which is what vacate means when one
 * person can hold several. The mirror of `assignUnitReal`.
 */
export async function vacateUnitReal(unit: Unit, contactId: string): Promise<void> {
  if (!isFacilioApiConfigured) return;
  const moduleName = REAL_SPACE_MODULE[unit.type];
  if (!moduleName) return;
  const id = Number(contactId);
  if (!Number.isFinite(id)) return;

  const ref = await ensureRealSpaceRecord(unit);
  if (!ref) return;

  {
    // Clears the field on THIS record, for every type — the mirror of the assign write above.
    // A Moves-based vacate would also be reading a move that no longer exists, now that desks are
    // assigned by writing `employee` rather than by moving anyone.
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

/** Which spacebooking lookup field carries the booked resource, per real module. */
const SPACEBOOKING_LOOKUP: Record<string, string> = { desks: 'desk', parkingstall: 'parkingStall' };
/** A room booking names its `space` record — the field the record and the booking filters read. */
const ROOM_SPACEBOOKING_LOOKUP = 'space';

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
  /** The form's own resource lookup field name (from its response) — logged when it differs from the module's. */
  resourceField?: string;
  /** A window that ends on another day ends on this date (omitted = the start's day). */
  endDateISO?: string;
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
  // Type-aware last resort: never hand another type's form over just because it sits first in
  // the list — the "All spaces" switch to a room would otherwise land on the desk form whenever the
  // org's space form matched no pattern.
  const avoid = FORM_NOT_FOR_TYPE[unitType];
  const fallback = avoid ? forms.find((f) => !avoid.test(f.name ?? '')) : undefined;
  return fallback ?? forms[0];
}

/** Link-name words that mark a form as ANOTHER type's — the guard the fallbacks above use. */
const FORM_NOT_FOR_TYPE: Partial<Record<UnitType, RegExp>> = {
  room: /desk|parking|hot/i,
  workstation: /space|room|parking/i,
  parking: /desk|space|room|hot/i,
  locker: /desk|space|room|parking|hot/i,
};

/**
 * Every listable form on the module that belongs to a unit type — the form picker offers these.
 * Matched on the link name with the same patterns as pickDefaultBookingForm; when nothing matches,
 * the forms that at least aren't another type's.
 */
export function bookingFormsForType(forms: BookingFormSummary[], module: 'space' | 'facility', unitType: UnitType): BookingFormSummary[] {
  const moduleName = module === 'space' ? 'spacebooking' : 'facilitybooking';
  const prefs = FORM_NAME_PREFERENCE[moduleName];
  const patterns = [...(prefs[unitType] ?? []), ...(prefs.default ?? [])];
  const listable = forms.filter((f) => !f.hideInList);
  const matched = listable.filter((f) => patterns.some((re) => re.test(f.name ?? '')));
  if (matched.length) return matched;
  const avoid = FORM_NOT_FOR_TYPE[unitType];
  return avoid ? listable.filter((f) => !avoid.test(f.name ?? '')) : listable;
}

/** What a form's resource LOOKUP points at → the unit type that form books. */
const FORM_LOOKUP_TYPE: Record<string, UnitType> = {
  desks: 'workstation',
  desk: 'workstation',
  rooms: 'room',
  space: 'room',
  basespace: 'room',
  parkingstall: 'parking',
  parkinglot: 'parking',
  lockers: 'locker',
};
/** The most SPECIFIC lookup on a form decides its type: a room form that also carries a desks lookup is a room form. */
const FORM_LOOKUP_SPECIFICITY: Record<string, number> = { rooms: 0, parkingstall: 1, parkinglot: 1, lockers: 2, desks: 3, desk: 3, space: 4, basespace: 4 };

/**
 * Which unit type each form books, read from the form's OWN resource lookup fields rather than
 * its name — link names differ per org, so name patterns alone put desks and rooms on the same
 * form. Resolved once per form and cached; null when a form has no recognisable resource lookup
 * (callers fall back to the link-name matching above).
 */
const formResourceTypeCache = new Map<string, UnitType | null>();
export async function resolveFormResourceTypes(module: 'space' | 'facility', forms: BookingFormSummary[]): Promise<Map<number, UnitType | null>> {
  const out = new Map<number, UnitType | null>();
  await Promise.all(
    forms.map(async (f) => {
      const key = `${module}:${f.id}`;
      if (formResourceTypeCache.has(key)) {
        out.set(f.id, formResourceTypeCache.get(key)!);
        return;
      }
      const meta = await fetchBookingFormById(module, f.id).catch(() => null);
      let type: UnitType | null = null;
      let bestRank = Number.POSITIVE_INFINITY;
      for (const field of meta?.fields ?? []) {
        const lm = (field.lookupModule ?? '').toLowerCase();
        if (!lm || !(lm in FORM_LOOKUP_TYPE)) continue;
        const rank = FORM_LOOKUP_SPECIFICITY[lm] ?? 5;
        if (rank < bestRank) {
          bestRank = rank;
          type = FORM_LOOKUP_TYPE[lm];
        }
      }
      formResourceTypeCache.set(key, type);
      out.set(f.id, type);
    })
  );
  return out;
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

  const isRoom = isRoomLike(unit.type);
  const lookupField = isRoom ? ROOM_SPACEBOOKING_LOOKUP : SPACEBOOKING_LOOKUP[REAL_SPACE_MODULE[unit.type] ?? ''];
  if (!lookupField) return { ok: false, reason: `no spacebooking mapping for ${unit.type}` };

  let recordId: number;
  let parentModuleId: number | null;
  if (isRoom) {
    // A room IS its org `space` record — that is the id an org room carries (see zoneUnitId /
    // toUnplacedUnit). A `zone-…` outline with no space behind it has nothing to book.
    if (!/^\d+$/.test(unit.id)) return { ok: false, reason: 'this room has no space record in the org' };
    recordId = Number(unit.id);
    // The space module's id: known from the floor's own zones once one was read, else from the
    // record itself.
    parentModuleId = spaceModuleIdCache.id ?? (await moduleIdFor('space', recordId));
  } else {
    const ref = await ensureRealSpaceRecord(unit);
    if (!ref) return { ok: false, reason: 'no real backend record for this unit' };
    recordId = ref.recordId;
    parentModuleId = await moduleIdFor(REAL_SPACE_MODULE[unit.type]!, ref.recordId);
  }
  if (!parentModuleId) return { ok: false, reason: 'could not resolve parentModuleId' };

  const reservedBy = Number(input.reservedBy);
  const host = Number(input.host);
  const internal = realIds(input.internalAttendees);
  // spacebooking requires at least one internal attendee — default to the reserver when the
  // form left it empty (matches how the real form auto-adds the reserver).
  if (Number.isFinite(reservedBy) && !internal.some((a) => a.id === reservedBy)) internal.unshift({ id: reservedBy });

  if (input.resourceField && input.resourceField !== lookupField) {
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] form resource field '${input.resourceField}' -> payload field '${lookupField}' (record ${recordId})`);
  }
  // Epochs on the ORG's clock: "10:00" means 10:00 at the facility, whatever zone the browser is
  // in — and the same zone the calendar reads the record back through (see bookingRows).
  const tz = await fetchOrgTimezone().catch(() => null);
  const bookingStartTime = epochAtInTz(dateISO, start, tz);
  const bookingEndTime = epochAtInTz(input.endDateISO || dateISO, end, tz);
  if (bookingEndTime <= bookingStartTime) return { ok: false, reason: 'the end is not after the start' };

  const res = await facilioApi.createRecord<any>('spacebooking', {
    data: {
      // Unknown org-form fields first, so the mapped fields below always win on collision.
      ...(input.extras ?? {}),
      // Route the create through the org form the user filled — backend form rules apply.
      ...(input.formId ? { formId: input.formId, actionFormId: input.formId } : {}),
      [lookupField]: { id: recordId },
      parentModuleId,
      bookingStartTime,
      bookingEndTime,
      // The breach marker (start + 30 min) is sent explicitly — the backend does not derive it on this path.
      bookingbreachtime: bookingStartTime + 30 * 60_000,
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

// ---------------------------------------------------------------------------
// Bookings, org-wide: the calendar reads the org's own spacebooking records and books from
// every hot desk and reservable space in the org, not just the floor on screen.
// ---------------------------------------------------------------------------

/**
 * The org's timezone (an IANA name), resolved once per session from the account and registered
 * with the org clock (orgNow / orgTimezone) so synchronous UI code reads the facility's "now".
 * `v2/fetchAccount?optimized=true` is what Facilio's own client boots from; `v2/account` stands in
 * for older backends. Null when neither names a usable zone — the browser's zone then applies.
 */
let orgTimezoneCache: Promise<string | null> | null = null;
export function fetchOrgTimezone(): Promise<string | null> {
  if (!isFacilioApiConfigured) return Promise.resolve(null);
  if (!orgTimezoneCache) {
    orgTimezoneCache = (async () => {
      const body = (await customGet('v2/fetchAccount', { optimized: true }).catch(() => null)) ?? (await customGet('v2/account').catch(() => null));
      const account = body?.result?.account ?? body?.account ?? body?.data?.account ?? body?.result ?? null;
      const candidates: unknown[] = [account?.timezone, account?.timeZone, account?.org?.timezone, account?.org?.timeZone, account?.organisation?.timezone, account?.user?.timezone];
      const tz = candidates.find(isValidTimezone) ?? null;
      setOrgTimezone(tz);
      // eslint-disable-next-line no-console
      console.info(`[facilio-api] org timezone ${tz ?? '(none — the browser zone applies)'}`);
      return tz;
    })();
    orgTimezoneCache.catch(() => {
      orgTimezoneCache = null;
    });
  }
  return orgTimezoneCache;
}

/**
 * The signed-in user's PEOPLE id — the id space bookings are reserved by and desks are assigned to
 * (it is not the login user id). From the account payload; null when the session names none.
 */
let peopleIdCache: Promise<number | null> | null = null;
export function fetchCurrentPeopleId(): Promise<number | null> {
  if (!isFacilioApiConfigured) return Promise.resolve(null);
  if (!peopleIdCache) {
    peopleIdCache = (async () => {
      const asId = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
      for (const [path, params] of [
        ['v2/fetchAccount', { optimized: true }],
        ['v2/account', undefined],
      ] as const) {
        const body = await customGet(path, params as Record<string, unknown> | undefined).catch(() => null);
        if (!body) continue;
        const account = body?.result?.account ?? body?.account ?? body?.data?.account ?? body?.result ?? body?.data ?? body;
        const user = account?.user ?? body?.result?.user ?? body?.user ?? null;
        const id = asId(user?.peopleId ?? user?.people?.id ?? user?.peopleID);
        if (id) return id;
      }
      // eslint-disable-next-line no-console
      console.warn('[facilio-api] the account payload carried no peopleId — "my bookings" cannot be told apart');
      return null;
    })();
    peopleIdCache.catch(() => {
      peopleIdCache = null;
    });
  }
  return peopleIdCache;
}

/**
 * Whether the host page is the MAINTENANCE (admin) app, read from its path: `'maintenance'` when a
 * path segment says so, else null — never a guess at a portal's name from an arbitrary segment.
 * Null also when the URL says nothing (plain local dev, a cross-origin parent that hides its
 * location, an origin-only referrer).
 */
export function currentAppLinkName(): 'maintenance' | null {
  const candidates: string[] = [];
  try {
    candidates.push(window.top && window.top !== window ? window.top.location.pathname : window.location.pathname);
  } catch {
    /* cross-origin parent — try the referrer */
  }
  try {
    if (document.referrer) candidates.push(new URL(document.referrer).pathname);
  } catch {
    /* unparsable referrer */
  }
  const name = candidates.some((href) => href.split('/').some((seg) => seg.trim().toLowerCase() === 'maintenance')) ? 'maintenance' : null;
  if (!loggedAppLinkName) {
    loggedAppLinkName = true;
    // eslint-disable-next-line no-console
    console.info('[facilio-api] host app from the URL:', name ?? '(unknown)', candidates);
  }
  return name;
}
let loggedAppLinkName = false;

/**
 * Whether this session sees only ITS OWN bookings. Always false for now: the calendar is org-wide,
 * the admin app's view, and the user's own rows are told apart by their people id. Scoping a
 * portal user server-side wants the current application resolved from the org, not guessed from
 * the URL — a wrong guess in an admin tool would read as everyone else's bookings missing.
 */
export function bookingsScopedToUser(): boolean {
  void currentAppLinkName();
  return false;
}

/**
 * Cancelled-state ids learnt from the rows themselves: the first row seen in a cancelled state
 * teaches its id, and every later request leaves such rows out at the source. The client-side
 * check in bookingRows stays regardless — that is what makes this safe before any id is known.
 */
const cancelledStateIds = new Set<string>();

export interface BookingRangeOptions {
  /** Only the signed-in user's bookings (a server-side reservedBy filter). */
  forCurrentUser?: boolean;
  /** Only bookings of resources on these floors. */
  floorIds?: string[];
  /** Only desk bookings (`desk` set) or only room bookings (`space` set). */
  resourceField?: 'desk' | 'space';
  /** Only these records' bookings — the clash check wants ONE desk or room, not every booked one. */
  resourceIds?: string[];
}

const BOOKING_PAGE = 500;
const BOOKING_MAX_PAGES = 6;
/** How far before a range the read looks for bookings that started earlier and run into it. */
const BOOKING_LOOKBACK_DAYS = 31;

/** Which spacebooking lookup a floor module's records are booked under. */
const BOOKING_FIELD_BY_MODULE: Record<string, 'desk' | 'space' | 'parkingStall'> = { desks: 'desk', space: 'space', parkingstall: 'parkingStall' };

/**
 * Every record id of one module on a floor (all pages), or [] when the read failed. Kept for a
 * minute: the plan's day list re-reads bookings on every date change, and the floor's records
 * have not changed between two dates.
 */
const FLOOR_IDS_TTL_MS = 60_000;
const floorIdsCache = new Map<string, { at: number; ids: Promise<string[]> }>();
function floorRecordIds(moduleName: string, floorId: string): Promise<string[]> {
  const key = `${floorId}:${moduleName}`;
  const hit = floorIdsCache.get(key);
  if (hit && Date.now() - hit.at < FLOOR_IDS_TTL_MS) return hit.ids;
  const ids = (async () => {
    const load = await loadFloorList(floorId, moduleName);
    if (load.error) throw new Error(load.error.message ?? `floor ${moduleName} read failed`);
    return [...load.first, ...(await load.rest)].map((r: any) => String(r.id));
  })();
  floorIdsCache.set(key, { at: Date.now(), ids });
  // A failed read is not kept — the next caller tries again — and answers [] to this one.
  return ids.catch(() => {
    if (floorIdsCache.get(key)?.ids === ids) floorIdsCache.delete(key);
    return [] as string[];
  });
}

/**
 * The org's spacebooking rows for an INCLUSIVE date range — ONE request per page rather than one
 * per visible day — mapped to this app's bookings on the org's clock, one segment per covered day
 * (see bookingRows). Cancelled rows are left out at the source (`isCancelled IS false`, plus any
 * cancelled state ids learnt so far) and again client-side, so correctness never depends on the
 * server-side criteria: if the org rejects it, the request is retried without it.
 *
 * `floorId` scopes the result to that floor's desks, spaces and stalls (the per-floor read the
 * plan shares); null reads org-wide for the calendar.
 */
export async function fetchSpaceBookingsForRange(startISO: string, endISO: string, floorId: string | null, opts: BookingRangeOptions = {}): Promise<Booking[]> {
  const tz = await fetchOrgTimezone().catch(() => null);
  // The filter is on the START time, so a booking that began before the range and runs into it
  // would be missed — and with no cap on a booking's length that is a real double-booking. The
  // filter reaches back BOOKING_LOOKBACK_DAYS and the segments are clipped to the asked range
  // afterwards; a booking longer than that which started earlier still is missed.
  const rangeStart = epochAtInTz(isoPlusDays(startISO, -BOOKING_LOOKBACK_DAYS), 0, tz);
  const rangeEnd = epochAtInTz(endISO, 24 * 60, tz);
  const reservedById = opts.forCurrentUser ? await fetchCurrentPeopleId().catch(() => null) : null;
  const baseFilters: Record<string, unknown> = {
    // BETWEEN (operatorId 20) on the start: a booking that STARTS in the range. One that started
    // before it and runs into it is rare for desks and is not chased here.
    bookingStartTime: { operatorId: 20, value: [String(rangeStart), String(rangeEnd - 1)] },
    ...(reservedById != null ? { reservedBy: { operatorId: 36, value: [String(reservedById)] } } : {}),
    // A desk booking has its `desk` lookup set, a room booking its `space` one: "is" (36) the named
    // records, or "is not empty" (2) for the whole category.
    ...(opts.resourceIds?.length
      ? { [opts.resourceField ?? 'desk']: { operatorId: 36, value: opts.resourceIds.map(String) } }
      : opts.resourceField
        ? { [opts.resourceField]: { operatorId: 2, value: [] } }
        : {}),
  };
  const excludeCancelled: Record<string, unknown> = {
    isCancelled: { operatorId: 15, value: ['false'] },
    ...(cancelledStateIds.size ? { moduleState: { operatorId: 10, value: [...cancelledStateIds] } } : {}),
  };

  const fetchPages = async (filters: Record<string, unknown>): Promise<SpaceBookingRow[]> => {
    const acc: SpaceBookingRow[] = [];
    let withExclusion = true;
    for (let page = 1; page <= BOOKING_MAX_PAGES; page++) {
      const sent = withExclusion ? { ...filters, ...excludeCancelled } : filters;
      let res = await facilioApi.fetchAll('spacebooking', { page, perPage: BOOKING_PAGE, filters: JSON.stringify(sent) });
      if (res.error && withExclusion) {
        // eslint-disable-next-line no-console
        console.warn('[facilio-api] spacebooking: cancelled criteria rejected — refetching without it', res.error);
        withExclusion = false;
        cancelledStateIds.clear();
        res = await facilioApi.fetchAll('spacebooking', { page, perPage: BOOKING_PAGE, filters: JSON.stringify(filters) });
      }
      if (res.error) {
        if (page === 1) throw new Error(`facilio-api: spacebooking fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
        break;
      }
      const list = (res.list ?? []) as SpaceBookingRow[];
      acc.push(...list);
      if (list.length < BOOKING_PAGE) break;
    }
    return acc;
  };

  let rows: SpaceBookingRow[];
  if (opts.floorIds?.length) {
    // Filter fields AND together, so one query cannot OR across the resource lookups: the chosen
    // floors' record ids are gathered (cached per-floor reads) and each lookup gets a query of
    // its own; the results merge and dedupe.
    const idsByField: Record<string, string[]> = { desk: [], space: [], parkingStall: [] };
    await Promise.all(
      opts.floorIds.flatMap((f) =>
        Object.entries(BOOKING_FIELD_BY_MODULE).map(async ([m, field]) => {
          for (const id of await floorRecordIds(m, f)) idsByField[field].push(id);
        })
      )
    );
    const queries = Object.entries(idsByField)
      .filter(([field, ids]) => ids.length > 0 && (!opts.resourceField || field === opts.resourceField))
      .map(([field, ids]) => fetchPages({ ...baseFilters, [field]: { operatorId: 36, value: ids } }).catch(() => [] as SpaceBookingRow[]));
    const seen = new Set<string>();
    rows = (await Promise.all(queries)).flat().filter((b) => (seen.has(String(b.id)) ? false : (seen.add(String(b.id)), true)));
  } else {
    rows = await fetchPages(baseFilters);
  }

  // The read is org-wide; a floor-scoped caller wants only its own records' bookings. An empty
  // set can also mean the floor's lists failed — showing the unscoped rows beats blanking real
  // bookings then.
  const onFloor = floorId
    ? new Set((await Promise.all(Object.keys(BOOKING_FIELD_BY_MODULE).map((m) => floorRecordIds(m, floorId)))).flat())
    : null;
  for (const row of rows) {
    const cancelledId = cancelledStateIdOf(row);
    if (cancelledId) cancelledStateIds.add(cancelledId);
  }
  return clipSegmentsToRange(
    rows.flatMap((row) => bookingSegmentsFromRow(row, tz, floorId ?? '') ?? []),
    startISO,
    endISO
  ).filter((b) => !onFloor || onFloor.size === 0 || onFloor.has(b.unitId));
}

/** Org-wide bookings for an inclusive date range — the calendar's read. */
export function fetchOrgBookingsForRange(startISO: string, endISO: string, opts?: BookingRangeOptions): Promise<Booking[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  return fetchSpaceBookingsForRange(startISO, endISO, null, opts);
}

const ORG_POOL_PAGE = 500;
const ORG_POOL_MAX_PAGES = 4;

/**
 * Every bookable resource in the org — hot/hotel desks and reservable spaces — as unplaced units,
 * whatever floor they are on. The type filter rides the request (desks: deskType hot/hotel;
 * spaces: reservable); should the org reject it or answer nothing, the read is retried unfiltered
 * and the client-side eligibility check (isBookable) still decides what is offered. Session-cached;
 * `force` re-reads, which the booking form asks for on every open so its picker is never stale.
 */
let orgResourcesCache: Promise<Unit[]> | null = null;
export function fetchOrgBookableResources(opts?: { force?: boolean }): Promise<Unit[]> {
  if (!isFacilioApiConfigured) return Promise.resolve([]);
  if (opts?.force) orgResourcesCache = null;
  if (!orgResourcesCache) {
    orgResourcesCache = (async () => {
      const mods: { type: UnitType; moduleName: string; typeFilter: Record<string, unknown> }[] = [
        { type: 'workstation', moduleName: 'desks', typeFilter: { deskType: { operatorId: 9, value: ['2', '3'] } } },
        { type: 'room', moduleName: 'space', typeFilter: { reservable: { operatorId: 9, value: ['true'] } } },
      ];
      const out: Unit[] = [];
      await Promise.all(
        mods.map(async ({ type, moduleName, typeFilter }) => {
          let filtered = true;
          for (let page = 1; page <= ORG_POOL_MAX_PAGES; page++) {
            const params = { page, perPage: ORG_POOL_PAGE, isArchived: false };
            let res: any = filtered ? await facilioApi.fetchAll(moduleName, { ...params, filters: JSON.stringify(typeFilter) }).catch(() => null) : null;
            if (filtered && (!res || res.error || !Array.isArray(res.list) || (page === 1 && res.list.length === 0))) {
              if (res?.error) {
                // eslint-disable-next-line no-console
                console.warn(`[facilio-api] ${moduleName} type filter rejected — refetching unfiltered`, res.error);
              }
              filtered = false;
              res = null;
            }
            if (!filtered) res = await facilioApi.fetchAll(moduleName, params).catch(() => null);
            const list = res?.list;
            if (res?.error || !Array.isArray(list)) break;
            for (const r of list as any[]) {
              const floorId = lookupId(r, 'floor');
              out.push(toUnplacedUnit(r, type, floorId != null ? String(floorId) : ''));
            }
            if (list.length < ORG_POOL_PAGE) break;
          }
        })
      );
      return out;
    })();
    orgResourcesCache
      .then((rows) => {
        if (!rows.length) orgResourcesCache = null; // never cache "nothing" — retry on the next open
      })
      .catch(() => {
        orgResourcesCache = null;
      });
  }
  return orgResourcesCache;
}
