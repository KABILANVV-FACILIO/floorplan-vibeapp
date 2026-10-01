import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { buildInitialState } from '../../state/reducer';
import { planRooms, roomLabelInputs } from '../../state/selectors';
import { planRoomLabels } from '../../lib/labelLayout';
import { IMG_H, IMG_W } from '../../lib/mockData';
import type { AppState } from '../../state/types';
import type { Unit } from '../../lib/types';

/**
 * The canvas places the room names it can (planRoomLabels) — inside a room, or just outside one
 * too small for its name — because an onboarded floor's dozens of small org rooms would otherwise
 * pile into one unreadable block. The print sheet drew
 * every name regardless — a pile of overlapping boxes on paper, and a "Current view" that showed
 * names the screen hid. These pin that paper keeps the names the screen would at the page's zoom.
 */

const store: { state: AppState } = { state: buildInitialState() };
vi.mock('../../state/FloorplanContext', () => ({
  useFloorplan: () => ({ state: store.state, actions: new Proxy({}, { get: () => vi.fn() }) }),
  useFloorplanData: () => ({ state: store.state, actions: new Proxy({}, { get: () => vi.fn() }) }),
}));
vi.mock('../../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

const { PrintSheet } = await import('./PrintSheet');

const square = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];
const orgRoom = (id: string, label: string, pts: [number, number][]): Unit => ({
  id,
  type: 'room',
  label,
  room: null,
  orgRoom: true,
  geom: { kind: 'poly', pts },
  floor: 'f1',
  plan: 'workstation',
});
// One big open area, and a row of small toilets and stores whose long names cannot fit inside
// them at print zoom — the shape of an onboarded HQ floor.
const rooms: Unit[] = [
  orgRoom('1', 'Open Office', square(0.1, 0.1, 0.5)),
  ...Array.from({ length: 12 }, (_, i) => orgRoom(String(100 + i), `HQ-BKB-1F-Male Toilet ${String(i + 1).padStart(2, '0')}`, square(0.7 + (i % 4) * 0.012, 0.7 + Math.floor(i / 4) * 0.012, 0.01))),
];

function printed(over: Partial<AppState>) {
  store.state = { ...buildInitialState(), mode: 'assign', floorId: 'f1', planId: 'workstation', units: rooms, savedUnits: rooms, ...over };
  const { container } = render(<PrintSheet preview />);
  const text = container.textContent ?? '';
  return rooms.filter((r) => text.includes(r.label)).map((r) => r.id);
}

afterEach(cleanup);

describe('the print sheet prints the room names the screen would keep', () => {
  it('whole floor: the big room is named; of the small rooms, those whose names find room outside their outlines', () => {
    const shown = printed({ printScope: 'floor' });
    expect(shown).toContain('1');
    // Twelve toilets a few px apart cannot all carry a 190px name beside them — but some can.
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.length).toBeLessThan(rooms.length);
  });

  it('current view: exactly the names the canvas keeps at the viewer\'s zoom', () => {
    const view = { tx: 0, ty: 0, z: 0.76 };
    const shown = printed({ printScope: 'view', view, stage: { w: 1200, h: 700 } });
    const screen = planRoomLabels(roomLabelInputs(store.state, planRooms(store.state)), { planW: IMG_W, planH: IMG_H, zoom: view.z });
    expect(new Set(shown)).toEqual(new Set(screen.keys()));
    expect(shown.length).toBeLessThan(rooms.length);
  });
});
