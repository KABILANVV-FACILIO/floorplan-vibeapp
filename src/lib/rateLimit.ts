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
 * A read Facilio refused for rate before it had anything to give — after its own waits, where it
 * has them. A stop with no rows: it IS an IncompleteListError, so whatever already keeps the
 * org's partial answer rather than asking another tier (CompositeDataSource) keeps this one too —
 * another tier's answer would be the org's records read some weaker way, or none, and is refused
 * by the same limit anyway. The caller says "busy" and keeps what is on screen.
 */
export class RateLimitedError extends IncompleteListError<never> {
  constructor(message: string) {
    super([], true, message);
    this.name = 'RateLimitedError';
  }
}

/**
 * `fn` over every item, at most `limit` at a time, answers in the items' order. Several reads to
 * one request URI started in the same second spend the user's minute at once (see above); two at a
 * time keeps a burst of them under it, the way a big floor's related-list pages are read. Rejects
 * with the first failure, as Promise.all does, and starts nothing after it.
 */
export async function mapPooled<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
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
 *
 * Shared with this person's other tabs of the app (see linkStartLog): Facilio counts every tab of
 * one user against the same window, so two tabs saving big floors would otherwise each start 80 a
 * minute against a shared 100.
 */
const writeStarts: number[] = [];

/**
 * Until when this person's writes wait because one of their other tabs was refused for rate (see
 * linkWriteHold) — 0 when no tab has said so. Module-wide, as the start log is.
 */
export interface WriteHold {
  until: number;
}
const writeHold: WriteHold = { until: 0 };

/** What a start log is shared over — a BroadcastChannel, or a test's stand-in for one. */
export interface StartLogChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** The channel the app's tabs share their write starts on. */
const WRITE_LOG_CHANNEL = 'floorplan-manager:write-starts';

/** Put `t` into a log kept oldest first — a start told by another tab can be older than ours. */
function insertStart(starts: number[], t: number): void {
  let i = starts.length;
  while (i > 0 && starts[i - 1] > t) i--;
  starts.splice(i, 0, t);
}

/**
 * Join `starts` to the log other tabs keep: every start they announce is put into it (a start
 * already older than the window is of no use and is dropped), and the function returned announces
 * this tab's. With no other tab listening an announcement reaches nobody, so one tab paces exactly
 * as it always has.
 */
export function linkStartLog(starts: number[], channel: StartLogChannel, now: () => number = Date.now): (t: number) => void {
  channel.addEventListener('message', (event) => {
    const t = (event?.data as { start?: unknown } | null)?.start;
    if (typeof t !== 'number' || !Number.isFinite(t) || now() - t >= RATE_LIMIT_WAIT_MS) return;
    // A tab that only watches never runs a pacer to trim the log, so it is trimmed here: another tab
    // saving all day would otherwise grow it without end.
    while (starts.length && now() - starts[0] >= RATE_LIMIT_WAIT_MS) starts.shift();
    insertStart(starts, t);
  });
  return (t) => {
    try {
      channel.postMessage({ start: t });
    } catch {
      // A channel closed under us costs the other tabs one start's worth of pacing, nothing more.
    }
  };
}

/**
 * Join `hold` to the other tabs' refusals: a tab whose write Facilio refused for rate announces
 * until when it waits (`{ holdUntil }`), and every tab's pacer holds its writes until then too —
 * the window is the person's, not the tab's, so the others' next writes would only be refused as
 * well. No tab waits longer than one window and its jitter for a refusal, so a hold told as further
 * off than that is taken as that far, and nothing told can hold the writes for longer. The function
 * returned announces this tab's.
 */
export function linkWriteHold(hold: WriteHold, channel: StartLogChannel, now: () => number = Date.now): (until: number) => void {
  channel.addEventListener('message', (event) => {
    const until = (event?.data as { holdUntil?: unknown } | null)?.holdUntil;
    if (typeof until !== 'number' || !Number.isFinite(until)) return;
    const capped = Math.min(until, now() + RATE_LIMIT_WAIT_MS + RATE_LIMIT_JITTER_MS);
    if (capped > hold.until) hold.until = capped;
  });
  return (until) => {
    try {
      channel.postMessage({ holdUntil: until });
    } catch {
      // As for a start: a channel closed under us costs the other tabs a refusal of their own.
    }
  };
}

/**
 * This tab's announcers for the module-wide log and hold. The channel is opened as the module
 * loads, not at the first save: a tab that has not saved yet still hears the starts and refusals
 * the others announce, so its first save is paced against them. Null where there is no
 * BroadcastChannel (an old browser, some WebViews) or it will not open — a tab then paces on its
 * own count, as before. Never throws at import.
 */
const moduleChannel: { start: (t: number) => void; hold: (until: number) => void } | null = (() => {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    const channel = new BroadcastChannel(WRITE_LOG_CHANNEL);
    // Node (the test runner) keeps a listening channel's process alive; a browser has no such method.
    (channel as unknown as { unref?: () => void }).unref?.();
    return { start: linkStartLog(writeStarts, channel), hold: linkWriteHold(writeHold, channel) };
  } catch {
    return null;
  }
})();

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
  /**
   * Told of each start, for the other tabs (linkStartLog). Defaults to this tab's channel when the
   * module-wide log is used; a test that passes its own `starts` passes its own announcer, or none.
   */
  announce?: (t: number) => void;
  /**
   * Until when writes wait because another tab was refused for rate (linkWriteHold). The
   * module-wide hold with the module-wide log; a test that passes its own `starts` passes its own
   * hold, or none — so a hold another test left behind never delays it.
   */
  hold?: WriteHold;
  /** Told, when a write is refused for rate, until when this save waits — for the other tabs. Defaults as `announce` does. */
  announceHold?: (until: number) => void;
}

