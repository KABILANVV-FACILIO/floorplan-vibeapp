import { useMemo, useState } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { useLivePeople } from '../../hooks/useLivePeople';
import { badgeLetters, newRoleId, sanitizeResponders, sanitizeRoles } from '../../lib/firstResponders';
import { RESPONDER_COLORS, RESPONDER_ICONS } from '../../lib/types';
import type { Employee, FirstResponder, ResponderRole, ResponderRoleDef, ResponderShape } from '../../lib/types';
import { departmentDisplayName } from '../../lib/displayNames';
import { ResponderGlyph } from '../canvas/ResponderBadge';
import { CardHead, StagedModal, SummaryRow } from './SettingsScreen';
import styles from './SettingsScreen.module.css';
import own from './FirstRespondersTab.module.css';

const SHAPES: { id: ResponderShape; name: string }[] = [
  { id: 'square', name: 'Square' },
  { id: 'circle', name: 'Circle' },
  { id: 'diamond', name: 'Diamond' },
];

/**
 * Settings › First responders — the org's responder roles, and who holds them.
 *
 * Roles: first aider and floor warden come built in; an org adds its own (fire marshal, AED
 * trained, radiation protection…), each with a badge of its own symbol, colour and shape.
 * People are picked from the org's directory and nothing is typed in: a responder is a link to the
 * employee record a desk is assigned to, so the plan finds their desk on its own, and their name,
 * department and mobile are the record's.
 */
