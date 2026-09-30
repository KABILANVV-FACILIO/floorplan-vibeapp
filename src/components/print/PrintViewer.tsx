import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { floorMeta } from '../../state/selectors';
import { orgNow } from '../../lib/orgTime';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { PrintSheet, printFileName } from './PrintSheet';
import { downloadBlob, printImages, sheetToImages, sheetToPdfBlob } from './sheetPdf';
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
 * drawn at its physical size and scaled to fit. Both buttons work from pictures of the pages shown
 * here: Download puts one on each PDF page, Print puts one on each sheet, fitted to the paper.
 *
 * The whole floor comes first; in "Floor + details" a zoomed page for every area of desks follows
 * it. The grey area scrolls through them, one page fitting in view.
 */
export function PrintViewer({ onClose, printRequest = 0 }: { onClose: () => void; /** Bumped to print straight away (Cmd+P). */ printRequest?: number }) {
  const { state, actions } = useFloorplanData();
  const meta = floorMeta(state, state.floorId);
  const floorTitle = meta ? meta.floor.name : 'Floor plan';

  const areaRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  // The pages' unscaled height (the plan page plus however many detail pages the floor needs), so
  // the frame can take the scaled size and the grey area scrolls through them.
  const [pagesH, setPagesH] = useState(PAGE_H);
  // Building the page pictures, for the PDF or for printing — a few seconds on a big floor.
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
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

  useLayoutEffect(() => {
    const el = pagesRef.current;
    if (!el) return;
    const measure = () => setPagesH(el.offsetHeight || PAGE_H);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Print the pages as drawn here — pictures of them, fitted to whatever paper the printer holds —
  // so the printout is the preview (see printImages). Should the pictures fail, the browser prints
  // the live page instead.
  async function onPrint() {
    const pages = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>('[data-print-page]') ?? []);
    if (!pages.length || busy) return;
    setBusy('print');
    setError(null);
    try {
      await printImages(await sheetToImages(pages));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[print] page images failed; printing the live page', err);
      await document.fonts?.ready;
      window.print();
    } finally {
      setBusy(null);
    }
  }

  // Cmd+P: print as soon as the pages are drawn. An effect runs after they are laid out; the short
  // timer lets a viewer opened by the key press paint first. (A timer, not animation frames, which
  // never fire in a background tab.)
  useEffect(() => {
    if (!printRequest) return;
    const t = setTimeout(() => void onPrint(), 30);
    return () => clearTimeout(t);
    // Only a new request prints; onPrint is re-created every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printRequest]);

  async function onDownload() {
    const pages = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>('[data-print-page]') ?? []);
    if (!pages.length || busy) return;
    setBusy('pdf');
    setError(null);
    try {
      const blob = await sheetToPdfBlob(pages);
      downloadBlob(blob, printFileName(floorTitle, orgNow().dateISO));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[print] PDF download failed', err);
      setError('The PDF could not be created here. Print, then choose “Save as PDF”, gives the same page.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal onClose={onClose} width={1180}>
      <ModalHeader title="Print preview" subtitle={`${floorTitle} · Landscape`} onClose={onClose} />
      <div ref={areaRef} className={styles.area}>
        {/* The frame takes the SCALED size, so the area lays out around what is visible; the page
            inside keeps its full size and is scaled from its corner. */}
        <div className={styles.frame} style={{ width: PAGE_W * scale, height: pagesH * scale, visibility: scale ? 'visible' : 'hidden' }}>
          <div className={styles.paper} style={{ transform: `scale(${scale})` }}>
            <PrintSheet preview pagesRef={pagesRef} />
          </div>
        </div>
      </div>
      <ModalFooter>
        {/* What the pages show. Floor + details: the whole floor, then a zoomed page for every area
            of desks, each desk labelled in full. Current view: the screen as it is. Whole floor:
            the floor alone. */}
        <div className={styles.scope} role="group" aria-label="Plan on page 1">
          <span className={styles.scopeLabel}>Plan</span>
          <button type="button" className={styles.scopeBtn} aria-pressed={state.printScope === 'detail'} onClick={() => actions.setPrintScope('detail')}>
            Floor + details
          </button>
          <button type="button" className={styles.scopeBtn} aria-pressed={state.printScope === 'view'} onClick={() => actions.setPrintScope('view')}>
            Current view
          </button>
          <button type="button" className={styles.scopeBtn} aria-pressed={state.printScope === 'floor'} onClick={() => actions.setPrintScope('floor')}>
            Whole floor
          </button>
        </div>
        {error && <span className={styles.error}>{error}</span>}
        <Button variant="secondary" onClick={() => void onDownload()} disabled={!!busy} icon={busy === 'pdf' ? <ButtonSpinner /> : <DownloadIcon />}>
          {busy === 'pdf' ? 'Preparing PDF…' : 'Download PDF'}
        </Button>
        <Button variant="primary" onClick={() => void onPrint()} disabled={!!busy} icon={busy === 'print' ? <ButtonSpinner /> : <PrintIcon />}>
          {busy === 'print' ? 'Preparing…' : 'Print'}
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
