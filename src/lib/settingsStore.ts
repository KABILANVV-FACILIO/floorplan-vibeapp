import type { EnabledModules, MarkerDef, Perms } from './types';
import type { AppState } from '../state/types';
import { isVibeApp, vibe } from './vibe';
import { fetchVibeSettings, storeVibeSettings } from './vibeDbDataSource';

/**
 * The app's persisted settings, stored server-side so a permission change or a recolored module
 * follows the user to every device instead of being stranded in one browser.
 *
 * Three tiers, in order:
 *
 * 1. the app's DATABASE, via the `floorplanApi` function — one row, the natural home for this;
 * 2. the app's FILE STORE, as a single JSON blob — the database addon cannot be provisioned in
 *    every region (Azure AE answers 500 to `vibe db create`), and the file store is a separate
 *    addon that works there. Uploads are never overwritten, so the newest copy of the settings
 *    file wins and older ones are pruned behind it;
 * 3. localStorage — offline `npm run dev`, and the last resort when both server tiers fail.
 *
 * Every tier reports whether it actually wrote. That matters more than it sounds: the DB helpers
 * RESOLVE rather than throw once their circuit breaker trips, so a "success" that wrote nothing
 * used to stop the chain dead and leave the settings saved nowhere at all.
 */
export interface SettingsConfig {
  perms?: Perms;
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
}

const LS_KEY = 'facilio_floorplan_settings_v1';
/** The settings blob's name in the app file store. */
const SETTINGS_FILE = 'floorplan-settings.json';

/** Extract the persisted slice of app state. */
export function settingsFromState(state: AppState): SettingsConfig {
  return {
    perms: state.perms,
    moduleColors: state.moduleColors,
    colorBy: state.colorBy,
    slotGranularity: state.slotGranularity,
    bookingModule: state.bookingModule,
    customMarkers: state.customMarkers,
    enabledModules: state.enabledModules,
  };
}

/** Serialize to the multi-line JSON string that gets stored. */
export function serializeSettings(cfg: SettingsConfig): string {
  return JSON.stringify(cfg, null, 2);
}

export async function loadSettings(): Promise<SettingsConfig | null> {
  if (isVibeApp) {
    const fromDb = await fetchVibeSettings<SettingsConfig>().catch(() => null);
    if (fromDb) {
      // eslint-disable-next-line no-console
      console.info('[settings] loaded from the app database');
      return fromDb;
    }
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
    // `storeVibeSettings` resolves false when the function isn't deployed in this region — that is
    // a no-op, not a save, so the chain has to continue rather than return here.
    const toDb = await storeVibeSettings(cfg).catch(() => false);
    if (toDb) return;

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
