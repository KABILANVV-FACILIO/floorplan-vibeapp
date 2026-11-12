import type { Access, EnabledModules, FirstResponder, MarkerDef, ParkingPrint, PlanLabel, PlanLabels, ResponderRoleDef } from './types';
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
 * the browser instead of being taken for a save. (An app-database tier once sat ahead of it, behind
 * the `floorplanApi` function; that function could never be deployed and was removed. The settings
 * a browser must not write — the access grid, the first responders — live behind floorplanResponders
 * instead; see lib/sharedSettings.)
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
   * Per-department colours are NOT here: they live in their own table (`fp_department_color`),
   * keyed by the department's record id, so other readers can use the scheme without unpacking
   * this blob. Only the mode above is an app preference.
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
  /** The parking register printed after a parking plan (print window › Details), for everyone. */
  parkingPrint?: ParkingPrint;
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
    parkingPrint: state.parkingPrint,
    labelStyle: state.labelStyle,
    // Not when the app database holds them: one source, never two (see lib/sharedSettings).
    ...(state.respondersInDb ? {} : { firstResponders: state.firstResponders, responderRoles: state.responderRoles }),
  };
}

/** Serialize to the multi-line JSON string that gets stored. */
export function serializeSettings(cfg: SettingsConfig): string {
  return JSON.stringify(cfg, null, 2);
}

export async function loadSettings(): Promise<SettingsConfig | null> {
  if (isVibeApp) {
    const fromFile = await loadSettingsFile().catch(() => null);
    if (fromFile) {
      // eslint-disable-next-line no-console
      console.info('[settings] loaded from the app file store');
      return fromFile;
    }
  }
  return loadLocalSettings();
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

/** The newest settings blob in the store, or null when there isn't one. */
async function loadSettingsFile(): Promise<SettingsConfig | null> {
  const files = await vibe.listFiles();
  // listFiles is newest-first, so the first match is the current one.
  const current = files.find((f) => f.fileName === SETTINGS_FILE);
  if (!current) return null;
  const blob = await vibe.downloadFile(current.fileId);
  const text = await blob.text();
  return JSON.parse(text) as SettingsConfig;
}

/** Returns false when the store couldn't take it, so the caller falls through. */
async function saveSettingsFile(cfg: SettingsConfig): Promise<boolean> {
  const blob = new Blob([serializeSettings(cfg)], { type: 'application/json' });
  const uploaded = await vibe.uploadFile(blob, SETTINGS_FILE);
  if (!uploaded?.fileId) return false;
  // An upload never overwrites, so every save would otherwise leave another copy behind. Prune the
  // superseded ones; a failure here is cosmetic, the newest file is already the live one.
  void pruneOldSettingsFiles(uploaded.fileId).catch(() => {});
  return true;
}

async function pruneOldSettingsFiles(keepFileId: number): Promise<void> {
  const files = await vibe.listFiles();
  for (const f of files) {
    if (f.fileName === SETTINGS_FILE && f.fileId !== keepFileId) await vibe.deleteFile(f.fileId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Browser tier
// ---------------------------------------------------------------------------

function loadLocalSettings(): SettingsConfig | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as SettingsConfig) : null;
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