export function FirstRespondersTab() {
  const { state } = useFloorplanData();
  const [editing, setEditing] = useState<'people' | 'roles' | null>(null);
  const list = state.firstResponders;
  const roles = state.responderRoles;

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <CardHead
          title="First responders"
          desc="The people a floor turns to in an emergency. Each one is marked on the plan at the desk they hold, listed on that floor, and printed on the floor's notice."
          onConfigure={() => setEditing('people')}
          action={list.length ? 'Edit' : 'Add responders'}
        />
        {roles.map((role) => {
          const people = list.filter((r) => r.roles.includes(role.id));
          return (
            <SummaryRow
              key={role.id}
              name={role.plural}
              desc={
                <span className={own.sumDesc}>
                  <ResponderGlyph role={role} size={14} />
                  {people.length ? `${people.length} named` : 'Nobody named yet'}
                </span>
              }
            >
              <span className={own.names}>{people.length ? people.map((p) => p.name).join(', ') : '—'}</span>
            </SummaryRow>
          );
        })}
        <div className={styles.footNote}>
          A responder is shown on the floor where their desk is. Someone with no desk assigned doesn&rsquo;t appear on any plan until they have one.
        </div>
      </div>

      <div className={styles.card}>
        <CardHead
          title="Responder roles"
          desc="The kinds of responder the org names, and the badge each one carries on the plan, the floor's list and the notice."
          onConfigure={() => setEditing('roles')}
          action="Edit roles"
        />
        <div className={own.roleChips}>
          {roles.map((role) => (
            <span key={role.id} className={own.roleChip}>
              <ResponderGlyph role={role} size={18} />
              {role.name}
              {role.builtIn && <span className={own.builtIn}>Built in</span>}
            </span>
          ))}
        </div>
      </div>

      {editing === 'people' && <RespondersModal onClose={() => setEditing(null)} />}
      {editing === 'roles' && <RolesModal onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function RespondersModal({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const roles = state.responderRoles;
  const roleIds = roles.map((r) => r.id);
  const [draft, setDraft] = useState<FirstResponder[]>(() => state.firstResponders.map((r) => ({ ...r, roles: [...r.roles] })));
  const saved = useMemo(() => JSON.stringify(sanitizeResponders(state.firstResponders, roleIds)), [state.firstResponders, roleIds.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const cleaned = sanitizeResponders(draft, roleIds);
  const changed = JSON.stringify(cleaned) === saved ? 0 : countChanged(state.firstResponders, cleaned, (r) => r.employeeId);

  const removeRole = (employeeId: string, role: ResponderRole) =>
    setDraft((d) => d.flatMap((r) => (r.employeeId !== employeeId ? [r] : r.roles.length > 1 ? [{ ...r, roles: r.roles.filter((x) => x !== role) }] : [])));
  const addPerson = (person: Employee, role: ResponderRole) =>
    setDraft((d) => {
      const at = d.find((r) => r.employeeId === person.id);
      if (at) return d.map((r) => (r === at ? { ...r, roles: roleIds.filter((k) => r.roles.includes(k) || k === role) } : r));
      return [...d, { employeeId: person.id, name: person.name, roles: [role] }];
    });

  return (
    <StagedModal
      title="First responders"
      subtitle="Pick people from the directory. Their name, department and mobile come from their employee record. Someone can hold more than one role."
      changed={changed}
      unit="responder"
      width={620}
      onCancel={onClose}
      onSave={() => {
        actions.setFirstResponders(cleaned);
        onClose();
      }}
    >
      {roles.map((role) => (
        <RoleSection
          key={role.id}
          role={role}
          people={draft.filter((r) => r.roles.includes(role.id))}
          employees={state.employees}
          onRemove={(id) => removeRole(id, role.id)}
          onAdd={(person) => addPerson(person, role.id)}
        />
      ))}
    </StagedModal>
  );
}

/** How many entries the save would add, drop or change — what a dialog's footer counts. */
function countChanged<T>(before: T[], after: T[], key: (x: T) => string): number {
  const b = new Map(before.map((r) => [key(r), JSON.stringify(r)]));
  const a = new Map(after.map((r) => [key(r), JSON.stringify(r)]));
  let n = 0;
  for (const [id, v] of a) if (b.get(id) !== v) n++;
  for (const id of b.keys()) if (!a.has(id)) n++;
  return Math.max(n, 1);
}

function RoleSection({
  role,
  people,
  employees,
  onRemove,
  onAdd,
}: {
  role: ResponderRoleDef;
  people: FirstResponder[];
  employees: Employee[];
  onRemove: (employeeId: string) => void;
  onAdd: (person: Employee) => void;
}) {
  const dept = (id: string) => departmentDisplayName(employees.find((e) => e.id === id)?.department);
  const key = role.id.replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <section className={own.section} aria-labelledby={`resp-${key}`}>
      <h4 className={own.sectionHead} id={`resp-${key}`}>
        <ResponderGlyph role={role} size={16} />
        {role.plural}
        <span className={own.count}>{people.length}</span>
      </h4>
      {people.length > 0 && (
        <ul className={own.table} aria-label={role.plural}>
          {people.map((r) => (
            <li key={r.employeeId} className={own.row}>
              <span className={own.person}>
                <span className={own.personName}>{r.name}</span>
                {dept(r.employeeId) && <span className={own.personDept}>{dept(r.employeeId)}</span>}
              </span>
              <span>
                <button type="button" className={own.remove} aria-label={`Remove ${r.name} as a ${role.name.toLowerCase()}`} data-tip="Remove" onClick={() => onRemove(r.employeeId)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <PersonAdder role={role} exclude={new Set(people.map((p) => p.employeeId))} employees={employees} onAdd={onAdd} />
    </section>
  );
}

/** "Add a first aider": a search over the org's directory, then a pick. */
function PersonAdder({ role, exclude, employees, onAdd }: { role: ResponderRoleDef; exclude: Set<string>; employees: Employee[]; onAdd: (person: Employee) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { people, loading } = useLivePeople(query, employees, { enabled: open });
  const hits = people.filter((p) => !exclude.has(p.id)).slice(0, 8);
  const name = role.name.toLowerCase();
  const key = role.id.replace(/[^a-zA-Z0-9_-]/g, '');

  if (!open) {
    return (
      <button type="button" className={own.add} onClick={() => setOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add to {role.plural}
      </button>
    );
  }
  return (
    <div className={own.adder}>
      <input
        id={`resp-${key}-search`}
        className={own.search}
        autoFocus
        placeholder="Search by name, HRMS ID or email"
        aria-label={`Search for a ${name}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // Close the search, not the whole dialog.
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setOpen(false);
            setQuery('');
          }
        }}
      />
      <div className={own.hits} role="listbox" aria-label="Matching people">
        {loading && hits.length === 0 && <div className={own.hint}>Searching…</div>}
        {!loading && query.trim() && hits.length === 0 && <div className={own.hint}>No one matches &ldquo;{query.trim()}&rdquo;.</div>}
        {!query.trim() && hits.length === 0 && !loading && <div className={own.hint}>Type a name to search the directory.</div>}
        {hits.map((p) => (
          <button
            key={p.id}
            type="button"
            role="option"
            aria-selected={false}
            className={own.hit}
            onClick={() => {
              onAdd(p);
              setQuery('');
              setOpen(false);
            }}
          >
            <span className={own.personName}>{p.name}</span>
            <span className={own.personDept}>{[p.hrmsEmployeeId, departmentDisplayName(p.department)].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className={own.cancelAdd}
        onClick={() => {
          setOpen(false);
          setQuery('');
        }}
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * The org's responder roles, each with its badge. The built-in two can be restyled but not
 * removed. Removing an org role takes it off everyone who holds it, which the dialog says before
 * the save rather than after.
 */
function RolesModal({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const [draft, setDraft] = useState<ResponderRoleDef[]>(() => state.responderRoles.map((r) => ({ ...r })));
  const [open, setOpen] = useState<string | null>(null);
  const cleaned = sanitizeRoles(draft);
  const changed = JSON.stringify(cleaned) === JSON.stringify(state.responderRoles) ? 0 : countChanged(state.responderRoles, cleaned, (r) => r.id);
  const holders = (id: string) => state.firstResponders.filter((r) => r.roles.includes(id)).length;
  const removed = state.responderRoles.filter((r) => !cleaned.some((c) => c.id === r.id));
  const dropped = removed.reduce((n, r) => n + holders(r.id), 0);

  const patch = (id: string, p: Partial<ResponderRoleDef>) => setDraft((d) => d.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const add = () => {
    const used = new Set(draft.map((r) => r.color));
    const color = RESPONDER_COLORS.find((c) => !used.has(c)) ?? RESPONDER_COLORS[0];
    const id = newRoleId('new role', draft.map((r) => r.id));
    setDraft((d) => [...d, { id, name: 'New role', plural: 'New roles', color, icon: 'star', shape: 'circle' }]);
    setOpen(id);
  };

  return (
    <StagedModal
      title="Responder roles"
      subtitle="Add the kinds of responder your floors have, and give each one a badge. The badge is what the plan, the floor's list and the notice show."
      changed={changed}
      unit="role"
      width={720}
      refused={dropped ? `Saving takes ${removed.map((r) => r.name).join(', ')} off ${dropped} ${dropped === 1 ? 'person' : 'people'} who hold it.` : undefined}
      onCancel={onClose}
      onSave={() => {
        // A role added in this dialog takes its id from its final name (the placeholder "New role"
        // is only what it was called while being set up). Nobody can hold it yet, so nothing
        // refers to the old one.
        const taken = new Set(state.responderRoles.map((r) => r.id));
        actions.setResponderRoles(
          cleaned.map((r) => {
            if (taken.has(r.id)) return r;
            const id = newRoleId(r.name, taken);
            taken.add(id);
            return { ...r, id };
          })
        );
        onClose();
      }}
    >
      <div className={own.roleList}>
        {draft.map((role) => (
          <RoleEditor
            key={role.id}
            role={role}
            open={open === role.id}
            holders={holders(role.id)}
            onToggle={() => setOpen(open === role.id ? null : role.id)}
            onPatch={(p) => patch(role.id, p)}
            onRemove={role.builtIn ? undefined : () => setDraft((d) => d.filter((r) => r.id !== role.id))}
          />
        ))}
      </div>
      <div style={{ padding: '4px 20px 16px' }}>
        <button type="button" className={own.add} onClick={add}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add a role
        </button>
      </div>
    </StagedModal>
  );
}

function RoleEditor({
  role,
  open,
  holders,
  onToggle,
  onPatch,
  onRemove,
}: {
  role: ResponderRoleDef;
  open: boolean;
  holders: number;
  onToggle: () => void;
  onPatch: (p: Partial<ResponderRoleDef>) => void;
  onRemove?: () => void;
}) {
  const key = role.id.replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <div className={[own.roleRow, open ? own.roleRowOpen : ''].join(' ')}>
      <div className={own.roleTop}>
        <button type="button" className={own.roleBadgeBtn} aria-expanded={open} aria-label={`Change the badge for ${role.name}`} onClick={onToggle}>
          <ResponderGlyph role={role} size={30} />
        </button>
        <label className={own.field}>
          <span className={own.fieldName}>Name</span>
          <input
            id={`role-${key}-name`}
            className={own.input}
            value={role.name}
            onChange={(e) => onPatch({ name: e.target.value, ...(role.plural === `${role.name}s` ? { plural: `${e.target.value}s` } : {}) })}
          />
        </label>
        <label className={own.field}>
          <span className={own.fieldName}>List heading</span>
          <input id={`role-${key}-plural`} className={own.input} value={role.plural} onChange={(e) => onPatch({ plural: e.target.value })} />
        </label>
        <span className={own.roleMeta}>
          {role.builtIn ? <span className={own.builtIn}>Built in</span> : holders ? `${holders} ${holders === 1 ? 'person' : 'people'}` : 'Nobody yet'}
        </span>
        <button type="button" className={own.badgeToggle} onClick={onToggle} aria-expanded={open}>
          {open ? 'Done' : 'Badge'}
        </button>
        {onRemove ? (
          <button type="button" className={own.remove} aria-label={`Remove the role ${role.name}`} data-tip="Remove role" onClick={onRemove}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        ) : (
          <span className={own.removeSpacer} />
        )}
      </div>

      {open && (
        <div className={own.badgeEditor}>
          <div className={own.pickRow}>
            <span className={own.pickName}>Symbol</span>
            <div className={own.picks} role="radiogroup" aria-label="Symbol">
              {RESPONDER_ICONS.map((ic) => (
                <button
                  key={ic.id}
                  type="button"
                  role="radio"
                  aria-checked={role.icon === ic.id}
                  aria-label={ic.name}
                  data-tip={ic.name}
                  className={[own.pick, role.icon === ic.id ? own.pickOn : ''].join(' ')}
                  onClick={() => onPatch({ icon: ic.id, ...(ic.id === 'text' ? { text: badgeLetters(role.text, role.name) } : {}) })}
                >
                  <ResponderGlyph role={{ ...role, icon: ic.id, text: ic.id === 'text' ? badgeLetters(role.text, role.name) : role.text }} size={24} />
                </button>
              ))}
            </div>
          </div>
          {role.icon === 'text' && (
            <div className={own.pickRow}>
              <span className={own.pickName}>Letters</span>
              <input
                id={`role-${key}-letters`}
                className={own.input}
                style={{ width: 80 }}
                maxLength={2}
                value={role.text ?? ''}
                aria-label="One or two letters"
                onChange={(e) => onPatch({ text: e.target.value.toUpperCase() })}
              />
            </div>
          )}
          <div className={own.pickRow}>
            <span className={own.pickName}>Shape</span>
            <div className={own.picks} role="radiogroup" aria-label="Shape">
              {SHAPES.map((sh) => (
                <button
                  key={sh.id}
                  type="button"
                  role="radio"
                  aria-checked={role.shape === sh.id}
                  aria-label={sh.name}
                  data-tip={sh.name}
                  className={[own.pick, role.shape === sh.id ? own.pickOn : ''].join(' ')}
                  onClick={() => onPatch({ shape: sh.id })}
                >
                  <ResponderGlyph role={{ ...role, shape: sh.id }} size={24} />
                </button>
              ))}
            </div>
          </div>
          <div className={own.pickRow}>
            <span className={own.pickName}>Colour</span>
            <div className={own.picks} role="radiogroup" aria-label="Colour">
              {RESPONDER_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={role.color.toUpperCase() === c.toUpperCase()}
                  aria-label={c}
                  className={[own.swatch, role.color.toUpperCase() === c.toUpperCase() ? own.swatchOn : ''].join(' ')}
                  style={{ background: c }}
                  onClick={() => onPatch({ color: c })}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
