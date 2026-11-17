import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { holdersOf, peopleOnFloor, respondersOnFloor, rolesOnFloor } from '../../lib/firstResponders';
import type { FloorPerson } from '../../lib/firstResponders';
import type { ResponderRoleDef } from '../../lib/types';
import { departmentDisplayName } from '../../lib/displayNames';
import { ResponderGlyph } from '../canvas/ResponderBadge';
import styles from './ResponderNoticePage.module.css';
import sheet from './PrintSheet.module.css';

/**
 * The floor's emergency-contacts notice: the sheet pinned by the lifts, in the shape the org
 * already uses — "First Aiders" and "Floor Wardens", each a table of name, mobile and department,
 * all three read off the person's employee record, and, new on paper, the
 * desk the plan marks. One row per person: someone holding several desks here lists them all in
 * one cell, a line each.
 *
 * Printed as the last page of the floor's sheet, only when the floor has someone to list.
 */
export function ResponderNoticePage({ where, pageNo, pageCount, header }: { where: { floor: string; building: string; site: string }; pageNo: number; pageCount: number; header: ReactNode }) {
  const { state } = useFloorplan();
  const onFloor = respondersOnFloor(state);
  const people = peopleOnFloor(onFloor);
  // A notice is read from across a corridor: a short list prints large, in one column. A longer one
  // goes to two columns, and a long one to two columns of smaller type — chosen by counting, not by
  // measuring, because the paper copy is laid out while hidden and can't measure itself.
  const roles = rolesOnFloor(onFloor, state.responderRoles);
  // Per role: its title, the table's header row, and a line per desk.
  const lines = roles.reduce((n, role) => n + 2 + holdersOf(people, role.id).reduce((k, p) => k + p.units.length, 0), 0);
  const layout = lines <= 16 ? 'roomy' : lines <= 40 ? 'twoCol' : 'dense';
  const recordOf = (employeeId: string) => state.employees.find((e) => e.id === employeeId);
  const deptOf = (employeeId: string, fallback?: string) => departmentDisplayName(recordOf(employeeId)?.department ?? fallback) || '—';
  const mobileOf = (employeeId: string) => recordOf(employeeId)?.mobile || '—';
  // The desk and mobile columns as wide as their longest entry on this page, so a desk code or a
  // number is never cut (a fixed 13% cut "TEest Desk 2" to "TEest De…", and ENEC's own codes
  // with it); the name and department share what is left. The same widths for every role's table,
  // so they line up down the page.
  const fit = {
    desk: Math.min(MAX_DESK_CH, Math.max(4, ...people.flatMap((p) => p.units.map((u) => u.label.length)))),
    mobile: Math.min(MAX_MOBILE_CH, Math.max('Mobile Phone'.length, ...people.map((p) => mobileOf(p.responder.employeeId).length))),
  };

  return (
    <div className={sheet.page} data-print-page="">
      <div className={sheet.bar}>{header}</div>

      <div className={[styles.body, styles[layout]].join(' ')}>
        <div className={styles.sections}>
          {roles.map((role) => (
            <RoleTable key={role.id} role={role} items={holdersOf(people, role.id)} deptOf={deptOf} mobileOf={mobileOf} fit={fit} />
          ))}
        </div>
      </div>

      <div className={sheet.foot}>
        <span className={sheet.footNote}>
          {where.floor} · first responders as named in Floorplan Manager, at the desks they hold when this was printed. In an emergency, call the
          nearest one.
        </span>
        <span className={sheet.pageNo}>
          Page {pageNo} of {pageCount}
        </span>
      </div>
    </div>
  );
}

/** The most characters the desk and mobile columns widen to; past that, the entry ends in "…". */
const MAX_DESK_CH = 24;
const MAX_MOBILE_CH = 18;

/**
 * A column `chars` characters wide in the table's own type, plus its cell padding. A little over
 * one `ch` (a digit's width) per character: desk codes run to capitals and the header is bold.
 */
const colWidth = (chars: number) => `calc(${(chars * 1.15).toFixed(1)}ch + 1.7em)`;

function RoleTable({
  role,
  items,
  deptOf,
  mobileOf,
  fit,
}: {
  role: ResponderRoleDef;
  items: FloorPerson[];
  deptOf: (employeeId: string, fallback?: string) => string;
  mobileOf: (employeeId: string) => string;
  /** The desk and mobile columns' widths, in characters: the page's longest entries. */
  fit: { desk: number; mobile: number };
}) {
  if (items.length === 0) return null;
  return (
    <section className={styles.section}>
      {/* Headed in the role's own colour, as the notice heads each list in its own. */}
      <h2 className={styles.title} style={{ color: role.color }}>
        <ResponderGlyph role={role} size={18} />
        {role.plural}
      </h2>
      <table className={styles.table}>
        {/* Fixed columns, so every role's table lines up down the page: the mobile and desk columns
            fit their entries, the name and department split the rest. */}
        <colgroup>
          <col />
          <col style={{ width: colWidth(fit.mobile) }} />
          <col />
          <col style={{ width: colWidth(fit.desk) }} />
        </colgroup>
        <thead>
          <tr>
            <th>Name</th>
            <th>Mobile Phone</th>
            <th>Department</th>
            <th>Desk</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ responder, units }) => (
            <tr key={responder.employeeId}>
              <td>{responder.name || '—'}</td>
              <td className={styles.num}>{mobileOf(responder.employeeId)}</td>
              <td>{deptOf(responder.employeeId, units[0].department)}</td>
              <td>
                {units.map((u) => (
                  <span key={u.id} className={styles.desk}>
                    {u.label}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
