import { customGet, customPatch, customPost, facilioApi, isConnectedApp, isFacilioApiConfigured } from './facilioApi';
import { refusedForRate } from './rateLimit';

/**
 * Module-agnostic stateflow + approval-flow client, mirroring the real Facilio web client
 * (clientV2)'s mechanics — the same endpoints drive EVERY module (spacebooking, desks, lockers,
 * parkingstall, space), with the module name in the path/params:
 *
 *  - stateflow list:    GET  v2/statetransition/getAvailableState {moduleName, id}
 *  - stateflow execute: PATCH v3/action/{moduleName}/{recordId}/transition {id, stateTransitionId, data}
 *  - approval list:     POST v2/approval/availableTransitions {moduleName, id}
 *  - approval execute:  PATCH v3/approval/action/{moduleName}/{recordId}/approval {id, approvalTransitionId, data}
 *
 * Envelopes differ by family: v2 answers `{responseCode: 0, result}`, v3 answers `{code: 0, data}`
 * — `unwrap` handles both.
 *
 * V1 SIMPLIFICATIONS (deliberate, vs clientV2's full TransitionButtonMixin):
 *  - Transitions carrying forms (`formId`/`dialogType === 2`) execute with empty `data`; if the
 *    backend's form rules reject that, the error surfaces verbatim as a toast.
 *  - The confirmation-dialog step (`v2/statetransition/confirmationDialogs`) is not called.
 *  - `commentRequired` is collected via a plain prompt upstream and travels as
 *    `data.transitionCommentData = {body, bodyHTML}` (the shape clientV2 sends).
 */

export interface TransitionOption {
  id: number;
  name: string;
  commentRequired?: boolean;
  formId?: number | null;
  dialogType?: number | null;
}

export interface FlowState {
  /** Display name of the record's current state (null when the flow isn't enabled/resolvable). */
  currentStateName: string | null;
  transitions: TransitionOption[];
}

