import type { Access, EnabledModules, FirstResponder, MarkerDef, ParkingPrint, PlanLabel, PlanLabels, RegisterKind, RegisterPrint, ResponderRoleDef, SurfaceAccess } from './types';
import { DEFAULT_ENABLED_MODULES, LABELLED_TYPES, SURFACES } from './types';
import type { AppState } from '../state/types';
import type { LabelStyle } from './labelLayout';
import { isVibeApp, vibe } from './vibe';

/**
 * The app's persisted settings, stored server-side so a permission change or a recolored module
 * follows the user to every device instead of being stranded in one browser.
 *
 * Two tiers, in order:
 *
 * 1. the app's FILE STORE, as a single JSON blob. Uploads are never overwritten, so the newest copy
 *    of the settings file wins and older ones are pruned behind it;
 * 2. localStorage — offline `npm run dev`, and the last resort when the file store fails.
 *
 * The file store reports whether it actually wrote, so a write that went nowhere falls through to
 * the browser instead of being taken for a save.
 *
 * Running as a vibe app with the app database answering, these tiers are no longer where the
 * settings live: the floorplanResponders function keeps them (lib/sharedSettings), and the file
 * store holds a copy written after each save the function took — for the builds still deployed that
 * read only the file — and is read only for a part the database holds no row for yet (an org whose
 * settings nobody has saved since the move). See FloorplanContext's settings autosave.
 */
export interface SettingsConfig {
  /**
   * Which roles reach which tab. Replaces the old `perms` key, which described three ACTIONS for a
   * fixed three roles; a blob still carrying that key is ignored rather than translated — the
   * surfaces changed meaning, so there is nothing faithful to carry across.
   */
  access?: Access;
  moduleColors?: Record<string, string>;
  /** Whether desk markers are coloured by availability or by department (Settings › Desks). */
  colorBy?: 'status' | 'department';
  /*
   * Per-department colours are NOT here: the scheme is stored on its own, keyed by the
   * department's record id (lib/departmentColorStore; the app database's 'departmentColors' row),
   * so a colour change never rewrites this blob. Only the mode above is an app preference.
   */
  slotGranularity?: number;
  bookingModule?: 'space' | 'facility';
  /** User-created marker-library entries (Edit view › Markers › New marker). */
  customMarkers?: MarkerDef[];
  /** Which modules the org runs. A disabled one is hidden app-wide (Settings › Modules). */
  enabledModules?: EnabledModules;
  /** What desks, stalls and rooms say on the plan (Settings › Desks / Parking / Rooms › Label on the plan). */
  planLabels?: Partial<PlanLabels>;
  /** The parking label alone, as v68–v69 stored it: read when `planLabels` has none; no longer written. */
  parkingLabel?: PlanLabel;
  /** The registers printed after a plan (print window › Details), one per kind, for everyone. */
  printRegisters?: Partial<Record<RegisterKind, Partial<RegisterPrint>>>;
  /** The parking register alone, as v68–v71 stored it: read when `printRegisters` has none; no longer written. */
  parkingPrint?: ParkingPrint;
  /** What the plan's page shows (print window › Print settings › Plan), for everyone; Floor + details until set. */
  printScope?: AppState['printScope'];
  /** The type the desk labels are drawn in (Settings › Desks › Desk labels). */
  labelStyle?: LabelStyle;
  /** The org's first aiders and floor wardens (Settings › First responders). */
  firstResponders?: FirstResponder[];
  /** The responder roles, built-in and the org's own, with their badges (Settings › First responders). */
  responderRoles?: ResponderRoleDef[];
}

const LS_KEY = 'facilio_floorplan_settings_v1';
/** The settings blob's name in the app file store. */
const SETTINGS_FILE = 'floorplan-settings.json';

/** Extract the persisted slice of app state. */
export function settingsFromState(state: AppState): SettingsConfig {
  return {
    // Not once the app database holds the grid: there only its function can write it (see
    // lib/sharedSettings), and a copy here would be one any browser can overwrite.
    ...(state.accessStoredInDb ? {} : { access: state.access }),
    moduleColors: state.moduleColors,
    colorBy: state.colorBy,
    slotGranularity: state.slotGranularity,
    bookingModule: state.bookingModule,
    customMarkers: state.customMarkers,
    enabledModules: state.enabledModules,
    planLabels: state.planLabels,
    printRegisters: state.printRegisters,
    printScope: state.printScope,
    labelStyle: state.labelStyle,
    // Not when the app database holds them: one source, never two (see lib/sharedSettings).
    ...(state.respondersInDb ? {} : { firstResponders: state.firstResponders, responderRoles: state.responderRoles }),
  };
}

