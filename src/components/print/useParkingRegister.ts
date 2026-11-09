import { useMemo } from 'react';
import type { AppState } from '../../state/types';
import { contactById, contactName, floorMeta, unitPlanLabel, visibleUnits } from '../../state/selectors';
import { unitOnPlan } from '../../lib/types';
import type { Unit } from '../../lib/types';
import type { RegisterContext } from '../../lib/parkingRegister';
import { parkingFieldTitle, useParkingFields } from '../../hooks/useParkingFields';

/**
 * What the print sheet counts and draws: the plan's own units with a position, less amenities —
 * exactly what the canvas draws, so paper and screen cannot disagree about what is on the floor.
 */
export function printableUnits(state: AppState): Unit[] {
  return visibleUnits(state).filter(
    (u) => u.type !== 'amenity' && !u.unplaced && unitOnPlan(u, state.planId) && (u.geom.kind === 'point' || u.geom.pts.length > 0),
  );
}

/**
 * Everything the parking register needs about this floor: its stalls on the plan, how to read each
 * one (the plan's label, the holder, picklist labels, the location), and the field the plan labels
 * stalls with when it is not the name. Shared by the print sheet and its Details window, so the
 * counts the window shows are the rows the pages print.
 */
export function useParkingRegister(state: AppState): { stalls: Unit[]; ctx: RegisterContext; labelField: { name: string; label: string } | null } {
  const fields = useParkingFields(state.units);
  return useMemo(() => {
    const stalls = printableUnits(state).filter((u) => u.type === 'parking');
    const field = state.parkingLabel.field;
    const labelField = field && field !== 'name' ? { name: field, label: parkingFieldTitle(field, fields.text) } : null;
    const meta = floorMeta(state, state.floorId);
    const ctx: RegisterContext = {
      planLabel: (u) => unitPlanLabel(state, u),
      labelField: labelField?.name ?? null,
      // The stall record's `employee` (state.assignments), resolved against the org's roster; a
      // holder the roster has not caught up with still prints by name.
      holderOf: (u) => {
        const id = state.assignments[u.id];
        return id ? (contactById(state, id) ?? { id, name: contactName(state, id) || `Employee ${id}` }) : null;
      },
      personById: (id) => contactById(state, id),
      location: meta ? [meta.site.name, meta.building.name, meta.floor.name].filter(Boolean).join(' / ') : '',
      options: fields.options,
    };
    return { stalls, ctx, labelField };
  }, [state, fields]);
}
