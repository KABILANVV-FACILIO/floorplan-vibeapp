import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { buildInitialState } from '../../state/reducer';
import type { AppState } from '../../state/types';
import type { Unit } from '../../lib/types';

/**
 * The plan's window listeners (v77 review): a drag's mousemove/mouseup listeners came off only on
 * mouseup — inside Facilio's frame a mouseup outside never arrives, and a view or floor switch
 * mid-drag left a pan following the pointer. And the wheel listener was taken off and put back on
 * every pan frame. Gestures themselves behave as before (roomGestures.test).
 */

const actions = new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
  get: (target, key: string) => (target[key] ??= vi.fn()),
});
const store: { state: AppState } = { state: buildInitialState() };
vi.mock('../../state/FloorplanContext', () => ({
  useFloorplan: () => ({ state: store.state, actions }),
  useFloorplanData: () => ({ state: store.state, actions }),
}));
vi.mock('../../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const { Canvas } = await import('./Canvas');

const desk: Unit = { id: '1001', type: 'workstation', label: 'WS-1', room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan: 'workstation' };

function renderPlan(over: Partial<AppState> = {}) {
  store.state = { ...buildInitialState(), mode: 'assign', tool: 'select', floorId: 'f1', planId: 'workstation', units: [desk], savedUnits: [desk], view: { tx: 0, ty: 0, z: 1 }, ...over };
  return render(<Canvas />);
}
const plane = (container: HTMLElement) => container.firstElementChild as HTMLElement;

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
});
afterEach(cleanup);

describe('a gesture in progress when the plan goes away', () => {
  it('a pan stops following the pointer, and its mouseup does nothing', () => {
    const { container, unmount } = renderPlan();
    fireEvent.mouseDown(plane(container), { button: 0, clientX: 300, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 340, clientY: 340 });
    expect(actions.setView).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.mouseMove(window, { clientX: 380, clientY: 380 });
    fireEvent.mouseUp(window, { clientX: 380, clientY: 380 });
    expect(actions.setView).toHaveBeenCalledTimes(1);
  });

  it('a marker drag in Edit mode commits nothing once the plan is gone', () => {
    const { container, unmount } = renderPlan({ mode: 'edit' });
    const marker = container.querySelector('[data-unit-id="1001"]') as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 340, clientY: 340 });
    unmount();
    fireEvent.mouseUp(window, { clientX: 340, clientY: 340 });
    expect(actions.updateUnit).not.toHaveBeenCalled();
    expect(actions.placeUnitOnUnit).not.toHaveBeenCalled();
  });

  it('while it is still there, a marker drag commits on mouseup exactly as before', () => {
    const { container } = renderPlan({ mode: 'edit' });
    const marker = container.querySelector('[data-unit-id="1001"]') as HTMLElement;
    fireEvent.mouseDown(marker, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.mouseMove(window, { clientX: 340, clientY: 340 });
    fireEvent.mouseUp(window, { clientX: 340, clientY: 340 });
    expect(actions.updateUnit).toHaveBeenCalledTimes(1);
    expect(actions.updateUnit.mock.calls[0][0]).toBe('1001');
    // And the listeners are off: another move or release does nothing more.
    fireEvent.mouseMove(window, { clientX: 400, clientY: 400 });
    fireEvent.mouseUp(window, { clientX: 400, clientY: 400 });
    expect(actions.updateUnit).toHaveBeenCalledTimes(1);
  });
});

describe('the wheel', () => {
  it('is listened for once, and zooms with the latest actions however often the view changes', () => {
    const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const { container, rerender } = renderPlan();
    // The plan's own wheel listener (other parts of the plan listen for the wheel too).
    const wheelAdds = () => add.mock.calls.filter(([type], i) => type === 'wheel' && add.mock.contexts[i] === plane(container)).length;
    expect(wheelAdds()).toBe(1);
    for (const tx of [10, 20, 30]) {
      store.state = { ...store.state, view: { tx, ty: 0, z: 1 } };
      rerender(<Canvas />);
    }
    expect(wheelAdds()).toBe(1);
    fireEvent.wheel(plane(container), { deltaY: -100, clientX: 10, clientY: 10 });
    expect(actions.zoomAtPoint).toHaveBeenCalledTimes(1);
    add.mockRestore();
  });
});