/**
 * The print window's keys (print › Print settings), stored apart from the rest in the app database:
 * the window keeps them "for everyone who prints", so anyone who prints may change them, while the
 * rest is for admins and roles given Settings. `parkingPrint` is v68–v71's: read, never written.
 */
export const PRINT_KEYS = ['printScope', 'printRegisters', 'parkingPrint'] as const satisfies readonly (keyof SettingsConfig)[];
const PRINT_KEY_SET = new Set<string>(PRINT_KEYS);

/** A settings blob as the app database stores it: the print window's keys, and everything else. */
export function splitSettings(cfg: SettingsConfig): { settings: SettingsConfig; print: SettingsConfig } {
  const settings: Record<string, unknown> = {};
  const print: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (value === undefined) continue;
    (PRINT_KEY_SET.has(key) ? print : settings)[key] = value;
  }
  return { settings: settings as SettingsConfig, print: print as SettingsConfig };
}

/** Serialize to the multi-line JSON string that gets stored. */
export function serializeSettings(cfg: SettingsConfig): string {
  return JSON.stringify(cfg, null, 2);
}

/**
 * The stored settings, made safe to apply (sanitizeSettings) — or null when there are none: no
 * settings file in the store and no copy in this browser.
 *
 * REJECTS when the store could not be read (listing or downloading the file failed). That is not
 * "no settings": a caller that took it for one would save the defaults over the org's settings on
 * the next change, so it must hold off saving until a read succeeds.
 */
export async function loadSettings(): Promise<SettingsConfig | null> {
  if (isVibeApp) {
    const fromFile = await loadSettingsFile();
    if (fromFile) {
      // eslint-disable-next-line no-console
      console.info('[settings] loaded from the app file store');
      return fromFile;
    }
  }
  return loadLocalSettings();
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SURFACE_IDS = new Set<string>(SURFACES.map((x) => x.id));
const MODULE_KEYS = new Set<string>(Object.keys(DEFAULT_ENABLED_MODULES));
const REGISTER_KINDS = ['workstation', 'parking', 'locker', 'room'] as const satisfies readonly RegisterKind[];
const REGISTER_ROWS = new Set(['all', 'assigned', 'vacant']);
const REGISTER_SORTS = new Set(['name', 'status', 'dept', 'emp']);
const PRINT_SCOPES = new Set(['detail', 'view', 'floor']);
/** The schemes a custom marker's image may be loaded from — what every user's browser will fetch. */
const MARKER_IMAGE = /^(https:\/\/|data:image\/)/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const inRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

function cleanPlanLabel(raw: unknown): Partial<PlanLabel> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Partial<PlanLabel> = {};
  if (shortText(raw.field, 120)) out.field = raw.field;
  if (typeof raw.showHolder === 'boolean') out.showHolder = raw.showHolder;
  return out;
}

function cleanRegister(raw: unknown): Partial<RegisterPrint> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Partial<RegisterPrint> = {};
  if (typeof raw.register === 'boolean') out.register = raw.register;
  if (Array.isArray(raw.cols)) out.cols = raw.cols.filter((c): c is string => shortText(c, 60)).slice(0, 60);
  if (typeof raw.rows === 'string' && REGISTER_ROWS.has(raw.rows)) out.rows = raw.rows as RegisterPrint['rows'];
  if (typeof raw.sort === 'string' && REGISTER_SORTS.has(raw.sort)) out.sort = raw.sort as RegisterPrint['sort'];
  return out;
}

function cleanLabelLine(raw: unknown): { size: number; weight: number } | undefined {
  if (!isObject(raw)) return undefined;
  const out: Partial<{ size: number; weight: number }> = {};
  if (inRange(raw.size, 1, 100)) out.size = raw.size;
  if (inRange(raw.weight, 1, 1000)) out.weight = raw.weight;
  // Merged over the defaults by the reducer, so a part is enough.
  return out as { size: number; weight: number };
}

