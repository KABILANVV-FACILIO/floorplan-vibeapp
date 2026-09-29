import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { PrintViewer } from './PrintViewer';

type OpenPrint = (opts?: { print?: boolean }) => void;

const PrintCtx = createContext<OpenPrint>(() => {});

/** Open the print viewer — and, with `print`, print from it straight away. */
export function usePrintViewer(): OpenPrint {
  return useContext(PrintCtx);
}

/** Cmd+P on a Mac, Ctrl+P elsewhere. `code` too, so it is the P KEY on any layout (Arabic included). */
function isPrintShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyP' || e.key.toLowerCase() === 'p');
}

/**
 * Owns the print viewer for the desktop shell, so the toolbar's button and the keyboard reach the
 * same one — on every view, not only the plan the toolbar sits on.
 *
 * Cmd+P / Ctrl+P is taken from the browser: left alone, it prints the live page, which the browser
 * lays out again for the paper (and Chrome shrinks to two thirds of the sheet). Instead it opens the
 * viewer and prints from it — the same page pictures, fitted to the paper, as the viewer's own Print
 * — or, with the viewer already open, presses its Print. The browser's File › Print menu is not a
 * key press and still prints the live page (see PrintSheet).
 */
export function PrintController({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Bumped for each request to print; 0 means "just show the viewer".
  const [printRequest, setPrintRequest] = useState(0);

  const openPrint = useCallback<OpenPrint>((opts) => {
    setOpen(true);
    if (opts?.print) setPrintRequest((n) => n + 1);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPrintShortcut(e)) return;
      e.preventDefault();
      openPrint({ print: true });
    };
    // Capture, so a field or a canvas handler that stops the event can't let the browser's own
    // print through.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openPrint]);

  return (
    <PrintCtx.Provider value={openPrint}>
      {children}
      {open && (
        <PrintViewer
          printRequest={printRequest}
          onClose={() => {
            setOpen(false);
            setPrintRequest(0);
          }}
        />
      )}
    </PrintCtx.Provider>
  );
}
