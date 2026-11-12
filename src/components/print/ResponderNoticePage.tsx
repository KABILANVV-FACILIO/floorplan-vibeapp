import type { ReactNode } from 'react';
import { useFloorplan } from '../../state/FloorplanContext';
import { holdersOf, respondersOnFloor, rolesOnFloor } from '../../lib/firstResponders';
import type { ResponderRoleDef } from '../../lib/types';
import { departmentDisplayName } from '../../lib/displayNames';
import { ResponderGlyph } from '../canvas/ResponderBadge';
import styles from './ResponderNoticePage.module.css';
import sheet from './PrintSheet.module.css';

/**
 * The floor's emergency-contacts notice: the sheet pinned by the lifts, in the shape the org
 * already uses — a first-aid sign, then "First Aiders" and "Floor Wardens", each a table of name,
 * mobile and department, all three read off the person's employee record, and, new on paper, the
 * desk the plan marks.
 *
 * Printed as the last page of the floor's sheet, only when the floor has someone to list.
 */
export function ResponderNoticePage({ where, pageNo, pageCount, header }: { where: { floor: string; building: string; site: string }; pageNo: number; pageCount: number; header: ReactNode }) {
  const { state } = useFloorplan();
  const onFloor = respondersOnFloor(state);
  // A notice is read from across a corridor: a short list prints large, in one column. A longer one
  // goes to two columns, and a long one to two columns of smaller type — chosen by counting, not by
  // measuring, because the paper copy is laid out while hidden and can't measure itself.
  const roles = rolesOnFloor(onFloor, state.responderRoles);
  // Per role: its title, the table's header row, and one line per person.
  const lines = roles.reduce((n, role) => n + 2 + holdersOf(onFloor, role.id).length, 0);
  const layout = lines <= 16 ? 'roomy' : lines <= 40 ? 'twoCol' : 'dense';
  const roomy = layout === 'roomy';
  const recordOf = (employeeId: string) => state.employees.find((e) => e.id === employeeId);
  const deptOf = (employeeId: string, fallback?: string) => departmentDisplayName(recordOf(employeeId)?.department ?? fallback) || '—';
  const mobileOf = (employeeId: string) => recordOf(employeeId)?.mobile || '—';

  return (
    <div className={sheet.page} data-print-page="">
      <div className={sheet.bar}>{header}</div>

      <div className={[styles.body, styles[layout]].join(' ')}>
        <div className={styles.sign} aria-hidden="true">
          <svg viewBox="0 0 120 150" width={roomy ? 116 : layout === 'twoCol' ? 84 : 60} height={roomy ? 145 : layout === 'twoCol' ? 105 : 75}>
            <rect x="2" y="2" width="116" height="146" rx="8" fill="#00843D" stroke="#1d4d2c" strokeWidth="2" />
            <path d="M46 14h28v28h28v28H74v28H46V70H18V42h28z" fill="#fff" />
            <text x="60" y="131" textAnchor="middle" fill="#fff" style={{ font: '800 17px var(--font-sans)', letterSpacing: '0.04em' }}>
              FIRST AID
            </text>
          </svg>
        </div>

        <div className={styles.sections}>
          {roles.map((role) => (
            <RoleTable key={role.id} role={role} items={holdersOf(onFloor, role.id)} deptOf={deptOf} mobileOf={mobileOf} narrow={!roomy} />
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

function RoleTable({
  role,
  items,
  deptOf,
  mobileOf,
  narrow,
}: {
  role: ResponderRoleDef;
  /** Half the page wide (two columns): the mobile column gets the room, the name and department give it. */
  narrow: boolean;
  items: ReturnType<typeof respondersOnFloor>;
  deptOf: (employeeId: string, fallback?: string) => string;
  mobileOf: (employeeId: string) => string;
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
        {/* Fixed columns, so every role's table lines up down the page. */}
        <colgroup>
          {(narrow ? [30, 28, 28, 14] : [34, 22, 31, 13]).map((w, i) => (
            <col key={i} style={{ width: `${w}%` }} />
          ))}
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
          {items.map(({ responder, unit }) => (
            <tr key={`${responder.employeeId}:${unit.id}`}>
              <td>{responder.name || '—'}</td>
              <td className={styles.num}>{mobileOf(responder.employeeId)}</td>
              <td>{deptOf(responder.employeeId, unit.department)}</td>
              <td>{unit.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