function cleanMarker(raw: unknown): MarkerDef | null {
  if (!isObject(raw) || !shortText(raw.id, 120) || !raw.id || !shortText(raw.name, 200) || typeof raw.color !== 'string' || !HEX_COLOR.test(raw.color)) return null;
  const out: MarkerDef = { id: raw.id, name: raw.name, color: raw.color };
  if (typeof raw.text === 'string') out.text = raw.text.slice(0, 2);
  if (shortText(raw.icon, 40)) out.icon = raw.icon as MarkerDef['icon'];
  // An image anyone's browser will load: https or an inline image only, never another scheme.
  if (typeof raw.img === 'string' && raw.img.length <= 200_000 && MARKER_IMAGE.test(raw.img.trim())) out.img = raw.img;
  return out;
}

/**
 * A stored settings blob made safe to apply. The file store is writable by every user of the app,
 * and the blob is applied as it reads — so whatever is not a setting this app knows, in the shape
 * it writes, is left out: unknown keys, values of the wrong type, colours that are not `#RRGGBB`, a
 * marker image from anywhere but https or an inline image. A blob this app wrote passes unchanged.
 *
 * The responders and their roles pass as lists only: the reducer cleans them itself
 * (sanitizeResponders / sanitizeRoles), against the roles they must name.
 */
export function sanitizeSettings(raw: unknown): SettingsConfig | null {
  if (!isObject(raw)) return null;
  const out: SettingsConfig = {};
  if (isObject(raw.access)) {
    const access: Access = {};
    for (const [surface, rule] of Object.entries(raw.access)) {
      if (!SURFACE_IDS.has(surface) || !isObject(rule) || typeof rule.all !== 'boolean') continue;
      const roles = Array.isArray(rule.roles) ? rule.roles.filter((r): r is string => shortText(r, 60)) : [];
      access[surface as keyof Access] = { all: rule.all, roles } as SurfaceAccess;
    }
    out.access = access;
  }
  if (isObject(raw.moduleColors)) {
    out.moduleColors = Object.fromEntries(Object.entries(raw.moduleColors).filter(([k, v]) => k.length <= 80 && typeof v === 'string' && HEX_COLOR.test(v))) as Record<string, string>;
  }
  if (raw.colorBy === 'status' || raw.colorBy === 'department') out.colorBy = raw.colorBy;
  if (inRange(raw.slotGranularity, 1, 1440) && Number.isInteger(raw.slotGranularity)) out.slotGranularity = raw.slotGranularity;
  if (raw.bookingModule === 'space' || raw.bookingModule === 'facility') out.bookingModule = raw.bookingModule;
  if (Array.isArray(raw.customMarkers)) out.customMarkers = raw.customMarkers.map(cleanMarker).filter((m): m is MarkerDef => !!m);
  if (isObject(raw.enabledModules)) {
    out.enabledModules = Object.fromEntries(Object.entries(raw.enabledModules).filter(([k, v]) => MODULE_KEYS.has(k) && typeof v === 'boolean')) as EnabledModules;
  }
  if (isObject(raw.planLabels)) {
    const labels: Partial<PlanLabels> = {};
    for (const k of LABELLED_TYPES) {
      const l = cleanPlanLabel(raw.planLabels[k]);
      if (l) labels[k] = l as PlanLabel;
    }
    out.planLabels = labels;
  }
  const parkingLabel = cleanPlanLabel(raw.parkingLabel);
  if (parkingLabel) out.parkingLabel = parkingLabel as PlanLabel;
  if (isObject(raw.printRegisters)) {
    const registers: Partial<Record<RegisterKind, Partial<RegisterPrint>>> = {};
    for (const k of REGISTER_KINDS) {
      const r = cleanRegister(raw.printRegisters[k]);
      if (r) registers[k] = r;
    }
    out.printRegisters = registers;
  }
  const parkingPrint = cleanRegister(raw.parkingPrint);
  if (parkingPrint) out.parkingPrint = parkingPrint as ParkingPrint;
  if (typeof raw.printScope === 'string' && PRINT_SCOPES.has(raw.printScope)) out.printScope = raw.printScope as SettingsConfig['printScope'];
  if (isObject(raw.labelStyle)) {
    const name = cleanLabelLine(raw.labelStyle.name);
    const detail = cleanLabelLine(raw.labelStyle.detail);
    if (name || detail) out.labelStyle = { ...(name ? { name } : {}), ...(detail ? { detail } : {}) } as LabelStyle;
  }
  if (Array.isArray(raw.firstResponders)) out.firstResponders = raw.firstResponders as FirstResponder[];
  if (Array.isArray(raw.responderRoles)) out.responderRoles = raw.responderRoles as ResponderRoleDef[];
  return out;
}

