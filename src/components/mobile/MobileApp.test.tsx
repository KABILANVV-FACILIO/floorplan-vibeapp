import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Opened from the Facilio Builds phone app, Back asks `window.FacilioShell.onBack` first. It wasn't
 * set, so Back with a sheet or the scanner open left the app altogether.
 */

const ctx = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
const actions = { setMobSel: vi.fn(), setMobAssignEdit: vi.fn(), setMobTimePick: vi.fn(), setMobFloorOpen: vi.fn(), setMobileTab: vi.fn() };

vi.mock('../../state/FloorplanContext', () => ({ useFloorplanData: () => ({ state: ctx.state, actions }) }));
vi.mock('../../state/selectors', () => ({
  canSee: () => true,
  floorMeta: () => null,
  isBookable: () => true,
  visibleUnits: () => [],
  contactName: () => '',
  myAssignedUnit: () => null,
}));
vi.mock('../../lib/firstResponders', () => ({ respondersOnFloor: () => [], rolesOnFloor: () => [], responderRolesFor: () => [] }));
vi.mock('../canvas/FloorplanSkeleton', () => ({ FloorplanSkeleton: () => null }));
vi.mock('../canvas/FloorplanBackground', () => ({ FloorplanBackground: () => null }));
vi.mock('../canvas/ResponderBadge', () => ({ ResponderBadges: () => null, ResponderGlyph: () => null }));
vi.mock('./MobileFloorPicker', () => ({ MobileFloorPicker: () => null }));
vi.mock('./MobileUnitSheet', () => ({ MobileUnitSheet: () => null }));
vi.mock('./MobileTimePicker', () => ({ MobileTimePicker: () => null }));
vi.mock('./MobileDatePicker', () => ({ MobileDatePicker: ({ open }: { open: boolean }) => (open ? <p>date sheet</p> : null) }));
vi.mock('./MobileSpacesSheet', () => ({ MobileSpacesSheet: ({ open }: { open: boolean }) => (open ? <p>spaces sheet</p> : null) }));
vi.mock('./MobileMyBookings', () => ({ MobileMyBookings: ({ open }: { open: boolean }) => (open ? <p>my bookings sheet</p> : null) }));
vi.mock('./MobileQrScanner', () => ({ MobileQrScanner: () => <p>scanner</p> }));

const { MobileApp } = await import('./MobileApp');

type Shell = { onBack?: () => unknown };
const win = window as unknown as { FacilioShell?: Shell };

beforeEach(() => {
  vi.clearAllMocks();
  ctx.state = {
    floorId: 'f1',
    date: '2026-11-24',
    start: 540,
    end: 600,
    bookings: [],
    bookBy: 'me',
    mobileTab: 'assign',
    planViews: { assign: true, book: false },
    loading: true,
    floorImageLoading: false,
    responderRoles: [],
    mobSel: null,
    mobFloorOpen: false,
    mobTimePick: null,
  };
});
afterEach(() => {
  cleanup();
  delete win.FacilioShell;
});

describe('Back in the Facilio Builds phone app', () => {
  it('is no concern of the page outside it — nothing is set, nothing throws', () => {
    expect(() => render(<MobileApp mode="page" />)).not.toThrow();
    expect(win.FacilioShell).toBeUndefined();
  });

  it('closes the scanner first, and says it handled Back', () => {
    win.FacilioShell = {};
    render(<MobileApp mode="page" />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan a space QR' }));
    expect(screen.getByText('scanner')).toBeTruthy();

    let handled: unknown;
    act(() => {
      handled = win.FacilioShell!.onBack!();
    });
    expect(handled).toBe(true);
    expect(screen.queryByText('scanner')).toBeNull();
  });

  it('closes the top sheet before the space sheet under it, one per Back', () => {
    win.FacilioShell = {};
    ctx.state.mobSel = 'd1';
    render(<MobileApp mode="page" />);
    fireEvent.click(screen.getByRole('button', { name: 'My bookings' }));
    expect(screen.getByText('my bookings sheet')).toBeTruthy();

    act(() => {
      expect(win.FacilioShell!.onBack!()).toBe(true);
    });
    expect(screen.queryByText('my bookings sheet')).toBeNull();
    expect(actions.setMobSel).not.toHaveBeenCalled();

    act(() => {
      expect(win.FacilioShell!.onBack!()).toBe(true);
    });
    expect(actions.setMobSel).toHaveBeenCalledWith(null);
  });

  it('lets the shell go back when nothing is open', () => {
    win.FacilioShell = {};
    render(<MobileApp mode="page" />);
    expect(win.FacilioShell.onBack!()).toBe(false);
  });

  it('puts back whatever handler was there before, when the app goes', () => {
    const before = () => 'theirs';
    win.FacilioShell = { onBack: before };
    const { unmount } = render(<MobileApp mode="page" />);
    expect(win.FacilioShell.onBack).not.toBe(before);
    unmount();
    expect(win.FacilioShell.onBack).toBe(before);
  });
});
