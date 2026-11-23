import { describe, expect, it, vi } from 'vitest';
import { IncompleteListError, isRateLimited, linkStartLog, linkWriteHold, mapPooled, onFacilioBusy, pacedWrites, rateLimitWait, RateLimitedError, readPatiently, RATE_LIMIT_JITTER_MS, RATE_LIMIT_WAIT_MS, withBackoff, WRITES_PER_WINDOW } from './rateLimit';
import type { PacedWrite, StartLogChannel, WriteHold } from './rateLimit';

/**
 * Facilio's rate limit (100 calls a minute per user and URI, a fixed 60 s window): what counts as a
 * refusal for rate, how long a refused read waits, a list read that stopped part-way, and a save's
 * writes paced under the limit.
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

describe("a save's writes", () => {
  type Res = { error: { code?: number; message?: string } | null };
  /** A clock that moves only when the pacer sleeps; writes answer at once, in the order sent. */
  const rig = (answer: (i: number, attempt: number) => Res['error'] = () => null) => {
    let clock = 0;
    const events: { kind: 'start' | 'refused'; i: number; at: number }[] = [];
    const tries = new Map<number, number>();
    const answers = new Map<number, Res | null>();
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const writes = (n: number): PacedWrite<Res>[] =>
      Array.from({ length: n }, (_, i) => ({
        send: async () => {
          const attempt = (tries.get(i) ?? 0) + 1;
          tries.set(i, attempt);
          events.push({ kind: 'start', i, at: clock });
          await Promise.resolve();
          const error = answer(i, attempt);
          if (isRateLimited(error)) events.push({ kind: 'refused', i, at: clock });
          return { error };
        },
        done: (res) => void answers.set(i, res),
      }));
    const opts = (onWait = vi.fn()) => ({ sleep, now: () => clock, starts: [] as number[], onWait });
    return { events, answers, tries, sleep, writes, opts };
  };
  const busy = { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' };

  it('start no more than 80 in any minute, and say how many are left while they wait', async () => {
    const r = rig();
    // Left to go: every write not yet answered, the one still on its way included.
    const onWait = vi.fn((left: number) => expect(left).toBe(150 - r.answers.size));
    await pacedWrites(r.writes(150), r.opts(onWait));
    const starts = r.events.map((e) => e.at);
    expect(starts).toHaveLength(150);
    for (const t of starts) expect(starts.filter((s) => s >= t && s < t + RATE_LIMIT_WAIT_MS).length).toBeLessThanOrEqual(WRITES_PER_WINDOW);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect([...r.answers.values()].every((a) => a?.error === null)).toBe(true);
  });

  it('go out at once when there are few, with no wait and nothing said', async () => {
    const r = rig();
    const onWait = vi.fn();
    await pacedWrites(r.writes(12), r.opts(onWait));
    expect(r.sleep).not.toHaveBeenCalled();
    expect(onWait).not.toHaveBeenCalled();
    expect(r.answers.size).toBe(12);
  });

  it('stop at a refusal for rate, wait out the window, send the refused one again and finish — nothing lost', async () => {
    const r = rig((i, attempt) => (i === 49 && attempt === 1 ? busy : null));
    const onWait = vi.fn();
    await pacedWrites(r.writes(150), r.opts(onWait));
    const refused = r.events.findIndex((e) => e.kind === 'refused');
    const resumeAt = r.events[refused].at + RATE_LIMIT_WAIT_MS;
    // Only the other write, already under way as the refusal came back, goes before the wait.
    const after = r.events.slice(refused + 1).filter((e) => e.kind === 'start');
    expect(after.filter((e) => e.at < resumeAt).length).toBeLessThanOrEqual(1);
    expect(after.find((e) => e.i === 49)!.at).toBeGreaterThanOrEqual(resumeAt);
    expect(r.tries.get(49)).toBe(2);
    expect(onWait).toHaveBeenCalled();
    expect(r.answers.size).toBe(150);
    expect([...r.answers.values()].every((a) => a?.error === null)).toBe(true);
  });

  it('give up after two waits, and hand back every write still unsent, for the save to keep', async () => {
    const r = rig(() => busy);
    await pacedWrites(r.writes(10), r.opts());
    expect(r.sleep).toHaveBeenCalledTimes(2);
    for (const [ms] of r.sleep.mock.calls) expect(ms).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
    expect(r.answers.size).toBe(10);
    expect([...r.answers.values()].every((a) => a === null)).toBe(true);
  });

  it('answer a refusal no wait fixes as it came, without waiting or sending it again', async () => {
    const denied = { code: 403, message: 'Permission denied' };
    const r = rig((i) => (i === 3 ? denied : null));
    await pacedWrites(r.writes(6), r.opts());
    expect(r.sleep).not.toHaveBeenCalled();
    expect(r.tries.get(3)).toBe(1);
    expect(r.answers.get(3)).toEqual({ error: denied });
  });
});

