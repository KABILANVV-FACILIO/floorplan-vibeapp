import type { AppState } from '../state/types';
import type { PointGeom, ResponderRoleDef, Unit } from './types';
import { responderRolesFor, rolesText } from './firstResponders';
import { markerStyle, unitStatus } from './unitStatus';
import type { MarkerStyle } from './unitStatus';
import { contactName, markerSubTexts, myPinText, unitDepartment, unitPlanLabel } from '../state/selectors';

/**
 * Everything a marker on the plan needs in order to draw itself, read from the app state ONCE —
 * by the canvas, for every marker, when the data changes — rather than by each marker on every
 * render.
 *
 * A marker used to subscribe to the whole app state and work all of this out itself. Panning
 * changes the state (its view), so every pan frame re-rendered every marker, and each one ran a
 * handful of lookups against the roster and the unit list: on a 400-desk floor that was 40–60ms
 * of work per mouse movement. Built here, a model only changes when what it shows changes, and a
 * pan re-renders no marker at all (the marker scales itself from the plane's `--inv` variable).
 */
export interface MarkerModel {
  unit: Unit;
  geom: PointGeom;
  style: MarkerStyle;
  /** What the card names it — see unitPlanLabel. */
  label: string;
  /** The chip's hover text — name, room, status, department: everything the labels may cut. */
  title: string;
  /** Who holds it (Assignment view), as the label shows it — see markerSubTexts. */
  holder: string | null;
  dept: string | null;
  /** The user's own desk or stall: draws the pill. */
  isMine: boolean;
  /** What the pill says — "Your desk" or "Your parking" (see myPinText). */
  pinText: string | null;
  isHighlighted: boolean;
  /** Outside the department the plan is filtered to: drawn faint, still clickable. */
  isDimmed: boolean;
  /** An org write is in flight for this record. */
  isBusy: boolean;
  /** Edit mode, Select tool: the chip can be dragged to reposition it. */
  draggable: boolean;
  /** The occupant is a first aider, a floor warden, or both — the chip carries their badge. */
  responderRoles: ResponderRoleDef[];
}

export function markerModel(state: AppState, unit: Unit, opts: { personal?: boolean; /** The department filter (activeDepartment). */ department?: string | null } = {}): MarkerModel {
  const style = markerStyle(state, unit);
  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const { holder, dept } = markerSubTexts(state, unit);
  // The status already names the holder in Assign view ("Assigned · Amrithya"), so only the
  // department is added — appending the whole holder line repeated the name.
  const responderRoles = responderRolesFor(state, unit);
  // The badge says it in a glyph; the tooltip (and a screen reader, which reads it as the chip's
  // name) says it in words.
  const roleText = rolesText(responderRoles);
  const label = unitPlanLabel(state, unit);
  // `personal: false` (the print sheet): no pill on paper — a sheet on a wall is read by everyone,
  // and the pill would stand where the desk's name belongs.
  const pinText = opts.personal !== false ? myPinText(state, unit) : null;
  // A stall labelled by another field keeps its record name in the tooltip: the card no longer says it.
  const named = label === unit.label ? label : `${label} (${unit.label})`;
  const title = `${named}${unit.room ? ' · ' + unit.room : ''} — ${status.text}${holder && dept ? ` · ${dept}` : ''}${roleText ? ` · ${roleText}` : ''}`;
  return {
    unit,
    geom: unit.geom as PointGeom,
    style,
    label,
    title,
    holder,
    dept,
    isMine: !!pinText,
    pinText,
    isHighlighted: state.highlightUnitId === unit.id,
    // Landmarks (stairs, extinguishers) belong to no department and stay as they are.
    isDimmed: !!opts.department && unit.type !== 'amenity' && unitDepartment(state, unit) !== opts.department,
    isBusy: state.busyUnitId === unit.id,
    draggable: state.mode === 'edit' && state.tool === 'select',
    responderRoles,
  };
}
