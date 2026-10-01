import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFloorplanData } from '../../state/FloorplanContext';
import { isBookable, mergeWithOrgPool, unitById } from '../../state/selectors';
import { fmtTime } from '../../lib/geometry';
import { epochAtInTz, orgTimezone } from '../../lib/orgTime';
import { useOrgClock } from '../../hooks/useOrgClock';
import { isFacilioApiConfigured } from '../../lib/facilioApi';
import { bookingFormsForType, fetchBookingFormById, fetchBookingFormList, fetchOrgBookableResources, fetchOrgBookingsForRange, pickDefaultBookingForm, resolveFormResourceTypes } from '../../lib/facilioApiDataSource';
import type { BookingFormFieldMeta, BookingFormMeta, BookingFormSummary } from '../../lib/facilioApiDataSource';
import { isRoomLike } from '../../lib/types';
import type { Employee, Unit, UnitType } from '../../lib/types';
import { Modal, ModalFooter, ModalHeader } from '../primitives/Modal';
import { Select } from '../primitives/Select';
import { DatePicker } from '../primitives/DatePicker';
import { Button } from '../primitives/Button';
import { ButtonSpinner } from '../primitives/ButtonSpinner';
import card from './Card.module.css';

/**
 * The booking form: the org's own configured form for the module, rendered field by field, with
 * this app's controls standing in for the resource lookup and the booking window.
 *
 * The window is free: a start and an end, each its own date and time, as far apart as the user
 * likes — an afternoon, overnight, a fortnight. There is no fixed slot length and no cap, for
 * desks and rooms alike; the org's own form rules still apply on submit.
 */

/** Resource-field label per unit type, in space-booking mode (matches the real Facilio forms). */
const SPACE_RESOURCE_LABEL: Record<UnitType, string> = { workstation: 'Desk', parking: 'Parking', room: 'Location', delivery: 'Location', locker: 'Locker', amenity: 'Amenity' };
/** Fallback chip names when the org form isn't reachable (local mode) — mirrors the system forms. */
const SPACE_FORM_NAME: Record<UnitType, string> = {
  workstation: 'Desk Booking Form',
  parking: 'Parking Booking Form',
  room: 'Space Booking Form',
  delivery: 'Space Booking Form',
  locker: 'Locker Form',
  amenity: 'Space Booking Form',
};
const FACILITY_FORM_NAME: Record<UnitType, string> = {
  workstation: 'Hot Desk Booking',
  parking: 'Parking Booking',
  room: 'Space Booking',
  delivery: 'Space Booking',
  locker: 'Locker Booking',
  amenity: 'Space Booking',
};

/** Org-form fields the modal maps onto its own controls; everything else renders generically. */
const KNOWN_FIELDS = new Set(['name', 'description', 'host', 'reservedBy', 'noOfAttendees', 'bookingStartTime', 'bookingEndTime', 'internalAttendees', 'externalAttendees']);

