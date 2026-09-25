/**
 * Call one of the Facilio host's `interface.*` actions by name.
 *
 * The connected-app SDK (FacilioAppSDK) ships a method per interface action it knew about when it
 * was published — `navigateTo`, `openSummary`, `getCurrentPage`… — and each one does the same
 * thing: post `{ key: 'interface.<name>', params }` to the host and wait for the reply. The host
 * library routes any `interface.<name>` it doesn't handle itself to Facilio's own handler, which
 * is where newer actions like `getUrlProps` and `pushUrlProps` live.
 *
 * The published SDK has no method for those two. And the generic `interface.trigger(name, …)` is
 * NOT a way to reach them: it posts `interface.trigger`, which the host sends to the widget's own
 * `actions.trigger` (the form-widget save/cancel channel), never to Facilio's handler — so a call
 * made that way silently goes nowhere. This posts the message a built-in method would have
 * posted, through the SDK's own request/reply plumbing, so the reply still resolves the promise.
 */
export function callHostInterface(app: any, name: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (typeof app?._postMessageWithPromise === 'function') {
    return app._postMessageWithPromise(`interface.${name}`, params);
  }
  // An SDK build that has grown a named method (and lost the private one) — use the method.
  if (typeof app?.interface?.[name] === 'function') {
    return Promise.resolve(app.interface[name](params));
  }
  return Promise.reject(new Error(`facilio-api: this connected-app SDK cannot send interface.${name}`));
}
