import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Unit } from '../../lib/types';

/**
 * The form's resource field was computed twice: once in a `useMemo` near the top of the component
 * and again further down. Both call predicates that read `isRoom`, a const declared BELOW the
 * memo — and a function declaration hoists, so the memo's call landed in that const's temporal
 * dead zone. The first render where the form's fields had arrived AND a resource was picked threw
 * "Cannot access 'isRoom' before initialization", and the booking modal never opened.
 *
 * This mounts that exact moment: a loaded form carrying a `rooms` lookup, and a room to book.
 */

const room: Unit = { id: '819849', type: 'room', label: 'Meeting Room 2', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: '5150', plan: 'workstation' };

const formSummary = { id: 7, name: 'default_spacebooking', displayName: 'Space Booking' };
const formMeta = {
  id: 7,
  name: 'default_spacebooking',
  displayName: 'Space Booking',
  moduleName: 'spacebooking' as const,
  // The `rooms` lookup is the resource field — reaching it is what read `isRoom`.
  fields: [
    { name: 'space', label: 'Location', required: true, type: 'LOOKUP_SIMPLE', lookupModule: 'rooms', sequence: 1 },
    { name: 'purpose', label: 'Purpose', required: false, type: 'TEXTBOX', sequence: 2 },
  ],
};

const state = {
  bookForm: { unitId: room.id, date: '2026-10-13', start: 540, end: 600, resourceUnit: room },
  bookingModule: 'spacebooking',
  activeView: 'map',
  units: [room],
  floorId: '5150',
  employees: [{ id: '7', name: 'Niviya', department: 'Design' }],
  bookBy: '7',
  bookingsNonce: 0,
};

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state, actions: { showToast: vi.fn(), submitBooking: vi.fn(), closeBookingForm: vi.fn() } }),
}));

vi.mock('../../state/selectors', () => ({
  unitById: (_s: unknown, id: string) => (id === room.id ? room : null),
  mergeWithOrgPool: (units: Unit[]) => units,
  isBookable: () => true,
}));

vi.mock('../../lib/facilioApi', () => ({ isFacilioApiConfigured: true }));

vi.mock('../../hooks/useOrgClock', () => ({ useOrgClock: () => ({ dateISO: '2026-10-13', minutes: 480 }) }));

vi.mock('../../lib/facilioApiDataSource', () => ({
  fetchOrgBookableResources: vi.fn(async () => [room]),
  fetchBookingFormList: vi.fn(async () => [formSummary]),
  fetchBookingFormById: vi.fn(async () => formMeta),
  fetchOrgBookingsForRange: vi.fn(async () => []),
  resolveFormResourceTypes: vi.fn(async () => new Map([[7, 'room']])),
  pickDefaultBookingForm: () => formSummary,
  bookingFormsForType: () => [formSummary],
}));

import { BookingModal } from './BookingModal';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BookingModal with a loaded form', () => {
  it('renders once the form fields land, instead of throwing on the resource field', async () => {
    // A TDZ ReferenceError thrown in render propagates out of `render`/`waitFor`, so reaching the
    // assertions below IS the assertion that it no longer throws.
    render(<BookingModal />);

    // Wait for a field that exists ONLY once the form's metadata has landed — the resource lookup
    // alone renders from the picked unit on the very first paint, before the crash condition holds.
    await waitFor(() => expect(screen.getByText('Purpose')).toBeTruthy());
    // The form's own resource field, rendered from its `rooms` lookup.
    expect(screen.getByText('Location')).toBeTruthy();
    expect(screen.getByText('Meeting Room 2')).toBeTruthy();
  });
});