describe('a read refused for rate', () => {
  const busy = { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' };

  it('waits out the window, says Facilio is busy, and asks again', async () => {
    const heard = vi.fn();
    const off = onFacilioBusy(heard);
    const sleep = vi.fn(async (_ms: number) => {});
    const read = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce({ code: 0, data: { floor: 1 } });
    expect(await readPatiently(read, sleep)).toEqual({ code: 0, data: { floor: 1 } });
    expect(read).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it('knows the refusal as an SDK result, and as a thrown dev-mode error', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const sdk = vi.fn().mockResolvedValueOnce({ error: busy }).mockResolvedValueOnce({ error: null, desks: [] });
    expect(await readPatiently(sdk, sleep)).toEqual({ error: null, desks: [] });
    const thrown = vi.fn().mockRejectedValueOnce({ response: { status: 429 } }).mockResolvedValueOnce('ok');
    expect(await readPatiently(thrown, sleep)).toBe('ok');
  });

  it('comes back at once with anything a wait does not fix', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const denied = { error: { code: 403, message: 'Permission denied' } };
    const read = vi.fn().mockResolvedValue(denied);
    expect(await readPatiently(read, sleep)).toBe(denied);
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    await expect(readPatiently(vi.fn().mockRejectedValue(new Error('network down')), sleep)).rejects.toThrow('network down');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after two waits, handing back the refusal for the caller to say so', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const read = vi.fn().mockResolvedValue(busy);
    expect(await readPatiently(read, sleep)).toBe(busy);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('a write whose send throws', () => {
  it('is answered with an error of its own, and every other write is still sent and answered', async () => {
    const answers = new Map<number, { error: { message?: string; code?: number } | null } | null>();
    const sent: number[] = [];
    const writes: PacedWrite<{ error: { message?: string; code?: number } | null }>[] = Array.from({ length: 6 }, (_, i) => ({
      send: async () => {
        sent.push(i);
        if (i === 2) throw new Error('bridge dropped');
        return { error: null };
      },
      done: (res) => void answers.set(i, res),
    }));
    const onWait = vi.fn();
    await expect(pacedWrites(writes, { starts: [], sleep: async () => {}, now: () => 0, onWait })).resolves.toBeUndefined();
    expect(sent).toEqual([0, 1, 2, 3, 4, 5]);
    expect(answers.size).toBe(6);
    expect(answers.get(2)).toEqual({ error: { message: 'bridge dropped' } });
    expect([0, 1, 3, 4, 5].every((i) => answers.get(i)?.error === null)).toBe(true);
    expect(onWait).not.toHaveBeenCalled();
  });

  it('waits out the window when what it threw was a refusal for rate, then sends it again', async () => {
    let tries = 0;
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const done = vi.fn();
    await pacedWrites(
      [
        {
          send: async () => {
            tries++;
            if (tries === 1) throw { response: { status: 429 } };
            return { error: null };
          },
          done,
        },
      ],
      { starts: [], sleep, now: () => clock },
    );
    expect(tries).toBe(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
    expect(done).toHaveBeenCalledWith({ error: null });
  });
});

describe("a save's writes, counted with this person's other tabs", () => {
  /** Two tabs' channels, joined the way one BroadcastChannel name joins them: each hears the other, never itself. */
  const channelPair = (): [StartLogChannel, StartLogChannel] => {
    const listeners: ((e: MessageEvent) => void)[][] = [[], []];
    const make = (me: 0 | 1): StartLogChannel => ({
      postMessage: (data) => listeners[1 - me].forEach((l) => l({ data } as MessageEvent)),
      addEventListener: (_type, l) => void listeners[me].push(l),
    });
    return [make(0), make(1)];
  };

  it('start no more than 80 in any minute between two tabs saving at once', async () => {
    let clock = 0;
    const now = () => clock;
    // One clock for both tabs: it moves only when a pacer sleeps, by the wait it asked for.
    const sleep = async (ms: number) => {
      clock = Math.max(clock, ms + clock);
    };
    const [a, b] = channelPair();
    const logA: number[] = [];
    const logB: number[] = [];
    const announceA = linkStartLog(logA, a, now);
    const announceB = linkStartLog(logB, b, now);
    const started: number[] = [];
    const writes = (n: number): PacedWrite<{ error: null }>[] =>
      Array.from({ length: n }, () => ({
        send: async () => {
          started.push(clock);
          await Promise.resolve();
          return { error: null };
        },
        done: () => {},
      }));
    await Promise.all([
      pacedWrites(writes(70), { starts: logA, announce: announceA, sleep, now }),
      pacedWrites(writes(70), { starts: logB, announce: announceB, sleep, now }),
    ]);
    expect(started).toHaveLength(140);
    for (const t of started) expect(started.filter((s) => s >= t && s < t + RATE_LIMIT_WAIT_MS).length).toBeLessThanOrEqual(WRITES_PER_WINDOW);
  });

  it('keeps the log oldest first, and holds no start older than the window', () => {
    const [a, b] = channelPair();
    const log = [1_000, 2_000];
    linkStartLog(log, a, () => 61_000);
    const tell = linkStartLog([], b, () => 61_000);
    tell(1_500);
    tell(500); // older than a minute by now — not taken
    tell(20_000);
    // 1_000 has aged out of the window too, and is trimmed as the others arrive.
    expect(log).toEqual([1_500, 2_000, 20_000]);
  });

  it('trims what it keeps as starts arrive, in a tab that never saves', () => {
    const [a, b] = channelPair();
    let clock = 0;
    const log: number[] = [];
    linkStartLog(log, a, () => clock);
    const tell = linkStartLog([], b, () => clock);
    for (let i = 0; i < 500; i++) {
      clock = i * 1_000;
      tell(clock);
    }
    // Only the last minute's starts are held, however long the other tab has been saving.
    expect(log.length).toBeLessThanOrEqual(61);
    expect(log[0]).toBeGreaterThan(clock - RATE_LIMIT_WAIT_MS);
  });

  it('holds the next write until a refusal another tab announced has been waited out', async () => {
    const [a, b] = channelPair();
    let clock = 0;
    const now = () => clock;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const hold: WriteHold = { until: 0 };
    linkWriteHold(hold, b, now);
    const tellFromA = linkWriteHold({ until: 0 }, a, now);
    tellFromA(30_000);
    const sentAt: number[] = [];
    const onWait = vi.fn();
    await pacedWrites([{ send: async () => (sentAt.push(clock), { error: null }), done: () => {} }], { starts: [], hold, sleep, now, onWait });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(sentAt).toEqual([30_000]);
    expect(onWait).toHaveBeenCalledWith(1);
  });

  it('tells the other tabs until when it waits when its own write is refused', async () => {
    let clock = 5_000;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const announceHold = vi.fn();
    let tries = 0;
    const done = vi.fn();
    await pacedWrites(
      [{ send: async () => (++tries === 1 ? { error: { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' } } : { error: null }), done }],
      { starts: [], announceHold, sleep, now: () => clock },
    );
    expect(announceHold).toHaveBeenCalledTimes(1);
    const until = announceHold.mock.calls[0][0] as number;
    expect(until).toBeGreaterThanOrEqual(5_000 + RATE_LIMIT_WAIT_MS);
    expect(until).toBeLessThanOrEqual(5_000 + RATE_LIMIT_WAIT_MS + RATE_LIMIT_JITTER_MS);
    expect(done).toHaveBeenCalledWith({ error: null });
  });

  it('waits a told hold out once, on a clock that does not move — and not as one of its own retries', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const busy = { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' };
    const done = vi.fn();
    await pacedWrites([{ send: async () => ({ error: busy }), done }], { starts: [], hold: { until: 30_000 }, sleep, now: () => 0 });
    // The hold, then this save's own two waits; still refused, the write is handed back unsent.
    expect(sleep.mock.calls.map(([ms]) => ms >= RATE_LIMIT_WAIT_MS)).toEqual([false, true, true]);
    expect(done).toHaveBeenCalledWith(null);
  });

  it('does not wait on a hold that has already passed', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const done = vi.fn();
    await pacedWrites([{ send: async () => ({ error: null }), done }], { starts: [], hold: { until: 40_000 }, sleep, now: () => 100_000 });
    expect(sleep).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith({ error: null });
  });

  it('takes no hold that is not a time, nor one told as further off than a window and its jitter', () => {
    const [a, b] = channelPair();
    const hold: WriteHold = { until: 0 };
    linkWriteHold(hold, a, () => 100_000);
    const tell = linkWriteHold({ until: 0 }, b, () => 100_000);
    tell(Number.NaN);
    expect(hold.until).toBe(0);
    tell(100_000 + 10 * 60_000);
    expect(hold.until).toBe(100_000 + RATE_LIMIT_WAIT_MS + RATE_LIMIT_JITTER_MS);
    // An earlier one never shortens a later one.
    tell(110_000);
    expect(hold.until).toBe(100_000 + RATE_LIMIT_WAIT_MS + RATE_LIMIT_JITTER_MS);
  });

  it('paces exactly as before when no other tab is listening', async () => {
    const posted: unknown[] = [];
    const lonely: StartLogChannel = { postMessage: (m) => void posted.push(m), addEventListener: () => {} };
    const log: number[] = [];
    const announce = linkStartLog(log, lonely);
    const done = vi.fn();
    await pacedWrites(
      Array.from({ length: 3 }, () => ({ send: async () => ({ error: null }), done })),
      { starts: log, announce, sleep: async () => {}, now: () => 1 },
    );
    expect(done).toHaveBeenCalledTimes(3);
    expect(log).toEqual([1, 1, 1]);
    expect(posted).toEqual([{ start: 1 }, { start: 1 }, { start: 1 }]);
  });
});

describe('a burst of reads to one address', () => {
  it('runs at most the given number at a time, and answers in the order asked', async () => {
    let inFlight = 0;
    let most = 0;
    const out = await mapPooled([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
  });

  it('stops at the first failure, as Promise.all does, and starts nothing after it', async () => {
    const started: number[] = [];
    await expect(
      mapPooled([1, 2, 3, 4, 5], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});

describe('a call that throws when refused', () => {
  const busy = Object.assign(new Error('executeAction facilio-cmms/list-sites failed: 429 Too Many Requests'), { status: 429 });
  const down = Object.assign(new Error('executeAction facilio-cmms/list-sites failed: 503 Service Unavailable'), { status: 503 });

  it('waits out the whole window before asking again — for a refusal for rate or a server failure', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const call = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(down).mockResolvedValueOnce('rows');
    expect(await withBackoff(call, sleep)).toBe('rows');
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    for (const [ms] of sleep.mock.calls) expect(ms).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
  });

  it('never retries anything else, and gives up after two waits', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const denied = Object.assign(new Error('403 Forbidden'), { status: 403 });
    await expect(withBackoff(vi.fn().mockRejectedValue(denied), sleep)).rejects.toBe(denied);
    expect(sleep).not.toHaveBeenCalled();
    const always = vi.fn().mockRejectedValue(busy);
    await expect(withBackoff(always, sleep)).rejects.toBe(busy);
    expect(always).toHaveBeenCalledTimes(3);
  });

  it('for a write, throws a server failure at once — it may have landed — and waits out only a refusal for rate', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const create = vi.fn().mockRejectedValue(down);
    await expect(withBackoff(create, sleep, { retryOn: 'rate' })).rejects.toBe(down);
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    const refusedOnce = vi.fn().mockRejectedValueOnce(busy).mockResolvedValueOnce({ id: 7 });
    expect(await withBackoff(refusedOnce, sleep, { retryOn: 'rate' })).toEqual({ id: 7 });
    expect(refusedOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
  });
});

describe('a read refused outright', () => {
  it('is a stop with no rows — so whatever keeps a partial answer keeps this one too', () => {
    const stop = new RateLimitedError('refused');
    expect(stop).toBeInstanceOf(IncompleteListError);
    expect(stop.rows).toEqual([]);
    expect(stop.rateLimited).toBe(true);
    expect(stop.name).toBe('RateLimitedError');
  });
});
