import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Unit } from '../../lib/types';

/**
 * A marked room has to be visibly marked. The old neutral grey-blue tint sat on top of a CAD
 * drawing that already fills its own rooms light grey, so outside Edit mode a traced room read as
 * part of the drawing — the complaint that prompted the blue. These pin the viewing colours so a
 * later "tidy the palette" can't quietly put a room back into the background.
 *
 * The mode colours (edit purple, assign by module, book green/red) are SEMANTIC and deliberately
 * left alone; only the neutral viewing state is specified here.
 */

const room: Unit = { id: 'r1', type: 'room', label: 'Majlis', room: null, geom: { kind: 'poly', pts: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]] }, floor: 'f1', plan: 'workstation' };

const state = {
  mode: 'view',
  selected: null as string | null,
  tool: 'select',
  placingUnitId: null,
  assignments: {},
  bookings: [],
  date: '2026-10-14',
  start: 540,
  end: 600,
};

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state, actions: { selectUnit: vi.fn() } }),
}));

import { RoomPolygon } from './RoomPolygon';

afterEach(() => {
  cleanup();
  state.selected = null;
});

describe('a traced room, outside the editing modes', () => {
  it('is tinted the blue the floor is read with, not a grey that sinks into the CAD', () => {
    const { container } = render(<RoomPolygon unit={room} />);

    // #eaf2ff at 80% — see RoomPolygon: flat, it hid the CAD linework inside the room.
    const tint = container.querySelector('[data-room-id="r1"]') as HTMLElement;
    expect(tint.style.background).toBe('rgba(234, 242, 255, 0.8)');

    const outline = container.querySelector('polygon') as SVGPolygonElement;
    expect(outline.getAttribute('stroke')).toBe('#6ca8fc');
  });

  it('keeps that outline colour when selected, and only deepens the tint', () => {
    state.selected = 'r1';
    const { container } = render(<RoomPolygon unit={room} />);

    // Selected deepens the same blue toward the border colour rather than changing hue.
    const tint = container.querySelector('[data-room-id="r1"]') as HTMLElement;
    expect(tint.style.background).toBe('rgba(206, 226, 254, 0.88)');

    expect((container.querySelector('polygon') as SVGPolygonElement).getAttribute('stroke')).toBe('#6ca8fc');
  });
});
