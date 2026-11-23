import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildInitialState } from '../../state/reducer';
import type { AppState } from '../../state/types';
import type { Unit } from '../../lib/types';
import { BUILTIN_RESPONDER_ROLES } from '../../lib/types';

/**
 * The plan's controls for the keyboard and a screen reader (v77 review): names on the icon-only
 * buttons and the occupancy chip, an empty alt on the drawing, the first-responders list reachable
 * from the keyboard, the loading status announced, and the print settings' radios and tabs moved
 * through with the arrow keys.
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

const { ZoomControls } = await import('./ZoomControls');
const { FloorplanBackground } = await import('./FloorplanBackground');
const { FloorCounts } = await import('./FloorCounts');
const { FloorResponders } = await import('./FloorResponders');
const { FloorplanSkeleton } = await import('./FloorplanSkeleton');
const { UnsavedChangesModal } = await import('./UnsavedChangesModal');
const { PrintDetails } = await import('../print/PrintDetails');

const point = (id: string, type: Unit['type'], plan: Unit['plan']): Unit => ({ id, type, label: `${type}-${id}`, room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan });
const roomOf = (id: string): Unit => ({ id, type: 'room', label: `Room ${id}`, room: null, geom: { kind: 'poly', pts: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] }, floor: 'f1', plan: 'workstation' });

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  store.state = { ...buildInitialState(), mode: 'assign', floorId: 'f1', planId: 'workstation' };
});
afterEach(cleanup);

describe('names a screen reader can announce', () => {
  it('the zoom buttons', () => {
    render(<ZoomControls rectW={1200} rectH={700} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(actions.zoomIn).toHaveBeenCalledTimes(1);
    expect(actions.zoomOut).toHaveBeenCalledTimes(1);
  });

  it('the drawing is decoration — the markers over it say what is there', () => {
    const { container } = render(<FloorplanBackground imageUrl="data:image/png;base64,AAAA" />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('the occupancy chip says its counts', () => {
    const units = [point('d1', 'workstation', 'workstation'), point('d2', 'workstation', 'workstation'), point('d3', 'workstation', 'workstation'), roomOf('r1'), roomOf('r2')];
    store.state = { ...store.state, units, assignments: { d1: 'e1', d2: 'e2' } };
    render(<FloorCounts />);
    expect(screen.getByRole('button', { name: 'Occupancy: Desks 2 of 3, Rooms 0 of 2' })).toBeTruthy();
  });

  it('the loading plan says it is loading, politely', () => {
    render(<FloorplanSkeleton />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBeTruthy();
  });
});

describe('the first-responders list', () => {
  beforeEach(() => {
    const desk = point('d1', 'workstation', 'workstation');
    store.state = {
      ...store.state,
      units: [desk, point('d2', 'workstation', 'workstation')],
      assignments: { d1: 'e1', d2: 'e2' },
      firstResponders: [
        { employeeId: 'e1', name: 'Omar Al Marri', roles: ['firstAider'] },
        { employeeId: 'e2', name: 'Priya Nair', roles: ['floorWarden'] },
      ],
      responderRoles: BUILTIN_RESPONDER_ROLES.map((r) => ({ ...r })),
    } as AppState;
  });

  it('takes the keyboard to its first person when it opens, and back to the chip on Escape', () => {
    render(<FloorResponders />);
    const chip = screen.getByRole('button', { expanded: false });
    act(() => {
      chip.focus();
      fireEvent.click(chip);
    });
    const list = screen.getByRole('dialog', { name: 'First responders on this floor' });
    expect(list.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain('Omar Al Marri');
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});

describe('the unsaved-changes dialog while it saves', () => {
  it('cannot be cancelled: the switch the save is for goes ahead when it lands', () => {
    store.state = { ...store.state, mode: 'edit', pendingModeSwitch: 'assign', unsavedChanges: 2, saving: true };
    render(<UnsavedChangesModal />);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    store.state = { ...store.state, saving: false };
    cleanup();
    render(<UnsavedChangesModal />);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('print settings from the keyboard', () => {
  it('moves through the Plan choices with the arrow keys, one Tab stop for the group', () => {
    store.state = { ...store.state, printScope: 'detail' };
    render(<PrintDetails labelFields={{}} onClose={vi.fn()} />);
    const radios = screen.getAllByRole('radio') as HTMLButtonElement[];
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    act(() => radios[0].focus());
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Current view' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Current view' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('radio', { name: 'Whole floor' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Floor + details' }).getAttribute('aria-checked')).toBe('true');
    expect((screen.getAllByRole('radio') as HTMLButtonElement[]).map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it('moves through the Details tabs with the arrow keys', () => {
    render(<PrintDetails labelFields={{}} onClose={vi.fn()} />);
    const tabs = screen.getAllByRole('tab') as HTMLButtonElement[];
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].tabIndex).toBe(-1);
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    const now = screen.getAllByRole('tab') as HTMLButtonElement[];
    expect(now[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(now[1]);
  });
});
