/**
 * `@facilio/studio-functions` exists only in Vibe's function runtime, not in this project's
 * node_modules. Tests resolve it here (vite.config's test alias) and stand in for what they need
 * with `vi.mock`; nothing else imports this.
 */
export default class StudioFunctions {
  constructor(_opts: { name: string }) {}
  addHandler(_handler: unknown): void {}
  execute(): void {}
}

export class StudioDatabase {
  constructor(_opts: Record<string, unknown>) {}
  query(_sql: string, _params?: unknown[]): { rows: any[] } {
    return { rows: [] };
  }
}
