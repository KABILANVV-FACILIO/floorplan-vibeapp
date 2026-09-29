import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { clipPathFor } from '../../lib/geometry';
import { conflictsFor, isAssignable, isBookable } from '../../state/selectors';
import { moduleColor } from '../../lib/unitStatus';
import type { PolyGeom, Unit } from '../../lib/types';

export function RoomPolygon({
  unit,
  onEditDown,
  clickSuppressed,
}: {
  unit: Unit;
  onEditDown?: (unit: Unit, e: ReactMouseEvent) => void;
  /** True while the click ending a gesture (a pan or drag that started inside this room) is to be ignored. */
  clickSuppressed?: () => boolean;
}) {
  const { state, actions } = useFloorplan();
  const geom = unit.geom as PolyGeom;
  const selected = state.selected === unit.id;
  // An armed "Available to place" desk, locker or stall places where the plan is clicked — inside a
  // room too (a desk in a private office). While one is armed a room is not a target at all: its
  // click and mousedown fall through to the canvas, which places the record.
  const placing = state.mode === 'edit' && !!state.placingUnitId;
  const movable = state.mode === 'edit' && state.tool === 'select' && !placing;

  let fill: string;
  if (state.mode === 'edit') {
    fill = selected ? 'rgba(60,34,157,0.22)' : 'rgba(60,34,157,0.10)';
  } else if (state.mode === 'assign') {
    if (!isAssignable(unit)) {
      // Bookable room, viewed in Assign mode — solid neutral, matches Marker's not-assignable fill.
      fill = 'rgba(96,119,150,0.07)';
    } else {
      const assigned = !!state.assignments[unit.id];
      const c = moduleColor(state, unit.type, assigned ? 'assigned' : 'free');
      fill = `color-mix(in srgb, ${c} ${selected ? 26 : 14}%, transparent)`;
    }
  } else if (!isBookable(unit)) {
    // A room that can't be booked here (an org room, while room booking isn't wired to Facilio; a
    // not-reservable one) — the same neutral fill as a not-assignable room in Assign mode, never
    // the green that reads "free to book".
    fill = 'rgba(96,119,150,0.07)';
  } else {
    const booked = conflictsFor(state.bookings, unit.id, state.date, state.start, state.end).length > 0;
    const base = booked ? '182,25,25' : '41,160,30';
    const alpha = selected ? 0.26 : 0.14;
    fill = `rgba(${base},${alpha})`;
  }

  function onClick(e: ReactMouseEvent) {
    if (state.mode === 'edit' && (state.tool !== 'select' || placing)) return;
    // A press inside a room that panned the plan past the click slop (see Canvas.startRoomDrag and
    // ROOM_CLICK_SLOP) is a pan, not a click; a click that only jittered still selects the room.
    if (clickSuppressed?.()) return;
    e.stopPropagation();
    actions.selectUnit(unit.id);
  }

  return (
    <div
      data-room-id={unit.id}
      onClick={onClick}
      onMouseDown={movable && onEditDown ? (e) => onEditDown(unit, e) : undefined}
      style={{ position: 'absolute', inset: 0, clipPath: clipPathFor(geom), background: fill, cursor: placing ? 'crosshair' : movable && selected ? 'move' : 'pointer' }}
    />
  );
}
