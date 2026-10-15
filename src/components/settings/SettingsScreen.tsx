import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { DEFAULT_ACCESS, STATE_DEFS, STATE_SWATCHES, SURFACE_ORDER, SURFACES, TOGGLEABLE_MODULES, TYPE_META } from '../../lib/types';
import type { ModuleKey, OrgRole, Surface, SurfaceAccess, UnitType } from '../../lib/types';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { computePlacement } from '../primitives/Select';

type Placement = ReturnType<typeof computePlacement>;
import { moduleEnabled } from '../../state/selectors';
import { Button } from '../primitives/Button';
import { moduleColor } from '../../lib/unitStatus';
import { DEFAULT_LABEL_STYLE, HALO_TEXT, typographyOf } from '../../lib/labelLayout';
import type { LabelStyle } from '../../lib/labelLayout';
import { departmentColor, departmentsIn, DEPARTMENT_PALETTE } from '../../lib/departmentColors';
import { departmentDisplayName } from '../../lib/displayNames';
import styles from './SettingsScreen.module.css';

const MODULE_TABS: { id: 'permissions' | 'modules' | 'bookings' | UnitType; name: string }[] = [
  { id: 'permissions', name: 'Roles & access' },
  { id: 'modules', name: 'Modules' },
  { id: 'bookings', name: 'Bookings' },
  { id: 'workstation', name: 'Desks' },
  { id: 'locker', name: 'Lockers' },
  { id: 'parking', name: 'Parking' },
  { id: 'room', name: 'Rooms' },
  { id: 'delivery', name: 'Delivery areas' },
];

