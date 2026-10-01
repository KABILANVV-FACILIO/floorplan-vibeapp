/**
 * The print sheet as pictures of its pages — for the downloadable PDF, and for printing.
 *
 * Each page is rasterised (html-to-image draws the DOM through an SVG foreignObject, so the plane's
 * `scale()` and every chip's counter-scale come out exactly as on screen). The PDF places them
 * full-bleed on letter-landscape pages; printing places one per sheet, scaled to the paper.
 *
 * Both libraries are imported on first use. Together they are several times the size of
 * everything else the print viewer needs, and most people who open it only print.
 */

/** Letter landscape, in inches — the size the sheet is laid out at. */
const PAGE_W_IN = 11;
const PAGE_H_IN = 8.5;

/**
 * Pixels per CSS pixel in the raster. 2.5 puts the 11in page at 2640px across, ~240 dpi: small
 * labels stay legible when printed, and the file stays a few MB. A floor of many pages takes
 * 1.8 (~170 dpi, still print-sharp): at 2.5 a 20-page floor was a 60MB PDF and a minute's wait.
 */
const PIXEL_RATIO = 2.5;
const PIXEL_RATIO_MANY = 1.8;
const MANY_PAGES = 12;

/**
 * Each page as a PNG data URL, drawn exactly as the viewer shows it. The PDF and the printout are
 * both made from these, so neither can differ from the preview.
 */
export async function sheetToImages(pages: HTMLElement[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
  const { toPng } = await import('html-to-image');
  // Roboto comes from Google Fonts. Until it has loaded, the raster would be drawn in the
  // fallback face, so wait for it rather than capture a page that differs from the screen.
  await document.fonts?.ready;
  const pixelRatio = pages.length > MANY_PAGES ? PIXEL_RATIO_MANY : PIXEL_RATIO;
  const out: string[] = [];
  for (const page of pages) {
    onProgress?.(out.length, pages.length);
    out.push(await toPng(page, { pixelRatio, backgroundColor: '#ffffff', width: page.offsetWidth, height: page.offsetHeight }));
  }
  onProgress?.(pages.length, pages.length);
  return out;
}

export async function sheetToPdfBlob(pages: HTMLElement[], onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const [images, { jsPDF }] = await Promise.all([sheetToImages(pages, onProgress), import('jspdf')]);
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'in', format: 'letter', compress: true });
  // One raster per page — the whole floor, then each detail page — each full-bleed on its own sheet.
  images.forEach((png, i) => {
    if (i > 0) pdf.addPage('letter', 'landscape');
    pdf.addImage(png, 'PNG', 0, 0, PAGE_W_IN, PAGE_H_IN, undefined, 'FAST');
  });
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

/**
 * Print the pages as the pictures `sheetToImages` makes — one per sheet, each scaled to fit
 * whatever paper the printer holds (A4 or Letter, either way round) — instead of handing the
 * browser the live page to lay out again.
 *
 * Laid out again at print time, the page followed the paper rather than the preview: on a narrower
 * sheet its bar wrapped and the zoomed plans came out cropped, and Chrome shrank a whole floor
 * plan onto two thirds of the sheet because the plan's clipped layers still counted as overflow.
 * A picture has none of that: what prints is the page in the preview. (Cmd+P without the viewer
 * still prints the live page — see PrintSheet.)
 */
export async function printImages(images: string[]): Promise<void> {
  document.querySelector('.fp-print-images')?.remove();
  const holder = document.createElement('div');
  holder.className = 'fp-print-images';
  for (const src of images) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    holder.appendChild(img);
  }
  document.body.appendChild(holder);
  document.body.classList.add('fp-printing-images');
  await Promise.all([...holder.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
  const done = () => {
    window.removeEventListener('afterprint', done);
    document.body.classList.remove('fp-printing-images');
    holder.remove();
  };
  window.addEventListener('afterprint', done);
  window.print();
}
