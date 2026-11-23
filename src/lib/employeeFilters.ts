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
  /**
   * The names of the picked records (lookups), so a reopened panel says "Omar Al Marri" rather than
   * an id. Display only — never sent.
   */
  labels?: Record<string, string>;
}

const TEXT_TYPES = new Set(['STRING', 'BIG_STRING', 'LARGE_TEXT', 'EMAIL', 'PHONE', 'URL_FIELD']);
const LOOKUP_TYPES = new Set(['LOOKUP', 'MULTI_LOOKUP']);

const op = (operatorId: number, label: string, valueNeeded = true): FilterOperatorDef => ({ operatorId, label, valueNeeded });

/**
 * The operators each data type answers to, as the org lists them (`criteria-operators`, read from
 * ENEC CAFM on 2026-11-08), default first. The fields list does NOT carry these: a field's own
 * `operators` are only its extras — Line Manager lists just "Logged In User", and Department,
 * Designation and HRMS Employee ID list none. Reading only the field's own list dropped those
 * three from the panel and left Line Manager with no way to pick a manager.
 *
 * A curated subset: "My Teams" and "associated" need editors this panel does not have.
 */
const TYPE_OPERATORS: Record<string, FilterOperatorDef[]> = {
  STRING: [op(5, 'contains'), op(3, 'is'), op(4, "isn't"), op(7, 'starts with'), op(1, 'is empty', false), op(2, 'is not empty', false)],
  LOOKUP: [op(36, 'is'), op(37, "isn't"), op(1, 'is empty', false), op(2, 'is not empty', false)],
  MULTI_LOOKUP: [op(90, 'contains'), op(91, "doesn't contain"), op(104, 'is empty', false), op(105, 'is not empty', false)],
  BOOLEAN: [op(15, 'is')],
  ENUM: [op(54, 'is'), op(55, "isn't"), op(1, 'is empty', false), op(2, 'is not empty', false)],
  SYSTEM_ENUM: [op(54, 'is'), op(55, "isn't"), op(1, 'is empty', false), op(2, 'is not empty', false)],
};
for (const t of TEXT_TYPES) TYPE_OPERATORS[t] ??= TYPE_OPERATORS.STRING;

/** Operators that need an editor this panel has no form of (a space tree, a team picker, a relation). */
const UNSUPPORTED_OPERATORS = new Set([38, 142, 144, 145]);

/**
 * Lookups whose records cannot be listed to pick from — the user directory, addresses, the space
 * tree, workflow states — and the employee module's field-service and system fields, which say
 * nothing about where anyone sits. The org's custom fields are never hidden.
 */
