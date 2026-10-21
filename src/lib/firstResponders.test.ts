import { describe, expect, it } from 'vitest';
import {
  badgeLetters,
  holdersOf,
  newRoleId,
  responderCountLabel,
  responderDataFrom,
  responderRolesFor,
  respondersOnFloor,
  rolesOnFloor,
  rolesText,
  sanitizeResponders,
  sanitizeRoles,
  withRecordNames,
} from './firstResponders';
import { BUILTIN_RESPONDER_ROLES } from './types';
import type { FirstResponder, ResponderRoleDef, Unit } from './types';

function desk(id: string, label: string, extra: Partial<Unit> = {}): Unit {
  return { id, type: 'workstation', label, room: null, geom: { kind: 'point', x: 0.5, y: 0.5 }, floor: 'f1', plan: 'workstation', ...extra } as Unit;
}

const marshal: ResponderRoleDef = { id: 'r_fire_marshal', name: 'Fire marshal', plural: 'Fire marshals', color: '#D9480F', icon: 'flame', shape: 'diamond' };
const roles = [...BUILTIN_RESPONDER_ROLES, marshal];
const roleIds = roles.map((r) => r.id);

const ahmed: FirstResponder = { employeeId: 'e1', name: 'Ahmed Albusaeedi', roles: ['firstAider', 'floorWarden'] };
const mohammed: FirstResponder = { employeeId: 'e2', name: 'Mohammed Abdul Rub', roles: ['floorWarden', 'r_fire_marshal'] };
const sara: FirstResponder = { employeeId: 'e3', name: 'Sara Haddad', roles: ['firstAider'] };

const state = {
  units: [desk('d1', 'WS-01'), desk('d2', 'WS-02'), desk('d3', 'WS-03'), { ...desk('l1', 'LK-01'), type: 'locker' } as Unit, desk('d9', 'WS-09', { unplaced: true })],
  assignments: { d1: 'e2', d2: 'e1', d3: 'e9', l1: 'e3', d9: 'e3' },
  firstResponders: [ahmed, mohammed, sara],
  responderRoles: roles,
};

describe('sanitizeRoles', () => {
  it('is the two built-ins when nothing is saved', () => {
    expect(sanitizeRoles(undefined)).toEqual(BUILTIN_RESPONDER_ROLES);
    expect(sanitizeRoles('junk')).toEqual(BUILTIN_RESPONDER_ROLES);
  });

  it('keeps a saved restyle of a built-in, but never drops one', () => {
    const out = sanitizeRoles([{ id: 'firstAider', color: '#0059d6', shape: 'circle' }]);
    expect(out.map((r) => r.id)).toEqual(['firstAider', 'floorWarden']);
    expect(out[0]).toMatchObject({ name: 'First aider', plural: 'First aiders', color: '#0059D6', shape: 'circle', icon: 'cross', builtIn: true });
  });

  it('appends custom roles after the built-ins, and drops malformed ones', () => {
    const out = sanitizeRoles([marshal, { id: 'x' }, { name: 'No id' }, { ...marshal, name: 'Duplicate' }, { id: 'r_aed', name: 'AED trained', color: 'red', icon: 'nope', shape: 'blob' }]);
    expect(out.map((r) => r.id)).toEqual(['firstAider', 'floorWarden', 'r_fire_marshal', 'r_aed']);
    expect(out[2]).toEqual({ ...marshal, color: '#D9480F' });
    // Bad fields fall back rather than drawing nothing: grey, letters, a circle, plural from the name.
    expect(out[3]).toEqual({ id: 'r_aed', name: 'AED trained', plural: 'AED traineds', color: '#4B5563', icon: 'text', text: 'AT', shape: 'circle' });
  });

  it('gives a lettered badge its letters, from what was typed or else the name', () => {
    const [, , typed, fromName] = sanitizeRoles([
      { id: 'r_a', name: 'Security', icon: 'text', text: 'sec' },
      { id: 'r_b', name: 'Radiation protection', icon: 'text' },
    ]);
    expect(typed.text).toBe('SE');
    expect(fromName.text).toBe('RP');
  });
});

