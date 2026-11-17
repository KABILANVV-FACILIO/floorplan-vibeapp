import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFloorplanData } from '../../state/FloorplanContext';
import { holdersOf, responderCountLabel, respondersOnFloor, rolesOnFloor } from '../../lib/firstResponders';
import { ResponderGlyph } from './ResponderBadge';
import styles from './FloorResponders.module.css';

/**
 * "Who do I call on this floor?" — the notice by the lifts, on the plan. A chip beside the legend
 * counts the floor's first aiders and wardens; opening it lists them with their mobile (from their
 * employee record) and desk, and picking one centres the plan on their desk.
 *
 * Only people who hold a desk on this floor are listed (see respondersOnFloor). The chip is absent
 * on a floor with none, rather than reading "0 first aiders" — that is for Settings to say.
 */
export function FloorResponders() {
  const { state, actions } = useFloorplanData();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Where the list opens: above the chip, on the page itself. Drawn inside the plan it sat UNDER
  // the floating Location panel, which covers exactly the corner the chip is in.
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const onFloor = respondersOnFloor(state);
  const mobileOf = (employeeId: string) => state.employees.find((e) => e.id === employeeId)?.mobile;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (r) setAt({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    // Capture phase, stopped here: Escape closes the list, not the plan's selection behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // A floor change closes it: the list was of the floor that was on screen.
  useEffect(() => setOpen(false), [state.floorId]);

  if (onFloor.length === 0) return null;
  const roles = rolesOnFloor(onFloor, state.responderRoles);

  return (
    // The plan reads a press as the start of a pan and a click as "deselect"; neither belongs to
    // this list.
    <div ref={rootRef} className={styles.root} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button type="button" className={styles.chip} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <span className={styles.glyphs}>
          {roles.slice(0, 4).map((r) => (
            <ResponderGlyph key={r.id} role={r} size={13} />
          ))}
        </span>
        {/* Two roles fit as counts; past that the chip would outgrow the legend row, so it gives the
            total and leaves the per-role counts to the list it opens. */}
        {roles.length <= 2 ? responderCountLabel(onFloor, roles) : `${new Set(onFloor.map((x) => x.responder.employeeId)).size} first responders`}
      </button>
      {open &&
        at &&
        createPortal(
        <div ref={panelRef} className={styles.panel} style={{ left: at.left, bottom: at.bottom }} role="dialog" aria-label="First responders on this floor">
          <div className={styles.head}>First responders on this floor</div>
          {roles.map((role) => (
            <section key={role.id} className={styles.section}>
              <h4 className={styles.roleHead}>
                <ResponderGlyph role={role} size={14} />
                {role.plural}
              </h4>
              {holdersOf(onFloor, role.id).map(({ responder, unit }) => {
                const mobile = mobileOf(responder.employeeId);
                return (
                  <button
                    key={`${responder.employeeId}:${unit.id}`}
                    type="button"
                    className={styles.row}
                    onClick={() => {
                      setOpen(false);
                      actions.focusUnit(unit.id, state.stage.w, state.stage.h);
                    }}
                  >
                    <span className={styles.name}>{responder.name || unit.label}</span>
                    <span className={styles.desk}>{unit.label}</span>
                    <span className={styles.contact}>{mobile ? <span>{mobile}</span> : <span className={styles.none}>No mobile on their record</span>}</span>
                  </button>
                );
              })}
            </section>
          ))}
          <div className={styles.foot}>Named in Settings › First responders. Pick someone to see their desk.</div>
        </div>,
          document.body
        )}
    </div>
  );
}
