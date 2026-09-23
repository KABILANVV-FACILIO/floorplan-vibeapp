/**
 * The print sheet as a downloadable PDF, made in the browser without a print dialog.
 *
 * The page is rasterised (html-to-image draws the DOM through an SVG foreignObject, so the plane's
 * `scale()` and every chip's counter-scale come out exactly as on screen) and placed full-bleed on
 * a letter-landscape PDF page. It is a picture of the page, not vector text: printing through the
 * browser stays the sharp path, and this is the one that hands over a file.
 *
 * Both libraries are imported on first use. Together they are several times the size of
 * everything else the print viewer needs, and most people who open it only print.
 */

/** Letter landscape, in inches — the size the sheet is laid out at. */
const PAGE_W_IN = 11;
const PAGE_H_IN = 8.5;

/**
 * Pixels per CSS pixel in the raster. 2.5 puts the 11in page at 2640px across, ~240 dpi: small
 * labels stay legible when printed, and the file stays a few MB.
 */
const PIXEL_RATIO = 2.5;

export async function sheetToPdfBlob(page: HTMLElement): Promise<Blob> {
  const [{ toPng }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  // Roboto comes from Google Fonts. Until it has loaded, the raster would be drawn in the
  // fallback face, so wait for it rather than capture a page that differs from the screen.
  await document.fonts?.ready;
  const png = await toPng(page, {
    pixelRatio: PIXEL_RATIO,
    backgroundColor: '#ffffff',
    width: page.offsetWidth,
    height: page.offsetHeight,
  });
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'in', format: 'letter', compress: true });
  pdf.addImage(png, 'PNG', 0, 0, PAGE_W_IN, PAGE_H_IN, undefined, 'FAST');
  return pdf.output('blob');
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later, not synchronously: some browsers start reading the URL only after the click
  // handler has returned, and a revoked URL downloads nothing.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