describe('badgeLetters and newRoleId', () => {
  it('takes at most two letters, upper-cased', () => {
    expect(badgeLetters('ab c', 'x')).toBe('AB');
    expect(badgeLetters('', 'Fire marshal')).toBe('FM');
    expect(badgeLetters(undefined, 'Security')).toBe('S');
  });

  it('never reuses an id', () => {
    expect(newRoleId('Fire Marshal!', [])).toBe('r_fire_marshal');
    expect(newRoleId('Fire marshal', ['r_fire_marshal', 'r_fire_marshal_2'])).toBe('r_fire_marshal_3');
    expect(newRoleId('???', [])).toBe('r_role');
  });
});

describe('sanitizeResponders', () => {
  it('keeps well-formed entries as they are', () => {
    expect(sanitizeResponders([ahmed, mohammed], roleIds)).toEqual([ahmed, mohammed]);
  });

  it('drops anything that is not a person with a known role', () => {
    expect(
      sanitizeResponders([null, 'x', { name: 'No id', roles: ['firstAider'] }, { employeeId: 'e5', roles: [] }, { employeeId: 'e6', roles: ['chef'] }], roleIds)
    ).toEqual([]);
    expect(sanitizeResponders({ not: 'an array' }, roleIds)).toEqual([]);
  });

  it('drops a role that no longer exists, and a person left with none', () => {
    expect(sanitizeResponders([mohammed], ['firstAider', 'floorWarden'])).toEqual([{ ...mohammed, roles: ['floorWarden'] }]);
    expect(sanitizeResponders([{ employeeId: 'e7', name: 'Only marshal', roles: ['r_fire_marshal'] }], ['firstAider', 'floorWarden'])).toEqual([]);
  });

  it('merges one person listed twice into one entry, roles in the org order', () => {
    const out = sanitizeResponders(
      [
        { employeeId: 'e1', name: 'Ahmed', roles: ['r_fire_marshal'] },
        { employeeId: 'e1', name: 'Ahmed', roles: ['firstAider'] },
      ],
      roleIds
    );
    expect(out).toEqual([{ employeeId: 'e1', name: 'Ahmed', roles: ['firstAider', 'r_fire_marshal'] }]);
  });

  it('trims text, takes numeric ids as strings, and keeps nothing but the link', () => {
    // Details typed in by an older build (group, ext, mobile) are dropped: they are the record's now.
    const [r] = sanitizeResponders([{ employeeId: 42, name: ' Ahmed ', roles: ['firstAider'], group: 'Male', ext: ' 2047 ', mobile: '055' }], roleIds);
    expect(r).toEqual({ employeeId: '42', name: 'Ahmed', roles: ['firstAider'] });
  });
});

describe('respondersOnFloor', () => {
  it('finds the responders who hold a desk on this floor, by name', () => {
    expect(respondersOnFloor(state).map((x) => [x.responder.name, x.unit.label])).toEqual([
      ['Ahmed Albusaeedi', 'WS-02'],
      ['Mohammed Abdul Rub', 'WS-01'],
    ]);
  });

  it('ignores lockers, unplaced desks, and holders who are not responders', () => {
    expect(respondersOnFloor(state).some((x) => x.responder.employeeId === 'e3')).toBe(false);
    expect(respondersOnFloor(state).some((x) => x.unit.id === 'd3')).toBe(false);
  });

  it('is empty when nobody is named', () => {
    expect(respondersOnFloor({ ...state, firstResponders: [] })).toEqual([]);
  });
});

