import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from './types';

/**
 * The connector tier reads lists a page at a time through the browser's `vibe.executeAction`
 * (deprecated — it belongs in a function; until it moves there it is at least polite). A page
 * refused for rate, or failed on the server, waits out Facilio's window and is asked again —
 * never at once — and the pages already read are kept rather than the list started over. A create
 * is sent again only after a refusal for rate: a server failure may mean it landed.
 */

const sdk = vi.hoisted(() => ({
  calls: [] as { action: string; body: Record<string, any> }[],
  answer: (_action: string, _body: Record<string, any>, _attempt: number): unknown => ({ data: [] }),
  attempts: new Map<string, number>(),
}));

vi.mock('./vibe', () => ({
  isVibeApp: true,
  CMMS_CONNECTION: 'facilio-cmms',
  RESPONDERS_FN: 'floorplanResponders',
  vibe: {
    executeAction: vi.fn(async (_conn: string, action: string, body: Record<string, any>) => {
      sdk.calls.push({ action, body });
      const key = `${action}:${body.page ?? ''}:${body.custom_module ?? ''}`;
      const attempt = (sdk.attempts.get(key) ?? 0) + 1;
      sdk.attempts.set(key, attempt);
      const out = sdk.answer(action, body, attempt);
      if (out instanceof Error) throw out;
      return out;
    }),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});

const { ConnectorDataSource } = await import('./connectorDataSource');
const { RATE_LIMIT_WAIT_MS } = await import('./rateLimit');
const { vibe } = await import('./vibe');

const vibeError = (status: number) => Object.assign(new Error(`executeAction facilio-cmms/list-sites failed: ${status}`), { status });
const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `Site ${String(from + i).padStart(4, '0')}` }));

beforeEach(() => {
  sdk.calls.length = 0;
  sdk.attempts.clear();
  vi.mocked(vibe.executeAction).mockClear();
});

describe('a connector list refused part-way', () => {
  it('keeps pages 1–2 through a refusal on page 3, waits out the window, and asks for page 3 again — no immediate retry', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    sdk.answer = (_a, body, attempt) => {
      if (body.page === 3 && attempt === 1) return vibeError(429);
      return { data: body.page < 3 ? page((body.page - 1) * 200, 200) : page(400, 17) };
    };
    const sites = await new ConnectorDataSource({ sleep }).getPortfolio();
    expect(sites).toHaveLength(417);
    expect(sdk.calls.map((c) => c.body.page)).toEqual([1, 2, 3, 3]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
  });

  it('waits out a server failure (5xx) the same way', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    sdk.answer = (_a, body, attempt) => (attempt === 1 ? vibeError(503) : { data: page(0, 3) });
    expect(await new ConnectorDataSource({ sleep }).getPortfolio()).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('never retries a refusal no wait fixes', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    sdk.answer = () => vibeError(403);
    await expect(new ConnectorDataSource({ sleep }).getPortfolio()).rejects.toThrow(/403/);
    expect(sdk.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after two waits and fails the list — saying how far it got — for the tier below', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    sdk.answer = (_a, body) => (body.page === 2 ? vibeError(429) : { data: page(0, 200) });
    await expect(new ConnectorDataSource({ sleep }).getPortfolio()).rejects.toThrow(/page 2 after 200 rows/);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sdk.calls.filter((c) => c.body.page === 2)).toHaveLength(3);
  });
});

describe('a space created through the connector', () => {
  const loc = { siteId: '1', buildingId: '2', floorId: '7' };
  const desk: Unit = { id: 'u1', type: 'workstation', label: 'D-01', room: null, geom: { kind: 'point', x: 0.1, y: 0.1 }, floor: '7', plan: 'workstation' };

  it('is sent once when Facilio answers with a server error — it may have landed, so it is never sent again', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    vi.mocked(vibe.executeAction).mockRejectedValueOnce({ status: 502 });
    await expect(new ConnectorDataSource({ sleep }).createUnit(loc, desk)).rejects.toEqual({ status: 502 });
    expect(vibe.executeAction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(vibe.executeAction).mock.calls[0][1]).toBe('create-space');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('is sent again after the wait when Facilio refused it for rate — it was never made', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    vi.mocked(vibe.executeAction).mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce({ data: { id: 9001 } } as never);
    expect((await new ConnectorDataSource({ sleep }).createUnit(loc, desk)).id).toBe('9001');
    expect(vibe.executeAction).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(RATE_LIMIT_WAIT_MS);
  });

  it('while a read failed on the server is still asked again after the wait', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    sdk.answer = (_a, body, attempt) => (attempt === 1 ? vibeError(504) : { data: [{ id: 1, name: String(body.custom_module) }] });
    expect(await new ConnectorDataSource({ sleep }).getUnits('7')).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

describe("a floor's spaces through the connector", () => {
  it('reads the desk, locker and stall lists no more than two at a time', async () => {
    let inFlight = 0;
    let most = 0;
    vi.mocked(vibe.executeAction).mockImplementation(async (_c: string, _a: string, body: any) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return { data: [{ id: body.custom_module === 'desks' ? 1 : body.custom_module === 'lockers' ? 2 : 3, name: body.custom_module }] } as never;
    });
    const units = await new ConnectorDataSource().getUnits('42');
    expect(units.map((u) => u.type)).toEqual(['workstation', 'locker', 'parking']);
    expect(most).toBe(2);
  });
});
