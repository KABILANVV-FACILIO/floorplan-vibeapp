import { describe, expect, it, vi } from 'vitest';
import type { Employee } from '../lib/types';

/**
 * The roster Facilio refuses part-way, as the app handles it (readRoster): the people read are
 * used, the user is told Facilio is busy, the rest is finished in the background — and when it
 * cannot be, the user is told the names may be missing. Never a silent empty roster.
 */

const ds = vi.hoisted(() => ({ getEmployees: vi.fn() }));
vi.mock('../lib/dataSource', () => ({ dataSource: ds }));
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
vi.mock('../lib/featureFlags', async (orig) => ({ ...(await orig<typeof import('../lib/featureFlags')>()), DEMO_DATA: false }));

const { readRoster, ROSTER_BUSY, ROSTER_FAILED } = await import('./FloorplanContext');
const { IncompleteListError } = await import('../lib/rateLimit');

const omar: Employee = { id: '1', name: 'Omar Al Marri' };
const priya: Employee = { id: '2', name: 'Priya Nair' };
const toasts = (dispatch: ReturnType<typeof vi.fn>) => dispatch.mock.calls.map(([a]) => a).filter((a) => a.type === 'SHOW_TOAST' && a.message).map((a) => a.message);
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('a roster refused for rate', () => {
  it('draws the people read, says Facilio is busy, and fills in the rest when the retry lands', async () => {
    ds.getEmployees.mockRejectedValueOnce(new IncompleteListError([omar], true, 'refused', async () => [omar, priya]));
    const dispatch = vi.fn();
    expect(await readRoster(dispatch)).toEqual([omar]);
    await settle();
    expect(toasts(dispatch)).toEqual([ROSTER_BUSY]);
    expect(dispatch).toHaveBeenCalledWith({ type: 'EMPLOYEES_LOADED', employees: [omar, priya] });
  });

  it('says the names may be missing when the retries give up', async () => {
    const last = new IncompleteListError([omar], true, 'refused for good');
    ds.getEmployees.mockRejectedValueOnce(new IncompleteListError([omar], true, 'refused', async () => Promise.reject(last)));
    const dispatch = vi.fn();
    await readRoster(dispatch);
    await settle();
    expect(toasts(dispatch)).toEqual([ROSTER_BUSY, ROSTER_FAILED]);
  });

  it('keeps the roster on screen on Refresh, rather than a shorter one', async () => {
    ds.getEmployees.mockRejectedValueOnce(new IncompleteListError([omar], true, 'refused', async () => [omar, priya]));
    expect(await readRoster(vi.fn(), { refresh: true })).toBeNull();
  });
});

describe('a roster that fails outright', () => {
  it('says so instead of drawing a plan of nobody', async () => {
    ds.getEmployees.mockRejectedValueOnce(new Error('facilio-api: employee fetch failed on page 1 (403 Permission denied)'));
    const dispatch = vi.fn();
    expect(await readRoster(dispatch)).toBeNull();
    expect(toasts(dispatch)).toEqual([ROSTER_FAILED]);
  });
});
