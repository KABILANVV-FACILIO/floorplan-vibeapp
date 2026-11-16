import { useMemo } from 'react';
import type { AppState } from '../../state/types';
import { activeDepartments, contactById, contactName, floorMeta, unitDepartment, unitPlanLabel, visibleUnits } from '../../state/selectors';
import { labelledType, unitOnPlan } from '../../lib/types';
import type { Booking, RegisterKind, Unit } from '../../lib/types';
import { registerKindsFor } from '../../lib/register';
import type { RegisterContext } from '../../lib/register';
import { fieldTitle, useRecordFields } from '../../hooks/useRecordFields';

/**
 * What the print sheet counts and draws: the plan's own units with a position, less amenities —
 * exactly what the canvas draws, so paper and screen cannot disagree about what is on the floor.
 */
export function printableUnits(state: AppState): Unit[] {
  return visibleUnits(state).filter(
    (u) => u.type !== 'amenity' && !u.unplaced && unitOnPlan(u, state.planId) && (u.geom.kind === 'point' || u.geom.pts.length > 0),
  );
}

export interface RegisterData {
  kind: RegisterKind;
  /** The spaces of this kind on the plan — the register's rows before its own filter. */
  units: Unit[];
  ctx: RegisterContext;
  /** The field the plan labels this kind with, when it is not the name. */
  labelField: { name: string; label: string } | null;
}

/**
 * Everything one register needs about this floor: the spaces of its kind on the plan, how to read
 * each (the plan's label, the holder — or for a room its booking in the window printed — picklist
 * labels, the location), and the field the plan labels them with when it is not the name. Shared
 * by the print sheet and its Details window, so the counts the window shows are the rows the pages
 * print.
 *
 * With departments ticked on screen (activeDepartments), a register of desks, stalls or lockers
 * lists theirs only — a space's department being its own, else its holder's, as the plan's filter
 * has it. Rooms belong to no department and are listed whole.
 *
 * The kind's field list (picklist labels, the label field's name) is read only when the plan
 * printed carries this register: the print sheet is always mounted, for every kind.
 */
export function useRegister(state: AppState, kind: RegisterKind): RegisterData {
  const labelKind = labelledType(kind);
  const onPlan = registerKindsFor(state.planId).includes(kind);
  const fields = useRecordFields(labelKind ?? 'workstation', state.units, onPlan && !!labelKind);
  const { units, planId, enabledModules, planLabels, assignments, employees, portfolio, floorId, spaceDepartments, bookings, date, start, end } = state;
  return useMemo(() => {
    const departments = kind === 'room' ? [] : activeDepartments(state);
    const rows = printableUnits(state).filter((u) => u.type === kind && (!departments.length || departments.includes(unitDepartment(state, u) ?? '')));
    const field = labelKind ? state.planLabels[labelKind].field : 'name';
    const labelField = field && field !== 'name' ? { name: field, label: fieldTitle(field, fields.text) } : null;
    const meta = floorMeta(state, state.floorId);
    // A room's booking in the window printed — the date and hours picked in the toolbar.
    const bookingOf = (u: Unit): Booking | null => state.bookings.find((b) => b.unitId === u.id && b.date === state.date && b.start < state.end && b.end > state.start) ?? null;
    const ctx: RegisterContext = {
      kind,
      planLabel: (u) => unitPlanLabel(state, u),
      labelField: labelField?.name ?? null,
      // The record's `employee` (state.assignments), resolved against the org's roster; a holder
      // the roster has not caught up with still prints by name.
      holderOf: (u) => {
        const id = state.assignments[u.id];
        return id ? (contactById(state, id) ?? { id, name: contactName(state, id) || `Employee ${id}` }) : null;
      },
      personById: (id) => contactById(state, id),
      bookingOf,
      location: meta ? [meta.site.name, meta.building.name, meta.floor.name].filter(Boolean).join(' / ') : '',
      options: fields.options,
    };
    return { kind, units: rows, ctx, labelField };
    // Rebuilt only when what it reads changes — every one of these, and nothing else of `state`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, units, planId, enabledModules, planLabels, assignments, employees, portfolio, floorId, spaceDepartments, bookings, date, start, end, fields]);
}
