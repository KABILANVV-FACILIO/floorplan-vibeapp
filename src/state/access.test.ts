import { describe, expect, it } from 'vitest';
import { canSee, clampView, visibleSurfaces } from './selectors';
import type { AppState } from './types';
import type { Access, OrgRole } from '../lib/types';

/**
 * Access decides what a person can open, so the dangerous failure is not "a tab leaked" — it is an
 * app with nothing in it. These pin the open-by-default rule at each point it could be lost: an
 * unknown viewer, an unconfigured tab, and a tab hidden while someone is standing on it.
 */

const HR: OrgRole = { id: '412', name: 'HR Business Partner' };
const TECH: OrgRole = { id: '907', name: 'Maintenance Technician' };

const base = (over: { access?: Access; viewerRole?: OrgRole | null; activeView?: AppState['activeView'] } = {}) =>
  ({ access: {}, viewerRole: null, activeView: 'map', ...over }) as unknown as AppState;

describe('who can see a tab', () => {
  it('shows every tab when the session carries no role', () => {
    // The account payload not naming a role is a read that failed, not an org that locked down.
    const state = base({ access: { people: { all: false, roles: ['412'] } }, viewerRole: null });
    expect(canSee(state, 'people')).toBe(true);
    expect(visibleSurfaces(state)).toEqual(['map', 'bookings', 'people', 'settings']);
  });

  it('shows a tab nobody has configured', () => {
    expect(canSee(base({ viewerRole: TECH }), 'settings')).toBe(true);
  });

  it('honours an explicit list once the viewer is known', () => {
    const access: Access = { people: { all: false, roles: ['412'] } };
    expect(canSee(base({ access, viewerRole: HR }), 'people')).toBe(true);
    expect(canSee(base({ access, viewerRole: TECH }), 'people')).toBe(false);
  });

  it('treats "everyone" as covering a role added after the rule was written', () => {
    const access: Access = { bookings: { all: true, roles: [] } };
    expect(canSee(base({ access, viewerRole: { id: '9999', name: 'Role created later' } }), 'bookings')).toBe(true);
  });

  it('hides a tab whose list is empty', () => {
    const access: Access = { settings: { all: false, roles: [] } };
    expect(canSee(base({ access, viewerRole: TECH }), 'settings')).toBe(false);
  });
});

describe('landing somewhere real', () => {
  it('keeps the asked-for view when it is allowed', () => {
    expect(clampView(base({ viewerRole: HR }), 'bookings')).toBe('bookings');
  });

  it('falls back to the first allowed tab, in nav order', () => {
    // A deep link, or a tab hidden while the person was standing on it.
    const access: Access = { map: { all: false, roles: ['412'] }, bookings: { all: false, roles: ['412'] } };
    expect(clampView(base({ access, viewerRole: TECH }), 'map')).toBe('people');
  });

  it('falls back to the plan rather than nothing when every tab is closed', () => {
    const shut: Access = {
      map: { all: false, roles: [] },
      bookings: { all: false, roles: [] },
      people: { all: false, roles: [] },
      settings: { all: false, roles: [] },
    };
    // The grid refuses to reach this state, and the function refuses to store it — but a blob
    // edited by hand must still open the app rather than render an empty shell.
    expect(clampView(base({ access: shut, viewerRole: TECH }), 'people')).toBe('map');
  });
});

describe('the admin floor', () => {
  it('keeps Settings for an admin role even when the grid leaves them off it', () => {
    const access: Access = { settings: { all: false, roles: ['412'] } };
    const admin: OrgRole = { id: '1', name: 'Super Admin', isAdmin: true };
    expect(canSee(base({ access, viewerRole: admin }), 'settings')).toBe(true);
  });

  it('gives an admin role no other tab for free', () => {
    const access: Access = { people: { all: false, roles: ['412'] } };
    const admin: OrgRole = { id: '1', name: 'Super Admin', isAdmin: true };
    expect(canSee(base({ access, viewerRole: admin }), 'people')).toBe(false);
  });
});
