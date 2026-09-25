import type { Employee } from './types';

/**
 * Filtering the People list the way a Facilio list page filters: the org says which employee
 * fields can be filtered and with which operators (`v2/filter/advanced/fields/employee`, the same
 * endpoint the Employee list page reads), and the result goes back as one V3 `filters` payload.
 *
 * Pure — no fetching, no React — so the request shape is pinned by tests, not by eye.
 */

export interface FilterOperatorDef {
  operatorId: number;
  label: string;
  /** False for operators like "is empty", which take no value. */
  valueNeeded: boolean;
}

/**
 * What the panel can edit. Deliberately a short list: a field of any other type (dates, numbers,
 * files…) is left out rather than offered with an editor that can't express it.
 */
export type FilterFieldKind = 'text' | 'lookup' | 'options';

export interface FilterFieldDef {
  name: string;
  label: string;
  kind: FilterFieldKind;
  operators: FilterOperatorDef[];
  /** For `options` fields (enum, boolean): the choices, as the org lists them. */
  options?: { value: string; label: string }[];
  /** For `lookup` fields: the module whose records are the choices. */
  lookupModule?: string;
}

/** One ticked field. `values` are record ids (lookup), option values, or a single text. */
export interface AppliedFilter {
  field: string;
  operatorId: number;
  values: string[];
}

/** Shown first, in this order, when the org has them — the ones people filter by. */
const PINNED = ['department', 'designation', 'hrmsEmployeeId'];

const TEXT_TYPES = new Set(['STRING', 'BIG_STRING', 'LARGE_TEXT', 'EMAIL', 'PHONE', 'URL_FIELD']);
const LOOKUP_TYPES = new Set(['LOOKUP', 'MULTI_LOOKUP']);

/**
 * The org's filterable employee fields, reduced to the ones the panel can edit.
 *
 * `name` is left out on purpose: the search box owns it, sending `name` with the email and HRMS
 * ID matches OR-ed in. A panel filter on `name` would be a second clause under the same key and
 * silently replace the search.
 */
export function mapFilterFields(raw: unknown): FilterFieldDef[] {
  if (!Array.isArray(raw)) return [];
  const out: FilterFieldDef[] = [];
  for (const f of raw as any[]) {
    const name = typeof f?.name === 'string' ? f.name : null;
    if (!name || name === 'name') continue;
    const dataType = String(f.dataType ?? '').toUpperCase();
    const options = Array.isArray(f.options) && f.options.length
      ? f.options.map((o: any) => ({ value: String(o.value ?? o.id ?? ''), label: String(o.label ?? o.value ?? '') })).filter((o: { value: string }) => o.value !== '')
      : undefined;
    const lookupModule = typeof f.lookupModule?.name === 'string' ? f.lookupModule.name : undefined;

    let kind: FilterFieldKind | null = null;
    if (options?.length) kind = 'options';
    else if (LOOKUP_TYPES.has(dataType) && lookupModule && !f.isSpecialType) kind = 'lookup';
    else if (TEXT_TYPES.has(dataType)) kind = 'text';
    if (!kind) continue;

    const operators: FilterOperatorDef[] = (Array.isArray(f.operators) ? f.operators : [])
      // A "special" operator (a lookup's sub-criteria, say) needs an editor this panel doesn't have.
      .filter((o: any) => typeof o?.operatorId === 'number' && !o.specialOperator && !o.isSpecialOperator)
      .map((o: any) => ({
        operatorId: o.operatorId,
        label: String(o.displayName ?? o.operator ?? o.operatorId),
        valueNeeded: o.valueNeeded !== false,
      }));
    if (!operators.length) continue;

    out.push({ name, label: String(f.displayName ?? name), kind, operators, options, lookupModule });
  }
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.label.localeCompare(b.label));
}

function rank(name: string): number {
  const i = PINNED.indexOf(name);
  return i < 0 ? PINNED.length : i;
}

