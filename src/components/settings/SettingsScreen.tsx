import { useFloorplan } from '../../state/FloorplanContext';
import { ACTIONS, OPT_DEFS, ROLES, STATE_DEFS, STATE_SWATCHES, TOGGLEABLE_MODULES, TYPE_META } from '../../lib/types';
import type { ModuleKey, PermsAction, Role, UnitType } from '../../lib/types';
import { moduleEnabled } from '../../state/selectors';
import { Button } from '../primitives/Button';
import { moduleColor, moduleOpt } from '../../lib/unitStatus';
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

const SLOT_OPTIONS = [
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
  { minutes: 120, label: '2h' },
];

export function SettingsScreen() {
  const { state, actions } = useFloorplan();

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
  const { state, actions } = useFloorplan();
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h3 className={styles.cardTitle}>Booking module</h3>
          <p className={styles.cardDesc}>
            Choose how bookings are made across the app. Only one can be active at a time — every booking (calendar and floor plan) routes through the
            selected module.
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' }}>
        {BOOKING_MODULES.map((m) => {
          const active = state.bookingModule === m.id;
          return (
            <button
              key={m.id}
              onClick={() => actions.setBookingModule(m.id)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
                textAlign: 'left',
                padding: '14px 16px',
                borderRadius: 10,
                border: `1.5px solid ${active ? 'var(--blue-500)' : 'var(--ink-200)'}`,
                background: active ? 'var(--blue-025)' : '#fff',
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
      <div className={styles.footNote}>
        Currently active: <b>{BOOKING_MODULES.find((m) => m.id === state.bookingModule)?.name}</b>. Bookings are also saved locally for now — real{' '}
        {state.bookingModule === 'space' ? 'spacebooking' : 'facilitybooking'} records are written when the backend is reachable.
      </div>
    </div>
  );
}

function PermissionsTab() {
  const { state, actions } = useFloorplan();
  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3 className={styles.cardTitle}>Roles &amp; access</h3>
            <p className={styles.cardDesc}>Choose which roles can perform each action. Changes apply immediately and are saved for your workspace.</p>
          </div>
          <Button variant="secondary" onClick={actions.resetPerms}>
            Reset to defaults
          </Button>
        </div>
        <div className={styles.matrixHead}>
          <span>Action</span>
          {ROLES.map((r) => (
            <span key={r.id} className={styles.matrixHeadCell}>
              {r.name}
            </span>
          ))}
        </div>
        {ACTIONS.map((a) => (
          <div key={a.id} className={styles.matrixRow}>
            <div>
              <div className={styles.rowName}>{a.name}</div>
              <div className={styles.rowDesc}>{a.desc}</div>
            </div>
            {ROLES.map((r) => (
              <div key={r.id} className={styles.switchCell}>
                <PermSwitch action={a.id} role={r.id} />
              </div>
            ))}
          </div>
        ))}
        <div className={styles.footNote} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span>
            Preview the app as a role:
          </span>
          <div style={{ display: 'inline-flex', gap: 4, padding: 4, background: 'var(--ink-050)', border: '1px solid var(--ink-200)', borderRadius: 8 }}>
            {ROLES.map((r) => (
              <button
                key={r.id}
                onClick={() => actions.setRole(r.id)}
                style={{
                  height: 28,
                  padding: '0 12px',
                  border: 'none',
                  borderRadius: 6,
                  background: state.role === r.id ? 'var(--blue-500)' : 'transparent',
                  color: state.role === r.id ? '#fff' : 'var(--ink-600)',
                  font: '600 12px/1 var(--font-sans)',
                  cursor: 'pointer',
                }}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3 className={styles.cardTitle}>Local data</h3>
            <p className={styles.cardDesc}>
              In local dev the app seeds from the editable JSON in <code>src/data</code> (sites,
              people, assets, spaces, bookings) and layers this session&rsquo;s edits on top in the
              browser. Clearing wipes those local edits and reloads, re-seeding from the repo JSON
              (and any live Facilio API data in connected-app mode).
            </p>
          </div>
          <Button variant="secondary" onClick={actions.clearCaches}>
            Clear local data
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermSwitch({ action, role }: { action: PermsAction; role: Role }) {
  const { state, actions } = useFloorplan();
  const on = state.perms[action].includes(role);
  return (
    <button className={[styles.switch, on ? styles.switchOn : ''].join(' ')} onClick={() => actions.togglePerm(action, role)}>
      <span className={styles.knob} style={{ left: on ? 18 : 2 }} />
    </button>
  );
}

/**
 * Which modules this workplace runs. Switching one off hides it everywhere — plan, legend, edit
 * tools, filters, panels and its own settings tab — so an org that has no lockers never sees the
 * word. Stored with the rest of settings (the app's vibe DB when deployed), so the choice is the
 * workplace's, not one browser's.
 */
function ModulesTab() {
  const { state } = useFloorplan();
  const enabledCount = TOGGLEABLE_MODULES.filter((m) => state.enabledModules[m]).length;

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>Modules in use</h3>
          <p className={styles.cardDesc}>
            Turn off anything this workplace doesn’t manage. A disabled module disappears from the whole app — existing records are
            kept, just hidden, so switching it back on restores them.
          </p>
        </div>
        {TOGGLEABLE_MODULES.map((m) => (
          <div key={m} className={styles.moduleRow}>
            <div className={styles.stateText}>
              <div className={styles.rowName}>{TYPE_META[m].name}</div>
              <div className={styles.rowDesc}>{MODULE_BLURB[m]}</div>
            </div>
            <ModuleSwitch module={m} disabled={enabledCount === 1 && state.enabledModules[m]} />
          </div>
        ))}
        <p className={styles.footNote}>Facility markers (stairs, restrooms, extinguishers) always stay on the plan.</p>
      </div>
    </div>
  );
}

const MODULE_BLURB: Record<ModuleKey, string> = {
  workstation: 'Desks — assigned seating and hot-desking.',
  room: 'Meeting rooms and other bookable spaces.',
  locker: 'Lockers, assigned to a person.',
  parking: 'Parking stalls, assigned or booked.',
  delivery: 'Delivery and loading areas, booked by slot.',
};

function ModuleSwitch({ module, disabled }: { module: ModuleKey; disabled: boolean }) {
  const { state, actions } = useFloorplan();
  const on = state.enabledModules[module];
  return (
    <button
      className={[styles.switch, on ? styles.switchOn : ''].join(' ')}
      // Refusing the last one keeps the app from becoming a blank plan with no way back.
      disabled={disabled}
      title={disabled ? 'At least one module must stay on' : on ? `Turn off ${TYPE_META[module].name}` : `Turn on ${TYPE_META[module].name}`}
      style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      onClick={() => actions.setModuleEnabled(module, !on)}
      aria-pressed={on}
      aria-label={TYPE_META[module].name}
    >
      <span className={styles.knob} style={{ left: on ? 18 : 2 }} />
    </button>
  );
}

function OptSwitch({ type, optKey }: { type: UnitType; optKey: string }) {
  const { state, actions } = useFloorplan();
  const on = moduleOpt(state, type, optKey);
  return (
    <button className={[styles.switch, on ? styles.switchOn : ''].join(' ')} onClick={() => actions.setModuleOpt(`${type}.${optKey}`, !on)} aria-pressed={on}>
      <span className={styles.knob} style={{ left: on ? 18 : 2 }} />
    </button>
  );
}

function ModuleTab({ type }: { type: UnitType }) {
  const { state, actions } = useFloorplan();
  const defs = STATE_DEFS[type];
  const showSlot = type !== 'locker';

  return (
    <div className={styles.stack}>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h3 className={styles.cardTitle}>States &amp; color coding</h3>
          <p className={styles.cardDesc}>Pick the color used on the floorplan and legend for each state.</p>
        </div>
        {defs.map((s) => (
          <div key={s.key} className={styles.stateRow}>
            <span className={styles.stateSwatch} style={{ background: moduleColor(state, type, s.key) }} />
            <div className={styles.stateText}>
              <div className={styles.rowName}>{s.label}</div>
              <div className={styles.rowDesc}>{s.desc}</div>
            </div>
            <div className={styles.swatchRow}>
              {STATE_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  title={hex}
                  className={styles.swatchBtn}
                  style={{
                    background: hex,
                    boxShadow: moduleColor(state, type, s.key) === hex ? '0 0 0 2px #fff, 0 0 0 4px var(--blue-500)' : 'none',
                  }}
                  onClick={() => actions.setModuleColor(`${type}.${s.key}`, hex)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {OPT_DEFS[type].length > 0 && (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>Configuration</h3>
            <p className={styles.cardDesc}>How this module behaves for everyone in the workplace.</p>
          </div>
          {OPT_DEFS[type].map((o) => (
            <div key={o.key} className={styles.matrixRow} style={{ gridTemplateColumns: '1fr 100px' }}>
              <div className={styles.stateText}>
                <div className={styles.rowName}>{o.label}</div>
                <div className={styles.rowDesc}>{o.desc}</div>
              </div>
              <div className={styles.switchCell}>
                <OptSwitch type={type} optKey={o.key} />
              </div>
            </div>
          ))}
        </div>
      )}

      {showSlot && (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>Default slot length</h3>
            <p className={styles.cardDesc}>New bookings start at this length. Drag the calendar edges to fine-tune any booking.</p>
          </div>
          <div className={styles.slotRow}>
            {SLOT_OPTIONS.map((o) => (
              <button
                key={o.minutes}
                className={[styles.slotChip, state.slotGranularity === o.minutes ? styles.slotChipActive : ''].join(' ')}
                onClick={() => actions.setSlotGranularity(o.minutes)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
