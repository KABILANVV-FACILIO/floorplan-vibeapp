import { apiOrigin, customGet, customPost, facilioApi, fetchFilePreview, isFacilioApiConfigured } from './facilioApi';
import { renderCadToDataUrl } from './cadPreview';
import { renderPdfToDataUrl } from './pdfPreview';
import { computeSyntheticGeometry, geometryStringToQuad, lngLatToQuadFraction, quadToGeometryString, quadToLngLat } from './geoReference';
import type { FloorplanDataSource } from './dataSource';
import type { Asset } from './assets';
import type { Assignments, Booking, Employee, PlanId, PointGeom, Site, Unit, UnitType } from './types';

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
 * `indoorfloorplan.geometry`; those are now read by `getUnits` and written by `saveUnits` (via
 * `saveFloorplanMarkers`), which is what puts real placed units on the canvas.
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
  async getPortfolio(): Promise<Site[]> {
    this.assertConfigured();
    const [sites, buildings, floors] = await Promise.all([fetchAllPaged('site'), fetchAllPaged('building'), fetchAllPaged('floor')]);

    const bySite = new Map<string, any[]>();
    for (const b of buildings) {
      const key = String(lookupId(b, 'site'));
      bySite.set(key, [...(bySite.get(key) ?? []), b]);
    }
    const byBuilding = new Map<string, any[]>();
    for (const f of floors) {
      const key = String(lookupId(f, 'building'));
      byBuilding.set(key, [...(byBuilding.get(key) ?? []), f]);
    }
    const orphanBuildings = buildings.filter((b) => !sites.some((s) => String(s.id) === String(lookupId(b, 'site')))).length;
    const orphanFloors = floors.filter((f) => !buildings.some((b) => String(b.id) === String(lookupId(f, 'building')))).length;
    // eslint-disable-next-line no-console
    console.info(`[facilio-api] getPortfolio: ${sites.length} sites, ${buildings.length} buildings, ${floors.length} floors` + (orphanBuildings || orphanFloors ? ` (unmatched: ${orphanBuildings} buildings, ${orphanFloors} floors — lookup shape?)` : ''));

    // Deliberately NOT calling getFloorplanDetailsByType here for every floor — that's an
    // N-request fan-out across the whole portfolio for data only the *currently selected*
    // floor needs. See `getFloorPlanSummary` below, called lazily on floor selection instead.
    return sortByName(sites).map((s: any) => ({
      id: String(s.id),
      name: s.name,
      buildings: sortByName(bySite.get(String(s.id)) ?? []).map((b: any) => ({
        id: String(b.id),
        name: b.name,
        floors: sortByName(byBuilding.get(String(b.id)) ?? []).map((f: any) => ({
          id: String(f.id),
          name: f.name,
          // Unknown until getFloorPlanSummary runs for this floor; true is the safer
          // default so the canvas isn't hidden behind "No floorplan yet" pre-emptively.
          hasPlan: true,
        })),
      })),
    }));
  }

  async getEmployees(): Promise<Employee[]> {
    this.assertConfigured();
    const res = await facilioApi.fetchAll('employee');
    if (res.error) throw new Error(`facilio-api: employee fetch failed (${res.error.code ?? '?'} ${res.error.message ?? ''})`.trim());
    return (res.list ?? []).map((e: any) => ({
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
    const rows: any[] = body?.asset ?? [];
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
    const byType = await getFloorplanDetailsByType(floorId);
    const units: Unit[] = [];

    for (const [typeNum, summary] of Object.entries(byType)) {
      const planId = PLAN_ID_BY_TYPE[Number(typeNum)];
      const planRecordId = (summary as any)?.id;
      if (!planId || !planRecordId) continue;

      const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: planRecordId });
      const quad = geometryStringToQuad(recordRes?.indoorfloorplan?.geometry);
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
        const point = parsePointGeometry(marker.geometry);
        if (!point) continue; // polygons/zones live in floorplanmarkedzone, not here
        const [x, y] = lngLatToQuadFraction(quad, point[0], point[1]);
        const props = safeJson<{ unitType?: string; secondary?: string | null }>(marker.properties) ?? {};
        const type = (props.unitType as Unit['type']) ?? PLAN_UNIT_TYPE[planId] ?? 'workstation';
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
    return units;
  }

  /** Positions are persisted as real floorplanmarker records — the same path the save bar uses. */
  async saveUnits(floorId: string, units: Unit[]): Promise<void> {
    this.assertConfigured();
    await saveFloorplanMarkers(floorId, units);
  }
  // Space creation is wired on the CMMS connector tier (create-space), not this raw module-CRUD
  // layer — throw so the composite falls through to it.
  async createUnit(): Promise<Unit> {
    throw new Error('facilio-api: space creation goes through the CMMS connector — not wired here');
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
async function getFloorplanDetailsByType(floorId: string): Promise<Record<string, any>> {
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
  if (!isFacilioApiConfigured) return [];
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
  if (!isFacilioApiConfigured || !apiOrigin) return null;
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
    if (floorRes.error || !floorRes.floor) throw new Error(floorRes.error?.message || `floor ${floorId} not found`);
    const floorRec = floorRes.floor;
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
export async function saveFloorplanMarkers(floorId: string, units: Unit[]): Promise<void> {
  if (!isFacilioApiConfigured) return;
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
    if (!summary?.id) continue;
    await syncMarkersForIndoorFloorPlan(summary.id, byPlan.get(planId) ?? []).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[facilio-api] marker sync failed for plan ${planId}`, err);
    });
  }
}

async function syncMarkersForIndoorFloorPlan(indoorFloorPlanId: number, units: (Unit & { geom: PointGeom })[]): Promise<void> {
  // See the matching comment in uploadFloorplanFile — `fetchRecord` nests the record under
  // `res[moduleName]` (`res.indoorfloorplan` here), not `res.data`.
  const recordRes = await facilioApi.fetchRecord<any>('indoorfloorplan', { id: indoorFloorPlanId });
  if (recordRes.error || !recordRes.indoorfloorplan) return;
  const quad = geometryStringToQuad(recordRes.indoorfloorplan.geometry);
  if (!quad) return;

  const existingRes = await facilioApi.fetchAllRelatedList<any>({
    moduleName: 'indoorfloorplan',
    id: indoorFloorPlanId,
    relatedModuleName: 'floorplanmarker',
    relatedFieldName: 'indoorfloorplan',
  });
  if (existingRes.error) {
    // eslint-disable-next-line no-console
    console.warn(`[facilio-api] fetching existing markers failed for plan ${indoorFloorPlanId}`, existingRes.error);
    return; // bail rather than risk creating duplicates against a list we couldn't actually verify.
  }
  const existing = existingRes.list ?? [];
  const existingByGeoId = new Map(existing.map((m) => [m.geoId, m]));
  const seenGeoIds = new Set<string>();

  for (const unit of units) {
    const [lng, lat] = quadToLngLat(quad, unit.geom.x, unit.geom.y);
    const geometry = JSON.stringify({ type: 'Point', coordinates: [lng, lat] });
    const properties = JSON.stringify({ unitType: unit.type, secondary: unit.secondary ?? null });
    seenGeoIds.add(unit.id);
    const match = existingByGeoId.get(unit.id);
    if (match) {
      if (match.geometry !== geometry || match.label !== unit.label) {
        // `facilioApi` resolves (doesn't reject) on a failed request — the failure shows up
        // as `res.error`, not a rejected promise, so a bare `.catch()` here would never catch
        // a real validation error; check `.error` explicitly and log it instead.
        const res = await facilioApi.updateRecord('floorplanmarker', { id: match.id, data: { geometry, properties, label: unit.label, type: 'Point' } });
        if (res.error) {
          // eslint-disable-next-line no-console
          console.warn(`[facilio-api] marker update failed for unit ${unit.id}`, res.error);
        }
      }
    } else {
      const res = await facilioApi.createRecord('floorplanmarker', {
        data: { geoId: unit.id, geometry, properties, type: 'Point', label: unit.label, indoorfloorplan: { id: indoorFloorPlanId } },
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
    const quad = geometryStringToQuad(recordRes.indoorfloorplan?.geometry);
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
        type: 'Point',
        label: unit.label,
        indoorfloorplan: { id: summary.id },
      },
    });
    if (createMarkerRes.error || !createMarkerRes.floorplanmarker?.id) return null;
    marker = createMarkerRes.floorplanmarker;
  }

  const floorRes = await facilioApi.fetchRecord<any>('floor', { id: unit.floor });
  if (floorRes.error || !floorRes.floor) return null;
  const siteId = Number(lookupId(floorRes.floor, 'site')) || undefined;
  const buildingId = lookupId(floorRes.floor, 'building');

  if (marker.recordId) {
    const ref = { recordId: marker.recordId, siteId };
    realSpaceRecordCache.set(unit.id, ref);
    return ref;
  }

  const createRes = await facilioApi.createRecord<any>(moduleName, {
    data: { name: unit.label, site: { id: siteId }, building: { id: buildingId }, floor: { id: unit.floor } },
  });
  if (createRes.error || !createRes[moduleName]?.id) return null;
  const recordId = createRes[moduleName].id;
  await facilioApi.updateRecord('floorplanmarker', { id: marker.id, data: { recordId } }).catch(() => {});
  const ref = { recordId, siteId };
  realSpaceRecordCache.set(unit.id, ref);
  return ref;
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
  if (!isFacilioApiConfigured) return null;
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
  const id = res?.[moduleName]?.moduleId;
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
  return { ok: true, id: res.spacebooking?.id };
}
