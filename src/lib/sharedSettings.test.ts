import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsConfig } from './settingsStore';

/**
 * The browser's side of the settings a browser must not write itself: what it asks the
 * floorplanResponders function to save (nothing about the user — the function names the caller),
 * that a refusal reaches the caller as a rejection carrying the function's own reason (the context
 * then re-reads what is stored, says why, and puts the screen back), and that a read it cannot
 * trust is no read at all.
 */
const fn = vi.hoisted(() => ({
  calls: [] as { name: string; handler: string; args: Record<string, unknown> }[],
  answer: (_handler: string): Promise<unknown> => Promise.resolve({ ok: true }),
}));
vi.mock('./vibe', () => ({
  isVibeApp: true,
  RESPONDERS_FN: 'floorplanResponders',
  vibe: {
    executeFunction: vi.fn(async (name: string, handler: string, args: Record<string, unknown>) => {
      fn.calls.push({ name, handler, args });
      return fn.answer(handler);
    }),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { accessFrom, loadSharedSettings, notSavedNotice, refusalReason, saveAccess, saveAppSettings, saveDepartmentColorScheme, savePrintSettings, saveResponderRoles, saveResponders } = await import('./sharedSettings');

beforeEach(() => {
  fn.calls.length = 0;
  fn.answer = () => Promise.resolve({ ok: true });
});

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

describe('saving through the function', () => {
  const REFUSED = new Error('floorplanResponders/save-roles failed: 500 — {"ok":false,"error":"Not saved: only admins and roles given Settings can change this"}');
  const roles = [
    { id: 'firstAider', name: 'First aider', plural: 'First aiders', color: '#00843D', icon: 'cross', shape: 'square', builtIn: true },
    { id: 'floorWarden', name: 'Floor warden', plural: 'Floor wardens', color: '#C8102E', icon: 'warden', shape: 'circle', builtIn: true },
  ] as const;

  it('sends the roles as their stored fields only — nothing about who is saving', async () => {
    await saveResponderRoles(roles.map((r) => ({ ...r })));
    expect(fn.calls).toEqual([
      {
        name: 'floorplanResponders',
        handler: 'save-roles',
        args: {
          rolesJson: JSON.stringify(roles.map(({ id, name, plural, color, icon, shape }) => ({ id, name, plural, color, icon, shape }))),
        },
      },
    ]);
  });

  it('sends the responders and the grid as JSON, the grid cleaned first', async () => {
    await saveResponders([{ employeeId: '9', name: 'Omar', roles: ['firstAider'] }]);
    await saveAccess({ settings: { all: false, roles: ['3874'] }, map: { all: true, roles: ['x'] } });
    expect(fn.calls.map((c) => [c.handler, c.args])).toEqual([
      ['save-responders', { respondersJson: '[{"employeeId":"9","name":"Omar","roles":["firstAider"]}]' }],
      ['save-access', { accessJson: '{"settings":{"all":false,"roles":["3874"]},"map":{"all":true,"roles":[]}}' }],
    ]);
  });

  it("rejects with the function's refusal, whose reason the caller can show", async () => {
    fn.answer = () => Promise.reject(REFUSED);
    const err = await saveResponderRoles(roles.map((r) => ({ ...r }))).catch((e) => e);
    expect(err).toBe(REFUSED);
    expect(refusalReason(err)).toBe('only admins and roles given Settings can change this');
  });

  it('reads back what is stored — the re-read a refused save puts the screen back to', async () => {
    fn.answer = (handler) =>
      Promise.resolve(handler === 'get-settings' ? { roles: [...roles], responders: [{ employeeId: '9', name: 'Omar', roles: ['firstAider'] }], access: { settings: { all: false, roles: ['3874'] } } } : null);
    const stored = await loadSharedSettings();
    expect(stored?.responders).toEqual([{ employeeId: '9', name: 'Omar', roles: ['firstAider'] }]);
    expect(stored?.access).toEqual({ settings: { all: false, roles: ['3874'] } });
  });

  it('answers null — keep the settings copy — for an answer that is not a settings read (a function from before it)', async () => {
    fn.answer = () => Promise.resolve({ rows: [] });
    expect(await loadSharedSettings()).toBeNull();
  });

  it('rejects — not "no database" — when the database is there but could not be asked', async () => {
    fn.answer = () => Promise.reject(new Error('503'));
    await expect(loadSharedSettings()).rejects.toThrow('503');
  });

  it('passes on why the settings table was not read: too large, or not imported yet', async () => {
    fn.answer = () => Promise.resolve({ roles: [], responders: [], access: {}, appSettingsRead: false, appSettingsError: 'too-large' });
    expect((await loadSharedSettings())?.appSettingsError).toBe('too-large');
    fn.answer = () => Promise.resolve({ roles: [], responders: [], access: {}, appSettingsRead: false, appSettingsError: 'unavailable' });
    expect((await loadSharedSettings())?.appSettingsError).toBe('unavailable');
    fn.answer = () => Promise.resolve({ roles: [], responders: [], access: {}, appSettingsRead: true });
    expect((await loadSharedSettings())?.appSettingsError).toBeNull();
  });
});

/**
 * The settings blob, the print settings and the department colours, which followed the responders
 * and the grid into the app database (fp_app_setting): read made safe and each held to its own
 * keys, saved to their own handlers.
 */
describe('the app settings in the database', () => {
  const answer = (over: Record<string, unknown>) => (handler: string) =>
    Promise.resolve(handler === 'get-settings' ? { roles: [], responders: [], access: {}, appSettingsRead: true, ...over } : null);

  it('reads none of them as null — the file store stays their source', async () => {
    fn.answer = answer({ appSettings: null, printSettings: null, departmentColors: null });
    expect(await loadSharedSettings()).toMatchObject({ appSettingsRead: true, appSettings: null, printSettings: null, departmentColors: null });
  });

  it('says when the function could not read their table, or is from before it', async () => {
    fn.answer = answer({ appSettingsRead: false, appSettings: null, printSettings: null, departmentColors: null });
    expect(await loadSharedSettings()).toMatchObject({ appSettingsRead: false });
    // A function from before the move answers without them at all.
    fn.answer = (handler) => Promise.resolve(handler === 'get-settings' ? { roles: [], responders: [], access: {} } : null);
    expect(await loadSharedSettings()).toMatchObject({ appSettingsRead: false, appSettings: null, printSettings: null, departmentColors: null });
  });

  it('makes each safe to apply, and holds each to its own keys', async () => {
    fn.answer = answer({
      appSettings: { colorBy: 'department', moduleColors: { 'workstation.free': 'red' }, printScope: 'floor', bogus: 1 },
      printSettings: { printScope: 'view', colorBy: 'status', printRegisters: { room: { register: true, rows: 'some' } } },
      departmentColors: { '10': { name: 'Finance', color: '#b0006e' }, '20': { name: 'HR', color: 'blue' } },
    });
    const stored = await loadSharedSettings();
    expect(stored?.appSettings).toEqual({ colorBy: 'department', moduleColors: {} });
    expect(stored?.printSettings).toEqual({ printScope: 'view', printRegisters: { room: { register: true } } });
    expect(stored?.departmentColors).toEqual({ '10': { name: 'Finance', color: '#b0006e' } });
  });

  it('sends each part to its own handler — the print keys never with the settings, nothing about who saves', async () => {
    const cfg = { colorBy: 'department', printScope: 'floor', printRegisters: { parking: { register: false } }, parkingPrint: { rows: 'all' } } as SettingsConfig;
    await saveAppSettings(cfg);
    await savePrintSettings(cfg);
    await saveDepartmentColorScheme({ '10': { name: 'Finance', color: '#b0006e' } });
    expect(fn.calls.map((c) => [c.handler, c.args])).toEqual([
      ['save-app-settings', { settingsJson: '{"colorBy":"department"}' }],
      ['save-print-settings', { printJson: '{"printScope":"floor","printRegisters":{"parking":{"register":false}}}' }],
      ['save-department-colors', { colorsJson: '{"10":{"name":"Finance","color":"#b0006e"}}' }],
    ]);
  });

  it("words a refusal with the function's reason, and anything else as try again", () => {
    const refused = new Error('{"ok":false,"error":"Not saved: only admins and roles given Settings can change this"}');
    expect(notSavedNotice('settings', refused)).toBe("Couldn't save the settings — only admins and roles given Settings can change this.");
    expect(notSavedNotice('print settings', new Error('network down'))).toBe("Couldn't save the print settings. Try again.");
  });
});
