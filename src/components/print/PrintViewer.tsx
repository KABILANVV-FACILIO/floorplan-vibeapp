import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { floorMeta } from '../../state/selectors';
import { orgNow } from '../../lib/orgTime';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { PrintSheet, printFileName } from './PrintSheet';
import { downloadBlob, sheetToPdfBlob } from './sheetPdf';
import styles from './PrintViewer.module.css';

/** The page's layout size in CSS px — letter landscape at 96px per inch. */
const PAGE_W = 11 * 96;
const PAGE_H = 8.5 * 96;
/** Breathing room around the page inside the grey preview area. */
const GUTTER = 24;

/**
 * What the toolbar's print button opens: the sheet as it will come out, with Print and Download
 * PDF beside it — instead of going straight to the browser's dialog, which offers no download
 * without a detour through "Save as PDF", and on some setups prints the page without its colours.
 *
 * The page on screen IS the sheet (PrintSheet in `preview` mode, same component, same styles),
 * drawn at its physical size and scaled to fit. Print hands over to the browser, which prints the
 * app's hidden paper copy of the same sheet — this dialog is portaled to <body>, and the print
 * stylesheet hides everything there. Download rasterises the page shown here.
 */
export function PrintViewer({ onClose }: { onClose: () => void }) {
  const { state } = useFloorplan();
  const meta = floorMeta(state, state.floorId);
  const floorTitle = meta ? meta.floor.name : 'Floor plan';

  const areaRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fit the whole page in the preview area, never larger than life.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const fit = () =>
      setScale(Math.max(0.1, Math.min(1, (area.clientWidth - GUTTER * 2) / PAGE_W, (area.clientHeight - GUTTER * 2) / PAGE_H)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(area);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onDownload() {
    const page = pageRef.current;
    if (!page || downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const blob = await sheetToPdfBlob(page);
      downloadBlob(blob, printFileName(floorTitle, orgNow().dateISO));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[print] PDF download failed', err);
      setError('The PDF could not be created here. Print, then choose “Save as PDF”, gives the same page.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Modal onClose={onClose} width={1180}>
      <ModalHeader title="Print preview" subtitle={`${floorTitle} · Letter, landscape`} onClose={onClose} />
      <div ref={areaRef} className={styles.area}>
        {/* The frame takes the SCALED size, so the area lays out around what is visible; the page
            inside keeps its full size and is scaled from its corner. */}
        <div className={styles.frame} style={{ width: PAGE_W * scale, height: PAGE_H * scale, visibility: scale ? 'visible' : 'hidden' }}>
          <div className={styles.paper} style={{ transform: `scale(${scale})` }}>
            <PrintSheet preview pageRef={pageRef} />
          </div>
        </div>
      </div>
      <ModalFooter>
        {error && <span className={styles.error}>{error}</span>}
        <Button variant="secondary" onClick={() => void onDownload()} disabled={downloading} icon={downloading ? <ButtonSpinner /> : <DownloadIcon />}>
          {downloading ? 'Preparing PDF…' : 'Download PDF'}
        </Button>
        <Button variant="primary" onClick={() => window.print()} disabled={downloading} icon={<PrintIcon />}>
          Print
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </svg>
  );
}

function PrintIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9V3h12v6" />
      <rect x="4" y="9" width="16" height="8" rx="2" />
      <path d="M8 17h8v4H8z" />
    </svg>
  );
}
