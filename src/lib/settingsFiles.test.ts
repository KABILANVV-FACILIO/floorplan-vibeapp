import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The org's settings and department colours, each one JSON file in the app's file store. An upload
 * never overwrites, so a save uploads a new copy and prunes the older ones behind it. What these pin:
 * a save uploads once and deletes only copies provably OLDER than its own (never a newer one another
 * tab just saved); a read that fails is a failure, not "no settings"; and what is read is cleaned —
 * the store is writable by every user of the app — while a blob this app wrote loads unchanged.
 */

type F = { fileId: number; fileName: string; uploadedTime: number | null };
const store = vi.hoisted(() => ({
  files: [] as F[],
  contents: new Map<number, string>(),
  uploads: [] as { name: string; text: string }[],
  deleted: [] as number[],
  nextId: 100,
  listFails: false,
  uploadFails: false,
  uploadTime: 5_000 as number | null,
}));

vi.mock('./vibe', () => ({
  isVibeApp: true,
  RESPONDERS_FN: 'floorplanResponders',
  vibe: {
    listFiles: vi.fn(async () => {
      if (store.listFails) throw Object.assign(new Error('listFiles failed: 503 Service Unavailable'), { status: 503 });
      // Newest first, as the SDK lists them.
      return [...store.files].sort((a, b) => (b.uploadedTime ?? 0) - (a.uploadedTime ?? 0));
    }),
    // jsdom's Blob has no .text(); the SDK's does — stand in with one that has.
    downloadFile: vi.fn(async (fileId: number) => ({ text: async () => store.contents.get(fileId) ?? '' })),
    uploadFile: vi.fn(async (blob: Blob, name: string) => {
      if (store.uploadFails) return null;
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });
      store.uploads.push({ name, text });
      const f: F = { fileId: store.nextId++, fileName: name, uploadedTime: store.uploadTime };
      store.files.push(f);
      store.contents.set(f.fileId, text);
      return { ...f, contentType: 'application/json', size: text.length, uploadedBy: 1 };
    }),
    deleteFile: vi.fn(async (fileId: number) => {
      store.deleted.push(fileId);
      store.files = store.files.filter((f) => f.fileId !== fileId);
    }),
  },
}));
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

const { loadSettings, saveSettings, sanitizeSettings } = await import('./settingsStore');
const { loadDepartmentColors, saveDepartmentColor, resetDepartmentColor, sanitizeDepartmentColors } = await import('./departmentColorStore');

const SETTINGS = 'floorplan-settings.json';
const COLORS = 'floorplan-department-colors.json';
const put = (fileId: number, fileName: string, uploadedTime: number | null, body: unknown) => {
  store.files.push({ fileId, fileName, uploadedTime });
  store.contents.set(fileId, typeof body === 'string' ? body : JSON.stringify(body));
};
/** Let the prune that a save starts behind itself run to the end. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A blob as this app writes it (settingsFromState): every key it knows, in the shapes it writes. */
const WRITTEN = {
  access: { map: { all: true, roles: [] }, 'map.assign': { all: false, roles: ['4215', '3874'] }, settings: { all: false, roles: [] } },
  moduleColors: { 'workstation.free': '#29A01E', 'parking.assigned': '#0059d6' },
  colorBy: 'department',
  slotGranularity: 30,
  bookingModule: 'space',
  customMarkers: [
    { id: 'm_aed', name: 'AED', color: '#B61919', text: 'AE' },
    { id: 'm_logo', name: 'Logo', color: '#607796', text: 'LO', img: 'https://cdn.example.org/logo.png' },
  ],
  enabledModules: { workstation: true, room: true, locker: false, parking: true, delivery: true },
  planLabels: { workstation: { field: 'deskCode', showHolder: true }, parking: { field: 'name', showHolder: false }, room: { field: 'name', showHolder: true } },
  printRegisters: { parking: { register: true, cols: ['name', 'id', 'emp'], rows: 'all', sort: 'name' }, workstation: { register: false, cols: ['name'], rows: 'assigned', sort: 'dept' } },
  printScope: 'floor',
  labelStyle: { name: { size: 8.5, weight: 600 }, detail: { size: 8, weight: 500 } },
  firstResponders: [{ employeeId: '9', name: 'Omar', roles: ['firstAider'] }],
  responderRoles: [{ id: 'firstAider', name: 'First aider', plural: 'First aiders', color: '#00843D', icon: 'cross', shape: 'square' }],
};

beforeEach(() => {
  store.files = [];
  store.contents.clear();
  store.uploads.length = 0;
  store.deleted.length = 0;
  store.nextId = 100;
  store.listFails = false;
  store.uploadFails = false;
  store.uploadTime = 5_000;
  localStorage.clear();
});

describe('saving the settings', () => {
  it('uploads once, then deletes only the older copies — never a newer one another tab just saved', async () => {
    put(1, SETTINGS, 1_000, {});
    put(2, SETTINGS, 2_000, {});
    put(3, SETTINGS, 9_000, { colorBy: 'status' }); // saved by another tab after this one
    put(4, 'unrelated.json', 500, {});
    await saveSettings({ colorBy: 'department' });
    await settle();
    expect(store.uploads).toEqual([{ name: SETTINGS, text: JSON.stringify({ colorBy: 'department' }, null, 2) }]);
    expect(store.deleted.sort()).toEqual([1, 2]);
  });

  it('deletes nothing when the store gives no upload times — an extra copy is harmless, a lost one is not', async () => {
    store.uploadTime = null;
    put(1, SETTINGS, null, {});
    await saveSettings({ colorBy: 'status' });
    await settle();
    expect(store.uploads).toHaveLength(1);
    expect(store.deleted).toEqual([]);
  });

  it('keeps a copy in this browser when the store does not take the upload', async () => {
    store.uploadFails = true;
    await saveSettings({ colorBy: 'status' });
    expect(JSON.parse(localStorage.getItem('facilio_floorplan_settings_v1')!)).toEqual({ colorBy: 'status' });
  });
});

