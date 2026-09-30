import type { MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { clipPathFor } from '../../lib/geometry';
import { IMG_H, IMG_W } from '../../lib/mockData';
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
  const { state, actions } = useFloorplanData();
  const geom = unit.geom as PolyGeom;
  const selected = state.selected === unit.id;
  // An armed "Available to place" desk, locker or stall places where the plan is clicked — inside a
  // room too (a desk in a private office). While one is armed a room is not a target at all: its
  // click and mousedown fall through to the canvas, which places the record.
  const placing = state.mode === 'edit' && !!state.placingUnitId;
  const movable = state.mode === 'edit' && state.tool === 'select' && !placing;

  /*
   * A room is always SEEN — a tint inside its outline and a line around it — in every mode. The
   * colour says what the room means in that mode; a room that means nothing there (an org room,
   * while booking and assigning rooms aren't wired to Facilio; a bookable room in Assign mode) is
   * neutral grey-blue, never the green that reads "free". The line is what keeps a room visible
   * on a CAD plan: the drawing already fills its rooms light grey, and a faint tint alone vanished
   * into it — a marked room looked unmarked outside Edit mode.
   */
  let fill: string;
  let stroke: string;
  if (state.mode === 'edit') {
    fill = selected ? 'rgba(60,34,157,0.22)' : 'rgba(60,34,157,0.10)';
    stroke = selected ? 'rgba(60,34,157,0.9)' : 'rgba(60,34,157,0.6)';
  } else if (state.mode === 'assign' && isAssignable(unit)) {
    const assigned = !!state.assignments[unit.id];
    const c = moduleColor(state, unit.type, assigned ? 'assigned' : 'free');
    fill = `color-mix(in srgb, ${c} ${selected ? 26 : 14}%, transparent)`;
    stroke = `color-mix(in srgb, ${c} ${selected ? 90 : 65}%, transparent)`;
  } else if (state.mode === 'book' && isBookable(unit)) {
    const booked = conflictsFor(state.bookings, unit.id, state.date, state.start, state.end).length > 0;
    const base = booked ? '182,25,25' : '41,160,30';
    fill = `rgba(${base},${selected ? 0.26 : 0.14})`;
    stroke = `rgba(${base},${selected ? 0.9 : 0.65})`;
  } else {
    fill = selected ? 'rgba(96,119,150,0.22)' : 'rgba(96,119,150,0.12)';
    stroke = selected ? 'rgba(96,119,150,0.9)' : 'rgba(96,119,150,0.6)';
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
    <>
      <div
        data-room-id={unit.id}
        onClick={onClick}
        onMouseDown={movable && onEditDown ? (e) => onEditDown(unit, e) : undefined}
        style={{ position: 'absolute', inset: 0, clipPath: clipPathFor(geom), background: fill, cursor: placing ? 'crosshair' : movable && selected ? 'move' : 'pointer' }}
      />
      {/* The outline. A clipped div can't draw a border along its polygon, so the line is an SVG
          over it; `--inv` (set by every plane that draws rooms) keeps it one line wide at any zoom. */}
      <svg
        viewBox={`0 0 ${IMG_W} ${IMG_H}`}
        preserveAspectRatio="none"
        aria-hidden
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
      >
        <polygon
          points={geom.pts.map(([x, y]) => `${x * IMG_W},${y * IMG_H}`).join(' ')}
          fill="none"
          stroke={stroke}
          style={{ strokeWidth: `calc(${selected ? 2 : 1.25}px * var(--inv, 1))` }}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}
