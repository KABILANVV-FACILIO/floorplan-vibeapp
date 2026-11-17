import { isVibeApp, vibe } from './vibe';

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
 * org actually recoloured), so writing the whole blob rather than a delta costs nothing. (A table
 * of its own, one row per department, sat ahead of these behind the `floorplanApi` function; that
 * function could never be deployed and was removed.)
 */

const LS_KEY = 'facilio_floorplan_department_colors_v1';
const COLORS_FILE = 'floorplan-department-colors.json';

/** Department record id -> the colour someone chose, plus the name for a reader's benefit. */
export type DepartmentColorScheme = Record<string, { name: string; color: string }>;

export async function loadDepartmentColors(): Promise<DepartmentColorScheme> {
  if (isVibeApp) {
    const fromFile = await loadColorsFile().catch(() => null);
    if (fromFile) {
      // eslint-disable-next-line no-console
      console.info('[departments] colours loaded from the app file store');
      return fromFile;
    }
  }
  return loadLocalColors() ?? {};
}

/** Persist one department's colour. Takes the whole scheme too: both tiers store it as a single blob. */
export async function saveDepartmentColor(
  departmentId: string,
  departmentName: string,
  color: string,
  scheme: DepartmentColorScheme,
): Promise<void> {
  if (isVibeApp) {
    if (await saveColorsFile(scheme).catch(() => false)) return;
    // eslint-disable-next-line no-console
    console.warn('[departments] no server tier accepted the colour; keeping it in this browser only');
  }
  saveLocalColors(scheme);
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
  const files = await vibe.listFiles();
  // listFiles is newest-first, so the first match is the current one.
  const current = files.find((f) => f.fileName === COLORS_FILE);
  if (!current) return null;
  const text = await (await vibe.downloadFile(current.fileId)).text();
  return JSON.parse(text) as DepartmentColorScheme;
}

/** Returns false when the store couldn't take it, so the caller falls through. */
async function saveColorsFile(scheme: DepartmentColorScheme): Promise<boolean> {
  const blob = new Blob([JSON.stringify(scheme, null, 2)], { type: 'application/json' });
  const uploaded = await vibe.uploadFile(blob, COLORS_FILE);
  if (!uploaded?.fileId) return false;
  // An upload never overwrites, so every save would otherwise leave another copy behind.
  void pruneOldColorFiles(uploaded.fileId).catch(() => {});
  return true;
}

async function pruneOldColorFiles(keepFileId: number): Promise<void> {
  const files = await vibe.listFiles();
  for (const f of files) {
    if (f.fileName === COLORS_FILE && f.fileId !== keepFileId) await vibe.deleteFile(f.fileId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Browser tier
// ---------------------------------------------------------------------------

function loadLocalColors(): DepartmentColorScheme | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as DepartmentColorScheme) : null;
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
