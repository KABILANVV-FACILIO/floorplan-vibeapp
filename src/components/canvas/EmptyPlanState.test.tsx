import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Access, OrgRole } from '../../lib/types';

/**
 * A floor with no plan. Adding one is editing the floor, so it happens in Edit mode — this screen,
 * which everyone sees, carries no Upload button. It says what is missing, and only to someone who
 * can fix it, where to go.
 */

const state = {
  floorId: 'f1',
  planId: 'workstation',
  access: {} as Access,
  viewerRole: null as OrgRole | null,
  sites: [],
};

vi.mock('../../state/FloorplanContext', () => ({
  useFloorplanData: () => ({ state, actions: { setUploadOpen: vi.fn() } }),
}));
vi.mock('../../state/selectors', async () => {
  const real = await vi.importActual<typeof import('../../state/selectors')>('../../state/selectors');
  return { ...real, floorMeta: () => ({ floor: { name: 'Level 4' } }) };
});

const { EmptyPlanState } = await import('./EmptyPlanState');

afterEach(() => {
  cleanup();
  state.access = {};
  state.viewerRole = null;
});

describe('a floor with no plan', () => {
  it('offers no Upload button, to anyone', () => {
    render(<EmptyPlanState />);
    expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
  });

  it('shows the empty-floor picture', () => {
    render(<EmptyPlanState />);
    expect(screen.getByRole('img', { name: 'No floorplan' })).toBeTruthy();
  });

  it('points someone who can edit to Edit', () => {
    render(<EmptyPlanState />);
    expect(screen.getByText(/Open Edit to upload a plan for Level 4/)).toBeTruthy();
  });

  it('only says what is missing to someone who cannot edit', () => {
    state.access = { 'map.edit': { all: false, roles: ['21'] } };
    state.viewerRole = { id: '907', name: 'Maintenance Technician' };
    render(<EmptyPlanState />);
    expect(screen.getByText(/A plan for Level 4 has not been added yet/)).toBeTruthy();
    expect(screen.queryByText(/Open Edit/)).toBeNull();
  });
});
