import { useEffect, useMemo, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { contactName, initials, isAssignable, isBookable, unitById } from '../../state/selectors';
import { byPersonName, personDisplayName } from '../../lib/displayNames';
import { useLivePeople } from '../../hooks/useLivePeople';
import { unitStatus } from '../../lib/unitStatus';
import { fmtTime } from '../../lib/geometry';
import { resolveMarkerDef, TYPE_META } from '../../lib/types';
import { responderRolesFor, rolesText } from '../../lib/firstResponders';
import { ResponderGlyph } from '../canvas/ResponderBadge';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { useSheetDrag } from './useSheetDrag';
import styles from './MobileUnitSheet.module.css';

/** Cap the rendered rows — the RCU directory is 1,400+ people; search narrows. */
const MAX_ROWS = 60;

export function MobileUnitSheet() {
  const { state, actions } = useFloorplanData();
  const unit = unitById(state, state.mobSel);
  const [contactQuery, setContactQuery] = useState('');
  const [confirmVacate, setConfirmVacate] = useState(false);
  // A question is about the space it was asked over: another space, or none, and it is gone. A
  // closed sheet also forgets what was typed into its search (Back in the phone app closes it too).
  useEffect(() => {
    setConfirmVacate(false);
    if (!state.mobSel) setContactQuery('');
  }, [state.mobSel]);
  const sheetRef = useSheetDrag(() => {
    actions.setMobSel(null);
    actions.setMobAssignEdit(false);
    setContactQuery('');
  }, !!unit);

  const contactId = unit ? state.assignments[unit.id] : undefined;
  const showBookTab = state.mobileTab === 'book' && state.planViews.book;
  // No Assignment right: the sheet says who holds the space and offers nothing to change it.
  const assignOn = state.planViews.assign;
  const isAmenity = unit?.type === 'amenity';
  const isAsset = isAmenity && !!unit?.assetId;
  const assignable = unit && !isAmenity ? isAssignable(unit) : false;
  // Contact picking expands the sheet to near-full height with its own
  // search — a plain dropdown was unusable against the full directory.
  const picking = !!unit && !showBookTab && assignOn && assignable && (!contactId || state.mobAssignEdit);
  // A write to this space is already on its way — from this sheet, or a drag on another surface.
  // Nothing here may start a second one over it (desktop disables its buttons the same way).
  const busy = !!unit && state.busyUnitId === unit.id;

  // Typing asks the org, as the desktop picker does: matching only the roster loaded at start-up
  // left anyone outside it unfindable on a phone. Until something is typed the roster in hand is
  // the list, as before — opening the sheet on each desk in turn sends nothing.
  const { people, loading: peopleLoading } = useLivePeople(contactQuery, state.employees, { enabled: picking && !!contactQuery.trim() });
  const filtered = useMemo(() => [...people].sort(byPersonName), [people]);

  if (!unit) return null;

  const status = unitStatus(state, unit, (id) => contactName(state, id));
  const bookable = isBookable(unit);

  function close() {
    actions.setMobSel(null);
    actions.setMobAssignEdit(false);
    setContactQuery('');
    setConfirmVacate(false);
  }

  const shown = filtered.slice(0, MAX_ROWS);

  return (
    <>
      <div className={styles.backdrop} onClick={close} />
      <div ref={sheetRef} className={[styles.sheet, picking ? styles.sheetTall : ''].join(' ')}>
        <div className={styles.handle} />
        <div className={styles.headRow}>
          <div className={styles.headText}>
            <div className={styles.name}>{unit.label}</div>
            <div className={styles.kind}>
              {isAmenity
                ? isAsset
                  ? 'Asset'
                  : unit.markerKind || unit.icon
                    ? resolveMarkerDef(state.customMarkers, unit).name
                    : 'Amenity'
                : TYPE_META[unit.type].name}
              {unit.room ? ` · ${unit.room}` : ''}
            </div>
            {responderRolesFor(state, unit).length > 0 && (
              // Who sits here, if it matters in an emergency.
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, font: '600 12px/1.3 var(--font-sans)', color: 'var(--ink-700)' }}>
                {responderRolesFor(state, unit).map((r) => (
                  <ResponderGlyph key={r.id} role={r} size={14} />
                ))}
                {rolesText(responderRolesFor(state, unit))}
              </div>
            )}
          </div>
          {!isAmenity && (
            <span className={styles.statusPill} style={{ background: status.bg, color: status.fg }}>
              {status.text}
            </span>
          )}
        </div>

        {isAmenity && unit.secondary && <div className={styles.infoBox}>{unit.secondary}</div>}

        {!isAmenity && showBookTab && bookable && status.key !== 'booked' && (
          <button
            className={styles.primaryBtn}
            onClick={() => {
              // Open the shared booking form (same as desktop) instead of an instant book.
              actions.openBookingForm({ unitId: unit.id, date: state.date, start: state.start, end: state.end });
              actions.setMobSel(null);
            }}
          >
            Book · {fmtTime(state.start)}–{fmtTime(state.end)}
          </button>
        )}
        {!isAmenity && showBookTab && bookable && status.key === 'booked' && <div className={styles.infoBox}>This space is currently booked for the selected time window.</div>}
        {!isAmenity && showBookTab && !bookable && <div className={styles.infoBox}>Lockers are assigned via the Assign tab, not booked.</div>}

        {!showBookTab && assignable && contactId && !state.mobAssignEdit && (
          <>
            <div className={styles.assignedRow}>
              <span className={styles.avatar}>{initials(contactName(state, contactId))}</span>
              <span className={styles.assignedName}>{contactName(state, contactId)}</span>
            </div>
            {assignOn && (
              <div className={styles.actionsRow}>
                <button type="button" className={styles.vacateBtn} disabled={busy} onClick={() => setConfirmVacate(true)}>
                  Vacate
                </button>
                <button type="button" className={styles.reassignBtn} disabled={busy} onClick={() => actions.setMobAssignEdit(true)}>
                  Reassign
                </button>
              </div>
            )}
          </>
        )}
        {confirmVacate && (
          <ConfirmDialog
            title={`Vacate ${unit.label}?`}
            confirmLabel={`Vacate ${unit.label}`}
            disabled={busy}
            onCancel={() => setConfirmVacate(false)}
            onConfirm={() => {
              setConfirmVacate(false);
              void actions.vacate(unit.id);
            }}
          >
            {contactId && contactName(state, contactId) ? `${contactName(state, contactId)} comes off ${unit.label}.` : `${unit.label} is left with nobody on it.`}
          </ConfirmDialog>
        )}

        {picking && (
          <div className={styles.pickWrap}>
            <div className={styles.assignLabel}>Assign to</div>
            <input
              className={styles.empSearch}
              placeholder="Search people"
              aria-label={`Search people to assign ${unit.label} to`}
              value={contactQuery}
              onChange={(e) => setContactQuery(e.target.value)}
            />
            <div className={styles.empList}>
              {shown.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={styles.empRow}
                  disabled={busy}
                  onClick={() => {
                    actions.assign(c.id, unit.id);
                    actions.setMobAssignEdit(false);
                    setContactQuery('');
                  }}
                >
                  <span className={styles.avatar}>{initials(c.name)}</span>
                  <span className={styles.empText}>
                    <span className={styles.empName}>{personDisplayName(c.name)}</span>
                  </span>
                  {contactId === c.id && (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue-600)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
              {filtered.length > MAX_ROWS && (
                <div className={styles.listNote}>
                  Showing {MAX_ROWS} of {filtered.length} — keep typing to narrow down.
                </div>
              )}
              {filtered.length === 0 && (
                <div className={styles.listNote}>
                  {peopleLoading ? 'Loading people…' : contactQuery.trim() ? `No people match “${contactQuery.trim()}”.` : 'Couldn’t load people — close this and try again.'}
                </div>
              )}
            </div>
            {state.mobAssignEdit && (
              <button
                type="button"
                className={styles.cancelPick}
                onClick={() => {
                  actions.setMobAssignEdit(false);
                  setContactQuery('');
                }}
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
