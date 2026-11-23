import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * A render error in one surface used to blank the whole app — React 18 unmounts the root on an
 * uncaught one, and the app's ErrorBoundary was never mounted (v77 review). Each surface now draws
 * inside one: the surface that failed says so, the user is told, the rest keeps working, and moving
 * on tries it again.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown>, broken: new Set<string>() }));
const actions = { showToast: vi.fn(), closeBookingForm: vi.fn() };
const surface = (name: string) => () => {
  if (ctx.broken.has(name)) throw new Error(`${name} broke`);
  return <p>{name}</p>;
};

vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('./MapStage', () => ({ MapStage: surface('map stage') }));
vi.mock('./BottomNav', () => ({ BottomNav: surface('bottom nav') }));
vi.mock('../settings/SettingsScreen', () => ({ SettingsScreen: surface('settings') }));
vi.mock('../bookings/BookingsView', () => ({ BookingsView: surface('bookings') }));
vi.mock('../people/PeopleView', () => ({ PeopleView: surface('people') }));
vi.mock('../details/BookingModal', () => ({ BookingModal: surface('booking form') }));
vi.mock('../mobile/MobileApp', () => ({ MobileApp: surface('mobile') }));
vi.mock('../print/PrintSheet', () => ({ PrintSheet: surface('print sheet') }));
vi.mock('../print/PrintController', () => ({ PrintController: ({ children }: { children: unknown }) => children }));
vi.mock('../primitives/Toast', () => ({ Toast: () => null }));

const { AppShell } = await import('./AppShell');

beforeEach(() => {
  vi.clearAllMocks();
  ctx.broken.clear();
  ctx.state = { loading: false, portfolio: [{}], activeView: 'map', floorId: 'f1', planId: 'workstation', bookModalOpen: false, toast: null, access: {}, viewerRole: null };
  // React logs the caught error; it is the point of the test, not noise to read.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(cleanup);

describe('a surface that fails to draw', () => {
  it('says so in its place, while the bottom navigation and the rest still render', () => {
    ctx.broken.add('map stage');
    render(<AppShell />);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t show the floor plan — map stage broke');
    expect(screen.getByText('bottom nav')).toBeTruthy();
    expect(screen.getByText('booking form')).toBeTruthy();
    expect(actions.showToast).toHaveBeenCalledWith(expect.stringContaining('the floor plan'), 6000);
  });

  it('is tried again when the user moves to another view and back', () => {
    ctx.broken.add('map stage');
    const { rerender } = render(<AppShell />);
    expect(screen.getByRole('alert')).toBeTruthy();
    ctx.broken.clear();
    ctx.state = { ...ctx.state, activeView: 'people' };
    rerender(<AppShell />);
    expect(screen.getByText('people')).toBeTruthy();
    ctx.state = { ...ctx.state, activeView: 'map' };
    rerender(<AppShell />);
    expect(screen.getByText('map stage')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('closes a booking form that failed, rather than leaving the app blank', () => {
    ctx.broken.add('booking form');
    ctx.state = { ...ctx.state, bookModalOpen: true };
    render(<AppShell />);
    expect(screen.getByText('map stage')).toBeTruthy();
    expect(screen.queryByText('booking form')).toBeNull();
    expect(actions.closeBookingForm).toHaveBeenCalledTimes(1);
  });

  it('keeps the app up when the hidden print sheet fails', () => {
    ctx.broken.add('print sheet');
    render(<AppShell />);
    expect(screen.getByText('map stage')).toBeTruthy();
    expect(screen.getByText('bottom nav')).toBeTruthy();
  });
});
