import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, myAssignedUnit } from '../../state/selectors';
import { markerStyle, unitStatus } from '../../lib/unitStatus';
import { isRoomLike } from '../../lib/types';
import type { PointGeom, Unit } from '../../lib/types';
import type { LabelPlacement } from '../../lib/labelLayout';
import { NAME_MAX_PX, SUB_MAX_PX } from '../../lib/labelLayout';
import { MARKER_ICONS as ICONS } from './markerIcons';
import styles from './Marker.module.css';

export function Marker({
  unit,
  invZ,
  labels,
  onDragStart,
}: {
  unit: Unit;
  invZ: number;
  /**
   * Which of this marker's labels the canvas found room for. Decided there, not here: whether a
   * label fits depends on the OTHER markers, which a single marker cannot see.
   */
  labels?: LabelPlacement;
  onDragStart?: (unit: Unit, e: ReactMouseEvent) => void;
}) {
  const { state, actions } = useFloorplan();
  const geom = unit.geom as PointGeom;
  const style = markerStyle(state, unit);
  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const draggable = state.mode === 'edit' && state.tool === 'select';
  const isMine = myAssignedUnit(state)?.id === unit.id;
  const isHighlighted = state.highlightUnitId === unit.id;
  // An org write is in flight for THIS record — shown on the record, not only on the button that
  // started it, because the transition is happening to the thing on the plan.
  const isBusy = state.busyUnitId === unit.id;

  function onClick(e: ReactMouseEvent) {
    e.stopPropagation();
    if (state.mode === 'edit' && state.tool !== 'select') return;
    actions.selectUnit(unit.id);
  }

  function onMouseDown(e: ReactMouseEvent) {
    if (draggable) onDragStart?.(unit, e);
  }

  // Edit mode: a tray-record drag of the SAME type may drop onto this marker — the dragged
  // record replaces this one's (this record moves to "Available to place"). The dragged unit's
  // type travels as an extra mime suffix because dragover can only read types, not data.
  const replaceMime = `application/x-floorplan-unit-t-${unit.type}`;
  function isReplaceDrag(e: ReactDragEvent): boolean {
    return state.mode === 'edit' && !isRoomLike(unit.type) && e.dataTransfer.types.includes(replaceMime);
  }

  function onDragOver(e: ReactDragEvent) {
    if (state.mode === 'edit') {
      if (!isReplaceDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (state.dragOverId !== unit.id) actions.dragOverUnit(unit.id);
      return;
    }
    if (state.mode !== 'assign') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (state.dragOverId !== unit.id) actions.dragOverUnit(unit.id);
  }
  function onDragLeave() {
    if (state.dragOverId === unit.id) actions.dragOverUnit(null);
  }
  function onDrop(e: ReactDragEvent) {
    if (state.mode === 'edit') {
      if (!isReplaceDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      actions.dragOverUnit(null);
      const unitId = e.dataTransfer.getData('application/x-floorplan-unit');
      if (unitId && unitId !== unit.id) actions.placeUnitOnUnit(unitId, unit.id);
      return;
    }
    if (state.mode !== 'assign') return;
    e.preventDefault();
    const contactId = state.dragContactId || e.dataTransfer.getData('text/plain');
    if (contactId) actions.assign(contactId, unit.id);
  }


  // Under-marker label. Assign view: desk name on top, assignee (if any)
  // underneath. Book view: the space name. Amenities: their name, always.
  const contactId = state.assignments[unit.id];
  // "Omar Haddad · Facilities": who holds it and which team they are on, under the desk number
  // above. The department is the thing a workplace manager is actually scanning for, and reading
  // it off a colour alone means holding a legend in your head.
  const holder = state.mode === 'assign' && contactId ? contactName(state, contactId) : null;
  const assignedName = holder ? (unit.department ? `${holder} · ${unit.department}` : holder) : null;
  // The chip's tooltip carries everything in FULL — the labels beside it are capped and may end
  // in "…", and they take no pointer events, so this is where a truncated name is readable.
  // The status already names the holder in Assign view ("Assigned · Amrithya"), so only the
  // department is added — appending the whole holder line repeated the name.
  const title = `${unit.label}${unit.room ? ' · ' + unit.room : ''} — ${status.text}${holder && unit.department ? ` · ${unit.department}` : ''}`;
  // The zoom threshold this used to carry (`invZ <= 1.9`) dropped every label past one zoom level
  // whether or not there was room for it, and kept every label before it whether or not there was.
  // Room is what actually matters, and only the canvas can judge it.
  // Common to both label boxes. `display: block` is what lets `max-width` + `text-overflow`
  // actually clip; an inline box ignores both.
  const labelBase = {
    position: 'absolute',
    left: `${geom.x * 100}%`,
    top: `${geom.y * 100}%`,
    transformOrigin: '0 0',
    pointerEvents: 'none',
    zIndex: 1,
    display: 'block',
    boxSizing: 'border-box',
    background: 'rgba(255,255,255,0.92)',
    border: '1px solid var(--ink-100)',
    padding: '2px 5px',
    borderRadius: 3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as const;
  const showName = !!labels?.name;
  const showSub = !!labels?.sub;

  return (
    <>
      {isMine && showName && (
        <div
          className={styles.myDeskBadge}
          style={{ left: `${geom.x * 100}%`, top: `${geom.y * 100}%`, transform: `scale(${invZ}) translate(-50%, calc(-100% - ${Math.round(style.size / 2 + 6)}px))`, transformOrigin: '0 0' }}
        >
          <div className={styles.myDeskPill}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            Your desk
          </div>
          <div className={styles.myDeskTail} />
        </div>
      )}
      <div
        data-tip={title}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          position: 'absolute',
          left: `${geom.x * 100}%`,
          top: `${geom.y * 100}%`,
          width: style.size,
          height: style.size,
          // Scale BEFORE translating: the plane is scaled by z, so a translate written here is in
          // PLAN px and reaches the screen multiplied by z. Inside the scale it is divided by z
          // first, so the offset is a constant number of screen px at every zoom — which is what
          // a 24px chip centred on its point, and a label a fixed gap away from it, both need.
          transform: `scale(${invZ}) translate(-50%,-50%)`,
          transformOrigin: '0 0',
          background: style.bg,
          border: `2px solid ${style.bd}`,
          color: style.fg,
          borderRadius: style.radius,
          boxShadow: style.shadow,
          opacity: style.opacity,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: draggable ? 'grab' : 'pointer',
          zIndex: style.zIndex,
        }}
      >
        {isHighlighted && <div className={styles.wave} />}
        {isBusy && <span className={styles.busy} aria-label="Working" />}
        {!isBusy && (style.img ? (
          <img src={style.img} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', pointerEvents: 'none' }} />
        ) : (
          <>
            {style.occText && <span style={{ font: '700 9px/1 var(--font-sans)' }}>{style.occText}</span>}
            {!style.occText && style.icon && ICONS[style.icon]}
          </>
        ))}
      </div>
      {/*
        The desk's name ABOVE its chip, and who holds it with their department BELOW.

        The two are separate boxes but never separate decisions: `planMarkerLabels` never draws a
        holder line without its own desk's name above it. That is what stops the old failure where
        a block of desks kept one desk's name on top and a different desk's holder underneath,
        reading as a caption for the whole group.

        Each box is capped — the name at NAME_MAX_PX, the holder at the width the layout reserved
        for it (`subWidth`, narrower than SUB_MAX_PX where that is what fitted beside a neighbour) —
        and ends in "…" when the text runs longer; the chip's tooltip has the full text.
      */}
      {showName && !isMine && (
        <div
          style={{
            ...labelBase,
            transform: `scale(${invZ}) translate(-50%, calc(-100% - ${Math.round(style.size / 2 + 4)}px))`,
            maxWidth: NAME_MAX_PX,
            font: '600 8.5px/1.15 var(--font-sans)',
            color: 'var(--ink-800)',
          }}
        >
          {unit.label}
        </div>
      )}
      {showSub && assignedName && (
        <div
          style={{
            ...labelBase,
            transform: `scale(${invZ}) translate(-50%, ${Math.round(style.size / 2 + 4)}px)`,
            maxWidth: labels?.subWidth ?? SUB_MAX_PX,
            font: '500 8px/1.2 var(--font-sans)',
            color: 'var(--ink-500)',
          }}
        >
          {assignedName}
        </div>
      )}
    </>
  );
}
