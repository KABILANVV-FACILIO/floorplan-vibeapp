import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { buildInitialState } from '../../state/reducer';
import type { AppState } from '../../state/types';
import type { Unit } from '../../lib/types';

/**
 * On main no real floor ever drew a room outline — every org room sat in "Available to place" — so
 * every Edit-mode press reached the canvas. Now an onboarded floor is covered in org outlines, and
 * a room that took every press inside it broke the desk workflows there: an armed desk would not
 * place inside a room, Shift+drag started no marquee, and a plain drag moved the room instead of
 * panning. These pin that a room only takes the gestures meant for it: a click selects it, and a
 * drag moves it once it is selected.
 */

const actions = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
  get: (target, key: string) => (target[key] ??= vi.fn()),
});
const store: { state: AppState } = { state: buildInitialState() };
vi.mock('../../state/FloorplanContext', () => ({
  useFloorplan: () => ({ state: store.state, actions }),
  // The view-less store reads the same test state: nothing here pans.
  useFloorplanData: () => ({ state: store.state, actions }),
}));
vi.mock('../../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
// jsdom has no ResizeObserver; the canvas only uses it to fit the view.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const { Canvas } = await import('./Canvas');

const orgRoom: Unit = {
  id: '9001',
  type: 'room',
  label: 'Private Office',
  room: null,
  orgRoom: true,
  geom: {
    kind: 'poly',
    pts: [
      [0.2, 0.2],
      [0.6, 0.2],
      [0.6, 0.6],
      [0.2, 0.6],
    ],
  },
  floor: 'f1',
  plan: 'workstation',
};
const pooledDesk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0, y: 0 }, floor: 'f1', plan: 'workstation', unplaced: true };

function renderEdit(over: Partial<AppState> = {}) {
  store.state = {
    ...buildInitialState(),
    mode: 'edit',
    tool: 'select',
    floorId: 'f1',
    planId: 'workstation',
    units: [orgRoom],
    savedUnits: [orgRoom],
    view: { tx: 0, ty: 0, z: 1 },
    ...over,
  };
  const { container } = render(<Canvas />);
  const room = container.querySelector('[data-room-id="9001"]') as HTMLElement;
  expect(room).not.toBeNull();
  return room;
}

/** A press at (x, y), moved by (dx, dy), released, then the click the browser fires. */
function press(el: HTMLElement, { dx = 0, dy = 0, shiftKey = false } = {}) {
  const at = { clientX: 300, clientY: 300 };
  fireEvent.mouseDown(el, { button: 0, shiftKey, ...at });
  if (dx || dy) fireEvent.mouseMove(window, { clientX: at.clientX + dx, clientY: at.clientY + dy });
  fireEvent.mouseUp(window, { clientX: at.clientX + dx, clientY: at.clientY + dy });
  fireEvent.click(el, { clientX: at.clientX + dx, clientY: at.clientY + dy });
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
});
afterEach(cleanup);

describe('an org room outline in Edit mode leaves desk gestures to the canvas', () => {
  it('a click inside a room places the armed desk there, and does not select the room', () => {
    const room = renderEdit({ placingUnitId: '1001', unplacedUnits: [pooledDesk] });
    press(room);
    expect(actions.placeUnitAt).toHaveBeenCalledTimes(1);
    expect(actions.placeUnitAt.mock.calls[0][0]).toBe('1001');
    expect(actions.setPlacingUnit).toHaveBeenCalledWith(null);
    expect(actions.selectUnit).not.toHaveBeenCalledWith('9001');
    expect(actions.updateUnit).not.toHaveBeenCalled();
  });

  it('Shift+drag starting inside a room starts a marquee, and does not move the room', () => {
    const room = renderEdit();
    press(room, { dx: 40, dy: 40, shiftKey: true });
    expect(actions.setMultiSelected).toHaveBeenCalled();
    expect(actions.updateUnit).not.toHaveBeenCalled();
  });

  it('a plain drag starting inside an unselected room pans the plan, and neither moves nor selects the room', () => {
    const room = renderEdit();
    press(room, { dx: 40, dy: 40 });
    expect(actions.setView).toHaveBeenCalled();
    expect(actions.updateUnit).not.toHaveBeenCalled();
    expect(actions.selectUnit).not.toHaveBeenCalledWith('9001');
  });

  it('a click still selects the room', () => {
    const room = renderEdit();
    press(room);
    expect(actions.selectUnit).toHaveBeenCalledWith('9001');
    expect(actions.placeUnitAt).not.toHaveBeenCalled();
  });

  it('a drag of the selected room still moves it', () => {
    const room = renderEdit({ selected: '9001' });
    press(room, { dx: 40, dy: 40 });
    expect(actions.updateUnit).toHaveBeenCalledTimes(1);
    expect(actions.updateUnit.mock.calls[0][0]).toBe('9001');
    expect(actions.setView).not.toHaveBeenCalled();
  });
});

describe('room selection gestures that main honoured', () => {
  it('a room marquee-selected on its own drags (and becomes the selection), rather than panning the plan', () => {
    // A Shift+drag marquee that caught only this room: SET_MULTI_SELECTED cleared `selected`.
    const room = renderEdit({ multiSelected: ['9001'], selected: null });
    press(room, { dx: 40, dy: 40 });
    expect(actions.selectUnit).toHaveBeenCalledWith('9001');
    expect(actions.updateUnit).toHaveBeenCalledTimes(1);
    expect(actions.updateUnit.mock.calls[0][0]).toBe('9001');
    expect(actions.setView).not.toHaveBeenCalled();
  });

  it('a room in a larger marquee selection still drags the group', () => {
    const desk: Unit = { id: '1002', type: 'workstation', label: 'WS-2', room: null, geom: { kind: 'point', x: 0.8, y: 0.8 }, floor: 'f1', plan: 'workstation' };
    const room = renderEdit({ units: [orgRoom, desk], savedUnits: [orgRoom, desk], multiSelected: ['9001', '1002'], selected: null });
    press(room, { dx: 40, dy: 40 });
    expect(actions.updateUnits).toHaveBeenCalledTimes(1);
    expect(actions.updateUnit).not.toHaveBeenCalled();
    expect(actions.setView).not.toHaveBeenCalled();
  });

  for (const mode of ['edit', 'book', 'assign'] as const) {
    for (const dx of [3, 5]) {
      it(`${mode} mode: a click that jitters ${dx}px still selects the room`, () => {
        const room = renderEdit({ mode });
        press(room, { dx });
        expect(actions.selectUnit).toHaveBeenCalledWith('9001');
      });
    }
    it(`${mode} mode: a press that pans the plan past the click slop does not select the room`, () => {
      const room = renderEdit({ mode });
      press(room, { dx: 6 });
      expect(actions.setView).toHaveBeenCalled();
      expect(actions.selectUnit).not.toHaveBeenCalledWith('9001');
    });
  }
});
