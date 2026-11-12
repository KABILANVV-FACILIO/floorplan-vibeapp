import type { AppState } from '../state/types';
import { BUILTIN_RESPONDER_ROLES, RESPONDER_ICONS } from './types';
import type { Employee, FirstResponder, ResponderIcon, ResponderRole, ResponderRoleDef, ResponderShape, Unit } from './types';

/**
 * First responders — the people Settings names under the org's responder roles — and where they
 * sit. A responder is placed on a floor by the DESK they hold there: the plan badges that desk,
 * the floor's list names them, and the printed notice prints them. Nobody is placed by hand, so the
 * plan can never show a warden at a desk they have since left.
 */

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
};

const ICONS = new Set<string>(RESPONDER_ICONS.map((i) => i.id));
const SHAPES = new Set<string>(['square', 'circle', 'diamond']);
const HEX = /^#[0-9a-f]{6}$/i;

/** One or two letters for a lettered badge, from what was typed or else from the role's name. */
export function badgeLetters(raw: string | undefined, name: string): string {
  const typed = (raw ?? '').replace(/\s+/g, '').slice(0, 2).toUpperCase();
  if (typed) return typed;
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 1)).toUpperCase();
}

/**
 * The org's roles, made safe to draw. The two built-ins are always there, in front — a saved
 * edit to one (its colour, its symbol) is kept, but it can never be dropped, so a notice always
 * has its first aiders and wardens. Custom roles follow in the order saved; one that is malformed
 * is left out rather than drawn wrong.
 */
export function sanitizeRoles(raw: unknown): ResponderRoleDef[] {
  const saved = Array.isArray(raw) ? raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
  const clean = (o: Record<string, unknown>, base?: ResponderRoleDef): ResponderRoleDef | null => {
    const id = text(o.id) ?? base?.id;
    const name = text(o.name) ?? base?.name;
    if (!id || !name) return null;
    const icon = (typeof o.icon === 'string' && ICONS.has(o.icon) ? o.icon : base?.icon ?? 'text') as ResponderIcon;
    const shape = (typeof o.shape === 'string' && SHAPES.has(o.shape) ? o.shape : base?.shape ?? 'circle') as ResponderShape;
    const color = typeof o.color === 'string' && HEX.test(o.color) ? o.color.toUpperCase() : base?.color ?? '#4B5563';
    const def: ResponderRoleDef = { id, name, plural: text(o.plural) ?? (base && name === base.name ? base.plural : `${name}s`), color, icon, shape };
    if (icon === 'text') def.text = badgeLetters(text(o.text), name);
    if (base) def.builtIn = true;
    return def;
  };
  const out: ResponderRoleDef[] = BUILTIN_RESPONDER_ROLES.map((b) => {
    const edit = saved.find((r) => r.id === b.id);
    return (edit && clean(edit, b)) || { ...b };
  });
  const seen = new Set(out.map((r) => r.id));
  for (const r of saved) {
    const def = clean(r);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    out.push(def);
  }
  return out;
}