/** A wait shorter than this is not worth telling anyone about. */
const QUIET_WAIT_MS = 5_000;

/**
 * Sends `writes` in order, paced (above), and answers each through its `done`.
 *
 * A write refused for rate anyway — another tab, another app of the same person — stops the
 * sending: the refused write and the rest wait out the window and carry on, at most
 * RATE_LIMIT_RETRIES times, and the other tabs are told until when (announceHold), so their writes
 * wait too. Still refused after that, the rest are answered `null`, unsent, for the caller to keep
 * unsaved and name. Never throws: a failed write is an answer like any other — and so is a write
 * whose `send` threw, answered as an error of its own (`{ error: { message } }`) while every other
 * write still goes out.
 *
 * A refusal another tab announced (`hold`) is waited out the same way before the next write goes —
 * but it is not one of this save's RATE_LIMIT_RETRIES: none of its writes was refused.
 */
export async function pacedWrites<R extends { error?: RateError }>(writes: PacedWrite<R>[], opts: PaceOptions = {}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const starts = opts.starts ?? writeStarts;
  const announce = opts.announce ?? (opts.starts ? undefined : moduleChannel?.start);
  const shared = opts.hold ?? (opts.starts ? undefined : writeHold);
  const announceHold = opts.announceHold ?? (opts.starts ? undefined : moduleChannel?.hold);
  // The last hold told by another tab that this save has waited out. Each is waited out once: after
  // a real wait the clock is past it anyway, and a clock that only a real wait moves (a test's
  // stand-in) can then never keep the save in a loop.
  let heeded = 0;
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
      // Another tab was refused for rate: this tab's next write would be refused too, so it waits
      // until that tab does — a wait for rate like this save's own (the other write's refusal then
      // starts no second one), but not counted against its retries.
      const heldUntil = shared?.until ?? 0;
      if (heldUntil > t && heldUntil !== heeded) {
        heeded = heldUntil;
        pause(heldUntil - t, true);
        continue;
      }
      while (starts.length && t - starts[0] >= RATE_LIMIT_WAIT_MS) starts.shift();
      if (starts.length >= WRITES_PER_WINDOW) {
        pause(starts[0] + RATE_LIMIT_WAIT_MS - t, false);
        continue;
      }
      const w = queue.shift()!;
      insertStart(starts, t);
      announce?.(t);
      inFlight++;
      let res: R;
      try {
        res = await w.send();
      } catch (err) {
        // A send that threw instead of answering is that write's failure, not the save's: it is
        // answered like a refusal no wait fixes, and the other writes carry on. Left to reject,
        // Promise.all below would abandon the queue unanswered while the other worker kept sending.
        // A throw that IS a refusal for rate (a dev-mode axios 429) waits out the window like one.
        const error = { message: (err as Error)?.message ?? String(err ?? 'request failed') };
        res = { error: refusedForRate(err) ? { ...error, code: 6 } : error } as R;
      } finally {
        inFlight--;
      }
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
      const ms = rateLimitWait();
      const until = now() + ms;
      pause(ms, true);
      // The person's other tabs hold their writes until then too (linkWriteHold).
      announceHold?.(until);
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

/** Whether a thrown error is the server failing (a 5xx status on it) rather than refusing the request. */
export function failedOnServer(err: unknown): boolean {
  const o = (err && typeof err === 'object' ? err : null) as { status?: unknown; response?: { status?: unknown } } | null;
  const status = Number(o?.status ?? o?.response?.status);
  return status >= 500 && status < 600;
}

/**
 * What withBackoff sends a call again for: `rateOrServer` (the default) — a refusal for rate or a
 * server failure (5xx), right for a read; `rate` — a refusal for rate only, for a write.
 */
export type RetryOn = 'rate' | 'rateOrServer';

/**
 * A call that THROWS when refused — the vibe SDK's `executeAction`, say, which throws a VibeError
 * carrying the HTTP status — retried the way a refused read is: only when refused for rate or failed
 * on the server (5xx), only after the whole window plus jitter, at most RATE_LIMIT_RETRIES times.
 * Anything else, and the last failure, is thrown as it came. Never a retry at once: that is only
 * refused again, and keeps the user locked out longer.
 *
 * A write passes `retryOn: 'rate'`. A refusal for rate says Facilio did nothing, so the write is
 * sent again after the window like a read; but a 5xx on a create often means it landed and only the
 * answer was lost, and sent again it would make the record twice — so that is thrown as it came.
 */
export async function withBackoff<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  opts: { retryOn?: RetryOn } = {},
): Promise<T> {
  const onServer = (opts.retryOn ?? 'rateOrServer') === 'rateOrServer';
  for (let waits = 0; ; waits++) {
    try {
      return await call();
    } catch (err) {
      const rate = refusedForRate(err);
      if (waits === RATE_LIMIT_RETRIES || !(rate || (onServer && failedOnServer(err)))) throw err;
      if (rate) sayFacilioBusy();
      await sleep(rateLimitWait());
    }
  }
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
