import axios from 'axios';

const devMode = import.meta.env.VITE_DEV_MODE === 'true';
const envBaseURL = import.meta.env.VITE_FACILIO_API_BASE_URL;
const token = import.meta.env.VITE_FACILIO_TOKEN;

/**
 * Connected-app mode (VITE_IS_CONNECTED_APP=true): the app is served INSIDE a Facilio org
 * (connected app tab/iframe). Real backend access goes through the Facilio Connected-App
 * browser SDK (`FacilioAppSDK`, see `facilioAppReady` below) rather than a direct HTTP client —
 * the SDK bridges to the host org itself, so there's no bearer token, no CORS, and no
 * configurable base URL for it. This mode OVERRIDES dev mode and every other data tier: when
 * it's on, the real Facilio API tier is active unconditionally.
 */
/**
 * `?capp_id=` / `#capp_id=` and `?origin=` are set by the Facilio host when it renders the app in
 * a connected-app iframe (the same params the SDK's own `initConnectedApp` reads).
 */
function hostParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  const fromSearch = new URLSearchParams(window.location.search).get(name);
  if (fromSearch) return fromSearch;
  return new URLSearchParams(window.location.hash.replace(/^#/, '')).get(name);
}

/** True when this page is inside an iframe — i.e. something is hosting it. */
const isEmbedded = typeof window !== 'undefined' && window.self !== window.top;

/**
 * Detected at RUNTIME, with the build flag only as one of several signals.
 *
 * Whether the app is embedded is not knowable at build time — the same bundle is served both
 * standalone and inside a Facilio product — and relying on the flag meant a build made before it
 * was set reported "not configured" and silently dropped every V3 call: marker geometry, Moves,
 * org forms, file previews. Being in an iframe is sufficient on its own, so the V3 tier now comes
 * alive wherever a host actually exists, regardless of how the bundle was built.
 */
export const isConnectedApp = import.meta.env.VITE_IS_CONNECTED_APP === 'true' || !!hostParam('capp_id') || isEmbedded;

/**
 * Where the V3 APIs live for absolute-URL needs: same-origin in connected mode (unless
 * explicitly overridden), the configured URL in dev. Only used for `facilioRecordUrl` (record
 * summary links) and the two dev-mode endpoints below that need an absolute, non-`/api`-prefixed
 * URL — connected mode's real calls go through the SDK, which resolves paths itself.
 */
// When embedded, the iframe's OWN origin is the vibe host, not the org — so record-summary links
// must be built from the parent origin the host handed us, falling back to same-origin for a
// classic connected app served from inside the org itself.
const absoluteBaseURL = isConnectedApp ? envBaseURL || `${hostParam('origin') ?? window.location.origin}/api` : envBaseURL;

/** True in connected-app mode (SDK bridge), or in dev mode with base URL + token set. */
export const isFacilioApiConfigured = isConnectedApp || (devMode && !!envBaseURL && !!token);

if (!isFacilioApiConfigured && devMode) {
  // eslint-disable-next-line no-console
  console.warn(
    '[facilioApi] VITE_DEV_MODE is true but VITE_FACILIO_API_BASE_URL / VITE_FACILIO_TOKEN are not both set — the Facilio API tier is disabled, falling back to the app db / mock tiers.'
  );
}

export const apiOrigin: string | null = absoluteBaseURL ? new URL(absoluteBaseURL).origin : null;

/**
 * Builds a link to a record's summary page in the real Facilio web app (e.g.
 * `https://pre-app-stage2.facilio.in/maintenance/goto/summary/employee/123`), matching the
 * `RECORD URL` convention documented on the CMMS actions.
 */
export function facilioRecordUrl(moduleName: string, id: string | number): string | null {
  if (!apiOrigin) return null;
  return `${apiOrigin}/maintenance/goto/summary/${moduleName}/${id}`;
}

// ---------------------------------------------------------------------------
// Dev-mode transport: talks directly to a live org over a bearer token, routed through the vite
// '/fapi' proxy (see vite.config.ts) to dodge CORS. Connected-app mode never touches this axios
// instance — the SDK bridge below handles that case entirely on its own. The URL/envelope
// conventions this file's `dev*` helpers use were copied from the actually-installed
// `@facilio/api` package (node_modules/@facilio/api/dist/index.mjs) rather than guessed, so
// dev-mode behavior is unchanged from before this file stopped depending on that package.
// ---------------------------------------------------------------------------
const devBaseURL = devMode && envBaseURL ? '/fapi' : envBaseURL;
const devInstance =
  !isConnectedApp && isFacilioApiConfigured
    ? (() => {
        const instance = axios.create({ baseURL: devBaseURL });
        instance.interceptors.request.use((config) => {
          config.headers = config.headers ?? {};
          (config.headers as Record<string, string>)['x-api-key'] = token!;
          return config;
        });
        return instance;
      })()
    : null;

/** `{code:0,...}` -> `{...body,error:null}`; else -> `{data:null,error:{code,message,...}}`. Matches `@facilio/api`'s own envelope handling for `v3/modules/...` responses. */
function v3Envelope(body: any): { error: any; [k: string]: any } {
  if (body && body.code === 0) return { ...body, error: null };
  const { code, message, ...rest } = body || {};
  const error: Record<string, unknown> = { ...rest };
  if (code !== undefined) error.code = code;
  if (message !== undefined) error.message = message;
  return { data: null, error };
}

async function devFetchAll(moduleName: string, params: Record<string, unknown> = {}): Promise<FacilioApiListResult> {
  const viewName = (params as { viewName?: string }).viewName;
  const url = `v3/modules/${moduleName}${viewName ? `/view/${viewName}` : ''}`;
  const res = await devInstance!.get(url, { params: { ...params, moduleName } });
  const env = v3Envelope(res.data);
  if (env.error) return { ...env, list: null };
  const { [moduleName]: list, ...rest } = env;
  return { ...rest, error: null, list: (list as unknown[] | undefined) ?? null };
}

async function devFetchRecord<T = any>(moduleName: string, params: { id: string | number; [k: string]: unknown }): Promise<FacilioApiResult<T>> {
  const url = `v3/modules/${moduleName}/${params.id}`;
  const res = await devInstance!.get(url, { params: { ...params, moduleName } });
  return v3Envelope(res.data);
}

async function devCreateRecord<T = any>(moduleName: string, params: { data: Record<string, unknown> }): Promise<FacilioApiResult<T>> {
  const res = await devInstance!.post(`v3/modules/${moduleName}`, { ...params, moduleName });
  return v3Envelope(res.data);
}

async function devUpdateRecord<T = any>(moduleName: string, params: { id: string | number; data: Record<string, unknown> }): Promise<FacilioApiResult<T>> {
  const res = await devInstance!.patch(`v3/modules/${moduleName}/${params.id}`, { ...params, moduleName });
  return v3Envelope(res.data);
}

async function devDeleteRecord<T = any>(moduleName: string, id: string | number): Promise<FacilioApiResult<T>> {
  const res = await devInstance!.delete(`v3/modules/${moduleName}/${id}`, {
    data: { moduleName, data: { [moduleName]: [id] } },
  });
  return v3Envelope(res.data);
}

async function devFetchAllRelatedList<T = any>(
  opts: { moduleName: string; id: string | number; relatedModuleName: string; relatedFieldName: string },
  params: Record<string, unknown> = {}
): Promise<FacilioApiListResult<T>> {
  const url = `v3/modules/${opts.moduleName}/${opts.id}/relatedList/${opts.relatedModuleName}/${opts.relatedFieldName}`;
  const res = await devInstance!.get(url, { params });
  const env = v3Envelope(res.data);
  if (env.error) return { ...env, list: null };
  const { [opts.relatedModuleName]: list, ...rest } = env;
  return { ...rest, error: null, list: ((list as unknown[] | undefined) ?? null) as T[] | null };
}

async function devUploadSingleFile(file: File): Promise<{ fileId: number } | { error: Error }> {
  const form = new FormData();
  form.append('files', file, file.name);
  form.append('fileNames', file.name);
  form.append('contentTypes', file.type);
  const res = await devInstance!.post('v3/modules/data/files', form);
  const body = res.data;
  if (!body || body.code !== 0) return { error: new Error(body?.message || 'facilio-api: upload failed') };
  const fileId = body.attachments?.[file.name];
  if (fileId == null) return { error: new Error('facilio-api: upload response missing file id') };
  return { fileId: Number(fileId) };
}

// ---------------------------------------------------------------------------
// Connected-app transport: FacilioAppSDK, loaded lazily from Facilio's CDN only when running as
// a connected app (so local/dev mode stays fully offline-capable — see README). Per
// https://facilio.com/developers/docs/connected-apps: calling API methods before "app.loaded"
// fires fails silently, so every call below goes through this readiness gate rather than
// assuming the app is ready. Untyped (`any`) throughout — the SDK ships no type declarations,
// same as `@facilio/api` before it.
// ---------------------------------------------------------------------------
const FACILIO_SDK_URL = 'https://static.facilio.com/apps-sdk/beta/facilio_apps_sdk.min.js';

/**
 * `app.loaded` only ever fires when a Facilio host is actually on the other side of the iframe.
 * Opening the app's own URL directly satisfies every other condition — the flag is on, the SDK
 * loads, `init()` succeeds — and then the handshake simply never completes. Without a deadline
 * that promise neither resolves nor rejects, so CompositeDataSource awaits it forever and the
 * canvas hangs instead of falling through to the tier below. Time out and reject instead.
 */
const SDK_HANDSHAKE_TIMEOUT_MS = 8000;

let sdkReady: Promise<any> | null = null;
function facilioAppReady(): Promise<any> {
  if (sdkReady) return sdkReady;

  // No iframe parent means no host can ever answer the handshake, so don't wait out the timeout —
  // this tier now leads for every call, and an 8s stall per call would make a standalone open feel
  // broken. Decided once and cached, so the fallthrough afterwards is instant.
  if (typeof window !== 'undefined' && window.self === window.top) {
    sdkReady = Promise.reject(new Error('facilio-api: not embedded in a Facilio host (no connected-app parent)'));
    // Nothing awaits this until a caller does; mark it handled so it isn't an unhandled rejection.
    sdkReady.catch(() => {});
    return sdkReady;
  }

  sdkReady = new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // The rejection is deliberately CACHED rather than cleared: a host that never completed the
    // handshake won't complete it on the next call either, and re-arming the timer would make
    // every subsequent request pay the full timeout again.
    const timer = setTimeout(() => {
      done(() => reject(new Error('facilio-api: connected-app handshake timed out (host did not respond)')));
    }, SDK_HANDSHAKE_TIMEOUT_MS);

    const start = () => {
      try {
        const app = (window as any).FacilioAppSDK.init();
        (window as any).facilioApp = app;
        app.on('app.loaded', () => done(() => resolve(app)));
      } catch (err) {
        done(() => reject(err));
      }
    };
    if ((window as any).FacilioAppSDK) {
      start();
      return;
    }
    const script = document.createElement('script');
    script.src = FACILIO_SDK_URL;
    script.async = true;
    script.onload = start;
    script.onerror = () => done(() => reject(new Error('facilio-api: failed to load FacilioAppSDK from CDN')));
    document.head.appendChild(script);
  });
  return sdkReady;
}

