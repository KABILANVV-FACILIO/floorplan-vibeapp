import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Employee } from '../lib/types';

/**
 * The people a surface shows (v77 review): with nothing typed, the roster the app already holds —
 * no employee list read per open, and never one page of 200 in place of the whole roster. Typing
 * still searches the org (debounced), a failed search is said by the hook itself, and retry()
 * searches again.
 */

const org = vi.hoisted(() => ({ fetchEmployees: vi.fn(), queryEmployees: vi.fn() }));
vi.mock('../lib/facilioApi', () => ({ isFacilioApiConfigured: true }));
// `fetchEmployees` stays on the mock only so a test can prove it is never called.
vi.mock('../lib/facilioApiDataSource', () => ({ fetchEmployees: org.fetchEmployees, queryEmployees: org.queryEmployees }));

const { useLivePeople } = await import('./useLivePeople');

const omar: Employee = { id: '1', name: 'Omar Al Marri' };
const roster: Employee[] = [];
const bigRoster: Employee[] = Array.from({ length: 2600 }, (_, i) => ({ id: String(i + 1), name: `Person ${i + 1}` }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useLivePeople', () => {
  it('shows the whole roster in hand for an empty query, and asks the org for no employee list', async () => {
    const { result } = renderHook(() => useLivePeople('', bigRoster));
    expect(result.current.people.length).toBe(2600);
    expect(result.current.loading).toBe(false);
    expect(result.current.loadFailed).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(org.fetchEmployees).not.toHaveBeenCalled();
    expect(org.queryEmployees).not.toHaveBeenCalled();
    expect(result.current.people.length).toBe(2600);
  });

  it('follows the roster as the app refreshes it, rather than a copy taken when the surface opened', () => {
    const { result, rerender } = renderHook(({ list }) => useLivePeople('', list), { initialProps: { list: [omar] } });
    expect(result.current.people).toEqual([omar]);
    rerender({ list: bigRoster });
    expect(result.current.people.length).toBe(2600);
    expect(org.fetchEmployees).not.toHaveBeenCalled();
  });

  it('an empty roster with nothing typed is not a failure, and is not loading', () => {
    const { result } = renderHook(() => useLivePeople('', roster));
    expect(result.current.people).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.loadFailed).toBe(false);
  });

  it('with nothing typed, an empty roster still being read is loading — not "no people"', () => {
    const { result } = renderHook(() => useLivePeople('', [], { rosterStatus: 'loading' }));
    expect(result.current.loading).toBe(true);
    expect(result.current.loadFailed).toBe(false);
  });

  it('with nothing typed, a roster that could not be read says so, and retry() asks the app for it — no list read here', () => {
    const reloadRoster = vi.fn();
    const { result } = renderHook(() => useLivePeople('', [], { rosterStatus: 'failed', reloadRoster }));
    expect(result.current.loading).toBe(false);
    expect(result.current.loadFailed).toBe(true);
    act(() => result.current.retry());
    expect(reloadRoster).toHaveBeenCalledTimes(1);
    expect(org.queryEmployees).not.toHaveBeenCalled();
    expect(org.fetchEmployees).not.toHaveBeenCalled();
  });

  it('a roster in hand is the list whatever its status says', () => {
    const { result } = renderHook(() => useLivePeople('', [omar], { rosterStatus: 'failed' }));
    expect(result.current.people).toEqual([omar]);
    expect(result.current.loadFailed).toBe(false);
  });

  it('typing searches the org once, after the typing stops, and its answer replaces the local match', async () => {
    vi.useFakeTimers();
    const found: Employee = { id: '9001', name: 'Zara Outside-Roster' };
    org.queryEmployees.mockResolvedValue([found]);
    const { result, rerender } = renderHook(({ q }) => useLivePeople(q, bigRoster), { initialProps: { q: '' } });
    rerender({ q: 'z' });
    rerender({ q: 'za' });
    rerender({ q: 'zar' });
    // The roster answers the keystroke at once (nobody in it matches).
    expect(result.current.people).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(org.queryEmployees).toHaveBeenCalledTimes(1);
    expect(org.queryEmployees).toHaveBeenCalledWith(expect.objectContaining({ query: 'zar' }));
    expect(result.current.people).toEqual([found]);
    expect(org.fetchEmployees).not.toHaveBeenCalled();
  });

  it('says a typed search could not be made, and retry() searches again', async () => {
    org.queryEmployees.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useLivePeople('zz', roster));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    org.queryEmployees.mockResolvedValueOnce([]);
    act(() => result.current.retry());
    await waitFor(() => expect(org.queryEmployees).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loadFailed).toBe(false));
  });
});
