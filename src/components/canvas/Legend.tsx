import { useFloorplan } from '../../state/FloorplanContext';
import { moduleColor } from '../../lib/unitStatus';
import { AMENITY_META, isRoomLike, TYPE_META } from '../../lib/types';
import { enabledTypes } from '../../state/selectors';
import { departmentColor, departmentsIn } from '../../lib/departmentColors';
import type { AmenityIcon } from '../../lib/types';
import type { AppState } from '../../state/types';

/**
 * What the marker colours on the plan MEAN right now — shared with the print sheet, so the key on
 * paper describes the markers on paper. A printed "Occupied / Available" beside markers drawn in
 * Free/Assigned, department or booking colours would be a key to a different drawing.
 */
export function legendItems(state: AppState): { label: string; color: string }[] {
  let items: { label: string; color: string }[];
  if (state.mode === 'edit') {
    // Derived from the enabled modules rather than a fixed list, so the legend never advertises
    // a module the plan can't show.
    items = enabledTypes(state, ['workstation', 'locker', 'parking', 'room', 'delivery']).map((t) => ({
      label: TYPE_META[t].name,
      color: isRoomLike(t) ? 'rgba(60,34,157,0.62)' : moduleColor(state, t, 'free'),
    }));
  } else if (state.mode === 'assign' && state.colorBy === 'department') {
    // The legend has to name what the colours MEAN, and in this mode they mean departments — a
    // "Free / Assigned" key beside department-coloured desks would be a straight lie.
    const present = departmentsIn(state.units);
    const ids = present.map((d) => d.id);
    items = present.map((d) => ({ label: d.name, color: departmentColor(d.id, state.departmentColors, ids) }));
    // Desks with no department on their record keep the state colours, so the key says so.
    if (state.units.some((u) => u.type === 'workstation' && !u.department)) {
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

  return items;
}

export function Legend() {
  const { state } = useFloorplan();
  const items = legendItems(state);

  return (
    <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: '70%' }}>
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
          <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
