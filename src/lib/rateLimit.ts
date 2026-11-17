/**
 * Facilio's rate limit: what a list read does when it hits it, and how writes stay under it.
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

/**
 * Writes, paced under the limit. A plan save is one call per new, moved or removed desk — a freshly
 * mapped floor of 150 desks is 150 creates to one address — so every write a save sends goes
 * through `pacedWrites`: two at a time, and no more than WRITES_PER_WINDOW started in any window,
 * counted across saves (the window is Facilio's, not one save's). A small save goes out at once;
 * only a big one waits.
 */
export const WRITES_AT_ONCE = 2;
/** Writes started in any window — under Facilio's 100, leaving room for the reads around them. */
export const WRITES_PER_WINDOW = 80;
/**
 * When recent writes started, oldest first: one log for every save, as Facilio's window is one.
 * Module-wide, so a test file whose saves send more than WRITES_PER_WINDOW writes would wait a real
 * minute on the next one — such a test passes its own `starts` (PaceOptions).
 */
const writeStarts: number[] = [];

type RateError = Parameters<typeof isRateLimited>[0];

export interface PacedWrite<R> {
  send: () => Promise<R>;
  /** The write's answer — or null when it was never sent: refused for rate after every wait. */
  done: (res: R | null) => void;
}

export interface PaceOptions {
  /** Told, as a wait of more than a moment begins, how many writes are still to go. */
  onWait?: (remaining: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The start log; tests pass their own. */
  starts?: number[];
}

/** A wait shorter than this is not worth telling anyone about. */
const QUIET_WAIT_MS = 5_000;

/**
 * Sends `writes` in order, paced (above), and answers each through its `done`.
 *
 * A write refused for rate anyway — another tab, another app of the same person — stops the
 * sending: the refused write and the rest wait out the window and carry on, at most
 * RATE_LIMIT_RETRIES times. Still refused after that, the rest are answered `null`, unsent, for the
 * caller to keep unsaved and name. Never throws: a failed write is an answer like any other.
 */
export async function pacedWrites<R extends { error?: RateError }>(writes: PacedWrite<R>[], opts: PaceOptions = {}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const starts = opts.starts ?? writeStarts;
  const queue = [...writes];
  let inFlight = 0;
  // One wait that every worker honours; a refusal during a wait for room in the window replaces it
  // with the longer wait for the window itself.
  let hold: { until: Promise<void>; rate: boolean } | null = null;
  // Read through a function: the other worker sets it while this one awaits its write.
  const waitingOnRate = () => hold?.rate === true;
  let waits = 0;
  let gaveUp = false;
  const pause = (ms: number, rate: boolean) => {
    if (ms >= QUIET_WAIT_MS) opts.onWait?.(queue.length + inFlight);
    const h = { until: Promise.resolve(), rate };
    h.until = sleep(ms).then(() => {
      if (hold === h) hold = null;
    });
    hold = h;
  };
  const worker = async () => {
    for (;;) {
      while (hold) await hold.until;
      if (gaveUp || !queue.length) return;
      const t = now();
      while (starts.length && t - starts[0] >= RATE_LIMIT_WAIT_MS) starts.shift();
      if (starts.length >= WRITES_PER_WINDOW) {
        pause(starts[0] + RATE_LIMIT_WAIT_MS - t, false);
        continue;
      }
      const w = queue.shift()!;
      starts.push(t);
      inFlight++;
      const res = await w.send();
      inFlight--;
      if (!isRateLimited(res?.error)) {
        w.done(res);
        continue;
      }
      queue.unshift(w);
      if (waitingOnRate()) continue; // the other write's refusal already started the wait
      if (waits === RATE_LIMIT_RETRIES) {
        gaveUp = true;
        return;
      }
      waits++;
      pause(rateLimitWait(), true);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITES_AT_ONCE, writes.length) }, worker));
  for (const w of queue) w.done(null);
}

/**
 * Who hears that Facilio refused a read for rate — the app's toast (FloorplanContext). The data
 * layer has no screen of its own, so it says so here and whoever is listening tells the user.
 */
const busyListeners = new Set<() => void>();
export function onFacilioBusy(listener: () => void): () => void {
  busyListeners.add(listener);
  return () => void busyListeners.delete(listener);
}
export function sayFacilioBusy(): void {
  for (const listener of busyListeners) listener();
}

/**
 * Whether an answer or a thrown error is a refusal for rate, in any of the shapes it arrives in: a
 * body (`{ code: 6, message }`), an SDK result (`{ error }`), or a dev-mode axios error carrying the
 * response.
 */
export function refusedForRate(x: unknown): boolean {
  const o = x as { error?: RateError; response?: { status?: number; data?: RateError } } | null | undefined;
  if (!o || typeof o !== 'object') return false;
  return isRateLimited(o as RateError) || isRateLimited(o.error) || o.response?.status === 429 || isRateLimited(o.response?.data);
}

/**
 * A read that, refused for rate, waits out the window and asks again — at most RATE_LIMIT_RETRIES
 * times, saying "busy" each time it waits. Anything else (a permission or validation error, a
 * missing record) comes back at once, as it came; and so does the last refusal, for the caller's own
 * failure path. For reads only: a write refused for rate is the pacer's to hold (pacedWrites), and
 * a list read that keeps its pages (fetchAllPaged) does its own waiting.
 */
export async function readPatiently<T>(read: () => Promise<T>, sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<T> {
  for (let waits = 0; ; waits++) {
    let refused = false;
    let out: T | undefined;
    try {
      out = await read();
      refused = refusedForRate(out);
    } catch (err) {
      if (waits === RATE_LIMIT_RETRIES || !refusedForRate(err)) throw err;
      refused = true;
    }
    if (!refused || waits === RATE_LIMIT_RETRIES) return out as T;
    sayFacilioBusy();
    await sleep(rateLimitWait());
  }
}
