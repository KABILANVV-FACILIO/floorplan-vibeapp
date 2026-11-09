import { describe, expect, it, vi } from 'vitest';
import { IncompleteListError, isRateLimited, rateLimitWait, RATE_LIMIT_WAIT_MS } from './rateLimit';

/**
 * Facilio's rate limit (100 calls a minute per user and URI, a fixed 60 s window): what counts as a
 * refusal for rate, how long a refused read waits, and a list read that stopped part-way.
 */

describe('a refusal for rate', () => {
  it('is told apart from errors no wait fixes', () => {
    expect(isRateLimited({ code: 6, message: 'You have reached the maximum number of allowed requests for this API. Please wait and try again later.' })).toBe(true);
    expect(isRateLimited({ code: '6' })).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ message: 'Too Many Requests' })).toBe(true);
    expect(isRateLimited({ code: 403, message: 'Permission denied' })).toBe(false);
    expect(isRateLimited({ code: 'INVALID_FIELD', message: "Field 'x' does not exist" })).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });

  it('waits out the whole window, plus a little jitter', () => {
    expect(rateLimitWait(() => 0)).toBe(RATE_LIMIT_WAIT_MS);
    expect(rateLimitWait(() => 1)).toBe(RATE_LIMIT_WAIT_MS + 5_000);
  });
});

describe('a list read that stopped part-way', () => {
  it('maps its rows, and what its resume finishes with, the same way', async () => {
    const resume = vi.fn(async () => [1, 2, 3]);
    const stop = new IncompleteListError([1], true, 'refused', resume).map((rows) => rows.map((n) => `#${n}`));
    expect(stop.rows).toEqual(['#1']);
    expect(stop.rateLimited).toBe(true);
    expect(await stop.resume!()).toEqual(['#1', '#2', '#3']);
  });

  it('maps a second stop its resume ran into, too', async () => {
    const again = new IncompleteListError([1, 2], true, 'refused again');
    const stop = new IncompleteListError([1], true, 'refused', async () => Promise.reject(again)).map((rows) => rows.map(String));
    await expect(stop.resume!()).rejects.toMatchObject({ rows: ['1', '2'], rateLimited: true });
  });
});