export interface FacilioApiResult<T = any> {
  data?: T | null;
  error: { code?: number | string; message?: string; isCancelled?: boolean } | null;
  [key: string]: any;
}
export interface FacilioApiListResult<T = any> extends FacilioApiResult<T[]> {
  list: T[] | null;
}

async function crudFetchAll(moduleName: string, params: Record<string, unknown> = {}): Promise<FacilioApiListResult> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    return app.api.fetchAll(moduleName, params);
  }
  return devFetchAll(moduleName, params);
}

async function crudFetchRecord<T = any>(moduleName: string, params: { id: string | number; [k: string]: unknown }): Promise<FacilioApiResult<T>> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    return app.api.fetchRecord(moduleName, params);
  }
  return devFetchRecord<T>(moduleName, params);
}

async function crudCreateRecord<T = any>(moduleName: string, params: { data: Record<string, unknown> }): Promise<FacilioApiResult<T>> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    return app.api.createRecord(moduleName, params);
  }
  return devCreateRecord<T>(moduleName, params);
}

async function crudUpdateRecord<T = any>(moduleName: string, params: { id: string | number; data: Record<string, unknown> }): Promise<FacilioApiResult<T>> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    return app.api.updateRecord(moduleName, params);
  }
  return devUpdateRecord<T>(moduleName, params);
}

