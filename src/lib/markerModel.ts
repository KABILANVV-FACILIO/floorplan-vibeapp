import type { AppState } from '../state/types';
import type { PointGeom, Unit } from './types';
import { markerStyle, unitStatus } from './unitStatus';
import type { MarkerStyle } from './unitStatus';
import { contactName, markerSubTexts, myAssignedUnit } from '../state/selectors';

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
  /** The chip's hover text — name, room, status, department: everything the labels may cut. */
  title: string;
  /** Who holds it (Assignment view), as the label shows it — see markerSubTexts. */
  holder: string | null;
  dept: string | null;
  /** The user's own desk: draws the "Your desk" pill. */
  isMine: boolean;
  isHighlighted: boolean;
  /** An org write is in flight for this record. */
  isBusy: boolean;
  /** Edit mode, Select tool: the chip can be dragged to reposition it. */
  draggable: boolean;
}

export function markerModel(state: AppState, unit: Unit, opts: { personal?: boolean } = {}): MarkerModel {
  const style = markerStyle(state, unit);
  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const { holder, dept } = markerSubTexts(state, unit);
  // The status already names the holder in Assign view ("Assigned · Amrithya"), so only the
  // department is added — appending the whole holder line repeated the name.
  const title = `${unit.label}${unit.room ? ' · ' + unit.room : ''} — ${status.text}${holder && dept ? ` · ${dept}` : ''}`;
  return {
    unit,
    geom: unit.geom as PointGeom,
    style,
    title,
    holder,
    dept,
    // `personal: false` (the print sheet): no "Your desk" pill on paper — a sheet on a wall is
    // read by everyone, and the pill would stand where the desk's name belongs.
    isMine: opts.personal !== false && myAssignedUnit(state)?.id === unit.id,
    isHighlighted: state.highlightUnitId === unit.id,
    isBusy: state.busyUnitId === unit.id,
    draggable: state.mode === 'edit' && state.tool === 'select',
  };
}
