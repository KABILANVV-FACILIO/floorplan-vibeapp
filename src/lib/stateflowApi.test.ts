import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stateflow client talks to four endpoints whose envelopes differ by family (v2 answers
 * `{responseCode, result}`, v3 `{code, data}`), so most of what can go wrong here is unwrapping
 * and payload shape. These pin both, plus the connected-mode fallback that exists because the
 * host bridge's PATCH support is unverified.
 */

const calls: { kind: string; path: string; body?: unknown; params?: unknown }[] = [];
let getBody: unknown;
let postBody: unknown;
let patchImpl: () => unknown = () => ({ code: 0, data: {} });
let updateImpl: () => unknown = () => ({ error: null });
let connected = true;

vi.mock('./facilioApi', () => ({
  isFacilioApiConfigured: true,
  get isConnectedApp() {
    return connected;
  },
  customGet: (path: string, params?: unknown) => {
    calls.push({ kind: 'GET', path, params });
    return Promise.resolve(getBody);
  },
  customPost: (path: string, body?: unknown) => {
    calls.push({ kind: 'POST', path, body });
    return Promise.resolve(postBody);
  },
  customPatch: (path: string, body?: unknown) => {
    calls.push({ kind: 'PATCH', path, body });
    return Promise.resolve(patchImpl());
  },
  facilioApi: {
    updateRecord: (moduleName: string, params: unknown) => {
      calls.push({ kind: 'updateRecord', path: moduleName, body: params });
      return Promise.resolve(updateImpl());
    },
  },
}));

const api = await import('./stateflowApi');

beforeEach(() => {
  calls.length = 0;
  connected = true;
  api.forgetFlowReads();
  patchImpl = () => ({ code: 0, data: {} });
  updateImpl = () => ({ error: null });
});

describe('reading a record’s available transitions', () => {
  it('unwraps the v2 envelope and names the current state', async () => {
    getBody = {
      responseCode: 0,
      result: { currentState: { displayName: 'Yet to Assign' }, states: [{ id: 5, name: 'Assign' }, { id: 6, name: 'Block' }] },
    };
    const flow = await api.fetchAvailableStates('desks', 1676024);

    expect(calls[0]).toMatchObject({ kind: 'GET', path: 'v2/statetransition/getAvailableState', params: { moduleName: 'desks', id: 1676024 } });
    expect(flow.currentStateName).toBe('Yet to Assign');
    expect(flow.transitions.map((t) => t.name)).toEqual(['Assign', 'Block']);
  });

  it('drops offline transitions and anything without a usable id', async () => {
    getBody = {
      responseCode: 0,
      result: { currentState: 'In Use', states: [{ id: 5, name: 'Vacate' }, { id: 7, name: 'Offline', isOffline: true }, { name: 'No id' }, null] },
    };
    const flow = await api.fetchAvailableStates('desks', 1);
    expect(flow.transitions.map((t) => t.name)).toEqual(['Vacate']);
    expect(flow.currentStateName).toBe('In Use');
  });

  it('surfaces a non-zero responseCode as an error rather than an empty list', async () => {
    getBody = { responseCode: 1, message: 'no stateflow on this module' };
    await expect(api.fetchAvailableStates('desks', 1)).rejects.toThrow('no stateflow on this module');
  });

  it('reports no state at all when the module has none', async () => {
    getBody = { responseCode: 0, result: { currentState: null, states: [] } };
    const flow = await api.fetchAvailableStates('space', 1);
    expect(flow.currentStateName).toBeNull();
    expect(flow.transitions).toEqual([]);
  });
});

