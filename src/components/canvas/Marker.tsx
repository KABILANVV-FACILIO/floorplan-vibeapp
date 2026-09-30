import { memo } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Unit, PointGeom } from '../../lib/types';
import type { MarkerModel } from '../../lib/markerModel';
import type { LabelPlacement } from '../../lib/labelLayout';
import { DEPT_FONT, NAME_MAX_PX, SUB_MAX_PX } from '../../lib/labelLayout';
import { MARKER_ICONS as ICONS } from './markerIcons';
import styles from './Marker.module.css';

/**
 * What the canvas does when a marker is clicked, pressed, or dragged over. The marker forwards
 * the event and its unit; the canvas, which knows the mode, the tool and what is being dragged,
 * decides. One stable object for every marker, so a change of mode never re-renders them for it.
 */
export interface MarkerHandlers {
  onClick(unit: Unit, e: ReactMouseEvent): void;
  onMouseDown(unit: Unit, e: ReactMouseEvent): void;
  onDragOver(unit: Unit, e: ReactDragEvent): void;
  onDragLeave(unit: Unit): void;
  onDrop(unit: Unit, e: ReactDragEvent): void;
}

/** One line of the holder label: its own ellipsis, so a long department never pushes the name out. */
const LINE = { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;

/**
 * A desk, locker, parking stall or amenity on the plan: its chip, and the labels the canvas found
 * room for.
 *
 * Pure: everything it shows arrives in `model` (see lib/markerModel), so it renders again only
 * when that changes — not on every pan. It scales itself by the plane's `--inv` variable (1/zoom)
 * rather than a prop, so a zoom changes nothing here either; the plane's one transform carries
 * the whole floor.
 */
export const Marker = memo(function Marker({
  model,
  labels,
  previewGeom,
  handlers,
}: {
  model: MarkerModel;
  /**
   * Which of this marker's labels the canvas found room for. Decided there, not here: whether a
   * label fits depends on the OTHER markers, which a single marker cannot see.
   */
  labels?: LabelPlacement;
  /** Where the chip is while it is being dragged (edit mode), ahead of the store. */
  previewGeom?: PointGeom;
  handlers?: MarkerHandlers;
}) {
  const { unit, style, title, holder, dept, isMine, isHighlighted, isBusy, draggable } = model;
  const geom = previewGeom ?? model.geom;

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
          style={{ left: `${geom.x * 100}%`, top: `${geom.y * 100}%`, transform: `scale(var(--inv)) translate(-50%, calc(-100% - ${Math.round(style.size / 2 + 6)}px))`, transformOrigin: '0 0' }}
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
        onClick={handlers ? (e) => handlers.onClick(unit, e) : undefined}
        onMouseDown={handlers && draggable ? (e) => handlers.onMouseDown(unit, e) : undefined}
        onDragOver={handlers ? (e) => handlers.onDragOver(unit, e) : undefined}
        onDragLeave={handlers ? () => handlers.onDragLeave(unit) : undefined}
        onDrop={handlers ? (e) => handlers.onDrop(unit, e) : undefined}
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
          transform: 'scale(var(--inv)) translate(-50%,-50%)',
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
        {!isBusy &&
          (style.img ? (
            <img src={style.img} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', pointerEvents: 'none' }} />
          ) : (
            <>
              {style.occText && <span style={{ font: '700 9px/1 var(--font-sans)' }}>{style.occText}</span>}
              {!style.occText && style.icon && ICONS[style.icon]}
            </>
          ))}
      </div>
      {/*
        The desk's name ABOVE its chip; who holds it BELOW, with their department as a second,
        smaller line when there is room for both (the holder alone when there isn't). Each box is
        capped — the name at NAME_MAX_PX, the holder at the width the layout reserved for it — and
        ends in "…" when the text runs longer; the chip's tooltip has the full text.
      */}
      {showName && !isMine && (
        <div
          style={{
            ...labelBase,
            transform: `scale(var(--inv)) translate(-50%, calc(-100% - ${Math.round(style.size / 2 + 4)}px))`,
            maxWidth: NAME_MAX_PX,
            font: '600 8.5px/1.15 var(--font-sans)',
            color: 'var(--ink-800)',
          }}
        >
          {unit.label}
        </div>
      )}
      {showSub && holder && (
        <div
          style={{
            ...labelBase,
            transform: `scale(var(--inv)) translate(-50%, ${Math.round(style.size / 2 + 4)}px)`,
            maxWidth: labels?.subWidth ?? SUB_MAX_PX,
            textAlign: 'center',
          }}
        >
          <div style={{ ...LINE, font: '500 8px/1.2 var(--font-sans)', color: 'var(--ink-700)' }}>{holder}</div>
          {labels?.dept && dept && <div style={{ ...LINE, font: `400 ${DEPT_FONT}px/1.2 var(--font-sans)`, color: 'var(--ink-500)' }}>{dept}</div>}
        </div>
      )}
    </>
  );
});
