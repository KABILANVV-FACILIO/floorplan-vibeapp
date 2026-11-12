import { describe, expect, it, vi } from 'vitest';
import { IncompleteListError, isRateLimited, onFacilioBusy, pacedWrites, rateLimitWait, readPatiently, RATE_LIMIT_WAIT_MS, WRITES_PER_WINDOW } from './rateLimit';
import type { PacedWrite } from './rateLimit';

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
