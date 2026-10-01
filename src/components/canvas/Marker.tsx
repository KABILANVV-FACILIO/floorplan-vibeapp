import { memo } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Unit, PointGeom } from '../../lib/types';
import type { MarkerModel } from '../../lib/markerModel';
import type { LabelPlacement, LabelPos, LabelTypography } from '../../lib/labelLayout';
import { CARD_GAP, CARD_PAD_X, CARD_PAD_Y, DEFAULT_LABEL_TYPOGRAPHY, HALO_TEXT, cardOffset } from '../../lib/labelLayout';
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

/** The tick: a short line from the chip's edge to the text, across the gap, per side. */
const TICK_COLOR = 'var(--ink-300)';
const TICK: Record<LabelPos, CSSProperties> = {
  below: { top: -CARD_GAP, left: '50%', width: 1, height: CARD_GAP, marginLeft: -0.5 },
  above: { bottom: -CARD_GAP, left: '50%', width: 1, height: CARD_GAP, marginLeft: -0.5 },
  right: { left: -CARD_GAP, top: '50%', width: CARD_GAP, height: 1, marginTop: -0.5 },
  left: { right: -CARD_GAP, top: '50%', width: CARD_GAP, height: 1, marginTop: -0.5 },
};

/** One line of the card: its own ellipsis, so a long line never pushes the next one out. */
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
  typography = DEFAULT_LABEL_TYPOGRAPHY,
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
  /** The type the card is drawn in — the one the labels were laid out for (Settings › Desks). */
  typography?: LabelTypography;
}) {
  const { unit, style, title, holder, dept, isMine, isHighlighted, isBusy, draggable } = model;
  const geom = previewGeom ?? model.geom;
  const t = typography;

  const at = { left: `${geom.x * 100}%`, top: `${geom.y * 100}%` };
  // Half the chip's screen size at the zoom the labels were laid out for — the chip grows with the
  // zoom (see chipScreenSize), and the card and the pill stand off its edge, not off 24px.
  const half = labels?.half ?? style.size / 2;
  // No card while the chip is being dragged: the layout placed it for where the chip WAS, and a
  // card trailing behind a moving chip reads as another desk's. It returns where the drag ends.
  const card = labels?.name && labels.pos && labels.w && labels.h && !previewGeom ? cardOffset(labels.pos, labels.w, labels.h, half) : null;

  return (
    <>
      {isMine && labels?.pill && (
        <div className={styles.myDeskBadge} style={{ ...at, transform: `scale(var(--inv)) translate(-50%, calc(-100% - ${Math.round(half + 6)}px))`, transformOrigin: '0 0' }}>
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
          // first, so the offset is in screen px — which is what a chip centred on its point, and
          // a label a fixed gap away from it, both need. `--chip` is the chip's own size at this
          // zoom over its 24px base (see chipScreenSize): it grows with the drawing, within bounds,
          // and the plane sets it beside `--inv`, so a zoom re-renders no chip for it.
          transform: 'scale(calc(var(--inv) * var(--chip, 1))) translate(-50%,-50%)',
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
        The card: the desk's name, who holds it, their department — wherever the canvas found room
        for it around the chip (see planMarkerLabels), at exactly the size it reserved, so what is
        drawn is what was measured against the neighbours. Outlined text, no box: the drawing shows
        through. A line too long for the card ends in "…" (the department runs to a second line
        first); the chip's tooltip has the full text.
      */}
      {card && labels && (
        <div
          style={{
            position: 'absolute',
            ...at,
            transformOrigin: '0 0',
            transform: `scale(var(--inv)) translate(${card.dx}px, ${card.dy}px)`,
            pointerEvents: 'none',
            zIndex: 1,
            width: labels.w,
            height: labels.h,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              boxSizing: 'border-box',
              padding: `${CARD_PAD_Y}px ${CARD_PAD_X}px`,
              textAlign: 'center',
              overflow: 'hidden',
              ...HALO_TEXT,
            }}
          >
            <div style={{ ...LINE, font: `${t.nameWeight} ${t.nameFont}px/${t.nameLine}px var(--font-sans)`, color: 'var(--ink-900)' }}>{unit.label}</div>
            {labels.sub && holder && <div style={{ ...LINE, font: `${t.subWeight} ${t.subFont}px/${t.subLine}px var(--font-sans)`, color: 'var(--ink-800)' }}>{holder}</div>}
            {labels.dept && dept && (
              <div
                style={{
                  font: `${t.deptWeight} ${t.deptFont}px/${t.deptLine}px var(--font-sans)`,
                  color: 'var(--ink-600)',
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: labels.deptLines ?? 1,
                  overflow: 'hidden',
                  overflowWrap: 'anywhere',
                }}
              >
                {dept}
              </div>
            )}
          </div>
          {/* The tick across the gap, from the chip's edge to the text, so a label beside a chip is
              never read as a neighbour's. */}
          <div style={{ position: 'absolute', background: TICK_COLOR, ...TICK[labels.pos!] }} />
        </div>
      )}
    </>
  );
});
