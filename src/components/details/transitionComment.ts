/**
 * The comment a workflow step requires, as `executeStateTransition` sends it.
 *
 * Facilio stores `bodyHTML` and renders it to everyone who reads the record's history, so the
 * text typed here must reach it as text: `<b>` typed in a comment is the four characters, not
 * bold, and nothing typed can become markup another user's browser runs. Whatever the server
 * cleans or doesn't is not visible from here, so it is escaped before it leaves. `body` stays as
 * typed. One helper for both surfaces that ask (the unit's StateflowActions and the booking's).
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function transitionCommentData(body: string): { transitionCommentData: { body: string; bodyHTML: string } } {
  // A line break typed in the dialog would collapse in HTML; it is kept as one.
  return { transitionCommentData: { body, bodyHTML: escapeHtml(body).replace(/\r?\n/g, '<br>') } };
}
