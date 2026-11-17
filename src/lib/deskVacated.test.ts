import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from './types';

/**
 * After a Vacate, the plan waits for the org to take the holder off the desk (it does so while
 * processing the move, after the request returns). That wait used to re-read the desk every 0.8 s,
 * up to 15 times, whether or not anyone was still looking. These pin the bounded version: three
 * reads, 2 s then 4 s then 8 s apart, none while the tab is hidden, and none once it is stopped.
 */

let holder: number | null = 7;

vi.mock('./facilioApi', () => ({
  apiOrigin: 'https://example.test',
  customGet: vi.fn(),
  customPost: vi.fn(),
  fetchFilePreview: vi.fn(),
  isFacilioApiConfigured: true,
  facilioApi: {
    fetchRecord: vi.fn(async (_module: string, { id }: { id: number }) => ({ desks: { id, employee: holder == null ? null : { id: holder } } })),
  },
}));
vi.mock('./pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('./cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

const { facilioApi } = await import('./facilioApi');
const { waitForDeskVacated } = await import('./facilioApiDataSource');
const reads = vi.mocked(facilioApi.fetchRecord);

const desk = { id: '1676024', type: 'workstation', label: 'WS-IN-05' } as Unit;
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  reads.mockClear();
  holder = 7;
  hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('waiting for the org to let go of a vacated desk', () => {
  it('reads three times, 2 s then 4 s then 8 s apart, and then gives up', async () => {
    const result = waitForDeskVacated(desk, '7');

    await vi.advanceTimersByTimeAsync(1999);
    expect(reads).not.toHaveBeenCalled(); // never straight away: the org has not processed the move yet
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(reads).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toEqual({ cleared: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(reads).toHaveBeenCalledWith('desks', { id: 1676024 });
  });

  it('stops at the first read that shows the holder gone', async () => {
    const result = waitForDeskVacated(desk, '7');
    await vi.advanceTimersByTimeAsync(2000);
    holder = null;
    await vi.advanceTimersByTimeAsync(4000);

    await expect(result).resolves.toEqual({ cleared: true });
    expect(reads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('counts a different holder as this one gone', async () => {
    holder = 9;
    const result = waitForDeskVacated(desk, '7');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toEqual({ cleared: true });
  });

  it('stops the moment it is told to, and reads nothing after', async () => {
    const stop = new AbortController();
    const result = waitForDeskVacated(desk, '7', { signal: stop.signal });
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads).toHaveBeenCalledTimes(1);

    stop.abort();
    await expect(result).resolves.toEqual({ cleared: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('keeps the answer of a read already out when it is stopped', async () => {
    const stop = new AbortController();
    holder = null;
    reads.mockImplementationOnce(async (_module, { id }: any) => {
      stop.abort(); // the card closes while the org is answering
      return { desks: { id, employee: null } } as any;
    });
    const result = waitForDeskVacated(desk, '7', { signal: stop.signal });
    await vi.advanceTimersByTimeAsync(2000);

    await expect(result).resolves.toEqual({ cleared: true });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('reads nothing at all when stopped before the first wait is over', async () => {
    const stop = new AbortController();
    const result = waitForDeskVacated(desk, '7', { signal: stop.signal });
    await vi.advanceTimersByTimeAsync(500);
    stop.abort();

    await expect(result).resolves.toEqual({ cleared: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).not.toHaveBeenCalled();
  });

  it('makes no read while the tab is hidden', async () => {
    hidden = true;
    const result = waitForDeskVacated(desk, '7');
    await vi.advanceTimersByTimeAsync(14_000);

    await expect(result).resolves.toEqual({ cleared: false });
    expect(reads).not.toHaveBeenCalled();
  });

  it('skips only the reads that fall while hidden', async () => {
    hidden = true;
    const result = waitForDeskVacated(desk, '7');
    await vi.advanceTimersByTimeAsync(2000); // hidden: skipped
    hidden = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(reads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8000);

    await expect(result).resolves.toEqual({ cleared: false });
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
