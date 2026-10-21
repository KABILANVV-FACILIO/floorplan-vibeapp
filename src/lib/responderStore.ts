import { RESPONDERS_FN, isVibeApp, vibe } from './vibe';
import { responderDataFrom } from './firstResponders';
import type { FirstResponder, ResponderRoleDef } from './types';

/**
 * Where the org's first responders live.
 *
 * Facilio's employee record has no field saying "this person is a first aider", and the org's
 * configuration is not the app's to change — so the app keeps that link itself, in its own
 * database, shaped like the multi-lookup it stands in for (functions/floorplanResponders): one row
 * per role, one row per (employee, role), and one row of notice details per responder. The person
 * stays the org's record; only the link is the app's.
 *
 * ONE SOURCE PER SESSION, never two. Running as a vibe app with the database answering, the
 * database is the source: Settings writes straight to it, and the settings blob neither carries
 * nor overrides the responders (settingsFromState, APPLY_SETTINGS). Otherwise — `npm run dev`, or a
 * database that could not be read — they ride in the settings blob as before. Letting both feed
 * the same state would let whichever loaded second silently win.
 */

export interface ResponderData {
  roles: ResponderRoleDef[];
  responders: FirstResponder[];
}

/** The database's answer, or null when there is none to have — the caller keeps the settings copy. */
export async function loadResponders(): Promise<ResponderData | null> {
  if (!isVibeApp) return null;
  try {
    const data = responderDataFrom(await vibe.executeFunction<unknown>(RESPONDERS_FN, 'get-responders', {}));
    // eslint-disable-next-line no-console
    console[data ? 'info' : 'warn'](
      data
        ? `[responders] ${data.responders.length} responders in ${data.roles.length} roles, from the app database`
        : '[responders] the app database answered with something that is not a responder list; keeping the settings copy'
    );
    return data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[responders] could not read the app database; keeping the settings copy:', (err as Error)?.message ?? err);
    return null;
  }
}

/** Replace every role, in order. Throws when the write is refused, so the caller can say so. */
export async function saveResponderRoles(roles: ResponderRoleDef[], updatedBy: string): Promise<void> {
  const rows = roles.map(({ id, name, plural, color, icon, text, shape }) => ({ id, name, plural, color, icon, text, shape }));
  await vibe.executeFunction(RESPONDERS_FN, 'save-roles', { rolesJson: JSON.stringify(rows), updatedBy });
}

/** Replace every responder — the links and the notice details, in one write. Throws when refused. */
export async function saveResponders(responders: FirstResponder[], updatedBy: string): Promise<void> {
  await vibe.executeFunction(RESPONDERS_FN, 'save-responders', { respondersJson: JSON.stringify(responders), updatedBy });
}
