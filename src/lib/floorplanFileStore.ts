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
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredFloorplanFile;
    // Entries written before persist resolved object URLs to bytes hold a `blob:` string that died
    // with the document that made it. Rendering one shows an empty canvas that looks like a load
    // failure; drop it so the org fetch is the only source and the floor reports honestly.
    if (!stored?.dataUrl?.startsWith('data:')) {
      localStorage.removeItem(fileKey(floorId, planId));
      return null;
    }
    return stored;
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
  // Callers hand over whatever URL they happen to be rendering, and for an upload that is routinely
  // a `blob:` object URL (the connected-app round-trip and the server-rendered image both build
  // one). Those die with the document, so resolve to bytes ONCE, up front: the store gets a real
  // blob and the local fallback gets a real data URL, instead of a string that reloads as nothing.
  const blob = await urlToBlob(file.dataUrl).catch(() => null);
  if (!blob) {
    // eslint-disable-next-line no-console
    console.warn('[floorplanFile] could not read the image back from its URL; nothing persisted');
    return;
  }

  if (isVibeApp) {
    try {
      const name = file.name ?? `floorplan-${floorId}-${planId}`;
      const uploaded = await vibe.uploadFile(blob, name);
      // `storeVibeFloorplanFile` RESOLVES (rather than throwing) once the floorplanApi circuit
      // breaker has tripped — the function isn't deployed in every region. Without checking, that
      // silent no-op used to return here having written the metadata nowhere AND skipped the local
      // fallback, so every upload after the first one persisted nothing at all.
      const stored = await storeVibeFloorplanFile(floorId, planId, {
        fileId: uploaded.fileId,
        name: uploaded.fileName ?? name,
        mime: uploaded.contentType ?? file.mime ?? blob.type,
      });
      if (stored) return;
      // eslint-disable-next-line no-console
      console.info('[floorplanFile] vibe DB unavailable for the metadata row; keeping a local copy instead');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[floorplanFile] vibe save failed; falling back to this browser only', err);
    }
  }
  try {
    const dataUrl = await blobToDataUrl(blob);
    localStorage.setItem(fileKey(floorId, planId), JSON.stringify({ ...file, dataUrl }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[floorplanFile] local save failed; kept in-memory preview only', err);
  }
}

/**
 * Any renderable image URL back to bytes. `fetch` handles `data:` and `blob:` URLs natively, which
 * beats hand-rolling a base64 decode and covers both of the shapes callers pass.
 */
async function urlToBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  return res.blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
