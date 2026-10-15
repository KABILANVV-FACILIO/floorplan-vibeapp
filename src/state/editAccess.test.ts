import { describe, expect, it, vi } from 'vitest';

// The reducer pulls in the PDF preview transitively, which imports pdf.js's worker via `?url` —
// a Vite-only import form the test runner can't resolve. Nothing here touches PDFs.
vi.mock('../lib/pdfPreview', () => ({ renderPdfToDataUrl: vi.fn() }));

import { buildInitialState, reducer } from './reducer';
import { canEdit, visibleSurfaces } from './selectors';
import type { Access, OrgRole } from '../lib/types';

/**
 * The edit right. It is a capability, not a place: it never becomes somewhere the app sends
 * someone, entering Edit needs it, and LEAVING Edit never does — a person must not be trapped in
 * a mode they have just lost the right to.
 */

const EDITOR: OrgRole = { id: '21', name: 'Space Planner' };
const VIEWER: OrgRole = { id: '907', name: 'Maintenance Technician' };
const editOnlyFor = (roles: string[]): Access => ({ 'map.edit': { all: false, roles } });

const stateWith = (access: Access, viewerRole: OrgRole | null, mode: 'assign' | 'book' | 'edit' = 'assign') => ({
  ...buildInitialState(),
  access,
  viewerRole,
  mode,
});

describe('who may edit', () => {
  it('needs the plan as well as the edit right', () => {
    const noPlan: Access = { map: { all: false, roles: ['1'] }, 'map.edit': { all: false, roles: ['21'] } };
    expect(canEdit(stateWith(noPlan, EDITOR))).toBe(false);
    expect(canEdit(stateWith(editOnlyFor(['21']), EDITOR))).toBe(true);
    expect(canEdit(stateWith(editOnlyFor(['21']), VIEWER))).toBe(false);
  });

  it('is open to everyone until someone restricts it — editing worked before this grid existed', () => {
    expect(canEdit(stateWith({}, VIEWER))).toBe(true);
  });

  it('never makes Edit a tab: there are still exactly four places to land', () => {
    expect(visibleSurfaces(stateWith(editOnlyFor(['21']), EDITOR))).toEqual(['map', 'bookings', 'people', 'settings']);
  });
});

describe('getting into and out of Edit', () => {
  it('refuses to enter Edit without the right', () => {
    const s = stateWith(editOnlyFor(['21']), VIEWER);
    expect(reducer(s, { type: 'SET_MODE', mode: 'edit' }).mode).toBe('assign');
    expect(reducer(s, { type: 'TOGGLE_EDIT' }).mode).toBe('assign');
  });

  it('lets an editor in', () => {
    expect(reducer(stateWith(editOnlyFor(['21']), EDITOR), { type: 'TOGGLE_EDIT' }).mode).toBe('edit');
  });

  it('always lets someone OUT of Edit, right or no right', () => {
    const trapped = stateWith(editOnlyFor(['21']), VIEWER, 'edit');
    expect(reducer(trapped, { type: 'TOGGLE_EDIT' }).mode).toBe('assign');
    expect(reducer(trapped, { type: 'SET_MODE', mode: 'book' }).mode).toBe('book');
  });

  it('moves someone out of Edit when their role turns out not to have the right', () => {
    // The usual case: the role resolves at boot, after someone is already in Edit.
    const s = stateWith(editOnlyFor(['21']), null, 'edit');
    expect(reducer(s, { type: 'SET_VIEWER_ROLE', role: VIEWER }).mode).toBe('assign');
  });

  it('moves someone out of Edit when the grid is saved without them', () => {
    const s = stateWith({}, EDITOR, 'edit');
    expect(reducer(s, { type: 'SET_ACCESS', access: editOnlyFor(['1']) }).mode).toBe('assign');
  });

  it('leaves an editor where they are', () => {
    const s = stateWith(editOnlyFor(['21']), null, 'edit');
    expect(reducer(s, { type: 'SET_VIEWER_ROLE', role: EDITOR }).mode).toBe('edit');
  });
});