describe('executing a transition', () => {
  it('PATCHes the real client’s path and payload', async () => {
    await api.executeStateTransition('desks', 1676024, 5);
    expect(calls[0]).toMatchObject({
      kind: 'PATCH',
      path: 'v3/action/desks/1676024/transition',
      body: { id: 1676024, stateTransitionId: 5, data: {} },
    });
  });

  it('carries a required comment in the shape the real client sends', async () => {
    await api.executeStateTransition('desks', 1, 9, { transitionCommentData: { body: 'why', bodyHTML: 'why' } });
    expect((calls[0].body as any).data.transitionCommentData).toEqual({ body: 'why', bodyHTML: 'why' });
  });

  it('falls back to updateRecord when the host bridge rejects PATCH', async () => {
    patchImpl = () => {
      throw new Error('PATCH not supported');
    };
    await api.executeStateTransition('desks', 42, 5);

    expect(calls.map((c) => c.kind)).toEqual(['PATCH', 'updateRecord']);
    expect(calls[1]).toMatchObject({ path: 'desks', body: { id: 42, stateTransitionId: 5 } });
  });

  it('does NOT fall back outside connected mode — a dev-mode failure is a real failure', async () => {
    connected = false;
    patchImpl = () => {
      throw new Error('boom');
    };
    await expect(api.executeStateTransition('desks', 42, 5)).rejects.toThrow('boom');
    expect(calls.map((c) => c.kind)).toEqual(['PATCH']);
  });

  it('does NOT re-send by the other road when Facilio refused the PATCH for rate, failed it (5xx) or let it time out', async () => {
    const failures: unknown[] = [
      Object.assign(new Error('You have reached the maximum number of allowed requests for this API.'), { code: 6 }),
      { response: { status: 429 } },
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
      new Error('Request failed with status code 502'),
      new Error('invokeFacilioAPI timed out'),
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    ];
    for (const failure of failures) {
      calls.length = 0;
      patchImpl = () => {
        throw failure;
      };
      await expect(api.executeStateTransition('desks', 42, 5)).rejects.toBe(failure);
      expect(calls.map((c) => c.kind)).toEqual(['PATCH']);
    }
  });

  it('still falls back when the error merely names a record whose id looks like a status', async () => {
    patchImpl = () => {
      throw new Error('invokeFacilioAPI: PATCH /api/v3/action/desks/503/transition is not supported');
    };
    await api.executeStateTransition('desks', 503, 5);
    expect(calls.map((c) => c.kind)).toEqual(['PATCH', 'updateRecord']);
  });

  it('still falls back when the bridge says it does not implement the verb (501)', async () => {
    patchImpl = () => {
      throw Object.assign(new Error('Not Implemented'), { status: 501 });
    };
    await api.executeStateTransition('desks', 42, 5);
    expect(calls.map((c) => c.kind)).toEqual(['PATCH', 'updateRecord']);
  });

  it('reports a rejected fallback instead of resolving silently', async () => {
    patchImpl = () => {
      throw new Error('nope');
    };
    updateImpl = () => ({ error: { message: 'transition not allowed from this state' } });
    await expect(api.executeStateTransition('desks', 42, 5)).rejects.toThrow('transition not allowed from this state');
  });

  it('treats a non-zero v3 code as a failure', async () => {
    patchImpl = () => ({ code: 7, message: 'invalid transition' });
    await expect(api.executeStateTransition('desks', 1, 5)).rejects.toThrow('invalid transition');
  });
});

describe('transition name helpers', () => {
  it('separates assign from vacate, whatever the org calls them', () => {
    const t = (name: string) => ({ id: 1, name });
    expect(api.isAssignTransition(t('Assign'))).toBe(true);
    expect(api.isAssignTransition(t('Re-Assign'))).toBe(true);
    // "Unassign" contains "assign" — the one that actually bit upstream.
    expect(api.isAssignTransition(t('Unassign'))).toBe(false);
    expect(api.isAssignTransition(t('De-assign'))).toBe(false);

    for (const name of ['Vacate', 'Unassign', 'Release', 'Check Out', 'Free Desk']) {
      expect(api.isVacateTransition(t(name))).toBe(true);
    }
    expect(api.isVacateTransition(t('Assign'))).toBe(false);
  });

  it('picks Re-assign out of the assign family — it reopens the picker on a held record', () => {
    const t = (name: string) => ({ id: 1, name });
    expect(api.isReassignTransition(t('Re-assign'))).toBe(true);
    expect(api.isReassignTransition(t('Reassign'))).toBe(true);
    expect(api.isReassignTransition(t('Assign'))).toBe(false);
    expect(api.isReassignTransition(t('Vacate'))).toBe(false);
  });

  it('renders a state object as a label, never as [object Object]', () => {
    expect(api.stateName({ displayName: 'In Use' })).toBe('In Use');
    expect(api.stateName({ status: 'Booked' })).toBe('Booked');
    expect(api.stateName('Free')).toBe('Free');
    expect(api.stateName({})).toBeNull();
    expect(api.stateName(null)).toBeNull();
  });

  it('finds the cancel transition when one is offered', () => {
    expect(api.findCancelTransition([{ id: 1, name: 'Approve' }, { id: 2, name: 'Cancel Booking' }])?.id).toBe(2);
    expect(api.findCancelTransition([{ id: 1, name: 'Approve' }])).toBeNull();
  });
});

