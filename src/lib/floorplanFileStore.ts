import { isVibeApp, vibe } from './vibe';
import { fetchVibeFloorplanFile, listVibeFloorplanFloors, storeVibeFloorplanFile } from './vibeDbDataSource';

/**
 * Persistence for an uploaded floorplan source file (an image, or a rasterized snapshot of a
 * PDF/CAD file), so the app can reload it after a refresh.
 *
 * As a vibe app the bytes go to the app's file store (`vibe.uploadFile`, which returns a durable
 * `fileId`) and only the small metadata record — the fileId, name and mime — is written to the vibe
 * DB. That split matters: a rasterized floor plan routinely exceeds the ~5MB localStorage budget the
 * previous build was stuck with, and the file store has no such cap.
 *
 * Outside a vibe app (offline `npm run dev`) it degrades to the old localStorage copy, so the seed
 * dataset still behaves.
 *
 * Callers see one shape either way: `dataUrl` is always something an `<img>` can render — a real
 * data URL from localStorage, or an object URL over the blob downloaded from the file store.
 */
export interface StoredFloorplanFile {
  /** A renderable URL — a data URL from local storage, or an object URL over the stored blob. */
  dataUrl: string;
  /** Durable handle in the app's vibe file store, when the bytes live there. */
  fileId?: number | null;
  name?: string;
  mime?: string;
}

const LS_PREFIX = 'facilio_floorplan_file_v1:';
const fileKey = (floorId: string, planId: string) => `${LS_PREFIX}${floorId}::${planId}`;

/** The metadata row held in the vibe DB — deliberately tiny, the bytes live in the file store. */
interface StoredFileRecord {
  fileId?: number | null;
  name?: string;
  mime?: string;
  /** Only set by the localStorage path; a vibe row never inlines bytes. */
  dataUrl?: string;
}

/**
 * Reads a previously-uploaded floorplan file for a floor+plan back.
 *
 * Falls through to the local copy when the app store can't answer — the vibe DB addon isn't
 * available in every region, and a plan that silently stops surviving a refresh is worse than one
 * that persists per-browser.
 */
export async function loadFloorplanFile(floorId: string, planId: string): Promise<StoredFloorplanFile | null> {
  if (isVibeApp) {
    const row = await fetchVibeFloorplanFile<StoredFileRecord>(floorId, planId).catch(() => null);
    if (row?.fileId) {
      const blob = await vibe.downloadFile(row.fileId).catch(() => null);
      if (blob) return { dataUrl: URL.createObjectURL(blob), fileId: row.fileId, name: row.name, mime: row.mime };
    } else if (row?.dataUrl) {
      return { dataUrl: row.dataUrl, name: row.name, mime: row.mime };
    }
  }
  return loadLocalFloorplanFile(floorId, planId);
}

function loadLocalFloorplanFile(floorId: string, planId: string): StoredFloorplanFile | null {
  try {
    const raw = localStorage.getItem(fileKey(floorId, planId));
    return raw ? (JSON.parse(raw) as StoredFloorplanFile) : null;
  } catch {
    return null;
  }
}

/**
 * Floor ids that have at least one stored floorplan file — keys only, no blobs. Lets the
 * portfolio tree stop showing "no plan" for floors whose upload lives in the store.
 */
export async function listFloorplanFloorIds(): Promise<string[]> {
  if (isVibeApp) {
    const ids = await listVibeFloorplanFloors().catch(() => []);
    if (ids.length) return ids;
    // fall through to the local scan — see loadFloorplanFile
  }
  try {
    const ids: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LS_PREFIX)) {
        const floorId = key.slice(LS_PREFIX.length).split('::')[0];
        if (floorId) ids.push(floorId);
      }
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * Persists an uploaded floorplan file so the app reloads it after a refresh. Best-effort: a failure
 * is swallowed — the in-memory preview still shows for the session.
 */
export async function persistFloorplanFile(floorId: string, planId: string, file: StoredFloorplanFile): Promise<void> {
  if (isVibeApp) {
    try {
      const blob = await dataUrlToBlob(file.dataUrl);
      const name = file.name ?? `floorplan-${floorId}-${planId}`;
      const uploaded = await vibe.uploadFile(blob, name);
      await storeVibeFloorplanFile(floorId, planId, {
        fileId: uploaded.fileId,
        name: uploaded.fileName ?? name,
        mime: uploaded.contentType ?? file.mime ?? blob.type,
      });
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[floorplanFile] vibe save failed; falling back to this browser only', err);
    }
  }
  try {
    localStorage.setItem(fileKey(floorId, planId), JSON.stringify(file));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[floorplanFile] local save failed; kept in-memory preview only', err);
  }
}

/**
 * A `data:` URL back to bytes. `fetch` handles data URLs natively, which beats hand-rolling the
 * base64 decode — and it is the same path an object URL would take.
 */
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}
