import { isVibeApp, vibe } from './vibe';
import { listStoredFiles, parseStored, pruneOlderCopies } from './settingsStore';

/**
 * Where the org's department -> marker colour scheme lives, keyed by the department's RECORD ID.
 *
 * The same two tiers as the settings blob (lib/settingsStore), in the same order:
 *
 *   1. the app FILE STORE — the whole scheme as one JSON blob. Durable and org-wide, which is
 *      what actually matters to the person choosing the colours.
 *   2. localStorage — offline `npm run dev`, and the last resort when the file store fails.
 *
 * Writes go to the best tier that accepts them. The map is small (one entry per department the
 * org actually recoloured), so writing the whole blob rather than a delta costs nothing.
 *
 * Running as a vibe app with the app database answering, the scheme lives there instead, behind
 * the floorplanResponders function (lib/sharedSettings saveDepartmentColorScheme, the
 * 'departmentColors' row), where only admins and roles given Settings can change it. The file-store
 * copy is then written after each save the function took, for the builds still deployed that read
 * only the file, and read only while the database holds no scheme yet.
 */

const LS_KEY = 'facilio_floorplan_department_colors_v1';
const COLORS_FILE = 'floorplan-department-colors.json';

/** Department record id -> the colour someone chose, plus the name for a reader's benefit. */
export type DepartmentColorScheme = Record<string, { name: string; color: string }>;

/**
 * The stored scheme, made safe to draw (sanitizeDepartmentColors) — {} when there is none.
 * REJECTS when the file store could not be read: that is not "no colours", and a save built on it
 * would replace every department's colour (see lib/settingsStore loadSettings).
 */
export async function loadDepartmentColors(): Promise<DepartmentColorScheme> {
  if (isVibeApp) {
    const fromFile = await loadColorsFile();
    if (fromFile) {
      // eslint-disable-next-line no-console
      console.info('[departments] colours loaded from the app file store');
      return fromFile;
    }
  }
  return loadLocalColors() ?? {};
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * A stored scheme made safe to draw: entries keyed by a department id, each with a `#RRGGBB`
 * colour; anything else is left out (the file store is writable by every user of the app). A
 * scheme this app wrote passes unchanged. Null for something that is not a scheme at all.
 */
export function sanitizeDepartmentColors(raw: unknown): DepartmentColorScheme | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: DepartmentColorScheme = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || id.length > 200 || !v || typeof v !== 'object') continue;
    const { name, color } = v as { name?: unknown; color?: unknown };
    if (typeof color !== 'string' || !HEX_COLOR.test(color)) continue;
    out[id] = { name: typeof name === 'string' ? name.slice(0, 200) : '', color };
  }
  return out;
}

/**
 * Persist the whole scheme — any number of changed colours in ONE write. Both tiers store it as a
 * single blob, so it must already hold every department's colour, changed and unchanged.
 */
export async function saveDepartmentColors(scheme: DepartmentColorScheme): Promise<void> {
  if (isVibeApp) {
    if (await saveColorsFile(scheme).catch(() => false)) return;
    // eslint-disable-next-line no-console
    console.warn('[departments] no server tier accepted the colours; keeping them in this browser only');
  }
  saveLocalColors(scheme);
}

/** Persist one department's colour. Takes the whole scheme too: both tiers store it as a single blob. */
export async function saveDepartmentColor(
  _departmentId: string,
  _departmentName: string,
  _color: string,
  scheme: DepartmentColorScheme,
): Promise<void> {
  return saveDepartmentColors(scheme);
}

/** Drop a department's colour so it falls back to the app's default wheel. */
export async function resetDepartmentColor(departmentId: string, scheme: DepartmentColorScheme): Promise<void> {
  if (isVibeApp) {
    if (await saveColorsFile(scheme).catch(() => false)) return;
  }
  saveLocalColors(scheme);
}

// ---------------------------------------------------------------------------
// File-store tier
// ---------------------------------------------------------------------------

async function loadColorsFile(): Promise<DepartmentColorScheme | null> {
  const files = await listStoredFiles();
  // listFiles is newest-first, so the first match is the current one.
  const current = files.find((f) => f.fileName === COLORS_FILE);
  if (!current) return null;
  const text = await (await vibe.downloadFile(current.fileId)).text();
  return sanitizeDepartmentColors(parseStored(text, COLORS_FILE));
}

/** Returns false when the store couldn't take it, so the caller falls through. */
async function saveColorsFile(scheme: DepartmentColorScheme): Promise<boolean> {
  const blob = new Blob([JSON.stringify(scheme, null, 2)], { type: 'application/json' });
  const uploaded = await vibe.uploadFile(blob, COLORS_FILE);
  if (!uploaded?.fileId) return false;
  // An upload never overwrites, so every save would otherwise leave another copy behind. Only the
  // copies older than this one go — never a newer one another save just made (pruneOlderCopies).
  void pruneOlderCopies(COLORS_FILE, uploaded).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Browser tier
// ---------------------------------------------------------------------------

function loadLocalColors(): DepartmentColorScheme | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? sanitizeDepartmentColors(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveLocalColors(scheme: DepartmentColorScheme): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(scheme));
  } catch {
    // A full or blocked store is not worth failing a colour change over.
  }
}
