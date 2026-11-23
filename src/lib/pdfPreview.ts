import * as pdfjsLib from 'pdfjs-dist';
// eslint-disable-next-line import/no-unresolved
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Renders the first page of a PDF to a PNG data URL, client-side only (pdf.js). */
export async function renderPdfToDataUrl(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const task = pdfjsLib.getDocument({ data: buffer });
  // Destroyed however this ends: the loading task holds the document, its worker and its memory
  // until it is, and a file that failed to open or render used to leave all of them behind.
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const targetWidth = 1492;
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');

    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    await task.destroy().catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[pdf] the document could not be torn down', err);
    });
  }
}