const UNLISTABLE_LOOKUPS = new Set(['users', 'location', 'basespace', 'space', 'ticketstatus']);
const HIDDEN_FIELDS = new Set([
  'avatarColor', 'currentLocation', 'trackGeoLocation', 'checkedIn', 'dispatchable', 'labour', 'isLabour', 'peopleType',
  'language', 'timezone', 'territories', 'startLocation', 'endLocation', 'sysCreatedBy', 'sysModifiedBy', 'locatedSpace',
  'address', 'moduleState', 'approvalStatus',
]);

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
  const seen = new Set<string>();
  for (const f of raw as any[]) {
    const name = typeof f?.name === 'string' ? f.name : null;
    if (!name || name === 'name' || HIDDEN_FIELDS.has(name) || seen.has(name)) continue;
    const dataType = String(f.dataType ?? '').toUpperCase();
    const options = Array.isArray(f.options) && f.options.length
      ? f.options.map((o: any) => ({ value: String(o.value ?? o.id ?? ''), label: String(o.label ?? o.value ?? '') })).filter((o: { value: string }) => o.value !== '')
      : undefined;
    const lookupModule =
      typeof f.lookupModule?.name === 'string' ? f.lookupModule.name : typeof f.lookupModule === 'string' ? f.lookupModule : typeof f.lookupModuleName === 'string' ? f.lookupModuleName : undefined;

    let kind: FilterFieldKind | null = null;
    if (options?.length) kind = 'options';
    else if (LOOKUP_TYPES.has(dataType) && lookupModule && !f.isSpecialType && !UNLISTABLE_LOOKUPS.has(lookupModule)) kind = 'lookup';
    else if (TEXT_TYPES.has(dataType)) kind = 'text';
    if (!kind) continue;

    // The type's own operators first, then whatever the field adds (Line Manager's "Logged In
    // User"), each id once. An org whose field list does carry the full set loses nothing.
    const byId = new Map<number, FilterOperatorDef>();
    for (const o of TYPE_OPERATORS[dataType] ?? (kind === 'options' ? TYPE_OPERATORS.ENUM : [])) byId.set(o.operatorId, o);
    for (const o of Array.isArray(f.operators) ? f.operators : []) {
      // A "special" operator (a lookup's sub-criteria, say) needs an editor this panel doesn't have.
      if (typeof o?.operatorId !== 'number' || o.specialOperator || o.isSpecialOperator || UNSUPPORTED_OPERATORS.has(o.operatorId)) continue;
      if (!byId.has(o.operatorId)) byId.set(o.operatorId, op(o.operatorId, String(o.displayName ?? o.operator ?? o.operatorId), o.valueNeeded !== false));
    }
    const operators = [...byId.values()];
    if (!operators.length) continue;

    seen.add(name);
    out.push({ name, label: String(f.displayName ?? name), kind, operators, options, lookupModule });
  }
  const idField = employeeIdField(out);
  const rank = (f: FilterFieldDef) => {
    if (f.name === 'department' || (f.kind === 'lookup' && f.lookupModule === 'department')) return 0;
    if (isLineManager(f)) return 1;
    if (f.name === 'designation') return 2;
    if (f.name === idField) return 3;
    if (f.kind === 'lookup' && f.lookupModule === 'site') return 4;
    if (f.kind === 'lookup' && f.lookupModule === 'desks') return 5;
    return 6;
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The org's line-manager lookup, by what it is called — its API name is the org's own. */
export function isLineManager(f: FilterFieldDef): boolean {
  return f.kind === 'lookup' && /line\s*manager|reporting\s*(to|manager)/i.test(f.label);
}

/**
 * The org's HRMS Employee ID field. A custom field, so its API name is the org's own: ENEC's is
 * `hrms_employee_id_employee`, and asking for any other name fails the whole request ("Field
 * 'hrmsEmployeeId' does not exist"). Found by its label; "Line Manager HRMS Id" is someone else's.
 */
export function employeeIdField(fields: FilterFieldDef[]): string | null {
  const text = fields.filter((f) => f.kind === 'text' && !/manager/i.test(f.label) && !/manager/i.test(f.name));
  const hit =
    text.find((f) => /hrms/i.test(f.label) && /(employee|emp)\s*(id|no|number)/i.test(f.label)) ??
    text.find((f) => /^hrms_?(employee|emp)_?id/i.test(f.name));
  return hit?.name ?? null;
}

/**
 * Where a lookup's choices are searched. A people lookup (Line Manager) points at `people`, which
 * also holds every tenant and vendor contact; the people it names are employees (ENEC's managers
 * are employee records, same id), so it is searched in `employee`.
 */
export function lookupSearchModule(f: FilterFieldDef): string | undefined {
  return f.lookupModule === 'people' ? 'employee' : f.lookupModule;
}

/** Too many records to tick from a first page: the choices come from searching the org. */
export function searchFirst(f: FilterFieldDef): boolean {
  return f.lookupModule === 'people' || f.lookupModule === 'employee';
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
 *
 * The HRMS field goes in only under the org's own name (`employeeIdField`); unknown, the search
 * is name OR email, both standard fields — an unknown field fails the whole request.
 */
export function searchClause(query: string, idField?: string | null): Record<string, unknown> | null {
  const q = query.trim();
  if (!q) return null;
  const clause = { operatorId: 5, value: [q] };
  const orFilters: Record<string, unknown>[] = [{ field: 'email', ...clause }];
  if (idField) orFilters.push({ field: idField, ...clause });
  return { name: { ...clause, orFilters } };
}

/**
 * The whole `filters` payload: the search clause plus one top-level key per ticked field. Top-level
 * keys AND together (search AND department AND …); several values on one field OR together.
 */
export function buildEmployeeFilters(query: string, applied: AppliedFilter[], fields: FilterFieldDef[], idField: string | null = employeeIdField(fields)): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(searchClause(query, idField) ?? {}) };
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