async function crudDeleteRecord<T = any>(moduleName: string, id: string | number): Promise<FacilioApiResult<T>> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    return app.api.deleteRecord(moduleName, { id });
  }
  return devDeleteRecord<T>(moduleName, id);
}

async function crudFetchAllRelatedList<T = any>(
  opts: { moduleName: string; id: string | number; relatedModuleName: string; relatedFieldName: string },
  params: Record<string, unknown> = {}
): Promise<FacilioApiListResult<T>> {
  if (isConnectedApp) {
    // The connected-app SDK exposes no dedicated related-list call (only generic module CRUD) —
    // approximated by filtering the related module on the parent lookup field. NOT verified
    // against a live org; the dev-mode path above uses the real `relatedList` V3 endpoint
    // instead (verified — see the `@facilio/api` source this was copied from) since dev mode
    // still talks to the org directly.
    const app = await facilioAppReady();
    const filters = JSON.stringify({ [opts.relatedFieldName]: { operatorId: 36, value: [String(opts.id)] } });
    return app.api.fetchAll(opts.relatedModuleName, { ...params, filters });
  }
  return devFetchAllRelatedList<T>(opts, params);
}

async function connectedUploadSingleFile(file: File): Promise<{ fileId: number } | { error: Error }> {
  const app = await facilioAppReady();
  const res = await app.api.uploadFile(file);
  if (!res?.fileId) return { error: new Error('facilio-api: upload failed') };
  return { fileId: Number(res.fileId) };
}

