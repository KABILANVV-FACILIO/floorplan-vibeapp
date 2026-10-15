import { useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { isCadFile } from '../../lib/cadPreview';
import { analyzeCadFile } from '../../lib/cadAnalyze';
import type { CadGroup } from '../../lib/cadAnalyze';
import { renderPdfToDataUrl } from '../../lib/pdfPreview';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { uploadFloorplanFile } from '../../lib/facilioApiDataSource';
import { measureImageDataUrl } from '../../lib/geoReference';
import { activateOnKey } from '../../lib/keyboard';
import styles from './FloorUploadModal.module.css';

const ACCEPT = '.png,.jpg,.jpeg,.pdf,.dwg,.dxf,image/png,image/jpeg,application/pdf';

export function FloorUploadModal() {
  const { state, actions } = useFloorplanData();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  /**
   * The upload in progress, if any. One at a time: a second file dropped mid-upload used to start
   * a second run, and whichever finished last decided the floor's plan. Held in a ref, not state,
   * so two drops in the same tick can't both see "nothing running". This component stays mounted
   * while the dialog is closed (it renders nothing then), so a cancelled run still settling is
   * remembered across a reopen.
   */
  const runRef = useRef<AbortController | null>(null);

  if (!state.uploadOpen) return null;
  const working = status === 'working';

  /**
   * Cancel, the close button, Escape and the backdrop all land here. A run in progress is told to
   * stop: whatever step it is on finishes (a request already sent can't be recalled), and it
   * goes no further — see uploadFloorplanFile for exactly what that leaves in the org.
   */
  function close() {
    const run = runRef.current;
    if (run && !run.signal.aborted) {
      run.abort();
      actions.showToast(`Upload of ${fileName ?? 'the file'} cancelled`);
    }
    setStatus('idle');
    setError(null);
    actions.setUploadOpen(false);
  }

  async function handleFile(file: File) {
    if (runRef.current) {
      actions.showToast(
        runRef.current.signal.aborted
          ? 'The cancelled upload is still stopping — try again in a moment'
          : `Still working on ${fileName ?? 'the last file'} — wait for it, or cancel it first`
      );
      return;
    }
    const run = new AbortController();
    runRef.current = run;
    try {
      await uploadOne(file, run.signal);
    } finally {
      if (runRef.current === run) runRef.current = null;
    }
  }

  async function uploadOne(file: File, signal: AbortSignal) {
    setFileName(file.name);
    setStatus('working');
    setError(null);
    const cad = isCadFile(file.name);
    try {
      const isPlainImage = /\.(png|jpe?g)$/i.test(file.name);
      // previewUrl stays null when the browser can't render the file (a DWG the CAD engine
      // chokes on) — we then rely on Facilio's server-rendered image fetched by file id.
      let previewUrl: string | null = null;
      let cadGroups: CadGroup[] = [];
      let clientRenderFailed = false;
      if (cad) {
        // One document-open pass renders the snapshot AND extracts the drawing's mappable
        // structure. If the embedded CAD engine can't parse this DWG, DON'T abort — fall
        // through and let the server render it from the uploaded file id.
        try {
          const analysis = await analyzeCadFile(file);
          previewUrl = analysis.previewUrl;
          cadGroups = analysis.groups;
        } catch (cadErr) {
          clientRenderFailed = true;
          // eslint-disable-next-line no-console
          console.warn('[FloorUploadModal] Browser CAD render failed; will try the server-rendered image', cadErr);
        }
      } else if (/\.pdf$/i.test(file.name)) {
        previewUrl = await renderPdfToDataUrl(file);
      } else if (isPlainImage) {
        previewUrl = await fileToDataUrl(file);
      } else {
        throw new Error('Unsupported file type');
      }
      // Cancelled while it was still being read here: nothing has left the browser yet.
      if (signal.aborted) return;

      let uploadedFileId: number | null = null;
      let attachedToFloorPlan = false;
      let serverImageUsed = false;
      let uploadError: string | null = null;
      if (isFacilioApiConfigured) {
        try {
          // Measured off the rendered preview when we have one (sizes the synthetic
          // geo-reference quad). No local render (CAD failed) → skip; the server sizes it.
          const dimensions = previewUrl ? await measureImageDataUrl(previewUrl).catch(() => undefined) : undefined;
          const uploaded = await uploadFloorplanFile(state.floorId, state.planId, file, dimensions, signal);
          if (signal.aborted && uploaded.attachedToFloorPlan) {
            // The cancel arrived while the floor's plan record was already being written: the org
            // has the new plan now. Showing the old one here would be the one wrong answer.
            const shown = isPlainImage ? uploaded.previewUrl : (previewUrl ?? uploaded.serverImageUrl);
            if (shown) actions.setFloorImage(state.floorId, state.planId, shown);
            actions.showToast(`Too late to cancel — ${file.name} was already saved as this floor's plan`);
            return;
          }
          if (signal.aborted) return;
          uploadedFileId = uploaded.fileId;
          attachedToFloorPlan = uploaded.attachedToFloorPlan;
          // Plain image: use the round-tripped original (proves the real round-trip).
          if (isPlainImage) previewUrl = uploaded.previewUrl;
          // No browser render (or CAD that failed) → use Facilio's server-RENDERED image by id.
          if (!previewUrl && uploaded.serverImageUrl) {
            previewUrl = uploaded.serverImageUrl;
            serverImageUsed = true;
          }
          if (!uploaded.attachedToFloorPlan) {
            // eslint-disable-next-line no-console
            console.warn('[FloorUploadModal] Uploaded to Facilio but could not attach to this floor\'s indoorfloorplan record:', uploaded.attachError);
          }
        } catch (uploadErr) {
          // Stopped between steps by Cancel — not a failure, and nothing to show.
          if (signal.aborted) return;
          // The org write failing used to be a console warning only, after which the success path
          // still toasted "Floorplan updated" — so a plan that never reached Facilio (the SDK
          // rejects anything over 10 MB outright) looked saved until someone else opened the floor.
          uploadError = (uploadErr as Error)?.message || 'upload failed';
          // eslint-disable-next-line no-console
          console.warn('[FloorUploadModal] Facilio upload failed', uploadErr);
        }
      }

      // Nothing renderable and nothing stored → the only true failure. (A stored-but-not-
      // renderable file is reported below, not thrown, so the upload isn't lost.)
      if (!previewUrl && uploadedFileId == null) {
        throw new Error(cad ? 'cad-render-failed' : 'Could not read this file.');
      }

      if (previewUrl) actions.setFloorImage(state.floorId, state.planId, previewUrl);
      // Rendered here but never stored in the org: say so and keep the modal open. The preview is
      // real, so it isn't thrown away — but it is this browser's copy only, and silently calling
      // that "uploaded to Facilio" is the one outcome the user can't detect for themselves.
      if (uploadError) {
        setStatus('error');
        setError(`Shown here, but NOT uploaded to Facilio: ${uploadError}. It won't be visible to anyone else, or after this browser's storage is cleared.`);
        return;
      }
      actions.showToast(
        uploadedFileId
          ? serverImageUsed
            ? `Rendered on the server from file #${uploadedFileId}`
            : previewUrl
              ? attachedToFloorPlan
                ? `Floorplan uploaded to Facilio (file #${uploadedFileId})`
                : `Uploaded to Facilio (file #${uploadedFileId}) — couldn't link it to this floor's plan record`
              : `Stored to Facilio (file #${uploadedFileId}) — can't preview it here; view it in AutoCAD`
          : `Floorplan updated from ${file.name}`
      );
      // A stored-but-unpreviewable CAD file: keep the modal's error visible so the user knows
      // it's saved-but-not-shown, but don't discard the upload.
      if (!previewUrl && uploadedFileId != null) {
        setStatus('error');
        setError(`Stored to Facilio (file #${uploadedFileId}), but it couldn't be rendered to an image here — open it in AutoCAD.`);
        return;
      }
      actions.setUploadOpen(false);
      setStatus('idle');
      if (cad) actions.storeCadAnalysis(state.floorId, state.planId, cadGroups);
      if (cadGroups.length > 0) {
        actions.openAutoMap(cadGroups);
      } else if (cad && !clientRenderFailed) {
        actions.showToast(`Floorplan updated from ${file.name} — no mappable CAD metadata found`);
      }
    } catch (err) {
      if (signal.aborted) return;
      setStatus('error');
      const msg = (err as Error).message;
      setError(cad || msg === 'cad-render-failed' ? 'Could not render this CAD file in the browser, and the server has no image for it. You can still store it and view it in AutoCAD.' : msg || 'Could not read this file.');
    }
  }

  function onDrop(e: ReactDragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  const browse = () => {
    if (!working) inputRef.current?.click();
  };

  return (
    <Modal onClose={close} width={460}>
      <ModalHeader title="Upload floorplan" subtitle="PNG, JPG, PDF, DWG, or DXF" onClose={close} />
      <div className={styles.body}>
        <div
          className={styles.dropzone}
          // The drop zone is also the "browse" button — reachable with Tab, opened with Enter/Space.
          role="button"
          tabIndex={0}
          aria-disabled={working || undefined}
          aria-label="Choose a floorplan file"
          style={working ? { opacity: 0.6, cursor: 'progress' } : undefined}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onClick={browse}
          onKeyDown={activateOnKey(browse)}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M17 8l-5-5-5 5M12 3v12" />
          </svg>
          <div className={styles.dzText}>Drag a file here, or click to browse</div>
          <div className={styles.dzSub}>Supports .png .jpg .pdf .dwg .dxf</div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className={styles.hiddenInput}
            disabled={working}
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Cleared, so choosing the same file again (after a failure) still fires a change.
              e.target.value = '';
              if (file) void handleFile(file);
            }}
          />
        </div>
        {status === 'working' && <p className={styles.status}>Rendering {fileName}…</p>}
        {status === 'error' && <p className={styles.error}>{error}</p>}
        <p className={styles.note}>
          DWG/DXF files render in your browser via an embedded CAD engine. If the browser can't render one, it's uploaded to Facilio and shown
          from the server-rendered image (by file id) instead.
        </p>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={close}>
          {working ? 'Cancel upload' : 'Cancel'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