export function SettingsScreen() {
  const { state, actions } = useFloorplanData();

  return (
    <div className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.headRow}>
          <div>
            <div className={styles.eyebrow}>Workplace administration</div>
            <h1 className={styles.h1}>Settings</h1>
          </div>
          <Button variant="secondary" onClick={actions.openMap}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to floorplan
          </Button>
        </div>

        <div className={styles.tabs}>
          {MODULE_TABS.filter((t) => t.id === 'permissions' || t.id === 'modules' || t.id === 'bookings' || moduleEnabled(state, t.id)).map((t) => (
            <button
              key={t.id}
              className={[styles.tab, state.settingsTab === t.id ? styles.tabActive : ''].join(' ')}
              onClick={() => actions.setSettingsTab(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>

        {state.settingsTab === 'permissions' ? (
          <PermissionsTab />
        ) : state.settingsTab === 'modules' ? (
          <ModulesTab />
        ) : state.settingsTab === 'bookings' ? (
          <BookingsSettingsTab />
        ) : (
          <ModuleTab type={state.settingsTab} />
        )}
      </div>
    </div>
  );
}

const BOOKING_MODULES: { id: 'space' | 'facility'; name: string; desc: string }[] = [
  { id: 'space', name: 'Space booking', desc: 'Book desks, rooms and parking directly for a time window (Facilio spacebooking module).' },
  { id: 'facility', name: 'Facility booking', desc: 'Book facilities by generated time slots — hot desks, bookable amenities (Facilio facilitybooking module).' },
];

function BookingsSettingsTab() {
  const { state } = useFloorplanData();
  const [editing, setEditing] = useState(false);
  const active = BOOKING_MODULES.find((m) => m.id === state.bookingModule);

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <CardHead
          title="Booking module"
          desc="How bookings are made across the app. Only one can be active at a time — every booking, from the calendar and from the plan, routes through it."
          onConfigure={() => setEditing(true)}
        />
        <SummaryRow name="Active module" desc={active?.desc}>
          <span className={[styles.pill, styles.pillOn].join(' ')}>{active?.name}</span>
        </SummaryRow>
        <div className={styles.footNote}>
          A booking is the org&rsquo;s own {state.bookingModule === 'space' ? 'spacebooking' : 'facilitybooking'} record — any start and end, across days if
          needed; there is no fixed slot length.
        </div>
      </div>
      {editing && <BookingModuleModal onClose={() => setEditing(false)} />}
    </div>
  );
}

function BookingModuleModal({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const [draft, setDraft] = useState(state.bookingModule);

  return (
    <StagedModal
      title="Booking module"
      subtitle="Every booking in the app routes through the module you pick."
      changed={draft === state.bookingModule ? 0 : 1}
      onCancel={onClose}
      onSave={() => {
        actions.setBookingModule(draft);
        onClose();
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 16px' }}>
        {BOOKING_MODULES.map((m) => {
          const active = draft === m.id;
          return (
            <button
              key={m.id}
              role="radio"
              aria-checked={active}
              onClick={() => setDraft(m.id)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                textAlign: 'left',
                padding: '14px 16px',
                borderRadius: 10,
                border: `1.5px solid ${active ? 'var(--blue-500)' : 'var(--ink-200)'}`,
                background: active ? 'var(--blue-025)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  marginTop: 2,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: `2px solid ${active ? 'var(--blue-500)' : 'var(--ink-300)'}`,
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                {active && <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--blue-500)' }} />}
              </span>
              <span>
                <span style={{ display: 'block', font: '600 14px/1.2 var(--font-sans)', color: 'var(--ink-900)' }}>{m.name}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 12.5, color: 'var(--ink-600)' }}>{m.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </StagedModal>
  );
}

/*
 * Every settings card reads the same way and edits the same way: the card states what is
 * configured now, a Configure button opens a modal, and the modal applies nothing until Save.
 *
 * Staged rather than live throughout, because these settings are shared — they are the
 * workspace's, not one browser's — and a half-finished state is something a colleague can see.
 * The chrome lives here so one tab cannot drift from the others.
 */

function CardHead({ title, desc, onConfigure, action = 'Configure' }: { title: string; desc: ReactNode; onConfigure: () => void; action?: string }) {
  return (
    <div className={styles.cardHead} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
      <div>
        <h3 className={styles.cardTitle}>{title}</h3>
        <p className={styles.cardDesc}>{desc}</p>
      </div>
      <Button variant="secondary" onClick={onConfigure}>
        {action}
      </Button>
    </div>
  );
}

/** One read-only line of a card: what the thing is, and what it is set to. */
function SummaryRow({ name, desc, children }: { name: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.sumRow}>
      <div className={styles.sumText}>
        <div className={styles.sumName}>{name}</div>
        {desc != null && <div className={styles.sumDesc}>{desc}</div>}
      </div>
      <div className={styles.sumValue}>{children}</div>
    </div>
  );
}

/**
 * The editing half. `changed` drives both the count and whether Save is live, so a modal that
 * changes nothing cannot be saved — there is no such thing as an empty write to confirm.
 */
function StagedModal({
  title,
  subtitle,
  changed,
  unit = 'change',
  refused,
  onCancel,
  onSave,
  children,
}: {
  title: string;
  subtitle: string;
  changed: number;
  unit?: string;
  refused?: string;
  onCancel: () => void;
  onSave: () => void;
  children: ReactNode;
}) {
  return (
    <Modal onClose={onCancel} width={580}>
      <ModalHeader title={title} subtitle={subtitle} onClose={onCancel} />
      <div style={{ padding: '4px 0', maxHeight: '58vh', overflowY: 'auto' }}>{children}</div>
      {refused && (
        <div role="status" className={styles.refused}>
          {refused}
        </div>
      )}
      <ModalFooter>
        <span className={styles.rowDesc} style={{ marginRight: 'auto' }}>
          {changed ? `${changed} ${unit}${changed === 1 ? '' : 's'} changed` : ''}
        </span>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!changed} onClick={onSave}>
          Save changes
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** A row of colour swatches, used by both the state colours and the department colours. */
function SwatchPick({ palette, current, label, onPick }: { palette: readonly string[]; current: string; label: string; onPick: (hex: string) => void }) {
  return (
    <div className={styles.swatchRow}>
      {palette.map((hex) => (
        <button
          key={hex}
          className={styles.swatchBtn}
          aria-label={label}
          aria-pressed={current === hex}
          style={{ background: hex, boxShadow: current === hex ? '0 0 0 2px #fff, 0 0 0 4px var(--blue-500)' : 'none' }}
          onClick={() => onPick(hex)}
        />
      ))}
    </div>
  );
}

/**
 * Who reaches which TAB.
 *
 * The card reads; the modal edits. Staged rather than live because access is the one setting where
 * a half-finished state is dangerous — a role stripped of its last tab between two clicks is a
 * person locked out, and "changes apply immediately" gives them no moment to reconsider.
 */
function PermissionsTab() {
  const { state, actions } = useFloorplanData();
  const [editing, setEditing] = useState(false);

  const accessOf = (id: Surface): SurfaceAccess => state.access[id] ?? DEFAULT_ACCESS[id];

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3 className={styles.cardTitle}>Roles &amp; access</h3>
            <p className={styles.cardDesc}>Which of the org&rsquo;s roles can reach each tab. A tab nobody&rsquo;s role reaches is not shown to them at all.</p>
          </div>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Configure access
          </Button>
        </div>
        {SURFACES.map((s) => {
          const rule = accessOf(s.id);
          return (
            <SummaryRow key={s.id} name={s.name} desc={s.desc}>
              {rule.all ? (
                <span className={[styles.pill, styles.pillOn].join(' ')}>Everyone</span>
              ) : rule.roles.length ? (
                <RoleChips ids={rule.roles} roles={state.orgRoles} />
              ) : (
                <span className={[styles.pill, styles.pillMuted].join(' ')}>Hidden for everyone</span>
              )}
            </SummaryRow>
          );
        })}
        {state.viewerRole ? (
          <div className={styles.footNote}>
            You are signed in as <b>{state.viewerRole.name}</b>, so this is what you see.
          </div>
        ) : (
          <div className={styles.footNote}>
            This session carries no role, so every tab is shown. Access only takes effect where the org tells the app who is signed in.
          </div>
        )}
      </div>

      {editing && <AccessModal onClose={() => setEditing(false)} />}
    </div>
  );
}

/** Up to four names, then a count — an org has dozens of roles and a row cannot hold them. */
function RoleChips({ ids, roles }: { ids: string[]; roles: OrgRole[] }) {
  const named = ids.map((id) => roles.find((r) => r.id === id)?.name ?? `Role ${id}`);
  const shown = named.slice(0, 4);
  const rest = named.length - shown.length;
  return (
    <>
      {shown.map((n) => (
        <span key={n} className={styles.pill}>
          {n}
        </span>
      ))}
      {rest > 0 && <span className={[styles.pill, styles.pillMuted].join(' ')}>+{rest} more</span>}
    </>
  );
}

/**
 * Editing the grid. One draft, applied on Save and thrown away on Cancel.
 *
 * Two rules are enforced here AND in the function behind it, because either side alone can be
 * bypassed: Settings keeps its locked roles, and no role may be left without a single tab.
 */
/**
 * Choosing roles for one tab: a field that opens a floating list, the way Facilio's own FSelect
 * does. The list is portaled to <body> and positioned against the field with the app's own
 * `computePlacement` — the same mechanics as the `Select` primitive — so it floats OVER the modal
 * instead of opening inside its row, flips upward near the bottom, and is never clipped by the
 * modal's scrolling body. It closes like FSelect: a click anywhere else, Escape, or focus leaving it.
 */
export function RoleLookup({
  label,
  rule,
  roles,
  loading,
  locked,
  onToggleAll,
  onToggleRole,
  onClear,
}: {
  label: string;
  rule: SurfaceAccess;
  roles: OrgRole[];
  loading: boolean;
  locked: string[];
  onToggleAll: () => void;
  onToggleRole: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shown = open && placement != null;

  // Focus the search box once the list is actually on screen — NOT with `autoFocus`. React applies
  // autoFocus before the list's own ref is attached, so the focus-leaving check below saw focus land
  // on an element it did not yet know as its own, and closed the list the instant it opened.
  // Keyed on `shown`, not on placement, so a scroll that repositions the list does not pull focus
  // back to the search box from wherever the person has moved it.
  useEffect(() => {
    if (shown) searchRef.current?.focus();
  }, [shown]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => triggerRef.current && setPlacement(computePlacement(triggerRef.current));
    const inside = (n: Node | null) => !!n && (!!triggerRef.current?.contains(n) || !!menuRef.current?.contains(n));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // Focus moving somewhere else — Tab past the last option — closes it, as FSelect does.
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target as Node)) setOpen(false);
    };
    reposition();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const visible = q ? roles.filter((r) => r.name.toLowerCase().includes(q)) : roles;
  const count = rule.all ? roles.length : rule.roles.length;
  // With no roles to choose from, turning Everyone off can only leave the tab empty — hidden from
  // every role — so it is not offered.
  const everyoneLocked = rule.all && !roles.length;

  return (
    <div className={styles.lookup}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.lookupField}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Roles that can reach ${label}`}
        onClick={() => {
          setOpen((o) => !o);
          setQuery('');
        }}
      >
        <span className={styles.lookupValues}>
          {rule.all ? (
            <span className={[styles.pill, styles.pillOn].join(' ')}>Everyone</span>
          ) : rule.roles.length ? (
            <RoleChips ids={rule.roles} roles={roles} />
          ) : (
            <span className={styles.lookupPlaceholder}>Choose roles</span>
          )}
        </span>
        <svg className={styles.caret} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open &&
        placement &&
        createPortal(
          <div
            ref={menuRef}
            className={[styles.menu, styles.menuFloating].join(' ')}
            style={{
              left: placement.left,
              top: placement.top,
              width: placement.width,
              maxHeight: placement.maxHeight,
              transform: placement.up ? 'translateY(-100%)' : undefined,
            }}
          >
            <div className={styles.menuSearch}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={roles.length ? `Search ${roles.length} roles` : 'Search roles'}
                aria-label="Search roles"
              />
            </div>

            <div className={styles.menuList} role="listbox" aria-multiselectable>
              <button
                type="button"
                role="option"
                aria-selected={rule.all}
                disabled={everyoneLocked}
                className={[styles.opt, styles.optAll, rule.all ? styles.optOn : ''].join(' ')}
                onClick={onToggleAll}
              >
                <span className={styles.optBox}>{rule.all && <Tick />}</span>
                Everyone
                <span className={styles.optTag}>including roles added later</span>
              </button>

              {loading ? (
                <div className={styles.menuEmpty}>Loading roles…</div>
              ) : !roles.length ? (
                <div className={styles.menuEmpty}>The org&rsquo;s roles could not be loaded, so this tab stays open to everyone for now.</div>
              ) : !visible.length ? (
                <div className={styles.menuEmpty}>No role matches &ldquo;{query}&rdquo;.</div>
              ) : (
                visible.map((r) => {
                  const isLocked = locked.includes(r.id);
                  const on = rule.all || isLocked || rule.roles.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      disabled={rule.all || isLocked}
                      className={[styles.opt, on ? styles.optOn : ''].join(' ')}
                      onClick={() => onToggleRole(r.id)}
                    >
                      <span className={styles.optBox}>{on && <Tick />}</span>
                      {r.name}
                      {isLocked && <span className={styles.optTag}>always has Settings</span>}
                    </button>
                  );
                })
              )}
            </div>

            {roles.length > 0 && (
              <div className={styles.menuFoot}>
                <span>{rule.all ? 'Everyone is on — turn it off to choose specific roles.' : `${count} of ${roles.length} selected`}</span>
                {!rule.all && rule.roles.length > locked.length && (
                  <button type="button" className={styles.menuClear} onClick={onClear}>
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

function AccessModal({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const [draft, setDraft] = useState<Record<Surface, SurfaceAccess>>(() => {
    const out = {} as Record<Surface, SurfaceAccess>;
    for (const s of SURFACES) {
      const cur = state.access[s.id] ?? DEFAULT_ACCESS[s.id];
      out[s.id] = { all: cur.all, roles: [...cur.roles] };
    }
    return out;
  });
  const [refused, setRefused] = useState('');

  // The role list is only needed here, so it is read when this opens rather than on boot.
  useEffect(() => {
    if (!state.orgRoles.length && !state.orgRolesLoading) void actions.loadOrgRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roleName = (id: string) => state.orgRoles.find((r) => r.id === id)?.name ?? `Role ${id}`;

  /**
   * Roles that can never lose Settings: the org's own admin roles, by the flags Facilio puts on the
   * role record (`isSuperAdmin` / `isPrevileged`) — not by id, so this holds for every org without
   * knowing its ids, and survives a rename.
   */
  const adminIds = state.orgRoles.filter((r) => r.isAdmin).map((r) => r.id);
  const lockedFor = (surface: Surface): string[] => (surface === 'settings' ? adminIds : []);

  /**
   * How many TABS a role still reaches under `next`. Tabs only: the edit right is not somewhere to
   * land, so a role holding nothing but it is as stranded as one holding nothing at all.
   */
  function tabsFor(next: Record<Surface, SurfaceAccess>, roleId: string): number {
    return SURFACE_ORDER.filter((t) => next[t].all || next[t].roles.includes(roleId)).length;
  }
  /** Every role named anywhere in the draft — the only ones a change can strand. */
  function namedRoles(next: Record<Surface, SurfaceAccess>): string[] {
    const out: string[] = [];
    for (const s of SURFACES) for (const r of next[s.id].roles) if (!out.includes(r)) out.push(r);
    return out;
  }
  function commit(next: Record<Surface, SurfaceAccess>): void {
    const stranded = namedRoles(next).filter((r) => tabsFor(next, r) === 0);
    if (stranded.length) {
      setRefused(
        stranded.length === 1
          ? `${roleName(stranded[0])} would be left with no tab at all. Give them another tab first.`
          : `${stranded.length} roles would be left with no tab at all: ${stranded.slice(0, 3).map(roleName).join(', ')}${stranded.length > 3 ? '…' : ''}.`
      );
      return;
    }
    setRefused('');
    setDraft(next);
  }

  function toggleRole(surface: Surface, roleId: string): void {
    const cur = draft[surface];
    if (cur.all || lockedFor(surface).includes(roleId)) return;
    const roles = cur.roles.includes(roleId) ? cur.roles.filter((r) => r !== roleId) : [...cur.roles, roleId];
    commit({ ...draft, [surface]: { all: false, roles } });
  }
  function toggleAll(surface: Surface): void {
    const cur = draft[surface];
    if (cur.all && !state.orgRoles.length) {
      // Nothing to choose instead, so turning Everyone off could only leave the tab empty —
      // hidden from every role — and the save would lock everyone out of it.
      setRefused("The org's roles haven't loaded, so this tab can only be open to everyone for now.");
      return;
    }
    // Turning "everyone" off starts from the roles that may never lose this tab, not from nothing.
    commit({ ...draft, [surface]: cur.all ? { all: false, roles: [...lockedFor(surface)] } : { all: true, roles: [] } });
  }
  function clearRoles(surface: Surface): void {
    commit({ ...draft, [surface]: { all: false, roles: [...lockedFor(surface)] } });
  }

  const changed = SURFACES.filter((s) => {
    const a = state.access[s.id] ?? DEFAULT_ACCESS[s.id];
    const b = draft[s.id];
    return a.all !== b.all || [...a.roles].sort().join() !== [...b.roles].sort().join();
  }).length;

  return (
    <StagedModal
      title="Configure access"
      subtitle="Choose who can reach each tab. Nothing changes until you save."
      changed={changed}
      unit="tab"
      refused={refused}
      onCancel={onClose}
      onSave={() => {
        actions.setAccess(draft);
        onClose();
      }}
    >
      {SURFACES.map((s) => (
        <div key={s.id} className={styles.editRow}>
          <div className={styles.editLabel}>
            <div className={styles.sumName}>{s.name}</div>
            <div className={styles.sumDesc}>{s.desc}</div>
          </div>
          <RoleLookup
            label={s.name}
            rule={draft[s.id]}
            roles={state.orgRoles}
            loading={state.orgRolesLoading}
            locked={lockedFor(s.id)}
            onToggleAll={() => toggleAll(s.id)}
            onToggleRole={(id) => toggleRole(s.id, id)}
            onClear={() => clearRoles(s.id)}
          />
        </div>
      ))}
    </StagedModal>
  );
}

/** The check inside a selected option's box. */
function Tick() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ModulesTab() {
  const { state, actions } = useFloorplanData();
  const [editing, setEditing] = useState(false);

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <CardHead
          title="Modules in use"
          desc="What this workplace manages. A module turned off disappears from the whole app — its records are kept, just hidden, so turning it back on restores them."
          onConfigure={() => setEditing(true)}
        />
        {TOGGLEABLE_MODULES.map((m) => (
          <SummaryRow key={m} name={TYPE_META[m].name} desc={MODULE_BLURB[m]}>
            {state.enabledModules[m] ? (
              <span className={[styles.pill, styles.pillOn].join(' ')}>In use</span>
            ) : (
              <span className={[styles.pill, styles.pillMuted].join(' ')}>Hidden</span>
            )}
          </SummaryRow>
        ))}
        <p className={styles.footNote}>Facility markers (stairs, restrooms, extinguishers) always stay on the plan.</p>
      </div>
      {editing && <ModulesModal onClose={() => setEditing(false)} />}
    </div>
  );
}

function ModulesModal({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const [draft, setDraft] = useState<Record<ModuleKey, boolean>>(() => ({ ...state.enabledModules }) as Record<ModuleKey, boolean>);
  const [refused, setRefused] = useState('');

  const onCount = TOGGLEABLE_MODULES.filter((m) => draft[m]).length;
  const changed = TOGGLEABLE_MODULES.filter((m) => draft[m] !== state.enabledModules[m]).length;

  function toggle(m: ModuleKey) {
    if (draft[m] && onCount === 1) {
      // Refusing the last one keeps the app from becoming a blank plan with no way back.
      setRefused(`${TYPE_META[m].name} is the only module left. Turn another on before hiding it.`);
      return;
    }
    setRefused('');
    setDraft({ ...draft, [m]: !draft[m] });
  }

  return (
    <StagedModal
      title="Modules in use"
      subtitle="Pick what this workplace manages. Records are kept either way."
      changed={changed}
      unit="module"
      refused={refused}
      onCancel={onClose}
      onSave={() => {
        for (const m of TOGGLEABLE_MODULES) if (draft[m] !== state.enabledModules[m]) actions.setModuleEnabled(m, draft[m]);
        onClose();
      }}
    >
      {TOGGLEABLE_MODULES.map((m) => (
        <div key={m} className={styles.moduleRow}>
          <div className={styles.sumText} style={{ flex: 1 }}>
            <div className={styles.rowName}>{TYPE_META[m].name}</div>
            <div className={styles.rowDesc}>{MODULE_BLURB[m]}</div>
          </div>
          <button
            className={[styles.switch, draft[m] ? styles.switchOn : ''].join(' ')}
            onClick={() => toggle(m)}
            aria-pressed={draft[m]}
            aria-label={TYPE_META[m].name}
          >
            <span className={styles.knob} style={{ left: draft[m] ? 18 : 2 }} />
          </button>
        </div>
      ))}
    </StagedModal>
  );
}

const MODULE_BLURB: Record<ModuleKey, string> = {
  workstation: 'Desks — assigned seating and hot-desking.',
  room: 'Meeting rooms and other bookable spaces.',
  locker: 'Lockers, assigned to a person.',
  parking: 'Parking stalls, assigned or booked.',
  delivery: 'Delivery and loading areas, booked by slot.',
};

function ModuleTab({ type }: { type: UnitType }) {
  const { state } = useFloorplanData();
  const [editing, setEditing] = useState(false);
  const defs = STATE_DEFS[type];

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <CardHead
          title="States &amp; colour coding"
          desc="The colour each state takes on the floorplan and in the legend."
          onConfigure={() => setEditing(true)}
        />
        {defs.map((d) => (
          <SummaryRow key={d.key} name={d.label} desc={d.desc}>
            <span className={styles.swatchLg} style={{ background: moduleColor(state, type, d.key) }} aria-label={`${d.label} colour`} />
          </SummaryRow>
        ))}
      </div>

      {editing && <StateColorsModal type={type} onClose={() => setEditing(false)} />}

      {type === 'workstation' && <DeskLabelStyle />}
      {type === 'workstation' && <DepartmentColors />}
    </div>
  );
}

function StateColorsModal({ type, onClose }: { type: UnitType; onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const defs = STATE_DEFS[type];
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const d of defs) out[d.key] = moduleColor(state, type, d.key);
    return out;
  });

  const changed = defs.filter((d) => draft[d.key] !== moduleColor(state, type, d.key)).length;

  return (
    <StagedModal
      title={`${TYPE_META[type].name} — states & colour coding`}
      subtitle="Pick the colour each state takes on the plan and in the legend."
      changed={changed}
      unit="colour"
      onCancel={onClose}
      onSave={() => {
        for (const d of defs) if (draft[d.key] !== moduleColor(state, type, d.key)) actions.setModuleColor(`${type}.${d.key}`, draft[d.key]);
        onClose();
      }}
    >
      {defs.map((d) => (
        <div key={d.key} className={styles.stateRow}>
          <span className={styles.stateSwatch} style={{ background: draft[d.key] }} />
          <div className={styles.sumText} style={{ flex: 1 }}>
            <div className={styles.rowName}>{d.label}</div>
            <div className={styles.rowDesc}>{d.desc}</div>
          </div>
          <SwatchPick palette={STATE_SWATCHES} current={draft[d.key]} label={d.label} onPick={(hex) => setDraft({ ...draft, [d.key]: hex })} />
        </div>
      ))}
    </StagedModal>
  );
}

function DepartmentColors() {
  const { state } = useFloorplanData();
  const [editing, setEditing] = useState(false);
  // The ORG's own departments, read from the `department` module at boot — not merely the ones
  // that happen to sit on the floor currently open, so a team whose desks are all elsewhere
  // still gets a colour. The floor's own departments stand in when that list is unavailable
  // (the local tier), so Settings is never empty when the plan is clearly coloured.
  const departments = state.departments.length ? state.departments : departmentsIn(state.units);
  const ids = departments.map((d) => d.id);
  const on = state.colorBy === 'department';

  return (
    <div className={styles.card}>
      <CardHead
        title="Colour desks by"
        desc={
          <>
            Availability answers &ldquo;what can I take&rdquo;. Department answers &ldquo;who sits where&rdquo; &mdash; the question when you are
            moving a team. Assignment view only; Booking view always shows what is free.
          </>
        }
        onConfigure={() => setEditing(true)}
      />

      <SummaryRow
        name={on ? 'Department' : 'Availability'}
        desc={on ? 'Each desk takes its department’s colour, keeping the holder’s initials.' : 'Free and assigned desks take the state colours above.'}
      >
        <span className={[styles.pill, styles.pillOn].join(' ')}>{on ? 'By department' : 'By availability'}</span>
      </SummaryRow>

      {departments.length === 0 ? (
        <SummaryRow name="No departments yet" desc="No desk on the floors loaded so far carries a department. The colours appear here as soon as one does.">
          <span />
        </SummaryRow>
      ) : (
        departments.map((dept) => (
          <SummaryRow
            key={dept.id}
            name={departmentDisplayName(dept.name)}
            desc={`${state.units.filter((u) => u.departmentId === dept.id).length || 'No'} desks on this floor`}
          >
            <span className={styles.swatchLg} style={{ background: departmentColor(dept.id, state.departmentColors, ids) }} aria-label={`${dept.name} colour`} />
          </SummaryRow>
        ))
      )}

      {editing && <DepartmentColorsModal onClose={() => setEditing(false)} />}
    </div>
  );
}

function DepartmentColorsModal({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const departments = state.departments.length ? state.departments : departmentsIn(state.units);
  const ids = departments.map((d) => d.id);

  const [colorBy, setColorBy] = useState(state.colorBy);
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const d of departments) out[d.id] = departmentColor(d.id, state.departmentColors, ids);
    return out;
  });

  const changedColors = departments.filter((d) => draft[d.id] !== departmentColor(d.id, state.departmentColors, ids)).length;
  const changed = changedColors + (colorBy === state.colorBy ? 0 : 1);

  return (
    <StagedModal
      title="Colour desks by"
      subtitle="Pick what the desks are coloured by, and the colour each department takes."
      changed={changed}
      onCancel={onClose}
      onSave={() => {
        if (colorBy !== state.colorBy) actions.setColorBy(colorBy);
        for (const d of departments) {
          if (draft[d.id] !== departmentColor(d.id, state.departmentColors, ids)) actions.setDepartmentColor(d.id, draft[d.id], d.name);
        }
        onClose();
      }}
    >
      <div className={styles.stateRow}>
        <div className={styles.sumText} style={{ flex: 1 }}>
          <div className={styles.rowName}>What the colours mean</div>
          <div className={styles.rowDesc}>Assignment view only; Booking view always shows what is free.</div>
        </div>
        <div className={styles.swatchRow}>
          <Button variant={colorBy === 'department' ? 'secondary' : 'primary'} onClick={() => setColorBy('status')}>
            Availability
          </Button>
          <Button variant={colorBy === 'department' ? 'primary' : 'secondary'} onClick={() => setColorBy('department')}>
            Department
          </Button>
        </div>
      </div>

      {departments.length === 0 ? (
        <div className={styles.stateRow}>
          <div className={styles.sumText} style={{ flex: 1 }}>
            <div className={styles.rowDesc}>No desk on the floors loaded so far carries a department, so there is nothing to colour yet.</div>
          </div>
        </div>
      ) : (
        departments.map((dept) => (
          <div key={dept.id} className={styles.stateRow}>
            <span className={styles.stateSwatch} style={{ background: draft[dept.id] }} />
            <div className={styles.sumText} style={{ flex: 1 }}>
              <div className={styles.rowName}>{departmentDisplayName(dept.name)}</div>
              <div className={styles.rowDesc}>
                {state.units.filter((u) => u.departmentId === dept.id).length || 'No'} desks on this floor
              </div>
            </div>
            <SwatchPick
              palette={DEPARTMENT_PALETTE}
              current={draft[dept.id]}
              label={dept.name}
              onPick={(hex) => setDraft({ ...draft, [dept.id]: hex })}
            />
          </div>
        ))
      )}
    </StagedModal>
  );
}

/* ─────────────────────────── Desk labels ─────────────────────────── */

const NAME_SIZES = [
  { v: 7.5, l: 'Small' },
  { v: 8.5, l: 'Default' },
  { v: 10, l: 'Large' },
  { v: 12, l: 'Larger' },
];
const DETAIL_SIZES = [
  { v: 7, l: 'Small' },
  { v: 8, l: 'Default' },
  { v: 9.5, l: 'Large' },
  { v: 11, l: 'Larger' },
];
const WEIGHTS = [
  { v: 400, l: 'Regular' },
  { v: 500, l: 'Medium' },
  { v: 600, l: 'Semibold' },
  { v: 700, l: 'Bold' },
];

/**
 * The type the desk labels are drawn in: the desk's name (the primary line) and the holder and
 * department under it (the details), each a size and a weight. The defaults are what the plan
 * ships with; the choice is saved with the workspace's other settings, so it follows the user to
 * every device. Settings does not show the plan, so a sample shows what the choice looks like.
 */
function DeskLabelStyle() {
  const { state } = useFloorplanData();
  const [editing, setEditing] = useState(false);
  const t = typographyOf(state.labelStyle);

  return (
    <div className={styles.card}>
      <CardHead
        title="Desk labels"
        desc="The text beside each desk — its name, then who holds it and their department. Outlined, with no box, so the drawing shows through."
        onConfigure={() => setEditing(true)}
      />
      <div className={styles.labelSample} aria-label="How desk labels read now">
        <div className={styles.labelSampleChip} />
        <div style={{ textAlign: 'center', ...HALO_TEXT }}>
          <div style={{ font: `${t.nameWeight} ${t.nameFont}px/${t.nameLine}px var(--font-sans)`, color: 'var(--ink-900)' }}>WS-05</div>
          <div style={{ font: `${t.subWeight} ${t.subFont}px/${t.subLine}px var(--font-sans)`, color: 'var(--ink-800)' }}>Amrithya Nair</div>
          <div style={{ font: `${t.deptWeight} ${t.deptFont}px/${t.deptLine}px var(--font-sans)`, color: 'var(--ink-600)' }}>Project Implementation</div>
        </div>
      </div>
      {editing && <DeskLabelModal onClose={() => setEditing(false)} />}
    </div>
  );
}

function DeskLabelModal({ onClose }: { onClose: () => void }) {
  const { state, actions } = useFloorplanData();
  const [draft, setDraft] = useState<LabelStyle>(state.labelStyle);
  const t = typographyOf(draft);
  const changed = JSON.stringify(draft) === JSON.stringify(state.labelStyle) ? 0 : 1;
  const update = (part: keyof LabelStyle, patch: Partial<LabelStyle['name']>) => setDraft({ ...draft, [part]: { ...draft[part], ...patch } });

  return (
    <StagedModal
      title="Desk labels"
      subtitle="Set the type the labels are drawn in. The sample shows the change before you save it."
      changed={changed}
      onCancel={onClose}
      onSave={() => {
        actions.setLabelStyle(draft);
        onClose();
      }}
    >
      <LabelTypeRow label="Desk name" sizes={NAME_SIZES} value={draft.name} onChange={(patch) => update('name', patch)} />
      <LabelTypeRow label="Holder & department" sizes={DETAIL_SIZES} value={draft.detail} onChange={(patch) => update('detail', patch)} />
      {/* Settings does not show the plan, so the sample is the only place the choice is visible. */}
      <div className={styles.labelSample} aria-label="Sample">
        <div className={styles.labelSampleChip} />
        <div style={{ textAlign: 'center', ...HALO_TEXT }}>
          <div style={{ font: `${t.nameWeight} ${t.nameFont}px/${t.nameLine}px var(--font-sans)`, color: 'var(--ink-900)' }}>WS-05</div>
          <div style={{ font: `${t.subWeight} ${t.subFont}px/${t.subLine}px var(--font-sans)`, color: 'var(--ink-800)' }}>Amrithya Nair</div>
          <div style={{ font: `${t.deptWeight} ${t.deptFont}px/${t.deptLine}px var(--font-sans)`, color: 'var(--ink-600)' }}>Project Implementation</div>
        </div>
      </div>
      <div className={styles.footNote} style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="secondary" onClick={() => setDraft(DEFAULT_LABEL_STYLE)}>
          Reset to default
        </Button>
      </div>
    </StagedModal>
  );
}


function LabelTypeRow({ label, sizes, value, onChange }: { label: string; sizes: { v: number; l: string }[]; value: { size: number; weight: number }; onChange: (patch: { size?: number; weight?: number }) => void }) {
  return (
    <div className={styles.labelRow}>
      <div className={styles.labelRowName}>{label}</div>
      <div className={styles.labelChoices}>
        <span className={styles.labelChoiceName}>Size</span>
        {sizes.map((o) => (
          <button key={o.v} className={[styles.slotChip, styles.labelChip, value.size === o.v ? styles.slotChipActive : ''].join(' ')} onClick={() => onChange({ size: o.v })}>
            {o.l}
          </button>
        ))}
      </div>
      <div className={styles.labelChoices}>
        <span className={styles.labelChoiceName}>Weight</span>
        {WEIGHTS.map((o) => (
          <button key={o.v} className={[styles.slotChip, styles.labelChip, value.weight === o.v ? styles.slotChipActive : ''].join(' ')} style={{ fontWeight: o.v }} onClick={() => onChange({ weight: o.v })}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}
