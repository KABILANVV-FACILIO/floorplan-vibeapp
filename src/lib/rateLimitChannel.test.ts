import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The channel a person's tabs share their write starts and refusals on is opened as lib/rateLimit
 * loads — so a tab that has not saved yet still hears what the others announce, and its first save
 * is paced against them — and opening it never fails the import, wherever BroadcastChannel is
 * missing or refuses. Each test loads the module afresh; "another tab" is a second real channel of
 * the same name.
 */

const CHANNEL = 'floorplan-manager:write-starts';
/** A message on a BroadcastChannel arrives on a later task. */
const delivered = () => new Promise((resolve) => setTimeout(resolve, 20));

const otherTab = () => {
  const channel = new BroadcastChannel(CHANNEL);
  (channel as unknown as { unref?: () => void }).unref?.();
  return channel;
};

/** A clock that starts now and moves only when the pacer sleeps. */
const clock = () => {
  const base = Date.now();
  let offset = 0;
  return {
    base,
    now: () => base + offset,
    elapsed: () => offset,
    sleep: vi.fn(async (ms: number) => {
      offset += ms;
    }),
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the channel between tabs', () => {
  it('counts the starts another tab announced before this tab’s first save', async () => {
    vi.resetModules();
    const { pacedWrites, RATE_LIMIT_WAIT_MS, WRITES_PER_WINDOW } = await import('./rateLimit');
    const other = otherTab();
    const c = clock();
    for (let i = 0; i < WRITES_PER_WINDOW; i++) other.postMessage({ start: c.base });
    await delivered();
    const sentAt: number[] = [];
    await pacedWrites([{ send: async () => (sentAt.push(c.elapsed()), { error: null }), done: () => {} }], { sleep: c.sleep, now: c.now });
    other.close();
    // The other tab used the window up: this tab's first write waits for room in it.
    expect(c.sleep).toHaveBeenCalledTimes(1);
    expect(sentAt).toEqual([RATE_LIMIT_WAIT_MS]);
  });

  it('holds this tab’s next write until a refusal another tab announced has been waited out', async () => {
    vi.resetModules();
    const { pacedWrites } = await import('./rateLimit');
    const other = otherTab();
    const c = clock();
    other.postMessage({ holdUntil: c.base + 30_000 });
    await delivered();
    const sentAt: number[] = [];
    await pacedWrites([{ send: async () => (sentAt.push(c.elapsed()), { error: null }), done: () => {} }], { sleep: c.sleep, now: c.now });
    other.close();
    expect(c.sleep).toHaveBeenCalledWith(30_000);
    expect(sentAt).toEqual([30_000]);
  });

  it('tells the other tabs until when it waits when Facilio refuses one of its writes', async () => {
    vi.resetModules();
    const { pacedWrites, RATE_LIMIT_JITTER_MS, RATE_LIMIT_WAIT_MS } = await import('./rateLimit');
    const other = otherTab();
    const heard: unknown[] = [];
    other.addEventListener('message', (e) => heard.push((e as MessageEvent).data));
    const c = clock();
    let tries = 0;
    await pacedWrites(
      [{ send: async () => (++tries === 1 ? { error: { code: 6, message: 'You have reached the maximum number of allowed requests for this API.' } } : { error: null }), done: () => {} }],
      { sleep: c.sleep, now: c.now },
    );
    await delivered();
    other.close();
    const holds = heard.filter((m): m is { holdUntil: number } => typeof (m as { holdUntil?: unknown })?.holdUntil === 'number');
    expect(holds).toHaveLength(1);
    expect(holds[0].holdUntil).toBeGreaterThanOrEqual(c.base + RATE_LIMIT_WAIT_MS);
    expect(holds[0].holdUntil).toBeLessThanOrEqual(c.base + RATE_LIMIT_WAIT_MS + RATE_LIMIT_JITTER_MS);
  });

  it('never fails the import where there is no BroadcastChannel, and paces on this tab’s own count', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.resetModules();
    const { pacedWrites } = await import('./rateLimit');
    const done = vi.fn();
    await pacedWrites([{ send: async () => ({ error: null }), done }], { sleep: async () => {}, now: () => 0 });
    expect(done).toHaveBeenCalledWith({ error: null });
  });

  it('never fails the import where opening the channel throws', async () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('blocked');
        }
      },
    );
    vi.resetModules();
    const { pacedWrites } = await import('./rateLimit');
    const done = vi.fn();
    await pacedWrites([{ send: async () => ({ error: null }), done }], { sleep: async () => {}, now: () => 0 });
    expect(done).toHaveBeenCalledWith({ error: null });
  });
});
