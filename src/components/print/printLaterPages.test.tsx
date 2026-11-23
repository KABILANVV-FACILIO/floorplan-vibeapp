import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { buildInitialState, reducer } from '../../state/reducer';
import type { AppState } from '../../state/types';
import type { Unit } from '../../lib/types';

/**
 * Print preview open on a big floor while its remaining desks are still loading (v77 review): the
 * page built its marker models once, when it mounted, but read the markers on every render — so a
 * desk arriving afterwards (FLOOR_UNITS_MORE) had no model, Marker threw, and with no error boundary
 * the whole app went blank. The page is now laid out from the floor as it is, whenever it changes.
 */

const store: { state: AppState } = { state: buildInitialState() };
vi.mock('../../state/FloorplanContext', () => ({
  useFloorplan: () => ({ state: store.state, actions: new Proxy({}, { get: () => vi.fn() }) }),
  useFloorplanData: () => ({ state: store.state, actions: new Proxy({}, { get: () => vi.fn() }) }),
}));
vi.mock('../../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../../lib/cadPreview', () => ({ renderCadToDataUrl: vi.fn() }));

const { PrintSheet } = await import('./PrintSheet');

const desk = (i: number): Unit => ({
  id: `d${i}`,
  type: 'workstation',
  label: `WS-${String(i).padStart(2, '0')}`,
  room: null,
  geom: { kind: 'point', x: 0.1 + (i % 10) * 0.08, y: 0.1 + Math.floor(i / 10) * 0.1 },
  floor: 'f1',
  plan: 'workstation',
});
const chips = (container: HTMLElement) => container.querySelectorAll('[data-unit-id]').length;

afterEach(cleanup);

describe('the print preview, while a big floor’s later pages arrive', () => {
  for (const printScope of ['floor', 'detail', 'view'] as const) {
    it(`draws the desk that arrives afterwards, without throwing (${printScope})`, () => {
      const first = Array.from({ length: 12 }, (_, i) => desk(i));
      const start = reducer(buildInitialState(), { type: 'SELECT_FLOOR_START', floorId: 'f1' });
      store.state = {
        ...reducer(start, { type: 'SELECT_FLOOR_DONE', floorId: 'f1', units: first, assignments: {}, bookings: [] }),
        mode: 'assign',
        planId: 'workstation',
        printScope,
        view: { tx: 0, ty: 0, z: 0.76 },
        stage: { w: 1200, h: 700 },
      };
      const { container, rerender } = render(<PrintSheet preview />);
      const before = chips(container);
      expect(before).toBeGreaterThanOrEqual(12);

      // The rest of the floor lands: one more desk.
      store.state = reducer(store.state, { type: 'FLOOR_UNITS_MORE', floorId: 'f1', units: [...first, desk(12)] });
      expect(store.state.units).toHaveLength(13);
      expect(() => rerender(<PrintSheet preview />)).not.toThrow();
      expect(container.querySelector('[data-unit-id="d12"]')).toBeTruthy();
      if (printScope === 'floor') expect(chips(container)).toBe(13);
    });
  }
});