export async function saveSettings(cfg: SettingsConfig): Promise<void> {
  if (isVibeApp) {
    if (await saveSettingsFile(cfg).catch(() => false)) return;
    // eslint-disable-next-line no-console
    console.warn('[settings] no server tier accepted the write; keeping a copy in this browser only');
  }
  saveLocalSettings(cfg);
}

// ---------------------------------------------------------------------------
// File-store tier
// ---------------------------------------------------------------------------

let listing: ReturnType<typeof vibe.listFiles> | null = null;

/**
 * The file store's listing for a READ, shared by the reads asking at the same moment — the settings
 * and the department colours are read together at boot, and each listing the store is a call for
 * the same answer. Never kept past its answer: a save lists afresh (pruneOlderCopies).
 */
export function listStoredFiles(): ReturnType<typeof vibe.listFiles> {
  if (!listing) {
    listing = vibe.listFiles();
    const clear = () => {
      listing = null;
    };
    listing.then(clear, clear);
  }
  return listing;
}

/**
 * The newest settings blob in the store, made safe to apply; null when there isn't one, or when
 * what is there is not a settings blob at all (unreadable JSON — the next save replaces it). A
 * listing or download that FAILS rejects: see loadSettings.
 */
async function loadSettingsFile(): Promise<SettingsConfig | null> {
  const files = await listStoredFiles();
  // listFiles is newest-first, so the first match is the current one.
  const current = files.find((f) => f.fileName === SETTINGS_FILE);
  if (!current) return null;
  const blob = await vibe.downloadFile(current.fileId);
  return sanitizeSettings(parseStored(await blob.text(), SETTINGS_FILE));
}

/** A stored blob's JSON, or null (said once in the console) when it is not JSON. */
export function parseStored(text: string, fileName: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[settings] ${fileName} in the app file store is not valid JSON — ignored`);
    return null;
  }
}

/** Returns false when the store couldn't take it, so the caller falls through. */
async function saveSettingsFile(cfg: SettingsConfig): Promise<boolean> {
  const blob = new Blob([serializeSettings(cfg)], { type: 'application/json' });
  const uploaded = await vibe.uploadFile(blob, SETTINGS_FILE);
  if (!uploaded?.fileId) return false;
  // An upload never overwrites, so every save would otherwise leave another copy behind. Prune the
  // superseded ones; a failure here is cosmetic, the newest file is already the live one.
  void pruneOlderCopies(SETTINGS_FILE, uploaded).catch(() => {});
  return true;
}

/**
 * Delete the copies of `fileName` OLDER than the one just uploaded (`keep`) — never a newer one.
 * Two saves close together (two tabs, two admins) each prune after their own upload; deleting
 * "every other copy" let the first delete the second's, newer, copy. Older is decided by the
 * store's own upload times: a copy uploaded strictly before `keep`. When either time is unknown
 * nothing is deleted — an extra copy is harmless (the newest is the one read), a lost one is not.
 */
export async function pruneOlderCopies(fileName: string, keep: { fileId: number; uploadedTime?: number | null }): Promise<void> {
  const files = await vibe.listFiles();
  const keptAt = files.find((f) => f.fileId === keep.fileId)?.uploadedTime ?? keep.uploadedTime ?? null;
  if (keptAt == null) return;
  for (const f of files) {
    if (f.fileName !== fileName || f.fileId === keep.fileId) continue;
    if (f.uploadedTime == null || !(f.uploadedTime < keptAt)) continue;
    await vibe.deleteFile(f.fileId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Browser tier
// ---------------------------------------------------------------------------

function loadLocalSettings(): SettingsConfig | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveLocalSettings(cfg: SettingsConfig): void {
  try {
    localStorage.setItem(LS_KEY, serializeSettings(cfg));
  } catch {
    /* ignore quota/serialization errors */
  }
}
