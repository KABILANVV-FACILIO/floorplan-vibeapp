import type { EnabledModules, MarkerDef, Perms } from './types';
import type { AppState } from '../state/types';
import { isVibeApp } from './vibe';
import { fetchVibeSettings, storeVibeSettings } from './vibeDbDataSource';

/**
 * The app's persisted settings.
 *
 * As a vibe app these live in the app's own database (a single row, written through the
 * `floorplanApi` function) so a permission change or a recolored module follows the user to every
 * device instead of being stranded in one browser. Outside a vibe app — offline `npm run dev` —
 * they fall back to localStorage, which is also the safety net if the DB write fails.
 */
export interface SettingsConfig {
  perms?: Perms;
  moduleColors?: Record<string, string>;
  /** Per-module option toggles, keyed `${unitType}.${optKey}`. */
  slotGranularity?: number;
  bookingModule?: 'space' | 'facility';
  /** User-created marker-library entries (Edit view › Markers › New marker). */
  customMarkers?: MarkerDef[];
  /** Which modules the org runs. A disabled one is hidden app-wide (Settings › Modules). */
  enabledModules?: EnabledModules;
}

const LS_KEY = 'facilio_floorplan_settings_v1';

/** Extract the persisted slice of app state. */
export function settingsFromState(state: AppState): SettingsConfig {
  return {
    perms: state.perms,
    moduleColors: state.moduleColors,
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
    const stored = await fetchVibeSettings<SettingsConfig>().catch(() => null);
    if (stored) return stored;
  }
  return loadLocalSettings();
}

export async function saveSettings(cfg: SettingsConfig): Promise<void> {
  if (isVibeApp) {
    try {
      await storeVibeSettings(cfg);
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[settings] vibe save failed; falling back to this browser only', err);
    }
  }
  saveLocalSettings(cfg);
}

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
