import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { floorMeta } from '../../state/selectors';
import { orgNow } from '../../lib/orgTime';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import { PrintSheet, printFileName } from './PrintSheet';
import { downloadBlob, printImages, sheetToImages, sheetToPdfBlob } from './sheetPdf';
import { PrintDetails } from './PrintDetails';
import { useRegister } from './useRegister';
import type { AppState } from '../../state/types';
import styles from './PrintViewer.module.css';

/** The page's layout size in CSS px — letter landscape at 96px per inch. */
const PAGE_W = 11 * 96;
const PAGE_H = 8.5 * 96;
/** Breathing room around the page inside the grey preview area. */
const GUTTER = 24;
/** The plan's page, as Print settings › Plan names it — under the title, so the choice in force is in view. */
const SCOPE_NAME: Record<AppState['printScope'], string> = { detail: 'Floor + details', view: 'Current view', floor: 'Whole floor' };
/** The preview's zoom, as a share of the page fitted in view: down to 40% of it (pages side by side in view), up to 4× life size. */
const ZOOM_MIN = 0.4;
const SCALE_MAX = 4;
/** One press of − or +. */
const ZOOM_STEP = 1.25;
const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl ';

/**
 * What the toolbar's print button opens: the sheet as it will come out, with Print and Download
 * PDF beside it — instead of going straight to the browser's dialog, which offers no download
 * without a detour through "Save as PDF", and on some setups prints the page without its colours.
 *
 * The page on screen IS the sheet (PrintSheet in `preview` mode, same component, same styles),
 * drawn at its physical size and scaled to fit. Both buttons work from pictures of the pages shown
 * here: Download puts one on each PDF page, Print puts one on each sheet, fitted to the paper.
 *
 * The whole floor comes first; in "Floor + details" a zoomed page for every area of desks (stalls on a parking plan, lockers on a locker one) follows
 * it. The grey area scrolls through them, one page fitting in view.
 */
