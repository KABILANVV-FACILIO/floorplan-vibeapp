/**
 * This browser's copy of an uploaded floorplan source file (an image, or a rasterized snapshot of a
 * PDF/CAD file), so a floor drawn from an upload survives a refresh where the org has no plan image
 * of its own to read back — chiefly offline `npm run dev` and the demo floors. A floor in Facilio
 * reads its plan from the org's `indoorfloorplan` record, which the upload writes.
 *
 * There was an app-database tier ahead of this one (a metadata row in the vibe DB, the bytes in the
 * app's file store). Its function could never be deployed — it ran DDL the app's database login
 * may not — so it was switched off and then removed; while off, each upload still sent its bytes to
 * the file store with no row to find them by.
 *
 * `dataUrl` is always something an `<img>` can render: a real data URL.
 */
export interface StoredFloorplanFile {
  /** A renderable URL — a data URL. */
  dataUrl: string;
  name?: string;
  mime?: string;
}

const LS_PREFIX = 'facilio_floorplan_file_v1:';
const fileKey = (floorId: string, planId: string) => `${LS_PREFIX}${floorId}::${planId}`;

/** Reads a previously-uploaded floorplan file for a floor+plan back. */
export async function loadFloorplanFile(floorId: string, planId: string): Promise<StoredFloorplanFile | null> {
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
  // one). Those die with the document, so resolve to bytes first, and keep a real data URL instead
  // of a string that reloads as nothing.
  const blob = await urlToBlob(file.dataUrl).catch(() => null);
  if (!blob) {
    // eslint-disable-next-line no-console
    console.warn('[floorplanFile] could not read the image back from its URL; nothing persisted');
    return;
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