async function crudUploadFiles(files: File[]): Promise<{ error: Error | null; ids?: (string | number)[]; data?: unknown }> {
  if (!files.length) return { error: new Error('File(s) not valid') };
  const result = isConnectedApp ? await connectedUploadSingleFile(files[0]) : await devUploadSingleFile(files[0]);
  if ('fileId' in result) return { error: null, ids: [result.fileId] };
  return { error: result.error ?? null };
}

/** Drop-in replacement for the old `@facilio/api` `API` object — same method names/shapes, dispatching per-mode internally. */
export const facilioApi = {
  fetchAll: crudFetchAll,
  fetchRecord: crudFetchRecord,
  createRecord: crudCreateRecord,
  updateRecord: crudUpdateRecord,
  deleteRecord: crudDeleteRecord,
  fetchAllRelatedList: crudFetchAllRelatedList,
  uploadFiles: crudUploadFiles,
};

/**
 * GET a custom (non-module) V3/V2 endpoint's JSON body, verbatim — no envelope unwrapping;
 * callers do their own `.data.xxx` (v3) / `.result.xxx` (v2) extraction, matching how these
 * endpoints actually respond on the wire (same as before this file stopped using raw axios
 * exclusively). Works in both dev and connected-app mode.
 *
 * `opts.devAbsoluteUrl`, when set, is used only in dev mode in place of `path` — some endpoints
 * live directly off the org's bare origin rather than under the configured API baseURL (see
 * call sites in facilioApiDataSource.ts for why). Connected mode never needs this: `path` is
 * always resolved by the SDK relative to the org itself.
 *
 * Connected mode goes through `invokeFacilioAPI`, which the SDK docs mark deprecated but still
 * working for endpoints with no dedicated module-CRUD equivalent, and which returns a JSON
 * STRING rather than a parsed object — parsed here. NOT verified against a live org: whether
 * GET query params are read from `data` isn't documented, so they're encoded into the URL's
 * query string directly instead, sidestepping the question.
 */
export async function customGet(path: string, params?: Record<string, unknown>, opts?: { devAbsoluteUrl?: string }): Promise<any> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    const query = params && Object.keys(params).length ? `?${new URLSearchParams(params as Record<string, string>).toString()}` : '';
    const raw = await app.api.invokeFacilioAPI(`${path}${query}`, { method: 'GET' });
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  const res = await devInstance!.get(opts?.devAbsoluteUrl ?? path, { params });
  return res.data;
}

/** POST version of `customGet` — same verbatim-body contract and the same caveats. */
export async function customPost(path: string, data?: Record<string, unknown>, opts?: { devAbsoluteUrl?: string }): Promise<any> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    const raw = await app.api.invokeFacilioAPI(path, { method: 'POST', data });
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  const res = await devInstance!.post(opts?.devAbsoluteUrl ?? path, data);
  return res.data;
}

/**
 * A stored file's bytes, for display. Dev mode returns the raw blob (as before — callers run it
 * through their own image/PDF/CAD rendering as needed). Connected mode has no blob/binary
 * access at all (per the SDK docs) — only `common.toBase64({fileId})`, which returns a bare
 * base64 string documented for "displaying attachments and signatures" without specifying the
 * underlying image format, so callers get a ready-to-use data URL back instead of a blob.
 *
 * NOT verified against a live org: `toBase64` collapses the old original-vs-server-rendered
 * distinction (`fetchOriginal` had no equivalent found in the SDK docs) — a DWG/DXF/PDF
 * uploaded in connected-app mode gets whatever single representation `toBase64` returns, which
 * may differ from the previously separate "original bytes" vs "server-rasterized" behavior.
 */
export async function fetchFilePreview(fileId: number, opts?: { original?: boolean }): Promise<{ dataUrl: string | null; blob?: Blob; contentType?: string }> {
  if (isConnectedApp) {
    const app = await facilioAppReady();
    const base64 = await app.common.toBase64({ fileId });
    return { dataUrl: base64 ? `data:image/png;base64,${base64}` : null };
  }
  const res = await devInstance!.get(`v2/files/preview/${fileId}`, {
    params: opts?.original ? { fetchOriginal: true } : undefined,
    responseType: 'blob',
  });
  return { dataUrl: null, blob: res.data, contentType: res.headers?.['content-type'] };
}