/** A ticked field with nothing to filter by yet (no text, no value picked) is not sent. */
export function isComplete(f: AppliedFilter, def: FilterFieldDef | undefined): boolean {
  if (!def) return false;
  const op = def.operators.find((o) => o.operatorId === f.operatorId);
  if (!op) return false;
  if (!op.valueNeeded) return true;
  return f.values.some((v) => v.trim() !== '');
}

export function completeFilters(applied: AppliedFilter[], fields: FilterFieldDef[]): AppliedFilter[] {
  return applied.filter((f) => isComplete(f, fields.find((d) => d.name === f.field)));
}

/**
 * Contains, on name OR email OR HRMS ID, in ONE clause. V3 ANDs the top-level keys of `filters`,
 * so the other fields hang off `name` as `orFilters` and the backend ORs them into the same group
 * (FilterUtil.setConditions). Operator 5 is StringOperators.CONTAINS.
 */
export function searchClause(query: string): Record<string, unknown> | null {
  const q = query.trim();
  if (!q) return null;
  const clause = { operatorId: 5, value: [q] };
  return {
    name: { ...clause, orFilters: [{ field: 'email', ...clause }, { field: 'hrmsEmployeeId', ...clause }] },
  };
}

/**
 * The whole `filters` payload: the search clause plus one top-level key per ticked field. Top-level
 * keys AND together (search AND department AND …); several values on one field OR together.
 */
export function buildEmployeeFilters(query: string, applied: AppliedFilter[], fields: FilterFieldDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(searchClause(query) ?? {}) };
  for (const f of completeFilters(applied, fields)) {
    if (f.field === 'name') continue; // owned by the search; see mapFilterFields
    const def = fields.find((d) => d.name === f.field)!;
    const op = def.operators.find((o) => o.operatorId === f.operatorId)!;
    const values = def.kind === 'text' ? [f.values[0].trim()] : f.values.filter((v) => v.trim() !== '');
    out[f.field] = op.valueNeeded ? { operatorId: f.operatorId, value: values } : { operatorId: f.operatorId };
  }
  return out;
}

/**
 * The demo tier's stand-in for the org: the fields its roster actually carries. Operator ids are
 * the real ones (StringOperators 5 contains / 3 is, PickListOperators 36 is / 37 isn't), so the
 * payload shown for the demo is the one an org would receive.
 */
export const DEMO_FILTER_FIELDS: FilterFieldDef[] = [
  { name: 'department', label: 'Department', kind: 'lookup', lookupModule: 'department', operators: [{ operatorId: 36, label: 'is', valueNeeded: true }, { operatorId: 37, label: "isn't", valueNeeded: true }] },
  { name: 'hrmsEmployeeId', label: 'HRMS Employee ID', kind: 'text', operators: [{ operatorId: 5, label: 'contains', valueNeeded: true }, { operatorId: 3, label: 'is', valueNeeded: true }] },
  { name: 'email', label: 'Email', kind: 'text', operators: [{ operatorId: 5, label: 'contains', valueNeeded: true }, { operatorId: 3, label: 'is', valueNeeded: true }] },
];

/**
 * Filters applied in the browser — the demo tier only, where there is no org to ask. Department
 * values there are department NAMES (the demo roster has no department records to point at).
 */
export function matchesLocally(e: Employee, applied: AppliedFilter[], fields: FilterFieldDef[]): boolean {
  for (const f of completeFilters(applied, fields)) {
    const own = (f.field === 'department' ? e.department : f.field === 'email' ? e.email : f.field === 'hrmsEmployeeId' ? e.hrmsEmployeeId : undefined) ?? '';
    const values = f.values.map((v) => v.trim().toLowerCase()).filter(Boolean);
    const v = own.toLowerCase();
    let hit: boolean;
    switch (f.operatorId) {
      case 5: hit = values.some((x) => v.includes(x)); break; // contains
      case 3: case 36: hit = values.includes(v); break; // is
      case 37: hit = !values.includes(v); break; // isn't
      default: hit = true;
    }
    if (!hit) return false;
  }
  return true;
}
