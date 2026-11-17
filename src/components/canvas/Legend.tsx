import { useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { moduleColor } from '../../lib/unitStatus';
import { AMENITY_META, isRoomLike, TYPE_META } from '../../lib/types';
import { activeDepartments, colorByOf, enabledTypes } from '../../state/selectors';
import { departmentColor, departmentsIn } from '../../lib/departmentColors';
import { departmentDisplayName } from '../../lib/displayNames';
import type { AmenityIcon, ResponderRoleDef } from '../../lib/types';
import type { AppState } from '../../state/types';
import { respondersOnFloor, rolesOnFloor } from '../../lib/firstResponders';
import { ResponderGlyph } from './ResponderBadge';
import { FloorResponders } from './FloorResponders';

/** The ticked departments by name, all of them — for paper, where "3 departments" would say too little. */
export function departmentNames(departments: string[]): string {
  return departments.map((d) => departmentDisplayName(d) || d).join(', ');
}

/** How the ticked departments are named on the plan's chips: one by name, two by both, more by how many. */
export function departmentsLabel(departments: string[]): string {
  const named = departments.map((d) => departmentDisplayName(d) || d);
  return named.length === 1 ? `Department: ${named[0]}` : named.length === 2 ? `Departments: ${named.join(', ')}` : `${named.length} departments`;
}

/** One key entry: a colour swatch, or — for a first responder — the badge the plan draws. */
export interface LegendItem {
  label: string;
  color: string;
  glyph?: ResponderRoleDef;
}

/** The swatch beside a legend entry: the badge itself for a responder, a colour square otherwise. */
export function LegendSwatch({ item, size = 8 }: { item: LegendItem; size?: number }) {
  if (item.glyph) return <ResponderGlyph role={item.glyph} size={size + 4} />;
  return <span style={{ width: size, height: size, borderRadius: 2, background: item.color, flexShrink: 0 }} />;
}

/**
 * What the marker colours on the plan MEAN right now — shared with the print sheet, so the key on
 * paper describes the markers on paper. A printed "Occupied / Available" beside markers drawn in
 * Free/Assigned, department or booking colours would be a key to a different drawing.
 */
export function legendItems(state: AppState): LegendItem[] {
  let items: LegendItem[];
  if (state.mode === 'edit') {
    // Derived from the enabled modules rather than a fixed list, so the legend never advertises
    // a module the plan can't show.
    items = enabledTypes(state, ['workstation', 'locker', 'parking', 'room', 'delivery']).map((t) => ({
      label: TYPE_META[t].name,
      color: isRoomLike(t) ? 'rgba(60,34,157,0.62)' : moduleColor(state, t, 'free'),
    }));
  } else if (state.mode === 'assign' && colorByOf(state) === 'department') {
    // The legend has to name what the colours MEAN, and in this mode they mean departments — a
    // "Free / Assigned" key beside department-coloured desks would be a straight lie.
    const present = departmentsIn(state.units);
    const ids = present.map((d) => d.id);
    // With departments ticked the rest are faded, so the key names the ticked ones only.
    const ticked = activeDepartments(state);
    items = present
      .filter((d) => !ticked.length || ticked.includes(d.name))
      .map((d) => ({ label: departmentDisplayName(d.name), color: departmentColor(d.id, state.departmentColors, ids) }));
    // Desks with no department on their record keep the state colours, so the key says so.
    if (!ticked.length && state.units.some((u) => u.type === 'workstation' && !u.department)) {
      items.push({ label: 'No department', color: moduleColor(state, 'workstation', 'free') });
    }
  } else if (state.mode === 'assign') {
    items = [
      { label: 'Free', color: moduleColor(state, 'workstation', 'free') },
      { label: 'Assigned', color: moduleColor(state, 'workstation', 'assigned') },
    ];
  } else {
    items = [
      { label: 'Available', color: moduleColor(state, 'room', 'available') },
      { label: 'Booked', color: moduleColor(state, 'room', 'booked') },
      { label: 'Not bookable', color: 'var(--ink-400)' },
    ];
  }

  // Add a color tag for each amenity type actually placed on this floor
  // (stairs, elevators, restrooms, …) so their marker colors are legible.
  const presentAmenities = Array.from(
    new Set(state.units.filter((u) => u.type === 'amenity' && u.icon).map((u) => u.icon as AmenityIcon)),
  );
  for (const icon of presentAmenities) {
    items.push({ label: AMENITY_META[icon].name, color: AMENITY_META[icon].color });
  }

  // The responder badges, in every mode, but only for a role someone on this floor holds — a key
  // to a badge the plan doesn't draw would send people looking for it.
  for (const role of rolesOnFloor(respondersOnFloor(state), state.responderRoles)) {
    items.push({ label: role.name, color: role.color, glyph: role });
  }

  return items;
}

/** How many key entries the plan shows before "+N more" — a floor of fifteen departments ran across the screen. */
const LEGEND_SHOWN = 6;

export function Legend() {
  const { state, actions } = useFloorplanData();
  const [allItems, setAllItems] = useState(false);
  const every = legendItems(state);
  // One more than the cap shows whole: "+1 more" would take the room the entry needs.
  const items = allItems || every.length <= LEGEND_SHOWN + 1 ? every : every.slice(0, LEGEND_SHOWN);
  // The department filter dims the rest of the plan; this says why, and undoes it in one click.
  const departments = activeDepartments(state);

  return (
    // Kept to the left of the bottom navigation, which sits centred over the same edge: wider, a wrapped
    // key ran behind it.
    <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', maxWidth: 'max(220px, calc(50% - 250px))' }}>
      {departments.length > 0 && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            padding: '0 4px 0 10px',
            background: 'var(--blue-025)',
            border: '1px solid var(--blue-100)',
            borderRadius: 999,
            font: '500 11px/1 var(--font-sans)',
            color: 'var(--blue-600)',
            boxShadow: 'var(--shadow-xs)',
          }}
        >
          {departmentsLabel(departments)}
          <button
            type="button"
            aria-label="Show all departments"
            data-tip="Show all departments"
            onClick={() => actions.setSpaceDepartments([])}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, border: 'none', borderRadius: 999, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0 }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </span>
      )}
      <FloorResponders />
      {items.map((it) => (
        <span
          key={it.label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            padding: '0 10px',
            background: '#fff',
            border: '1px solid var(--ink-200)',
            borderRadius: 999,
            font: '500 11px/1 var(--font-sans)',
            color: 'var(--ink-700)',
            boxShadow: 'var(--shadow-xs)',
          }}
        >
          <LegendSwatch item={it} />
          {it.label}
        </span>
      ))}
      {every.length > LEGEND_SHOWN + 1 && (
        <button
          type="button"
          aria-expanded={allItems}
          onClick={() => setAllItems((v) => !v)}
          style={{ height: 24, padding: '0 10px', background: '#fff', border: '1px solid var(--ink-200)', borderRadius: 999, font: '500 11px/1 var(--font-sans)', color: 'var(--blue-600)', boxShadow: 'var(--shadow-xs)', cursor: 'pointer' }}
        >
          {allItems ? 'Show less' : `+${every.length - LEGEND_SHOWN} more`}
        </button>
      )}
    </div>
  );
}
