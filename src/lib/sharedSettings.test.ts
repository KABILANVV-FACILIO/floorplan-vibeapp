import { describe, expect, it } from 'vitest';
import { accessFrom, refusalReason } from './sharedSettings';

describe('accessFrom', () => {
  it('keeps known surfaces as clean { all, roles }, and drops everything else', () => {
    expect(
      accessFrom({
        settings: { all: false, roles: ['3874', 4215] },
        map: { all: true, roles: ['ignored'] },
        bogus: { all: true },
        people: 'junk',
      })
    ).toEqual({ settings: { all: false, roles: ['3874', '4215'] }, map: { all: true, roles: [] } });
  });

  it('reads nothing from something that is not a grid', () => {
    expect(accessFrom(null)).toEqual({});
    expect(accessFrom([])).toEqual({});
    expect(accessFrom('settings')).toEqual({});
  });
});

describe('refusalReason', () => {
  it("passes on the function's own words when it refused on purpose", () => {
    const err = new Error('{"ok":false,"code":"handler_error","error":"Not saved: only admins and roles given Settings can change this"}');
    expect(refusalReason(err)).toBe('only admins and roles given Settings can change this');
  });

  it('says nothing about a transport failure', () => {
    expect(refusalReason(new Error('network down'))).toBeNull();
  });
});
