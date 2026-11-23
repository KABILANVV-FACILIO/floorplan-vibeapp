import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A CAD or PDF plan that failed to render left its viewer, workers and graphics context — or its
 * pdf.js document — running, so each failed try added more (v77 review). They are now torn down
 * however the render ends.
 */

const cad = vi.hoisted(() => ({ open: true, destroy: vi.fn(async () => {}) }));
vi.mock('@mlightcad/cad-simple-viewer', () => ({
  AcApOpenViewMode: { Extents: 0 },
  AcApDocManager: {
    createInstance: () => ({
      openDocument: async () => cad.open,
      destroy: cad.destroy,
      curView: { isProcessingEntities: false, zoomToFitDrawing: () => {} },
    }),
  },
}));

const pdf = vi.hoisted(() => ({ pageFails: false, destroy: vi.fn(async () => {}) }));
vi.mock('pdfjs-dist/build/pdf.worker.mjs?url', () => ({ default: 'worker.js' }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      getPage: async () => {
        if (pdf.pageFails) throw new Error('bad page');
        return { getViewport: () => ({ width: 100, height: 50 }), render: () => ({ promise: Promise.resolve() }) };
      },
    }),
    destroy: pdf.destroy,
  }),
}));

const { analyzeCadFile } = await import('./cadAnalyze');
const { renderCadToDataUrl } = await import('./cadPreview');
const { renderPdfToDataUrl } = await import('./pdfPreview');

// jsdom's File has no arrayBuffer(); the renderers read nothing else of it.
const file = (name: string) => ({ name, arrayBuffer: async () => new ArrayBuffer(1) }) as unknown as File;

beforeEach(() => {
  vi.clearAllMocks();
  cad.open = true;
  pdf.pageFails = false;
});

describe('a CAD plan that cannot be read', () => {
  it('is analysed: the viewer is destroyed though the file did not open', async () => {
    cad.open = false;
    await expect(analyzeCadFile(file('plan.dxf'))).rejects.toThrow('Could not parse this CAD file');
    expect(cad.destroy).toHaveBeenCalledTimes(1);
    expect(document.body.children.length).toBe(0);
  });

  it('is previewed: the viewer is destroyed though the file did not open', async () => {
    cad.open = false;
    await expect(renderCadToDataUrl(file('plan.dwg'))).rejects.toThrow('Could not parse this CAD file');
    expect(cad.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('a PDF plan', () => {
  it('that fails to render: its document is still destroyed', async () => {
    pdf.pageFails = true;
    await expect(renderPdfToDataUrl(file('plan.pdf'))).rejects.toThrow('bad page');
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
  });

  it('that renders: destroyed once its picture is taken', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
    expect(await renderPdfToDataUrl(file('plan.pdf'))).toBe('data:image/png;base64,AAAA');
    expect(pdf.destroy).toHaveBeenCalledTimes(1);
    getContext.mockRestore();
    toDataURL.mockRestore();
  });
});