describe('loading the settings', () => {
  it('loads a blob this app wrote unchanged', async () => {
    put(1, SETTINGS, 1_000, WRITTEN);
    expect(await loadSettings()).toEqual(WRITTEN);
  });

  it('reads the newest copy', async () => {
    put(1, SETTINGS, 1_000, { colorBy: 'status' });
    put(2, SETTINGS, 2_000, { colorBy: 'department' });
    expect(await loadSettings()).toEqual({ colorBy: 'department' });
  });

  it('leaves out what is not a setting in the shape this app writes', async () => {
    put(1, SETTINGS, 1_000, {
      ...WRITTEN,
      perms: { admin: ['*'] }, // a key no build reads any more
      injected: '<script>',
      moduleColors: { 'workstation.free': 'red', 'room.free': '#12345G', 'locker.free': '#0EA5A5' },
      colorBy: 'everything',
      slotGranularity: '30',
      bookingModule: 'other',
      access: { map: { all: 'yes', roles: [] }, 'map.delete': { all: true, roles: [] }, people: { all: false, roles: ['12', 13] } },
      customMarkers: [
        { id: 'ok', name: 'OK', color: '#0059D6' },
        { id: 'bad-colour', name: 'X', color: 'url(javascript:alert(1))' },
        { id: 'tracker', name: 'Pixel', color: '#0059D6', img: 'http://tracker.example.com/p.gif' },
        'not a marker',
      ],
      printScope: 'everything',
      enabledModules: { workstation: 'no', parking: false, spaceship: true },
    });
    const cfg = await loadSettings();
    expect(cfg).not.toHaveProperty('perms');
    expect(cfg).not.toHaveProperty('injected');
    expect(cfg).not.toHaveProperty('colorBy');
    expect(cfg).not.toHaveProperty('slotGranularity');
    expect(cfg).not.toHaveProperty('bookingModule');
    expect(cfg).not.toHaveProperty('printScope');
    expect(cfg!.moduleColors).toEqual({ 'locker.free': '#0EA5A5' });
    expect(cfg!.access).toEqual({ people: { all: false, roles: ['12'] } });
    // The marker with a plain-http image keeps its chip; the image is not loaded from there.
    expect(cfg!.customMarkers).toEqual([
      { id: 'ok', name: 'OK', color: '#0059D6' },
      { id: 'tracker', name: 'Pixel', color: '#0059D6' },
    ]);
    expect(cfg!.enabledModules).toEqual({ parking: false });
  });

  it('falls back to this browser’s copy when the store has no settings file', async () => {
    localStorage.setItem('facilio_floorplan_settings_v1', JSON.stringify({ colorBy: 'department', bogus: 1 }));
    expect(await loadSettings()).toEqual({ colorBy: 'department' });
  });

  it('answers null when there are no settings anywhere', async () => {
    expect(await loadSettings()).toBeNull();
  });

  it('REJECTS when the store cannot be read — that is not "no settings"', async () => {
    store.listFails = true;
    localStorage.setItem('facilio_floorplan_settings_v1', JSON.stringify({ colorBy: 'department' }));
    await expect(loadSettings()).rejects.toThrow(/503/);
  });

  it('treats a stored file that is not JSON as no settings, so the next save replaces it', async () => {
    put(1, SETTINGS, 1_000, '{not json');
    expect(await loadSettings()).toBeNull();
  });

  it('cleans a blob with nothing usable to an empty config, and a non-object to nothing', () => {
    expect(sanitizeSettings({ junk: true })).toEqual({});
    expect(sanitizeSettings([1, 2])).toBeNull();
    expect(sanitizeSettings('x')).toBeNull();
  });
});

describe('the department colours', () => {
  const scheme = { '101': { name: 'Finance', color: '#0059D6' }, '102': { name: 'HR', color: '#29a01e' } };

  it('saves the whole scheme once, and deletes only the older copies', async () => {
    put(1, COLORS, 1_000, {});
    put(2, COLORS, 9_000, {}); // newer — another tab's
    await saveDepartmentColor('102', 'HR', '#29a01e', scheme);
    await settle();
    expect(store.uploads).toEqual([{ name: COLORS, text: JSON.stringify(scheme, null, 2) }]);
    expect(store.deleted).toEqual([1]);
  });

  it('resets through the same single upload', async () => {
    await resetDepartmentColor('102', { '101': scheme['101'] });
    expect(store.uploads.map((u) => JSON.parse(u.text))).toEqual([{ '101': scheme['101'] }]);
  });

  it('loads a scheme this app wrote unchanged, and leaves out an entry that is not a colour', async () => {
    put(1, COLORS, 1_000, { ...scheme, '103': { name: 'Ops', color: 'javascript:1' }, '104': 'teal', '105': { color: '#ABCDEF' } });
    expect(await loadDepartmentColors()).toEqual({ ...scheme, '105': { name: '', color: '#ABCDEF' } });
  });

  it('answers {} with none stored, and REJECTS when the store cannot be read', async () => {
    expect(await loadDepartmentColors()).toEqual({});
    store.listFails = true;
    await expect(loadDepartmentColors()).rejects.toThrow(/503/);
  });

  it('reads nothing from something that is not a scheme', () => {
    expect(sanitizeDepartmentColors(null)).toBeNull();
    expect(sanitizeDepartmentColors(['#0059D6'])).toBeNull();
  });
});
