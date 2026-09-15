import type { DragEvent as ReactDragEvent } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { contactName, moduleEnabled } from '../../state/selectors';
import { unitSortCompare } from '../../lib/geometry';
import { unitStatus } from '../../lib/unitStatus';
import { Chip } from '../primitives/Chip';
import { SkeletonRows } from '../primitives/Skeleton';
import { StatusPill } from '../primitives/StatusPill';
import type { SpaceFilter } from '../../state/types';
import { isRoomLike } from '../../lib/types';
import type { Unit } from '../../lib/types';
import styles from './SpacesList.module.css';

const FILTERS: { id: SpaceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'workstation', label: 'Desks' },
  { id: 'locker', label: 'Lockers' },
  { id: 'room', label: 'Rooms' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'parking', label: 'Parking' },
];

/** The type glyphs used as drag ghosts — same iconography as the edit palette. */
const DRAG_GLYPH: Partial<Record<Unit['type'], { svg: string; color: string }>> = {
  workstation: { svg: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', color: '#0059D6' },
  locker: { svg: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', color: '#3C229D' },
  parking: { svg: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M9 8h3.5a2.5 2.5 0 0 1 0 5H9"/>', color: '#43516B' },
};

/**
 * Replaces the browser's default whole-row drag snapshot with a compact type logo (desk glyph
 * for desks, locker for lockers, parking for stalls) — setDragImage needs a rendered element,
 * so a throwaway chip is appended off-screen and removed on the next tick.
 */
function setTypeDragImage(e: ReactDragEvent, unit: Unit) {
  const glyph = DRAG_GLYPH[unit.type];
  if (!glyph) return;
  const ghost = document.createElement('div');
  ghost.style.cssText =
    'position:fixed;top:-200px;left:-200px;width:42px;height:42px;border-radius:50%;background:#fff;' +
    `border:2px solid ${glyph.color};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 10px rgba(16,24,40,0.18);`;
  ghost.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${glyph.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${glyph.svg}</svg>`;
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 21, 21);
  setTimeout(() => ghost.remove(), 0);
}

export function SpacesList() {
  const { state, actions } = useFloorplan();
  const isEdit = state.mode === 'edit';
  // Everything on the floor, in every mode: what is already on the plan, plus the org's records
  // that have no marker yet. Edit mode used to list the unplaced pool ALONE, so a record vanished
  // from this list the moment you placed it — including the one you had just selected on the plan,
  // which left the sidebar with no trace of the desk the inspector was editing. The per-row
  // "Unplaced" pill already distinguishes the two, so there is nothing to gain by hiding one.
  // Disabled modules are filtered out before counting, so their chips read 0 and their rows
  // never appear.
  const allUnits = [...state.units, ...state.unplacedUnits];
  const units = allUnits.filter((u) => moduleEnabled(state, u.type));

  const counts: Record<string, number> = { all: units.length };
  for (const u of units) counts[u.type] = (counts[u.type] || 0) + 1;

  const q = state.spaceSearch.trim().toLowerCase();
  const filtered = units
    .filter((u) => state.spaceFilter === 'all' || u.type === state.spaceFilter)
    .filter((u) => !q || u.label.toLowerCase().includes(q) || (u.room ?? '').toLowerCase().includes(q) || (u.secondary ?? '').toLowerCase().includes(q))
    .sort(unitSortCompare);

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.headRow}>
          <span className={styles.title}>Spaces on this floor</span>
          <span className={styles.total}>{units.length}</span>
        </div>
        <div className={styles.searchBox}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.searchIcon}>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            className={styles.searchInput}
            value={state.spaceSearch}
            onChange={(e) => actions.setSpaceSearch(e.target.value)}
            placeholder={isEdit ? 'Search available spaces' : 'Search this floor'}
          />
          {state.spaceSearch && (
            <button className={styles.clearBtn} data-tip="Clear" onClick={() => actions.setSpaceSearch('')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className={styles.chips}>
          {FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0).map((f) => (
            <Chip key={f.id} active={state.spaceFilter === f.id} count={counts[f.id] || 0} onClick={() => actions.setSpaceFilter(f.id)}>
              {f.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className={styles.list}>
        {state.loading ? (
          <SkeletonRows rows={7} />
        ) : (
          <>
            {filtered.map((u) => (
              <SpaceRow key={u.id} unit={u} />
            ))}
            {filtered.length === 0 && (
              <div className={styles.empty}>
                {isEdit
                  ? 'Nothing on this floor yet — add desks, lockers or stalls from the Edit panel.'
                  : 'No spaces match this filter.'}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SpaceRow({ unit }: { unit: Unit }) {
  const { state, actions } = useFloorplan();
  // Read off the unit itself rather than the mode: in assign/book the pool rows used to render as
  // if they were placed, so clicking one focused the canvas on its 0,0 placeholder geometry.
  const unplaced = !!unit.unplaced;
  const isEdit = state.mode === 'edit';
  const selected = state.selected === unit.id;
  const status = unitStatus(state, unit, (id) => contactName(state, id));
  // The row dot reflects the unit's current-state color from the module color settings
  // (status.dot is moduleColor-driven), so a Settings color change shows here too.
  // Only the unplaced records drag onto the canvas (edit mode); placed markers are moved on the
  // canvas itself. The drag ghost is the type logo, not the row (see setTypeDragImage).
  const draggable = unplaced && isEdit && !isRoomLike(unit.type);
  // Click-to-arm alternative to dragging: arm the record, then click the plan to place it.
  const placing = state.placingUnitId === unit.id;
  return (
    <div
      className={[styles.row, selected ? styles.rowSelected : ''].join(' ')}
      style={
        unplaced
          ? placing
            ? { borderStyle: 'dashed', borderColor: 'var(--blue-300)', background: 'var(--blue-025)' }
            : { borderStyle: 'dashed' }
          : undefined
      }
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData('application/x-floorplan-unit', unit.id);
              // Type-suffixed duplicate so marker dragover handlers can type-check the drag
              // (dragover exposes types only, never data).
              e.dataTransfer.setData(`application/x-floorplan-unit-t-${unit.type}`, unit.id);
              e.dataTransfer.effectAllowed = 'move';
              setTypeDragImage(e, unit);
            }
          : undefined
      }
      onClick={
        unplaced
          ? draggable
            ? () => actions.setPlacingUnit(placing ? null : unit.id)
            : undefined
          // A placed record is on the plan: centre on it and select it, so clicking the row and
          // clicking the marker land in the same place.
          : () => actions.focusUnit(unit.id, state.stage.w, state.stage.h)
      }
      data-tip={draggable ? 'Drag onto the floorplan, or click and then click the map' : undefined}
    >
      <span className={styles.dot} style={{ background: status.dot }} />
      <div className={styles.rowText}>
        <div className={styles.rowLabel}>{unit.label}</div>
        <div className={styles.rowSub}>{unit.secondary || [unit.type === 'workstation' ? 'Desk' : unit.type, unit.room].filter(Boolean).join(' · ')}</div>
      </div>
      {unplaced ? (
        placing ? (
          <StatusPill label="Click map" bg="var(--blue-025)" fg="var(--blue-600)" />
        ) : (
          <StatusPill label="Unplaced" bg="var(--ink-050)" fg="var(--ink-600)" />
        )
      ) : (
        <StatusPill label={status.text} bg={status.bg} fg={status.fg} />
      )}
    </div>
  );
}
