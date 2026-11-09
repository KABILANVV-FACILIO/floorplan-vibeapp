/**
 * Facilio's rate limit, and what a list read does when it hits it.
 *
 * Facilio allows a user 100 calls a minute to one request URI (per org, per region), in a fixed
 * 60-second window that starts at the first call. Past that it refuses with HTTP 429, error code 6,
 * "You have reached the maximum number of allowed requests for this API…", and keeps refusing until
 * the window resets — so a retry sooner than the window is wasted, and a retry loop makes it worse
 * for every tab the same person has open. (bmsconsole AccessRateInterceptor, facilio-framework
 * RedisAPIRateLimiter, bmsconsole ErrorUtil.) The bridge does not hand the app the `X-Retry-After`
 * header, so the wait is the whole window.
 */

/** A refused read waits out the whole window before it asks again. */
export const RATE_LIMIT_WAIT_MS = 60_000;
/** Plus up to this much, so tabs and people refused together don't all come back in the same second. */
export const RATE_LIMIT_JITTER_MS = 5_000;
/** How many times a refused list read carries on after waiting, before it gives up and says so. */
export const RATE_LIMIT_RETRIES = 2;

/** How long to wait before asking again: the window, plus jitter. */
export function rateLimitWait(random: () => number = Math.random): number {
  return RATE_LIMIT_WAIT_MS + Math.round(random() * RATE_LIMIT_JITTER_MS);
}

/** Whether an API error is Facilio refusing for rate — not a permission, validation or missing-record error, which no wait fixes. */
export function isRateLimited(error: { code?: number | string; status?: number; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.status === 429 || String(error.code) === '6' || String(error.code) === '429') return true;
  return /maximum number of allowed requests|too many requests|rate.?limit/i.test(String(error.message ?? ''));
}

/**
 * A list read that stopped part-way: the rows it did get — kept, never thrown away — whether Facilio
 * refused it for rate, and, when it may still finish, `resume`, which waits out the window and
 * carries on from the page that was refused.
 */
export class IncompleteListError<T = unknown> extends Error {
  constructor(
    readonly rows: T[],
    readonly rateLimited: boolean,
    message: string,
    readonly resume?: () => Promise<T[]>,
  ) {
    super(message);
    this.name = 'IncompleteListError';
  }

  /** The same stop, over mapped rows — and a resume that maps what it finishes with. */
  map<U>(fn: (rows: T[]) => U[]): IncompleteListError<U> {
    const resume = this.resume;
    return new IncompleteListError(fn(this.rows), this.rateLimited, this.message, resume ? () => resume().then(fn, (err) => Promise.reject(err instanceof IncompleteListError ? err.map(fn) : err)) : undefined);
  }
}