export function PrintViewer({ onClose, printRequest = 0 }: { onClose: () => void; /** Bumped to print straight away (Cmd+P). */ printRequest?: number }) {
  const { state } = useFloorplanData();
  const meta = floorMeta(state, state.floorId);
  const floorTitle = meta ? meta.floor.name : 'Floor plan';

  const areaRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  // The page fitted in view, and the zoom over it (− / +, a trackpad pinch, Ctrl/⌘ + − 0).
  const [fit, setFit] = useState(0);
  const [zoom, setZoom] = useState(1);
  const scale = fit * zoom;
  const fitRef = useRef(0);
  const zoomRef = useRef(1);
  // The page point to keep under the pointer (or the middle, from the buttons) once the new size is
  // laid out, and where in the grey area it sat.
  const anchorRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  // The pages' unscaled height (the plan page plus however many detail pages the floor needs), so
  // the frame can take the scaled size and the grey area scrolls through them.
  const [pagesH, setPagesH] = useState(PAGE_H);
  // Building the page pictures, for the PDF or for printing — a few seconds on a big floor.
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
  // "Page 12 of 48": a big floor's pictures take a while, and a button that only says
  // "Preparing…" for a minute reads as stuck.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const onProgress = (done: number, total: number) => setProgress(total > 1 ? { done, total } : null);
  const progressText = progress ? ` page ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : '';
  const [error, setError] = useState<string | null>(null);
  // Every plan prints registers after it — desks and rooms, stalls, lockers — and Details chooses
  // what each lists. The labels the plan reads them by, per kind, for the window's columns.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const labelFields = {
    workstation: useRegister(state, 'workstation').labelField,
    room: useRegister(state, 'room').labelField,
    parking: useRegister(state, 'parking').labelField,
    locker: useRegister(state, 'locker').labelField,
  };

  // Fit the whole page in the preview area, never larger than life.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => {
      fitRef.current = Math.max(0.1, Math.min(1, (area.clientWidth - GUTTER * 2) / PAGE_W, (area.clientHeight - GUTTER * 2) / PAGE_H));
      setFit(fitRef.current);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(area);
    return () => ro.disconnect();
  }, []);

  // Zoom to a share of the fitted page, keeping the spot under the pointer where it is.
  const zoomTo = useCallback((next: number, at?: { clientX: number; clientY: number }) => {
    const area = areaRef.current;
    const frame = frameRef.current;
    const f = fitRef.current;
    if (!area || !frame || !f) return;
    const z = Math.min(Math.max(next, ZOOM_MIN), SCALE_MAX / f);
    if (Math.abs(z - zoomRef.current) < 1e-4) return;
    if (!anchorRef.current) {
      const box = area.getBoundingClientRect();
      const px = at ? at.clientX - box.left : area.clientWidth / 2;
      const py = at ? at.clientY - box.top : area.clientHeight / 2;
      const s = f * zoomRef.current;
      anchorRef.current = { x: (area.scrollLeft + px - frame.offsetLeft) / s, y: (area.scrollTop + py - frame.offsetTop) / s, px, py };
    }
    zoomRef.current = z;
    setZoom(z);
  }, []);

  useLayoutEffect(() => {
    const a = anchorRef.current;
    const area = areaRef.current;
    const frame = frameRef.current;
    anchorRef.current = null;
    if (!a || !area || !frame) return;
    area.scrollLeft = frame.offsetLeft + a.x * scale - a.px;
    area.scrollTop = frame.offsetTop + a.y * scale - a.py;
  }, [scale]);

  // A trackpad pinch reaches the page as a wheel with Ctrl held (Chrome, Edge, Firefox) — as does
  // Ctrl + mouse wheel — and as gesture events in Safari. Both zoom the pages, never the app.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    let pinching = false;
    let base = 1;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || pinching) return;
      e.preventDefault();
      const dy = Math.max(-30, Math.min(30, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      zoomTo(zoomRef.current * Math.exp(-dy * 0.01), e);
    };
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      pinching = true;
      base = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      zoomTo(base * (e as Gesture).scale, e as Gesture);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      pinching = false;
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    area.addEventListener('gesturestart', onGestureStart);
    area.addEventListener('gesturechange', onGestureChange);
    area.addEventListener('gestureend', onGestureEnd);
    return () => {
      area.removeEventListener('wheel', onWheel);
      area.removeEventListener('gesturestart', onGestureStart);
      area.removeEventListener('gesturechange', onGestureChange);
      area.removeEventListener('gestureend', onGestureEnd);
    };
  }, [zoomTo]);

  // Ctrl/⌘ + and − zoom the pages while the preview is open, as in a PDF viewer; Ctrl/⌘ 0 fits the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+') zoomTo(zoomRef.current * ZOOM_STEP);
      else if (e.key === '-') zoomTo(zoomRef.current / ZOOM_STEP);
      else if (e.key === '0') zoomTo(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomTo]);

  // The sheet keeps its own subscription to the state; built once, so a zoom re-renders only the
  // frame around it, not every label on the floor.
  const sheet = useMemo(() => <PrintSheet preview pagesRef={pagesRef} />, []);

  useLayoutEffect(() => {
    const el = pagesRef.current;
    if (!el) return;
    const measure = () => setPagesH(el.offsetHeight || PAGE_H);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Escape is the dialog's own (see Modal).

  // Print the pages as drawn here — pictures of them, fitted to whatever paper the printer holds —
  // so the printout is the preview (see printImages). Should the pictures fail, the browser prints
  // the live page instead.
  async function onPrint() {
    const pages = Array.from(pagesRef.current?.querySelectorAll<HTMLElement>('[data-print-page]') ?? []);
    if (!pages.length || busy) return;
    setBusy('print');
    setError(null);
    try {
      await printImages(await sheetToImages(pages, onProgress));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[print] page images failed; printing the live page', err);
      await document.fonts?.ready;
      window.print();
    } finally {
      setBusy(null);
      setProgress(null);
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
      const blob = await sheetToPdfBlob(pages, onProgress);
      downloadBlob(blob, printFileName(floorTitle, orgNow().dateISO));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[print] PDF download failed', err);
      setError('The PDF could not be created here. Print, then choose “Save as PDF”, gives the same page.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  return (
    <Modal onClose={onClose} width={1180}>
      <ModalHeader title="Print preview" subtitle={`${floorTitle} · Landscape · ${SCOPE_NAME[state.printScope]}`} onClose={onClose} />
      <div className={styles.view}>
        <div ref={areaRef} className={styles.area}>
          {/* The frame takes the SCALED size, so the area lays out (and scrolls) around what is
              visible; the page inside keeps its full size and is scaled from its corner. */}
          <div ref={frameRef} className={styles.frame} style={{ width: PAGE_W * scale, height: pagesH * scale, visibility: scale ? 'visible' : 'hidden' }}>
            <div className={styles.paper} style={{ transform: `scale(${scale})` }}>
              {sheet}
            </div>
          </div>
        </div>
        <div className={styles.zoomBar} role="group" aria-label="Zoom">
          <button type="button" className={styles.zoomBtn} onClick={() => zoomTo(zoom / ZOOM_STEP)} disabled={zoom <= ZOOM_MIN + 1e-4} aria-label="Zoom out" data-tip={`Zoom out (${MOD_KEY}−)`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M5 12h14" />
            </svg>
          </button>
          <button type="button" className={styles.zoomPct} onClick={() => zoomTo(1)} aria-label={`Zoom ${Math.round(scale * 100)}%, fit the page`} data-tip={`Fit the page (${MOD_KEY}0)`}>
            {Math.round(scale * 100)}%
          </button>
          <button type="button" className={styles.zoomBtn} onClick={() => zoomTo(zoom * ZOOM_STEP)} disabled={!!fit && scale >= SCALE_MAX - 1e-4} aria-label="Zoom in" data-tip={`Zoom in (${MOD_KEY}+)`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
      <ModalFooter>
        {/* What the plan's page shows (Floor + details, Current view, Whole floor) and the registers
            after it are set here, for everyone — see PrintDetails. */}
        <Button variant="secondary" className={styles.settingsBtn} onClick={() => setDetailsOpen(true)} disabled={!!busy} icon={<DetailsIcon />}>
          Print settings
        </Button>
        {error && <span className={styles.error}>{error}</span>}
        <Button variant="secondary" onClick={() => void onDownload()} disabled={!!busy} icon={busy === 'pdf' ? <ButtonSpinner /> : <DownloadIcon />}>
          {busy === 'pdf' ? `Preparing PDF…${progressText}` : 'Download PDF'}
        </Button>
        <Button variant="primary" onClick={() => void onPrint()} disabled={!!busy} icon={busy === 'print' ? <ButtonSpinner /> : <PrintIcon />}>
          {busy === 'print' ? `Preparing…${progressText}` : 'Print'}
        </Button>
      </ModalFooter>
      {detailsOpen && <PrintDetails labelFields={labelFields} onClose={() => setDetailsOpen(false)} />}
    </Modal>
  );
}

function DetailsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <path d="M4 6h16M4 12h10M4 18h7" />
      <circle cx="18" cy="16" r="3" />
    </svg>
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