describe('responderRolesFor', () => {
  it("gives the roles of the person at a desk, as definitions in the org's order", () => {
    expect(responderRolesFor(state, state.units[1]).map((r) => r.id)).toEqual(['firstAider', 'floorWarden']);
    expect(responderRolesFor(state, state.units[0]).map((r) => r.id)).toEqual(['floorWarden', 'r_fire_marshal']);
    expect(responderRolesFor(state, state.units[2])).toEqual([]);
    expect(responderRolesFor(state, state.units[3])).toEqual([]);
  });

  it('names them in words', () => {
    expect(rolesText(responderRolesFor(state, state.units[0]))).toBe('Floor warden · Fire marshal');
  });
});

describe('rolesOnFloor', () => {
  it("is the roles someone on this floor holds, in the org's order", () => {
    expect(rolesOnFloor(respondersOnFloor(state), roles).map((r) => r.id)).toEqual(['firstAider', 'floorWarden', 'r_fire_marshal']);
    const onlyMohammed = respondersOnFloor(state).filter((x) => x.responder.employeeId === 'e2');
    expect(rolesOnFloor(onlyMohammed, roles).map((r) => r.id)).toEqual(['floorWarden', 'r_fire_marshal']);
  });
});

describe('holdersOf', () => {
  const list = [ahmed, mohammed, sara].map((responder) => ({ responder }));

  it("is one role's people, in the list's order", () => {
    expect(holdersOf(list, 'firstAider').map((x) => x.responder.name)).toEqual(['Ahmed Albusaeedi', 'Sara Haddad']);
    expect(holdersOf(list, 'r_fire_marshal').map((x) => x.responder.name)).toEqual(['Mohammed Abdul Rub']);
    expect(holdersOf(list, 'r_nobody')).toEqual([]);
  });
});

describe('withRecordNames', () => {
  it('names each responder as their employee record does', () => {
    const out = withRecordNames([ahmed, sara], [{ id: 'e1', name: 'Ahmed Al Busaeedi' }]);
    expect(out.map((r) => r.name)).toEqual(['Ahmed Al Busaeedi', 'Sara Haddad']);
  });

  it('hands back the same list when nothing changed, so state is not churned', () => {
    const list = [ahmed];
    expect(withRecordNames(list, [{ id: 'e1', name: 'Ahmed Albusaeedi' }])).toBe(list);
    expect(withRecordNames(list, [])).toBe(list);
  });
});

describe('responderCountLabel', () => {
  it('counts each role, and leaves out a role with nobody', () => {
    const onFloor = respondersOnFloor(state);
    expect(responderCountLabel(onFloor, roles)).toBe('1 First aider · 2 Floor wardens · 1 Fire marshal');
    expect(responderCountLabel(onFloor.filter((x) => x.responder.employeeId === 'e1'), roles)).toBe('1 First aider · 1 Floor warden');
    expect(responderCountLabel([], roles)).toBe('');
  });
});

describe('responderDataFrom', () => {
  it("cleans the database's answer the way a saved blob is cleaned", () => {
    const out = responderDataFrom({
      roles: [{ id: 'floorWarden', name: 'Floor warden', plural: 'Floor wardens', color: '#c8102e', icon: 'warden', shape: 'circle' }, marshal],
      responders: [
        { employeeId: '901', name: 'Ahmed', roles: ['r_fire_marshal', 'firstAider'] },
        { employeeId: '902', name: 'Gone role', roles: ['r_deleted'] },
      ],
    });
    // The built-ins come first even when the table is missing one.
    expect(out?.roles.map((r) => r.id)).toEqual(['firstAider', 'floorWarden', 'r_fire_marshal']);
    expect(out?.responders).toEqual([{ employeeId: '901', name: 'Ahmed', roles: ['firstAider', 'r_fire_marshal'] }]);
  });

  it('is null for anything that is not a responder list, so the caller keeps what it has', () => {
    expect(responderDataFrom(null)).toBeNull();
    expect(responderDataFrom({ roles: [] })).toBeNull();
    expect(responderDataFrom('[]')).toBeNull();
  });
});
