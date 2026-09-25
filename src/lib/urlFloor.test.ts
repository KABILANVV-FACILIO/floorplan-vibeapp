import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The floor in the url decides where the app opens, ahead of the user's own desk. These pin the
 * order, and that the url is read and written through the host when embedded — the host's url is
 * the one the user sees and shares — and on the app's own url otherwise.
 */

const host = vi.hoisted(() => ({
  embedded: false,
  query: null as Record<string, unknown> | null,
  pushed: [] as Record<string, string>[],
}));

vi.mock('./facilioApi', () => ({
  get isConnectedApp() {
    return host.embedded;
  },
  getHostUrlProps: async () => host.query,
  pushHostUrlProps: (q: Record<string, string>) => host.pushed.push(q),
}));

const { bootFloorCandidates, readUrlFloorId, writeUrlFloorId, _resetUrlFloorForTests } = await import('./urlFloor');

beforeEach(() => {
  host.embedded = false;
  host.query = null;
  host.pushed = [];
  _resetUrlFloorForTests();
  window.history.replaceState({}, '', '/');
});

describe('which floor to open on', () => {
  it('tries the floor in the url before the desk', () => {
    expect(bootFloorCandidates('4417', '5100')).toEqual([
      { floorId: '4417', source: 'url' },
      { floorId: '5100', source: 'desk' },
    ]);
  });

  it('falls to the desk when the url names no floor', () => {
    expect(bootFloorCandidates(null, '5100')).toEqual([{ floorId: '5100', source: 'desk' }]);
    expect(bootFloorCandidates('  ', '5100')).toEqual([{ floorId: '5100', source: 'desk' }]);
  });

  it('does not try the same floor twice', () => {
    expect(bootFloorCandidates('5100', '5100')).toEqual([{ floorId: '5100', source: 'url' }]);
  });

  it('has nothing to try with neither', () => {
    expect(bootFloorCandidates(undefined, undefined)).toEqual([]);
  });
});

describe('inside Facilio, the host page url', () => {
  beforeEach(() => {
    host.embedded = true;
  });

  it('reads floorId from the host query', async () => {
    host.query = { floorId: '4417', other: 'x' };
    expect(await readUrlFloorId()).toBe('4417');
  });

  it('writes floorId through pushUrlProps as { floorId }', () => {
    writeUrlFloorId('4417');
    expect(host.pushed).toEqual([{ floorId: '4417' }]);
  });

  it('writes nothing when the floor did not change', () => {
    writeUrlFloorId('4417');
    writeUrlFloorId('4417');
    expect(host.pushed).toHaveLength(1);
  });

  it('treats a host that did not answer as no floor in the url', async () => {
    host.query = null;
    expect(await readUrlFloorId()).toBeNull();
  });
});

describe('opened on its own, the app url', () => {
  it('reads ?floorId=', async () => {
    window.history.replaceState({}, '', '/?floorId=hqA2');
    expect(await readUrlFloorId()).toBe('hqA2');
  });

  it('writes ?floorId= without adding a history entry, keeping the path', () => {
    window.history.replaceState({}, '', '/bookings');
    const before = window.history.length;
    writeUrlFloorId('hqA2');
    expect(window.location.pathname).toBe('/bookings');
    expect(new URLSearchParams(window.location.search).get('floorId')).toBe('hqA2');
    expect(window.history.length).toBe(before);
  });
});
