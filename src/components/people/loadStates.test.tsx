import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Employee, Unit } from '../../lib/types';

/**
 * When the org's people could not be read, the People page and the assign picker said there were
 * none — the page literally `No people match “”`. Now: shimmer rows while asking, "Couldn't load
 * people · Retry" when the read failed, and "No people match" only for a search that was typed.
 *
 * The failure is the hook's to report (`loadFailed`) and Retry its `retry()` — this used to be
 * guessed from an empty list, and Retry remounted the list to start a fresh read; the mock below
 * counted those mounts. It now counts retry() calls.
 */

const ctx = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  live: { people: [] as Employee[], loading: false, failed: false },
  retries: 0,
}));

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state: ctx.state, actions: { showToast: vi.fn(), setUnitBusy: vi.fn(), markAssigned: vi.fn(), refreshAssignments: vi.fn(), assign: vi.fn() } }),
}));
vi.mock('../../lib/facilioApi', () => ({ isFacilioApiConfigured: true, facilioRecordUrl: () => null }));
vi.mock('../../lib/facilioApiDataSource', () => ({ assignEmployeeToRecord: vi.fn(), resolveUnitRecord: () => null }));
// The org read: what it returns is set per test; each retry() is counted, and re-renders as a fresh read would.
vi.mock('../../hooks/useLivePeople', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    useLivePeople: (query: string) => {
      const [, bump] = useState(0);
      const q = query.trim().toLowerCase();
      return {
        people: ctx.live.people.filter((p) => !q || p.name.toLowerCase().includes(q)),
        loading: ctx.live.loading,
        failed: false,
        loadFailed: ctx.live.failed,
        retry: () => {
          ctx.retries += 1;
          bump((n) => n + 1);
        },
      };
    },
  };
});

const { PeopleView } = await import('./PeopleView');
const { AssignEmployeeModal } = await import('../details/AssignEmployeeModal');

const desk = { id: 'd1', type: 'workstation', label: 'WS-01', geom: { kind: 'point', x: 0.5, y: 0.5 }, plan: 'workstation', room: null } as Unit;

beforeEach(() => {
  ctx.retries = 0;
  ctx.live = { people: [], loading: true, failed: false };
  ctx.state = { employees: [], assignments: {}, units: [], enabledModules: {} };
});
afterEach(cleanup);

/** The org is asked (loading), then answers with `people` — or fails (`failed`), leaving nothing to show. */
function answer(people: Employee[], rerender: () => void, failed = false) {
  ctx.live = { people, loading: false, failed };
  act(() => rerender());
}

describe('the People page', () => {
  it('shows shimmer rows while the org is asked, never "No people match “”"', () => {
    render(<PeopleView />);
    expect(screen.queryByText(/No people match/)).toBeNull();
    expect(screen.queryByText(/Couldn’t load/)).toBeNull();
    expect(screen.getByText('Loading people…')).toBeTruthy();
  });

  it('says it could not load, with Retry, when the read failed — and Retry asks again', () => {
    const { rerender } = render(<PeopleView />);
    answer([], () => rerender(<PeopleView />), true);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load people');
    expect(screen.queryByText(/No people match/)).toBeNull();

    ctx.live = { people: [{ id: '1', name: 'Omar Al Marri' }], loading: false, failed: false };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(ctx.retries).toBe(1);
    expect(screen.getByText('Omar Al Marri')).toBeTruthy();
  });

  it('says the org has nobody, not that it failed, when the read answered with no one', () => {
    const { rerender } = render(<PeopleView />);
    answer([], () => rerender(<PeopleView />));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('No people in this org yet.')).toBeTruthy();
  });

  it('says a typed search could not be made, with Retry, rather than that nobody matches', () => {
    const { rerender } = render(<PeopleView />);
    fireEvent.change(screen.getByRole('textbox', { name: /Search people/ }), { target: { value: 'zz' } });
    answer([], () => rerender(<PeopleView />), true);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t search people');
    expect(screen.queryByText(/No people match/)).toBeNull();
  });

  it('keeps "No people match" for a search that was typed', () => {
    ctx.live = { people: [{ id: '1', name: 'Omar Al Marri' }], loading: false, failed: false };
    render(<PeopleView />);
    fireEvent.change(screen.getByRole('textbox', { name: /Search people/ }), { target: { value: 'zz' } });
    expect(screen.getByText('No people match “zz”.')).toBeTruthy();
  });
});

describe('the assign picker', () => {
  it('shows shimmer rows while the org is asked', () => {
    render(<AssignEmployeeModal unit={desk} onClose={() => {}} />);
    expect(screen.queryByText(/Couldn’t load/)).toBeNull();
    expect(screen.queryByText(/No people in this org/)).toBeNull();
    expect((screen.getByRole('textbox', { name: 'Search people' }) as HTMLInputElement).placeholder).toBe('Loading people…');
  });

  it('says it could not load, with Retry, instead of "No people in this org yet" — and Retry asks again', () => {
    const el = <AssignEmployeeModal unit={desk} onClose={() => {}} />;
    const { rerender } = render(el);
    answer([], () => rerender(<AssignEmployeeModal unit={desk} onClose={() => {}} />), true);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load people');
    expect(screen.queryByText(/No people in this org/)).toBeNull();

    ctx.live = { people: [{ id: '7', name: 'Niviya' }], loading: false, failed: false };
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(ctx.retries).toBe(1);
    expect(screen.getByRole('button', { name: /Niviya/ })).toBeTruthy();
  });

  it('says "Nobody matches" only for a typed search', () => {
    ctx.live = { people: [{ id: '7', name: 'Niviya' }], loading: false, failed: false };
    render(<AssignEmployeeModal unit={desk} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search people' }), { target: { value: 'zz' } });
    expect(screen.getByText('Nobody matches “zz”.')).toBeTruthy();
  });
});
