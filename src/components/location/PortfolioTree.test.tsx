import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Typing in the floor search sent a `floor` list request on every keystroke. It now waits for the
 * typing to pause; the box itself still answers every key.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const setPortfolioSearch = vi.fn(async (q: string) => {
  ctx.state = { ...ctx.state, portfolioSearch: q, portfolioSearching: q.trim().length > 0 };
});
vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state: ctx.state, actions: { setPortfolioSearch, expandNode: vi.fn(), selectFloor: vi.fn(), setNavView: vi.fn(), revealSearchHit: vi.fn() } }),
}));

const { PortfolioTree } = await import('./PortfolioTree');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ctx.state = { portfolioSearch: '', portfolioSearching: false, portfolioSearchResults: [], portfolio: [], expanded: {}, treeLoading: {}, floorsWithPlans: {}, floorId: 'f1' };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const box = () => screen.getByRole('textbox', { name: 'Search floors' }) as HTMLInputElement;

describe('the floor search', () => {
  it('sends one search for five quick keystrokes, the last one typed', () => {
    render(<PortfolioTree />);
    for (const q of ['T', 'To', 'Tow', 'Towe', 'Tower']) fireEvent.change(box(), { target: { value: q } });
    expect(box().value).toBe('Tower');
    expect(setPortfolioSearch).not.toHaveBeenCalled();
    // Typed but not yet asked: it says it is searching, never "No floors match".
    expect(screen.getByText('Searching…')).toBeTruthy();
    expect(screen.queryByText(/No floors match/)).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(setPortfolioSearch).toHaveBeenCalledTimes(1);
    expect(setPortfolioSearch).toHaveBeenCalledWith('Tower');
  });

  it('goes straight back to the tree when the box is emptied — nothing to wait for', () => {
    render(<PortfolioTree />);
    fireEvent.change(box(), { target: { value: 'Tow' } });
    fireEvent.change(box(), { target: { value: '' } });
    expect(setPortfolioSearch).toHaveBeenCalledWith('');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // The pending "Tow" was dropped, not sent late.
    expect(setPortfolioSearch).toHaveBeenCalledTimes(1);
  });

  it('shows the box cleared when the app clears the search itself (a hit was opened)', () => {
    const { rerender } = render(<PortfolioTree />);
    fireEvent.change(box(), { target: { value: 'Tower' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender(<PortfolioTree />);
    expect(box().value).toBe('Tower');

    ctx.state = { ...ctx.state, portfolioSearch: '', portfolioSearching: false };
    rerender(<PortfolioTree />);
    expect(box().value).toBe('');
  });

  it('never overwrites letters typed while an earlier search was answered', () => {
    const { rerender } = render(<PortfolioTree />);
    fireEvent.change(box(), { target: { value: 'Tow' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(box(), { target: { value: 'Towe' } });
    // The app now holds "Tow" (what was sent) — the box keeps "Towe".
    rerender(<PortfolioTree />);
    expect(box().value).toBe('Towe');
  });

  it('says Facilio is busy — not "No floors match" — when the search could not be answered', () => {
    const { rerender } = render(<PortfolioTree />);
    fireEvent.change(box(), { target: { value: 'Tower' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    ctx.state = { ...ctx.state, portfolioSearch: 'Tower', portfolioSearching: false, portfolioSearchResults: [], portfolioSearchFailed: 'busy' };
    rerender(<PortfolioTree />);
    expect(screen.getByRole('alert').textContent).toBe('Facilio is busy — search again in a minute.');
    expect(screen.queryByText(/No floors match/)).toBeNull();
  });

  it('still says no floors match when the search was answered with none', () => {
    const { rerender } = render(<PortfolioTree />);
    fireEvent.change(box(), { target: { value: 'Tower' } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    ctx.state = { ...ctx.state, portfolioSearch: 'Tower', portfolioSearching: false, portfolioSearchResults: [], portfolioSearchFailed: null };
    rerender(<PortfolioTree />);
    expect(screen.getByText('No floors match “Tower”.')).toBeTruthy();
  });
});