/** A fresh id for a role being added — never one already taken. */
export function newRoleId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `r_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'role'}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  return id;
}

/**
 * The list as stored, made safe to use. The settings blob is read back from a file anyone with the
 * app's store can write, and from configs saved by older builds: anything that isn't a person with
 * at least one known role is dropped rather than drawn. One person listed twice is merged into one
 * entry carrying both roles. Roles come out in the org's order (`roleIds`).
 */
export function sanitizeResponders(raw: unknown, roleIds: ResponderRole[] = BUILTIN_RESPONDER_ROLES.map((r) => r.id)): FirstResponder[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(roleIds);
  const ordered = (ids: ResponderRole[]) => roleIds.filter((k) => ids.includes(k));
  const byId = new Map<string, FirstResponder>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const employeeId = text(o.employeeId);
    if (!employeeId) continue;
    const roles = Array.isArray(o.roles) ? (o.roles.filter((x) => typeof x === 'string' && known.has(x)) as ResponderRole[]) : [];
    if (roles.length === 0) continue;
    const prev = byId.get(employeeId);
    if (prev) {
      prev.roles = ordered([...prev.roles, ...roles]);
      continue;
    }
    byId.set(employeeId, { employeeId, name: text(o.name) ?? '', roles: ordered(roles) });
  }
  return [...byId.values()];
}

/**
 * Each responder named as their employee record names them. The record is the source — a rename in
 * Facilio shows up here at the next load — and the stored name is kept only for someone the
 * directory does not have.
 */
export function withRecordNames(list: FirstResponder[], employees: Pick<Employee, 'id' | 'name'>[]): FirstResponder[] {
  if (list.length === 0 || employees.length === 0) return list;
  const names = new Map(employees.map((e) => [e.id, e.name]));
  let changed = false;
  const out = list.map((r) => {
    const name = names.get(r.employeeId);
    if (!name || name === r.name) return r;
    changed = true;
    return { ...r, name };
  });
  return changed ? out : list;
}

/**
 * What the responders database answers (`get-responders`, functions/floorplanResponders), made
 * safe to draw — cleaned exactly as a settings blob is, since a table is no more trusted than a
 * file. Null when the answer is not a responder list at all, so the caller keeps what it has
 * rather than blanking the floor.
 */
export function responderDataFrom(raw: unknown): { roles: ResponderRoleDef[]; responders: FirstResponder[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.roles) || !Array.isArray(o.responders)) return null;
  const roles = sanitizeRoles(o.roles);
  return { roles, responders: sanitizeResponders(o.responders, roles.map((r) => r.id)) };
}

export interface FloorResponder {
  responder: FirstResponder;
  /** The desk they hold on this floor. */
  unit: Unit;
}

type ResponderState = Pick<AppState, 'units' | 'assignments' | 'firstResponders' | 'responderRoles'>;

/**
 * The responders who hold a desk on the floor that is loaded, in name order. Desks only: the badge
 * marks where a person SITS, and a locker or a parking stall says nothing about where to find them.
 */
export function respondersOnFloor(state: Pick<AppState, 'units' | 'assignments' | 'firstResponders'>): FloorResponder[] {
  if (state.firstResponders.length === 0) return [];
  const byId = new Map(state.firstResponders.map((r) => [r.employeeId, r]));
  const out: FloorResponder[] = [];
  for (const unit of state.units) {
    if (unit.type !== 'workstation' || unit.unplaced) continue;
    const holder = state.assignments[unit.id];
    const responder = holder ? byId.get(String(holder)) : undefined;
    if (responder) out.push({ responder, unit });
  }
  return out.sort((a, b) => a.responder.name.localeCompare(b.responder.name) || a.unit.label.localeCompare(b.unit.label));
}

/** The roles of the person at this desk, as definitions in the org's order — empty for everyone else. */
export function responderRolesFor(state: ResponderState, unit: Unit): ResponderRoleDef[] {
  if (unit.type !== 'workstation' || state.firstResponders.length === 0) return [];
  const holder = state.assignments[unit.id];
  if (!holder) return [];
  const roles = state.firstResponders.find((r) => r.employeeId === String(holder))?.roles ?? [];
  return state.responderRoles.filter((d) => roles.includes(d.id));
}

/** The roles someone on this floor holds — what the legend keys and the notice prints. */
export function rolesOnFloor(list: FloorResponder[], roles: ResponderRoleDef[]): ResponderRoleDef[] {
  return roles.filter((d) => list.some((x) => x.responder.roles.includes(d.id)));
}

/** The responders on this list who hold one role — one section of the floor's list or its notice. */
export function holdersOf<T extends { responder: FirstResponder }>(list: T[], role: ResponderRole): T[] {
  return list.filter((x) => x.responder.roles.includes(role));
}

/** "2 First aiders · 1 Floor warden" — what the plan's responder chip says. */
export function responderCountLabel(list: FloorResponder[], roles: ResponderRoleDef[]): string {
  return roles
    .map((d) => {
      const n = list.filter((x) => x.responder.roles.includes(d.id)).length;
      return n === 0 ? null : `${n} ${n === 1 ? d.name : d.plural}`;
    })
    .filter(Boolean)
    .join(' · ');
}

/** "First aider · Floor warden" — what a tooltip or a sheet says about the person at a desk. */
export function rolesText(defs: ResponderRoleDef[]): string {
  return defs.map((d) => d.name).join(' · ');
}