/** `moduleState`/`approvalStatus`/transition-state objects -> a printable label (never render the raw object). */
export function stateName(state: any): string | null {
  if (state == null) return null;
  if (typeof state === 'string') return state.trim() || null;
  const n = state.displayName ?? state.status ?? state.name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** Heuristic for "awaiting approval" state labels — clientV2 resolves this server-side; we approximate by name. */
export function isPendingApprovalName(name: string | null | undefined): boolean {
  return !!name && /pending|requested|waiting/i.test(name);
}

export function findCancelTransition(transitions: TransitionOption[]): TransitionOption | null {
  return transitions.find((t) => /cancel/i.test(t.name)) ?? null;
}

/**
 * An ASSIGN-ish transition (never a vacate/unassign one). Assign and re-assign are RECORD WRITES
 * in this app (requested): the picker patches the desk's assignee field and that is the whole
 * action — no transition call. This predicate exists so those transitions can be kept off the
 * button bar and, where one is the only way back into the picker (Re-Assign), open it without
 * firing. VACATE is the opposite: it goes straight to the transition API.
 */
export function isAssignTransition(t: TransitionOption): boolean {
  // Orgs name it Assign, Re-assign or Allocate (parking stalls use the latter in ENEC CAFM).
  // The negative half matters as much: "Unassign" and "Deallocate" both contain the positive word.
  return /assign|allocat/i.test(t.name) && !ASSIGN_OPPOSITE.test(t.name);
}

/** Words that turn an assign-ish name into its opposite. */
const ASSIGN_OPPOSITE = /vacat|un-?assign|de-?assign|un-?allocat|de-?allocat|release|free/i;

/**
 * Run the record's own assign transition IF its current state still offers one — called AFTER the
 * assignee has actually been written (picker or drag-and-drop), never on a button click.
 *
 * Writing the field alone does not move the record's STATE: a desk stayed "Yet to Assign" with a
 * holder on it, so the flow kept offering the unassigned actions and Vacate never appeared
 * (reported). Returns the transition's name, or null when the state offers none — already
 * occupied, no stateflow on the module, or local mode.
 */
export async function runAssignTransition(moduleName: string, recordId: number): Promise<string | null> {
  if (!isFacilioApiConfigured) return null;
  const flow = await fetchAvailableStates(moduleName, recordId).catch(() => null);
  const t = (flow?.transitions ?? []).find(isAssignTransition);
  if (!t) return null;
  await executeStateTransition(moduleName, recordId, t.id);
  return t.name;
}

/**
 * Re-assign specifically: an assign transition offered on a record that already has a holder. It
 * reopens the picker rather than firing, same as Assign, but from a different entry point.
 */
export function isReassignTransition(t: TransitionOption): boolean {
  return isAssignTransition(t) && /re-?assign/i.test(t.name);
}

/**
 * A VACATE-ish transition — the mirror of isAssignTransition. Orgs name it differently (Vacate,
 * Unassign, Release, Check Out, Free Desk), and matching only /vacat|unassign/ left the assignee
 * on screen after any other spelling (reported: transition done, details not updated).
 */
export function isVacateTransition(t: TransitionOption): boolean {
  return /vacat|un-?assign|de-?assign|un-?allocat|de-?allocat|release|check\s*out|free/i.test(t.name);
}

function assertConfigured(): void {
  if (!isFacilioApiConfigured) throw new Error('facilio-api: not configured');
}

/** v2 bodies nest under `result` (responseCode), v3 under `data` (code) — accept either. */
function unwrap(body: any): any {
  if (body == null) return null;
  if (body.responseCode !== undefined && body.responseCode !== 0) throw new Error(body.message || `responseCode ${body.responseCode}`);
  if (body.code !== undefined && body.code !== 0) throw new Error(body.message || `code ${body.code}`);
  return body.result ?? body.data ?? body;
}

function toTransitionOptions(states: any[]): TransitionOption[] {
  return (states ?? [])
    .filter((s) => s && !s.isOffline && typeof s.id === 'number')
    .map((s) => ({
      id: s.id,
      name: String(s.name ?? s.displayName ?? `Transition ${s.id}`),
      commentRequired: !!s.commentRequired,
      formId: s.formId ?? null,
      dialogType: s.dialogType ?? null,
    }));
}

/** Available state transitions for a record — empty transitions when the module/record has no stateflow. */
export async function fetchAvailableStates(moduleName: string, recordId: number): Promise<FlowState> {
  assertConfigured();
  const body = await customGet('v2/statetransition/getAvailableState', { moduleName, id: recordId });
  const res = unwrap(body);
  return { currentStateName: stateName(res?.currentState), transitions: toTransitionOptions(res?.states) };
}

/**
 * How long a flow just read is handed to another surface asking for the same record at the same
 * version, instead of asking the org again. Long enough to cover the plan's card and the side
 * panel mounting a moment apart for one click; short enough that nothing is remembered for long.
 */
const FLOW_REUSE_MS = 5000;

/**
 * A record's flow, read once for every surface showing it.
 *
 * Every `getAvailableState` call shares one per-minute limit, and one desk click mounted two
 * readers of the same record (the plan's card and the side panel), each asking for itself; booking
 * cards for one booking did the same. Here a read on its way is shared, and an answer that has just
 * landed is handed on for a few seconds — but only for the same `version`: a record that changed
 * gets a new version from the caller, and a new version is always a new read. A read that failed
 * is never handed on, so Retry asks again. A transition on the record drops what is held for it
 * (see forget), so nothing read before a move is served after it.
 *
 * Built by a factory so tests can put a reader around their own `fetchAvailableStates` — a call
 * from inside this module would never reach a mocked export.
 */
export function createFlowReader(fetch: (moduleName: string, recordId: number) => Promise<FlowState> = fetchAvailableStates, reuseMs = FLOW_REUSE_MS) {
  /** By record: the version it was read at, the read, and when it answered (null while on its way). */
  const held = new Map<string, { version: string; read: Promise<FlowState>; at: number | null }>();

  function read(moduleName: string, recordId: number, version: number | string = 0): Promise<FlowState> {
    const key = `${moduleName}:${recordId}`;
    const v = String(version);
    const now = Date.now();
    // Answers past their few seconds go as soon as anyone asks again; nothing needs a timer.
    for (const [k, e] of held) if (e.at !== null && now - e.at >= reuseMs) held.delete(k);
    const have = held.get(key);
    if (have && have.version === v) return have.read;
    // A different version replaces what is held: the record changed, so the old answer is not its.
    const entry = { version: v, read: undefined as unknown as Promise<FlowState>, at: null as number | null };
    entry.read = fetch(moduleName, recordId).then(
      (flow) => {
        if (held.get(key) === entry) entry.at = Date.now();
        return flow;
      },
      (err) => {
        if (held.get(key) === entry) held.delete(key);
        throw err;
      },
    );
    held.set(key, entry);
    return entry.read;
  }

  /** Drop what is held for one record (after a transition on it), or for every record. */
  function forget(moduleName?: string, recordId?: number): void {
    if (moduleName === undefined || recordId === undefined) held.clear();
    else held.delete(`${moduleName}:${recordId}`);
  }

  return { read, forget };
}

const flowReader = createFlowReader();

/**
 * The record's flow at `version` — shared with every other surface asking for the same record at
 * the same version (see createFlowReader). Callers keep their own "latest read wins" guard: this
 * shares requests, it does not decide which answer a surface shows.
 */
export const readFlow = flowReader.read;
/** Drop the held flow of one record, or of all of them. */
export const forgetFlowReads = flowReader.forget;

/** HTTP statuses that say the org is down or slow — 501 (Not Implemented) is a verb the path lacks, and is not one. */
const UPSTREAM_STATUS = new Set([500, 502, 503, 504]);
// Phrases only, never a bare number: a record id echoed in the error's path (`…/desks/503/…`) is
// not a status, and would keep that record from the fallback for good.
const UPSTREAM_TEXT = /status code 5(00|02|03|04)\b|internal server error|bad gateway|service unavailable|gateway time-?out|time(d)?[\s-]?out/i;

/**
 * Whether a PATCH failed because of the org rather than the path: Facilio refusing for rate,
 * erroring (5xx) or not answering in time. The fallback below sends the same transition again by
 * another road to the same org, which would be refused, fail or time out just the same — and a
 * timed-out PATCH may yet have landed, so sending it twice could run the step twice.
 *
 * Nothing on record says what the host bridge throws for a verb it lacks, so the fallback is kept
 * for every OTHER failure, as before; only these are kept from it.
 */
function failedUpstream(err: unknown): boolean {
  if (refusedForRate(err)) return true;
  const o = (err && typeof err === 'object' ? err : null) as { name?: unknown; status?: unknown; code?: unknown; message?: unknown; response?: { status?: unknown } } | null;
  const status = Number(o?.status ?? o?.response?.status);
  if (UPSTREAM_STATUS.has(status)) return true;
  if (o?.name === 'TimeoutError' || o?.code === 'ECONNABORTED' || o?.code === 'ETIMEDOUT') return true;
  return UPSTREAM_TEXT.test(String(o?.message ?? err ?? ''));
}

/**
 * Executes one state transition. Primary path is the real client's PATCH; in connected mode,
 * where the SDK bridge's PATCH support is unverified, a thrown transport error falls back to a
 * plain module update carrying `stateTransitionId` — the exact payload clientV2's own permalink
 * transition page sends via updateRecord, so the server-side behavior is proven. A PATCH the org
 * refused for rate, failed with a 5xx or let time out is NOT re-sent that way (failedUpstream).
 */
export async function executeStateTransition(moduleName: string, recordId: number, transitionId: number, data?: Record<string, unknown>): Promise<void> {
  assertConfigured();
  // The record's held flow goes before the move and again after it, whatever the move did —
  // landed, failed, or timed out having landed: a flow read before or during it is not the
  // record's any more.
  forgetFlowReads(moduleName, recordId);
  try {
    await sendStateTransition(moduleName, recordId, transitionId, data);
  } finally {
    forgetFlowReads(moduleName, recordId);
  }
}

async function sendStateTransition(moduleName: string, recordId: number, transitionId: number, data?: Record<string, unknown>): Promise<void> {
  const payload = { id: recordId, stateTransitionId: transitionId, data: data ?? {} };
  let body: any;
  try {
    body = await customPatch(`v3/action/${moduleName}/${recordId}/transition`, payload);
  } catch (err) {
    // ONLY a transport failure falls back. `unwrap` is deliberately outside this try: it throws
    // when the server answered properly and REFUSED the transition, and retrying that through
    // updateRecord would re-send a move the org just rejected — and, if the second path happened
    // to succeed, report a refusal as a success. Caught by the "non-zero v3 code" test.
    if (!isConnectedApp || failedUpstream(err)) throw err;
    // eslint-disable-next-line no-console
    console.warn(`[stateflow] PATCH transition failed in connected mode — falling back to updateRecord`, err);
    const res = await facilioApi.updateRecord(moduleName, { id: recordId, data: data ?? {}, stateTransitionId: transitionId } as any);
    if (res.error) throw new Error(res.error.message || `transition failed (code ${res.error.code ?? '?'})`);
    return;
  }
  unwrap(body);
}

/** Available approval actions (Approve/Reject/Cancel/...) — empty when the record isn't under an approval flow. */
export async function fetchApprovalTransitions(moduleName: string, recordId: number): Promise<FlowState> {
  assertConfigured();
  const body = await customPost('v2/approval/availableTransitions', { moduleName, id: recordId });
  const res = unwrap(body);
  return { currentStateName: stateName(res?.currentState), transitions: toTransitionOptions(res?.states) };
}

/** Executes one approval action. No non-PATCH fallback exists in clientV2 — a transport failure surfaces to the caller. */
export async function executeApprovalTransition(moduleName: string, recordId: number, approvalTransitionId: number, data?: Record<string, unknown>): Promise<void> {
  assertConfigured();
  // An approval moves the record's state too, so its held flow goes (see executeStateTransition).
  forgetFlowReads(moduleName, recordId);
  try {
    const body = await customPatch(`v3/approval/action/${moduleName}/${recordId}/approval`, {
      id: recordId,
      approvalTransitionId,
      data: data ?? {},
    });
    unwrap(body);
  } finally {
    forgetFlowReads(moduleName, recordId);
  }
}
