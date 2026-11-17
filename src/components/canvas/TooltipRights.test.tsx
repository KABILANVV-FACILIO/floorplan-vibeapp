import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Unit } from '../../lib/types';
import type { AppState } from '../../state/types';

/**
 * A desk's card on the plan offers the desk record's own flow — Vacate, Re-assign — only to a role
 * holding Assignment, in Booking view as much as in Assignment view (ENEC, 2026-11-09: "if
 * assignment permission is not there, drag and drop should be off" — and so the rest of assigning).
 */

const ctx = vi.hoisted(() => ({ state: {} as AppState }));

// The reducer pulls in the PDF preview, whose pdf.js worker import the test runner can't resolve.
vi.mock('../../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));
vi.mock('../../state/FloorplanContext', () => ({ useFloorplan: () => ({ state: ctx.state, actions: { openBookingForm: vi.fn() } }) }));
vi.mock('../../lib/facilioApiDataSource', () => ({ fetchUnitRecordInfo: vi.fn(() => Promise.resolve(null)), resolveUnitRecord: vi.fn(() => null) }));
vi.mock('../details/StateflowActions', () => ({ StateflowActions: () => <div data-testid="flow">the desk's flow</div> }));
vi.mock('../details/LocalAssign', () => ({ LocalAssign: () => null }));

const { buildInitialState } = await import('../../state/reducer');
const { Tooltip } = await import('./Tooltip');

const HOT_DESK = { id: 'd1', type: 'workstation', label: 'N-047', geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan: 'workstation', deskType: 'HOT' } as Unit;

function card(mode: 'assign' | 'book', planViews: AppState['planViews']) {
  ctx.state = { ...buildInitialState(), floorId: 'f1', units: [HOT_DESK], selected: 'd1', mode, planViews, stage: { w: 1200, h: 800 } };
  return render(<Tooltip />);
}

afterEach(cleanup);

describe("a desk's card on the plan", () => {
  it("offers the desk's flow with Assignment, in either view", () => {
    card('assign', { assign: true, book: true });
    expect(screen.queryByTestId('flow')).not.toBeNull();
    cleanup();
    card('book', { assign: true, book: true });
    expect(screen.queryByTestId('flow')).not.toBeNull();
  });

  it('offers only Book to a role that books but cannot assign', () => {
    card('book', { assign: false, book: true });
    expect(screen.queryByTestId('flow')).toBeNull();
    expect(screen.getByRole('button', { name: 'Book' })).toBeTruthy();
  });

  it('offers nothing with neither right', () => {
    card('assign', { assign: false, book: false });
    expect(screen.queryByTestId('flow')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
  });
});