/** "2h", "10h 30m", "3d 4h" — the window's length, shown under the pickers. */
function fmtSpan(mins: number): string {
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Minutes from a fixed epoch for a date + time pair, so windows compare across days. */
function absMin(dateISO: string, m: number): number {
  return Math.round(new Date(`${dateISO}T00:00:00`).getTime() / 60000) + m;
}

function baseFieldName(name: string): string {
  return name.toLowerCase().replace(/_(space|facility)booking$/, '');
}

/**
 * What a form's lookup points at (`field.lookupModule`) → the unit type it books. Resource fields
 * are identified from this, never from hardcoded names: an org's room picker arrives as, say,
 * `meeting_rooms_spacebooking` with lookupModule `rooms`.
 */
const RESOURCE_LOOKUP_TYPE: Record<string, UnitType> = {
  desks: 'workstation',
  desk: 'workstation',
  rooms: 'room',
  space: 'room',
  basespace: 'room',
  parkingstall: 'parking',
  parkinglot: 'parking',
  lockers: 'locker',
};
const PEOPLE_LOOKUPS = new Set(['people', 'employee', 'clientcontact', 'users']);
/** The most SPECIFIC lookup decides a form's type: a room form that also carries a desks lookup is a room form. */
const LOOKUP_SPECIFICITY: Record<string, number> = { rooms: 0, parkingstall: 1, parkinglot: 1, lockers: 2, desks: 3, desk: 3, space: 4, basespace: 4 };
export function typeFromFormFields(fields: { lookupModule?: string }[]): UnitType | null {
  let best: { rank: number; type: UnitType } | null = null;
  for (const f of fields) {
    const lm = (f.lookupModule ?? '').toLowerCase();
    const type = lm ? RESOURCE_LOOKUP_TYPE[lm] : undefined;
    if (!type) continue;
    const rank = LOOKUP_SPECIFICITY[lm] ?? 5;
    if (!best || rank < best.rank) best = { rank, type };
  }
  return best?.type ?? null;
}

/** A booking step of half an hour on the pickers — the resolution, not a length. */
const STEP_MIN = 30;
/** How far ahead a booking may start or end. */
const HORIZON_DAYS = 365;

export function BookingModal() {
  const { state } = useFloorplanData();
  if (!state.bookForm) return null;
  const target = state.bookForm;
  // Remount (fresh field state) whenever the form opens for a different resource/window.
  return <BookingFormInner key={`${target.unitId}:${target.date}:${target.start}:${target.end}:${target.endDate ?? ''}`} />;
}

function BookingFormInner() {
  const { state, actions } = useFloorplanData();
  const target = state.bookForm!;
  // The RESOURCE is a form lookup: the plan/calendar pick is only the default; any bookable unit of
  // the same type can be picked here.
  const [resourceId, setResourceId] = useState(target.unitId);
  // Org-wide resources (the calendar) aren't in state.units — the same pool the calendar lists is
  // read here so the type switch and the lookup work from any floor; the snapshot covers the
  // moment before it lands. Re-read on every open and on every type switch, never a stale list.
  const snap = target.resourceUnit;
  const [orgUnits, setOrgUnits] = useState<Unit[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(isFacilioApiConfigured);
  const [resourceNonce, setResourceNonce] = useState(0);
  useEffect(() => {
    if (!isFacilioApiConfigured) return;
    let alive = true;
    setResourcesLoading(true);
    fetchOrgBookableResources({ force: true })
      .then((u) => {
        if (!alive) return;
        setOrgUnits(u);
        setResourcesLoading(false);
      })
      .catch(() => alive && setResourcesLoading(false));
    return () => {
      alive = false;
    };
  }, [resourceNonce]);
  const unitPool = useMemo(() => {
    // From the PLAN, the lookup offers what is on that plan: booking from a floor means booking
    // something on it. The calendar is org-wide — with a floor filter applied, the lookups follow it.
    const onFloorplan = state.activeView === 'map';
    const scope = target.floorIds && target.floorIds.length ? new Set(target.floorIds) : null;
    const pool = mergeWithOrgPool(
      state.units,
      orgUnits.filter((u) => (onFloorplan ? u.floor === state.floorId : !scope || scope.has(u.floor)))
    );
    if (snap && !pool.some((u) => u.id === snap.id)) pool.push(snap);
    return pool;
  }, [state.units, orgUnits, snap, state.activeView, state.floorId, target.floorIds]);
  const unit = unitById(state, resourceId) ?? unitPool.find((u) => u.id === resourceId) ?? unitById(state, target.unitId) ?? snap ?? null;
  // In "All spaces" the chosen FORM decides what is being booked; the resource follows it.
  const [typeOverride, setTypeOverride] = useState<UnitType | null>(null);
  const effType: UnitType = typeOverride ?? unit?.type ?? 'workstation';
  useEffect(() => {
    if (!typeOverride || unit?.type === typeOverride) return;
    const first = unitPool.find((u) => u.type === typeOverride && isBookable(u));
    if (first) setResourceId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeOverride, unitPool]);
  const lastType = useRef(effType);
  useEffect(() => {
    if (lastType.current === effType) return;
    lastType.current = effType;
    setResourceNonce((n) => n + 1);
  }, [effType]);

  const module = state.bookingModule;
  const contacts = state.employees;

  const defaultContact = contacts.some((c) => c.id === state.bookBy) ? state.bookBy : contacts[0]?.id ?? '';

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [host, setHost] = useState(defaultContact);
  const [reservedBy, setReservedBy] = useState(defaultContact);
  const [noOfAttendees, setNoOfAttendees] = useState('1');
  const [internalAttendees, setInternalAttendees] = useState<string[]>([]);
  const [externalAttendees, setExternalAttendees] = useState<string[]>([]);
  // The window: a start date+time and an end date+time, each free.
  const [slotDate, setSlotDate] = useState(target.date);
  const [startMin, setStartMin] = useState(target.start);
  const [endDate, setEndDate] = useState(target.endDate ?? target.date);
  const [endMin, setEndMin] = useState(target.endDate && target.endDate !== target.date ? target.end : Math.max(target.end, target.start + STEP_MIN));
  const [submitting, setSubmitting] = useState(false);
  // Values of org-form fields the app doesn't model natively, keyed by field name.
  const [extras, setExtras] = useState<Record<string, string>>({});

  // The org's configured forms (v2/forms) for the module; each typed by its own resource lookup.
  const [formList, setFormList] = useState<BookingFormSummary[]>([]);
  const [formTypes, setFormTypes] = useState<Map<number, UnitType | null>>(new Map());
  const [formId, setFormId] = useState<number | null>(null);
  const [formMeta, setFormMeta] = useState<BookingFormMeta | null>(null);
  const [formLoading, setFormLoading] = useState<boolean>(isFacilioApiConfigured);

  // Step 1: the module's form list, then the default for this unit type.
  useEffect(() => {
    let alive = true;
    if (!isFacilioApiConfigured || !unit) {
      setFormLoading(false);
      return;
    }
    fetchBookingFormList(module).then((forms) => {
      if (!alive) return;
      setFormList(forms);
      void resolveFormResourceTypes(module, forms)
        .then((types) => {
          if (alive) setFormTypes(types);
        })
        .catch(() => {});
      const def = pickDefaultBookingForm(forms, module, unit.type);
      if (def) setFormId(def.id);
      else setFormLoading(false); // no forms — the built-in layout stands in
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Forms the header offers for what is being booked. All spaces offers both types' forms.
  const formsForCurrentType = useMemo(() => {
    if (!unit) return [];
    const byLookup = (t: UnitType) => formList.filter((f) => formTypes.get(f.id) === t);
    if (target.allowTypeSwitch) {
      const both = [
        ...(byLookup('workstation').length ? byLookup('workstation') : bookingFormsForType(formList, module, 'workstation')),
        ...(byLookup('room').length ? byLookup('room') : bookingFormsForType(formList, module, 'room')),
      ];
      const seen = new Set<number>();
      return both.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
    }
    const typed = byLookup(effType);
    return typed.length ? typed : bookingFormsForType(formList, module, effType);
  }, [formList, formTypes, module, effType, unit, target.allowTypeSwitch]);

  /** Which resource type a form belongs to — picking a form in All spaces switches to it. */
  const typeOfForm = (id: number): UnitType | null => {
    const resolved = formTypes.get(id);
    if (resolved) return resolved;
    if (bookingFormsForType(formList, module, 'workstation').some((f) => f.id === id)) return 'workstation';
    if (bookingFormsForType(formList, module, 'room').some((f) => f.id === id)) return 'room';
    return null;
  };

  // A type switch re-picks that type's own form.
  useEffect(() => {
    if (!formList.length || !unit) return;
    if (formsForCurrentType.length === 1) {
      if (formsForCurrentType[0].id !== formId) setFormId(formsForCurrentType[0].id);
      return;
    }
    if (formsForCurrentType.length > 1) {
      if (formId != null && formsForCurrentType.some((f) => f.id === formId)) return;
      const def = target.allowTypeSwitch ? null : pickDefaultBookingForm(formsForCurrentType, module, effType);
      setFormId(def ? def.id : null);
      return;
    }
    const def = pickDefaultBookingForm(formList, module, effType);
    if (def && def.id !== formId) setFormId(def.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effType, formList]);

  // Step 2: the chosen form's fields.
  useEffect(() => {
    if (formId == null) {
      setFormMeta(null);
      setFormLoading(false);
      return;
    }
    let alive = true;
    setFormLoading(true);
    fetchBookingFormById(module, formId).then((meta) => {
      if (!alive) return;
      setFormMeta(meta);
      setFormLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  const isFacility = module === 'facility';
  /** A form picker is offered only where the context can't decide: the All-spaces switch. */
  const canPickForm = !!target.allowTypeSwitch;

  /**
   * The RESOURCE field on the loaded form, from its own metadata — rendered as the lookup and
   * named on the create payload. NOTE: every hook stays above the `if (!unit)` bail-out below.
   */
  const formResourceField = useMemo(() => {
    if (!formMeta || !unit) return null;
    const hit = [...formMeta.fields].filter(isResourceField).sort((a, b) => resourceFieldRank(a) - resourceFieldRank(b))[0];
    return hit?.name ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formMeta, unit?.type, isFacility]);

  // The loaded form is the authority on what it books: re-derive the type from its fields.
  useEffect(() => {
    if (!canPickForm || !formMeta) return;
    const t = typeFromFormFields(formMeta.fields);
    if (t && t !== effType) setTypeOverride(t);
  }, [formMeta, canPickForm, effType]);

  const nowOrg = useOrgClock();

  // This resource's existing bookings over every day the window touches — the clash line.
  const [conflicts, setConflicts] = useState<{ date: string; start: number; end: number; name?: string }[]>([]);
  useEffect(() => {
    if (!isFacilioApiConfigured || !unit || !resourceId) {
      setConflicts([]);
      return;
    }
    const winStart = absMin(slotDate, startMin);
    const winEnd = absMin(endDate, endMin);
    let alive = true;
    const timer = window.setTimeout(() => {
      fetchOrgBookingsForRange(slotDate, endDate < slotDate ? slotDate : endDate, { resourceField: isRoomLike(unit.type) ? 'space' : 'desk', resourceIds: [unit.id] })
        .then((rows) => {
          if (!alive) return;
          setConflicts(
            rows
              .filter((b) => b.unitId === unit.id && absMin(b.date, b.start) < winEnd && absMin(b.date, b.end) > winStart)
              .map((b) => ({ date: b.date, start: b.start, end: b.end, name: b.name }))
          );
        })
        .catch(() => alive && setConflicts([]));
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unit?.id, resourceId, slotDate, startMin, endMin, endDate, state.bookingsNonce]);

  if (!unit) return null;

  const isRoom = isRoomLike(effType);
  const resourceFieldLabel = isFacility ? 'Facility' : SPACE_RESOURCE_LABEL[effType];
  const fallbackFormName = isFacility ? FACILITY_FORM_NAME[unit.type] : SPACE_FORM_NAME[unit.type];
  const reserverLabel = isFacility ? 'Reserved For' : 'Reserved By';

  // The window, on the ORG clock: "today" is the facility's today.
  const minDate = nowOrg.dateISO;
  const maxDate = addDaysIso(minDate, HORIZON_DAYS);
  const startAbs = absMin(slotDate, startMin);
  const endAbs = absMin(endDate, endMin);
  /** Still ahead? Compared as org-zone epochs, with a minute of grace for the current slot. */
  const startSelectable = epochAtInTz(slotDate, startMin, orgTimezone()) >= Date.now() - 60_000;

  const contactOptions = contacts.map((c) => ({ value: c.id, label: c.name, sublabel: c.department }));

  /** Any resource-family field, read from the form's own lookup metadata. */
  function isResourceFamilyField(f: BookingFormFieldMeta): boolean {
    const lm = (f.lookupModule ?? '').toLowerCase();
    return lm === 'facility' || lm in RESOURCE_LOOKUP_TYPE;
  }

  /** THE resource field for what is being booked: a room fills the space lookup, a desk the desk one. */
  function isResourceField(f: BookingFormFieldMeta): boolean {
    const lm = (f.lookupModule ?? '').toLowerCase();
    const nm = baseFieldName(f.name);
    if (isFacility) return lm === 'facility';
    if (lm in RESOURCE_LOOKUP_TYPE) return RESOURCE_LOOKUP_TYPE[lm] === (isRoom ? 'room' : effType);
    if (isRoom) return ['space', 'location'].includes(nm);
    switch (effType) {
      case 'workstation':
        return nm === 'desk';
      case 'parking':
        return nm === 'parking';
      case 'locker':
        return nm === 'locker';
      default:
        return isResourceFamilyField(f);
    }
  }

  /** A form can carry two fields for one thing (Location and Meeting Rooms): the most specific is shown. */
  function resourceFieldRank(f: BookingFormFieldMeta): number {
    const lm = (f.lookupModule ?? '').toLowerCase();
    if (isRoom) return lm === 'rooms' ? 0 : lm === 'space' || lm === 'basespace' ? 2 : 1;
    return lm in RESOURCE_LOOKUP_TYPE ? 0 : 1;
  }
  const primaryResourceFieldName = formMeta ? ([...formMeta.fields].filter(isResourceField).sort((a, b) => resourceFieldRank(a) - resourceFieldRank(b))[0]?.name ?? null) : null;

  /** Org fields rendered generically → typed extras for the API. */
  function collectExtras(meta: BookingFormMeta | null): { values: Record<string, unknown>; missing: string | null } {
    if (!meta) return { values: {}, missing: null };
    const values: Record<string, unknown> = {};
    for (const f of meta.fields) {
      // The resource family is excluded: the payload's own lookup carries the resource, and a
      // shared form's other-type field must neither travel nor block submit as "required".
      if (KNOWN_FIELDS.has(f.name) || isResourceFamilyField(f)) continue;
      const raw = (extras[f.name] ?? '').trim();
      if (!raw) {
        if (f.required) return { values, missing: f.label || f.name };
        continue;
      }
      if (f.lookupModule) {
        // Any lookup travels as {id}. Demo ids ("c1") have no record behind them and are dropped.
        const id = Number(raw);
        if (Number.isFinite(id)) values[f.name] = { id };
        else if (f.required) return { values, missing: f.label || f.name };
      } else if (f.type === 'NUMBER' || f.type === 'DECIMAL') values[f.name] = Number(raw);
      else if (f.type === 'DATE' || f.type === 'DATETIME') {
        // Epoch millis on the wire, read in the org's zone.
        const [d, t] = raw.split('T');
        const [hh, mm] = (t ?? '00:00').split(':').map(Number);
        const ts = /^\d{4}-\d{2}-\d{2}$/.test(d) ? epochAtInTz(d, (hh || 0) * 60 + (mm || 0), orgTimezone()) : Date.parse(raw);
        if (Number.isFinite(ts)) values[f.name] = ts;
      } else if (f.type === 'DECISION_BOX') values[f.name] = raw === '1';
      else values[f.name] = raw;
    }
    return { values, missing: null };
  }

  async function onSubmit() {
    if (!unit || (isRoom ? !isRoomLike(unit.type) : unit.type !== effType)) {
      actions.showToast(`Pick a ${resourceFieldLabel.toLowerCase()} first`);
      return;
    }
    if (slotDate < minDate) {
      actions.showToast('That start is in the past');
      return;
    }
    if (endAbs <= startAbs) {
      actions.showToast('The end must be after the start');
      return;
    }
    if (!startSelectable) {
      actions.showToast('That start time has already passed — pick an upcoming one');
      return;
    }
    if (conflicts.length) {
      actions.showToast(`This ${isRoom ? 'space' : 'desk'} is already booked in that window`);
      return;
    }
    // Built-in fields carry the org form's own `required` flag when one is loaded, else the
    // fallback layout's.
    const usingOrgForm = !!formMeta && formMeta.fields.length > 0;
    const isRequired = (fieldName: string, fallbackRequired: boolean): boolean => (usingOrgForm ? !!formMeta!.fields.find((f) => f.name === fieldName)?.required : fallbackRequired);
    if (isRequired('name', !isFacility) && !name.trim()) {
      actions.showToast('“Name” is required');
      return;
    }
    if (isRequired('host', !isFacility) && !host) {
      actions.showToast('“Host” is required');
      return;
    }
    if (isRequired('reservedBy', true) && !reservedBy) {
      actions.showToast(`“${reserverLabel}” is required`);
      return;
    }
    if (isRequired('noOfAttendees', true) && !(Number(noOfAttendees) > 0)) {
      actions.showToast('“Number Of Attendees” is required');
      return;
    }
    if (isRequired('internalAttendees', false) && internalAttendees.length === 0) {
      actions.showToast('“Internal Attendees” is required');
      return;
    }
    if (isRequired('externalAttendees', false) && externalAttendees.length === 0) {
      actions.showToast('“External Attendees” is required');
      return;
    }
    const { values: extraValues, missing } = collectExtras(formMeta);
    if (missing) {
      actions.showToast(`“${missing}” is required`);
      return;
    }
    setSubmitting(true);
    const ok = await actions.submitBooking({
      unitId: unit.id,
      date: slotDate,
      start: startMin,
      end: endMin,
      ...(endDate !== slotDate ? { endDate } : {}),
      name: name.trim() || `${unit.label} booking`,
      description: description.trim(),
      host,
      reservedBy,
      noOfAttendees: Number(noOfAttendees) || 1,
      internalAttendees,
      externalAttendees,
      formId: formMeta?.id,
      extras: extraValues,
      resourceField: formResourceField ?? undefined,
    });
    setSubmitting(false);
    if (ok) actions.closeBookingForm();
  }

  // Bookable units of the type being booked — the lookup's options. The record id rides each
  // option: two desks can share a name, and the lookup is where the wrong one costs the most.
  const resourceOptions = unitPool
    .filter((u) => (isRoom ? isRoomLike(u.type) : u.type === effType) && isBookable(u))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    .map((u) => ({
      value: u.id,
      label: u.label,
      sublabel: [u.room ?? u.secondary ?? '', /^\d+$/.test(u.id) ? `#${u.id}` : ''].filter(Boolean).join(' · ') || undefined,
    }));

  /** The clash, as a small red line under the resource field. */
  const conflictHint =
    conflicts.length > 0 ? (
      <div role="alert" style={{ marginTop: 5, font: '500 11.5px/1.4 var(--font-sans)', color: '#b3261e' }}>
        Already booked{' '}
        {conflicts.map((c, i) => `${i ? ', ' : ''}${c.date !== slotDate || endDate !== slotDate ? `${c.date} ` : ''}${fmtTime(c.start)}–${fmtTime(c.end)}`).join('')} — pick another time or another{' '}
        {isRoom ? 'space' : 'desk'}.
      </div>
    ) : null;

  const resourceControl = (
    <>
      <Select
        value={unit && (isRoom ? isRoomLike(unit.type) : unit.type === effType) ? resourceId : null}
        options={resourceOptions}
        onChange={setResourceId}
        placeholder={resourcesLoading && resourceOptions.length === 0 ? 'Loading…' : `Select a ${resourceFieldLabel.toLowerCase()}`}
        // From the plan the resource was chosen by clicking it; from the calendar it is chosen here.
        disabled={state.activeView === 'map'}
        fullWidth
        aria-label={resourceFieldLabel}
      />
      {conflictHint}
    </>
  );

  const resourceRow = (
    <Field key="__resource" label={resourceFieldLabel} required>
      {resourceControl}
    </Field>
  );

  const span = endAbs - startAbs;
  const timeWindow = (
    <Field key="__time" label="Booking Window" required>
      {/* The org declares start and end as DATETIME fields, so each is one datetime control:
          a date plus a time on half-hour steps. Any length — an hour, overnight, a week. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <div className={card.label}>Start Time</div>
          <DatePicker
            value={slotDate}
            min={minDate}
            max={maxDate}
            minutes={startMin}
            minuteStep={STEP_MIN}
            minMinutes={slotDate === minDate ? nowOrg.minutes : undefined}
            onChange={(iso) => {
              // Moving the start keeps the window's length; the end follows.
              const len = Math.max(STEP_MIN, span);
              const abs = absMin(iso, startMin) + len;
              const days = Math.floor((abs - absMin(iso, 0)) / 1440);
              setSlotDate(iso);
              setEndDate(addDaysIso(iso, days));
              setEndMin(abs - absMin(iso, 0) - days * 1440);
            }}
            onMinutesChange={(m) => {
              setStartMin(m);
              if (endDate === slotDate && endMin <= m) setEndMin(Math.min(1440, m + STEP_MIN));
            }}
            fullWidth
            aria-label="Start time"
          />
        </div>
        <div>
          <div className={card.label}>End Time</div>
          <DatePicker
            value={endDate}
            min={slotDate}
            max={maxDate}
            minutes={endMin}
            minuteStep={STEP_MIN}
            minMinutes={endDate === slotDate ? startMin + STEP_MIN : undefined}
            onChange={(iso) => {
              setEndDate(iso);
              if (iso === slotDate && endMin <= startMin) setEndMin(Math.min(1440, startMin + STEP_MIN));
            }}
            onMinutesChange={setEndMin}
            fullWidth
            aria-label="End time"
          />
        </div>
      </div>
      <p className={card.helper} style={{ marginTop: 6 }}>
        {span <= 0 ? 'The end must be after the start' : `Duration ${fmtSpan(span)}${endDate !== slotDate ? ' · ends on another day' : ''}`}
      </p>
    </Field>
  );

  /** One org-form field → the matching control (dedicated where the app models it, generic otherwise). */
  function renderOrgField(f: BookingFormFieldMeta, flags: { time: boolean; resource: boolean }): ReactNode {
    switch (f.name) {
      case 'name':
        return (
          <Field key={f.name} label={f.label || 'Name'} required={f.required}>
            <input className={card.input} value={name} placeholder="Enter your text here" onChange={(e) => setName(e.target.value)} />
          </Field>
        );
      case 'description':
        return (
          <Field key={f.name} label={f.label || 'Description'} required={f.required}>
            <textarea className={card.input} style={{ height: 72, padding: '8px 10px', resize: 'vertical' }} value={description} placeholder="Type your description here" onChange={(e) => setDescription(e.target.value)} />
          </Field>
        );
      case 'host':
        return (
          <Field key={f.name} label={f.label || 'Host'} required={f.required}>
            <Select value={host || null} options={contactOptions} onChange={setHost} placeholder="Select an option" fullWidth aria-label={f.label || 'Host'} />
          </Field>
        );
      case 'reservedBy':
        return (
          <Field key={f.name} label={f.label || reserverLabel} required={f.required}>
            <Select value={reservedBy || null} options={contactOptions} onChange={setReservedBy} placeholder="Select an option" fullWidth aria-label={f.label || reserverLabel} />
          </Field>
        );
      case 'noOfAttendees':
        return (
          <Field key={f.name} label={f.label || 'Number Of Attendees'} required={f.required}>
            <input className={card.input} type="number" min={1} value={noOfAttendees} placeholder="Input numerical value" onChange={(e) => setNoOfAttendees(e.target.value)} />
          </Field>
        );
      case 'bookingStartTime':
      case 'bookingEndTime':
        if (flags.time) return null;
        flags.time = true;
        return timeWindow;
      default:
        break;
    }
    // The org form's own start/end inputs are always this app's window controls; any DATETIME
    // field on a booking form is part of that window.
    if (/DATE_?TIME/i.test(f.type)) {
      if (flags.time) return null;
      flags.time = true;
      return timeWindow;
    }
    switch (f.name) {
      case 'internalAttendees':
        return (
          <Field key={f.name} label={f.label || 'Internal Attendees'} required={f.required}>
            <AttendeePicker contacts={contacts} selected={internalAttendees} onChange={setInternalAttendees} placeholder="Select one or more options" />
          </Field>
        );
      case 'externalAttendees':
        return (
          <Field key={f.name} label={f.label || 'External Attendees'} required={f.required}>
            <AttendeePicker contacts={contacts} selected={externalAttendees} onChange={setExternalAttendees} placeholder="Select one or more options" />
          </Field>
        );
      default:
        break;
    }
    if (isResourceField(f)) {
      // The second resource field for the same thing (Location beside Meeting Rooms) is not
      // shown; the save fills it from the picked record.
      if (primaryResourceFieldName && f.name !== primaryResourceFieldName) return null;
      flags.resource = true;
      return (
        <Field key={f.name} label={f.label || resourceFieldLabel} required={f.required}>
          {resourceControl}
        </Field>
      );
    }
    // Resource-family fields for OTHER unit types (a shared form's Desk field on a room booking)
    // aren't editable here — the payload's own lookup carries the resource.
    if (isResourceFamilyField(f)) return null;
    // People lookups the app doesn't model (approvers, …) → an employee select into extras.
    if (f.lookupModule && PEOPLE_LOOKUPS.has(f.lookupModule.toLowerCase())) {
      return (
        <Field key={f.name} label={f.label || f.name} required={f.required}>
          <Select value={extras[f.name] || null} options={contactOptions} onChange={(v) => setExtras((x) => ({ ...x, [f.name]: v }))} placeholder="Select an option" fullWidth aria-label={f.label || f.name} />
        </Field>
      );
    }
    // A lookup the app can't resolve never becomes a free-text box (a label typed into a lookup
    // writes garbage) — it is skipped, named once in the console.
    if (/LOOKUP/i.test(f.type)) {
      // eslint-disable-next-line no-console
      console.info(`[booking-form] unmapped lookup field skipped: ${f.name} (type ${f.type}, module ${f.lookupModule ?? '?'})`);
      return null;
    }
    const set = (v: string) => setExtras((x) => ({ ...x, [f.name]: v }));
    const val = extras[f.name] ?? '';
    let control: ReactNode;
    if (f.type === 'TEXTAREA') control = <textarea className={card.input} style={{ height: 64, padding: '8px 10px', resize: 'vertical' }} value={val} onChange={(e) => set(e.target.value)} />;
    else if (f.type === 'NUMBER' || f.type === 'DECIMAL') control = <input className={card.input} type="number" value={val} onChange={(e) => set(e.target.value)} />;
    else if (f.type === 'DATE') control = <DatePicker value={val} onChange={set} fullWidth aria-label={f.label || f.name} />;
    else if (f.type === 'DECISION_BOX')
      control = (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, font: '400 12.5px/1 var(--font-sans)', color: 'var(--ink-700)' }}>
          <input type="checkbox" checked={val === '1'} onChange={(e) => set(e.target.checked ? '1' : '')} /> Yes
        </label>
      );
    else control = <input className={card.input} value={val} placeholder="Enter your text here" onChange={(e) => set(e.target.value)} />;
    return (
      <Field key={f.name} label={f.label || f.name} required={f.required}>
        {control}
      </Field>
    );
  }

  /** The org form, field by field, in its configured order. */
  function renderOrgForm(meta: BookingFormMeta): ReactNode[] {
    const flags = { time: false, resource: false };
    const nodes = meta.fields.map((f) => renderOrgField(f, flags)).filter(Boolean) as ReactNode[];
    // A booking without its resource or its window makes no sense — a custom form that omits
    // them still gets this app's own controls.
    if (!flags.resource) nodes.unshift(resourceRow);
    if (!flags.time) nodes.push(timeWindow);
    return nodes;
  }

  return (
    <Modal onClose={actions.closeBookingForm} width={560}>
      <ModalHeader
        title={isFacility ? 'Booking' : 'Space Booking'}
        subtitle={
          // Several forms for what is being booked → a picker of their display names (in All
          // spaces the chosen form decides desk vs room). One → a static label.
          canPickForm && formsForCurrentType.length > 1 ? (
            <Select
              value={formId != null ? String(formId) : ''}
              options={formsForCurrentType.map((f) => ({ value: String(f.id), label: f.displayName || f.name }))}
              placeholder="Choose a form"
              onChange={(v) => {
                const id = Number(v);
                setFormId(id);
                if (target.allowTypeSwitch) {
                  const t = typeOfForm(id);
                  if (t && t !== effType) setTypeOverride(t);
                }
              }}
              size="sm"
              aria-label="Booking form"
            />
          ) : (
            <span style={{ padding: '3px 10px', borderRadius: 6, background: 'var(--ink-050)', border: '1px solid var(--ink-200)', fontSize: 12, color: 'var(--ink-700)' }}>
              {formMeta ? formMeta.displayName : formsForCurrentType[0]?.displayName || fallbackFormName}
            </span>
          )
        }
        onClose={actions.closeBookingForm}
      />
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '64vh', overflowY: 'auto' }}>
        {canPickForm && formsForCurrentType.length > 1 && formId == null ? (
          <div style={{ padding: '28px 0', textAlign: 'center', font: '400 12.5px/1.5 var(--font-sans)', color: 'var(--ink-500)' }}>Choose a booking form above to continue.</div>
        ) : formLoading ? (
          <div style={{ padding: '34px 0', display: 'flex', justifyContent: 'center' }} role="status" aria-label="Loading">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="9" stroke="var(--ink-100)" />
              <path d="M12 3a9 9 0 0 1 9 9" stroke="var(--ink-400)">
                <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite" />
              </path>
            </svg>
          </div>
        ) : formMeta && formMeta.fields.length > 0 ? (
          renderOrgForm(formMeta)
        ) : (
          <>
            {!isFacility && (
              <>
                <Field label="Name" required>
                  <input className={card.input} value={name} placeholder="Enter your text here" onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Description">
                  <textarea className={card.input} style={{ height: 72, padding: '8px 10px', resize: 'vertical' }} value={description} placeholder="Type your description here" onChange={(e) => setDescription(e.target.value)} />
                </Field>
                <Field label="Host" required>
                  <Select value={host || null} options={contactOptions} onChange={setHost} placeholder="Select an option" fullWidth aria-label="Host" />
                </Field>
              </>
            )}

            <Field label={reserverLabel} required>
              <Select value={reservedBy || null} options={contactOptions} onChange={setReservedBy} placeholder="Select an option" fullWidth aria-label={reserverLabel} />
            </Field>

            {resourceRow}

            <Field label="Number Of Attendees" required>
              <input className={card.input} type="number" min={1} value={noOfAttendees} placeholder="Input numerical value" onChange={(e) => setNoOfAttendees(e.target.value)} />
            </Field>

            {timeWindow}

            {(isFacility || isRoom) && (
              <div style={{ borderTop: '1px solid var(--ink-100)', paddingTop: 12 }}>
                <div style={{ font: '700 12px/1 var(--font-sans)', color: 'var(--ink-700)', letterSpacing: '0.03em', marginBottom: 10 }}>ATTENDEES</div>
                <Field label="Internal Attendees">
                  <AttendeePicker contacts={contacts} selected={internalAttendees} onChange={setInternalAttendees} placeholder="Select one or more options" />
                </Field>
              </div>
            )}
            {!isFacility && isRoom && (
              <Field label="External Attendees">
                <AttendeePicker contacts={contacts} selected={externalAttendees} onChange={setExternalAttendees} placeholder="Select one or more options" />
              </Field>
            )}
          </>
        )}
      </div>
      <ModalFooter>
        <Button variant="secondary" disabled={submitting} onClick={actions.closeBookingForm}>
          Cancel
        </Button>
        <Button variant="primary" disabled={submitting || formLoading} onClick={onSubmit}>
          {submitting && <ButtonSpinner />}
          {submitting ? 'Saving…' : 'Submit Details'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label className={card.label}>
        {required && <span style={{ color: 'var(--danger-500)', marginRight: 3 }}>*</span>}
        {label}
      </label>
      {children}
    </div>
  );
}

function AttendeePicker({ contacts, selected, onChange, placeholder }: { contacts: Employee[]; selected: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const available = contacts.filter((c) => !selected.includes(c.id));
  return (
    <div>
      <Select value={null} options={available.map((c) => ({ value: c.id, label: c.name, sublabel: c.department }))} onChange={(v) => onChange([...selected, v])} placeholder={placeholder} fullWidth aria-label="Add attendee" />
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {selected.map((id) => {
            const e = contacts.find((x) => x.id === id);
            return (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 6px 4px 10px', borderRadius: 999, background: 'var(--blue-025)', border: '1px solid var(--blue-200)', font: '500 12px/1 var(--font-sans)', color: 'var(--blue-700)' }}>
                {e?.name ?? id}
                <button type="button" onClick={() => onChange(selected.filter((x) => x !== id))} style={{ border: 'none', background: 'transparent', color: 'var(--blue-600)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }} aria-label={`Remove ${e?.name ?? id}`}>
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