describe('approval flow', () => {
  it('asks for approval transitions over POST and unwraps them', async () => {
    postBody = { responseCode: 0, result: { currentState: { displayName: 'Requested' }, states: [{ id: 3, name: 'Approve' }] } };
    const flow = await api.fetchApprovalTransitions('spacebooking', 99);
    expect(calls[0]).toMatchObject({ kind: 'POST', path: 'v2/approval/availableTransitions' });
    expect(flow.transitions[0].name).toBe('Approve');
    expect(api.isPendingApprovalName(flow.currentStateName)).toBe(true);
  });

  it('PATCHes an approval action on its own path', async () => {
    await api.executeApprovalTransition('spacebooking', 99, 3);
    expect(calls[0]).toMatchObject({
      kind: 'PATCH',
      path: 'v3/approval/action/spacebooking/99/approval',
      body: { id: 99, approvalTransitionId: 3, data: {} },
    });
  });
});

/**
 * One desk click mounted two readers of the same record's flow (the plan's card and the side
 * panel), each sending its own `getAvailableState`, against one per-minute limit. `readFlow`
 * shares them: a read on its way, and an answer for a few seconds after — for the same version only.
 */
describe('readFlow — one read for every surface showing the record', () => {
  const okBody = { responseCode: 0, result: { currentState: { displayName: 'Vacant' }, states: [{ id: 5, name: 'Assign' }] } };
  const gets = () => calls.filter((c) => c.kind === 'GET').length;

  it('two surfaces asking at once share one request', async () => {
    getBody = okBody;
    const [a, b] = await Promise.all([api.readFlow('desks', 11, '0.0'), api.readFlow('desks', 11, '0.0')]);
    expect(gets()).toBe(1);
    expect(a).toEqual(b);
    expect(a.transitions.map((t) => t.name)).toEqual(['Assign']);
  });

  it('a surface mounting a moment after the first answer is handed that answer, not a new request', async () => {
    getBody = okBody;
    await api.readFlow('desks', 12, '0.0');
    await api.readFlow('desks', 12, '0.0');
    expect(gets()).toBe(1);
  });

  it('a new version is a new read', async () => {
    getBody = okBody;
    await api.readFlow('desks', 13, '0.0');
    await api.readFlow('desks', 13, '0.1');
    expect(gets()).toBe(2);
  });

  it('other records are read for themselves', async () => {
    getBody = okBody;
    await Promise.all([api.readFlow('desks', 14, 0), api.readFlow('desks', 15, 0), api.readFlow('lockers', 14, 0)]);
    expect(gets()).toBe(3);
  });

  it('an answer is handed on for a few seconds only', async () => {
    getBody = okBody;
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      await api.readFlow('desks', 16, 0);
      now.mockReturnValue(1_004_000);
      await api.readFlow('desks', 16, 0);
      expect(gets()).toBe(1);
      now.mockReturnValue(1_006_000);
      await api.readFlow('desks', 16, 0);
      expect(gets()).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('a read that failed is never handed on — the next ask goes to the org', async () => {
    getBody = { responseCode: 1, message: 'busy' };
    await expect(api.readFlow('desks', 17, 0)).rejects.toThrow('busy');
    getBody = okBody;
    await expect(api.readFlow('desks', 17, 0)).resolves.toMatchObject({ currentStateName: 'Vacant' });
    expect(gets()).toBe(2);
  });

  it('a transition on the record drops its held flow, even at the same version', async () => {
    getBody = okBody;
    await api.readFlow('desks', 18, 0);
    await api.executeStateTransition('desks', 18, 5);
    await api.readFlow('desks', 18, 0);
    expect(gets()).toBe(2);
  });

  it('an approval on the record drops its held flow too', async () => {
    getBody = okBody;
    await api.readFlow('spacebooking', 19, 0);
    await api.executeApprovalTransition('spacebooking', 19, 3);
    await api.readFlow('spacebooking', 19, 0);
    expect(gets()).toBe(2);
  });
});
