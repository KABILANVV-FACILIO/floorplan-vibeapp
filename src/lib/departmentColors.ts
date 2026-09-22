/**
 * Colouring desks by the department that holds them.
 *
 * The plan answers one question at a time. Coloured by STATE it answers "what can I take" — the
 * question a person booking a desk has. Coloured by DEPARTMENT it answers "who sits where", which
 * is the question a workplace manager has when they are moving a team, and which the plan could
 * not answer at all: Finance and Support looked identical, so working out where a department
 * actually sits meant opening desks one at a time.
 *
 * `department` is a real field on the `desks` module and the floor load already reads every desk
 * record, so this costs no extra call — see `getUnits`.
 *
 * Every department gets a colour before anyone configures one: picking from a fixed wheel by a
 * hash of the name means the plan is legible on first sight, the same department keeps the same
 * colour across floors and sessions, and Settings only has to carry the overrides someone
 * actually disagreed with.
 */

/**
 * The default wheel. Hues are spaced far enough apart to stay distinguishable side by side, and
 * every one of them carries white text at the marker's 9px — they are the saturated end of the
 * Facilio Atom ramps, not pastels.
 */
export const DEPARTMENT_PALETTE = [
  '#0059d6', // blue-500
  '#29a01e', // success-500
  '#8a4bd3', // violet
  '#e07b00', // amber-700
  '#0d9aa8', // teal
  '#b61919', // danger-500
  '#3c229d', // brand indigo
  '#b0006e', // magenta
  '#5c7a1e', // olive
  '#0047ab', // blue-600
] as const;

/** Stable small hash — the same name must land on the same colour on every device, forever. */
function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100003;
  return h;
}

/**
 * What a colour is stored against: the department's RECORD ID in the org.
 *
 * An id, not a name, because a department that gets renamed in Facilio must keep its colour, and
 * because two orgs' "Operations" are different departments. Where a desk named a department
 * without identifying it (the local tier, or a lookup that answered with a bare string), the
 * `name:`-prefixed stand-in from `departmentFallbackId` takes its place — which is why keys here
 * are opaque strings rather than numbers.
 */
export type DepartmentId = string;

/** Case- and space-insensitive comparison of NAMES, for the stand-in ids and for de-duping. */
export function departmentKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Default colours for a whole set of departments at once.
 *
 * Hashing each name INDEPENDENTLY is the obvious implementation and the wrong one: with a
 * ten-colour wheel, four departments collide about 50% of the time, and the first floor this was
 * tried on drew Engineering and Support the same green. Two teams sharing a colour defeats the
 * entire feature, so the set decides: each department takes its hashed preference, and a name
 * whose preference is already spoken for walks to the next free slot. Deterministic for a given
 * set, so the answer is stable across renders, devices and sessions.
 *
 * Only past the wheel's length must colours repeat, and then in a defined order rather than by
 * accident.
 */
export function departmentColorMap(ids: DepartmentId[], overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  const keys = [...new Set(ids)].sort();

  // Overrides are honoured first and reserve their colour, so a default never duplicates a
  // colour somebody deliberately chose.
  for (const key of keys) {
    const override = overrides[key];
    if (override) {
      out[key] = override;
      taken.add(override);
    }
  }

  for (const key of keys) {
    if (out[key]) continue;
    const start = hash(key) % DEPARTMENT_PALETTE.length;
    let pick = DEPARTMENT_PALETTE[start];
    for (let i = 0; i < DEPARTMENT_PALETTE.length; i++) {
      const candidate = DEPARTMENT_PALETTE[(start + i) % DEPARTMENT_PALETTE.length];
      if (!taken.has(candidate)) {
        pick = candidate;
        break;
      }
    }
    out[key] = pick;
    taken.add(pick);
  }

  return out;
}

/** Cheap memo: the same set and overrides must not be re-solved once per marker per render. */
let lastMapKey = '';
let lastMap: Record<string, string> = {};

/**
 * The colour for one department. Pass the other departments on the plan so the set can be kept
 * collision-free; without them this falls back to the name's own hashed preference.
 */
export function departmentColor(id: DepartmentId, overrides: Record<string, string> = {}, all?: DepartmentId[]): string {
  const key = id;
  const override = overrides[key];
  if (override) return override;
  if (!all || all.length === 0) return DEPARTMENT_PALETTE[hash(key) % DEPARTMENT_PALETTE.length];

  const cacheKey = all.join('|') + '##' + JSON.stringify(overrides);
  if (cacheKey !== lastMapKey) {
    lastMap = departmentColorMap(all, overrides);
    lastMapKey = cacheKey;
  }
  return lastMap[key] ?? DEPARTMENT_PALETTE[hash(key) % DEPARTMENT_PALETTE.length];
}

const listCache = new WeakMap<object, DepartmentRef[]>();

/**
 * Every department present in a set of units, in display order (alphabetical), with the name as
 * first seen so Settings shows the org's own capitalisation rather than the normalised key.
 *
 * Cached against the array itself: the marker path asks once per marker per render, and the units
 * array only changes when the floor does.
 */
export interface DepartmentRef {
  id: DepartmentId;
  name: string;
}

export function departmentsIn(units: { department?: string; departmentId?: string }[]): DepartmentRef[] {
  const cached = listCache.get(units as object);
  if (cached) return cached;
  const computed = computeDepartmentsIn(units);
  listCache.set(units as object, computed);
  return computed;
}

function computeDepartmentsIn(units: { department?: string; departmentId?: string }[]): DepartmentRef[] {
  const seen = new Map<string, DepartmentRef>();
  for (const u of units) {
    const name = u.department?.trim();
    if (!name) continue;
    const id = u.departmentId || 'name:' + departmentKey(name);
    if (!seen.has(id)) seen.set(id, { id, name });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
