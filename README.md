# Floorplan Manager — Vibe App

A React + Vite implementation of the "Floorplan Manager" design prototype (`.design-src/Floorplan Manager.dc.html`), built as a Facilio **Vibe app**.

Org records (portfolio, people, assets) come from the **`facilio-cmms` connector**; the app's own records (on-plan geometry, assignments, bookings, settings, uploaded plans) live in the **vibe DB**, reached through the `floorplanApi` Studio Function. Direct **connected-app V3 API** calls remain only where no connector action exists — marker geometry, desk Moves, org forms and file previews. Offline `npm run dev` still runs on the JSON seed in `src/data/`.

## Run it

```bash
npm install
npm run dev        # http://localhost:9090 (strict port)
npm run build      # outputs dist/, index.html at the root
npm run typecheck

npm run fn:create  # first time only: upload + build the floorplanApi function
npm run fn:push    # thereafter: update its source and rebuild
npm run deploy     # build, then `facilio vibe deploy`
```

Out of the box `npm run dev` runs fully offline against the JSON data in `src/data/` — no backend required. The vibe tiers switch on automatically when the app is served from its `*.vibe.facilio.com` host (override in dev with `VITE_IS_VIBE_APP` + `VITE_VIBE_SERVER_URL`).

## `.env.local` setup

Copy `.env.local.example` to `.env.local` (gitignored — never commit it). A **deployed vibe app needs none of these** — it detects the runtime from its host, talks to its own origin and authenticates with the session cookie. They exist for dev:

- **Local JSON (default):** leave everything blank/false — the app serves `src/data/*.json`.
- **Dev against the deployed vibe app:** `VITE_IS_VIBE_APP=true` + `VITE_VIBE_SERVER_URL=https://<linkName>.vibe.facilio.com`. Auth is cookie-based, so sign in to that host once in the same browser first.
- **Dev against a real org's V3 API:** set `VITE_DEV_MODE=true` and both `VITE_FACILIO_API_BASE_URL` (…/api) + `VITE_FACILIO_TOKEN`. Only needed to exercise the V3-only paths. Requests route through the vite dev proxy (`/fapi`) to dodge CORS.
- **Connected app:** `VITE_IS_CONNECTED_APP=true` — for a build served inside a Facilio org as a connected app rather than as a vibe app.

## Data layer

`src/lib/dataSource.ts` tries a four-tier list of `FloorplanDataSource` implementations per call, first-to-resolve wins (`defaultTiers()`). The split is by **ownership**, not preference:

1. **CMMS connector** (`src/lib/connectorDataSource.ts`) — the org's real records through the `facilio-cmms` connection, via `vibe.executeAction(connectionSlug, actionSlug, body)`. Covers the portfolio (`list-sites` / `list-buildings` / `list-floors`), the people directory (`list-employees`), the asset catalog (`list-assets`) and space creation (`create-space`). Preferred wherever an action exists: the platform brokers the call with a service token minted for the signed-in user, so the browser never holds a credential.
2. **Vibe DB** (`src/lib/vibeDbDataSource.ts`) — this app's own records, in its per-app Postgres schema. The browser has **no direct database access**; every call is a handler on the `floorplanApi` Studio Function (`functions/floorplanApi/code.ts`), which is the only thing holding DB credentials. Owns placement geometry, assignments, bookings, settings and floorplan-file records. `get-floor-data` returns a whole floor in one round trip.
3. **Connected-app V3** (`src/lib/facilioApiDataSource.ts`, module CRUD via `v3/modules/{moduleName}`) — kept for exactly what no connector action reaches: on-plan marker geometry (`floorplanmarker`), desk **Moves**, `spacebooking`, org forms (`v2/forms`) and file previews. `src/lib/facilioApi.ts` fronts two transports behind one API: the Connected-App browser SDK when embedded in an org, or a bearer-token axios client in dev.
4. **Local JSON** (`LocalJsonDataSource` in `dataSource.ts`) — the editable seed from `src/data/*.json` plus this session's edits in `localStorage`. Always succeeds; powers offline dev.

Writes that have a real-world counterpart go to **both**: assigning a desk records it in the vibe DB *and* best-effort creates the org's `moves` record; booking stores locally *and* posts a real `spacebooking`. The vibe DB is this app's source of truth for its read path, and the org write is the side effect.

## Modules

Five modules, each with the same treatment — a summary row in the spaces list and inspector, a stateflow (states + configurable colors) and a config card, all on its own Settings tab:

| Module | Shape | Booked / assigned |
|---|---|---|
| Desk (`workstation`) | point marker | assignable, or bookable when HOT/HOTEL |
| Locker | point marker | assignment-only |
| Parking stall | point marker | assignable or bookable |
| Room | polygon zone | bookable, or assignable when not reservable |
| Delivery area (`delivery`) | polygon zone | same rules as a room |

Rooms and delivery areas are *zones* — drawn as polygons with their own edit tool and sharing one code path (`isRoomLike` / `isZoneTool`); the other three are point markers tied to a plan type. Facility markers (stairs, restrooms, extinguishers) are a sixth, non-toggleable kind: they stay on the plan as wayfinding.

**Settings › Modules** switches any of the five off. A disabled module is *hidden*, not emptied — it disappears from the canvas, legend, edit tools, filter chips, spaces list, bookings categories, auto-map options, the plan-type switcher and its own settings tab, and any selection/armed tool pointing at it is cleared. Its records are untouched, so switching it back on restores them. The last enabled module can't be switched off. The choice is stored in the app's settings blob (vibe DB), so it belongs to the workplace rather than one browser.

### Editable data — `src/data/*.json`

The dataset that used to live in the vibe-db is now plain JSON files you can edit in the repo:

| File | Contents |
|---|---|
| `portfolio.json` | site → building → floor tree |
| `employees.json` | people directory |
| `units.json` | placed desks / lockers / rooms / parking (with normalized `geom`) |
| `assignments.json` | `unitId → employeeId` map |
| `bookings.json` | booking templates (date-agnostic; the app stamps the viewed day) |
| `assets.json` | Edit-mode asset catalog |

Edit a file and save — Vite picks it up (the seed is imported directly). Session edits made in the UI persist to `localStorage`; **Settings → Local data → Clear local data** wipes those and reloads to re-seed from the JSON. `src/lib/mockData.ts` re-exports this same JSON for the reducer's initial state, so there's a single source of truth.

### Floorplan file uploads

"Upload floorplan" renders the file client-side first (image directly, PDF via pdf.js, DWG/DXF via `@mlightcad/cad-simple-viewer`) so it works fully offline, and persists the renderable data URL to `localStorage` (`floorplanFileStore`) so it survives a refresh. When the real backend tier is configured it *additionally* uploads the original for real and attaches the `fileId` to the floor's `indoorfloorplan` record (best-effort; a failure surfaces as a toast).

## Deploying

`vibe.json` declares the app (`app` = its linkName, `build.publish` = `dist`). First-time setup, from a `facilio login` session:

```bash
facilio vibe app create        # creates the app, patches vibe.json
facilio vibe db create         # provision the app's Postgres schema
npm run fn:create              # upload + build the floorplanApi function
npm run deploy                 # build, zip dist/, upload
```

Thereafter `npm run deploy` for the UI and `npm run fn:push` for the function. Deploys land on **preview**; promoting to production is a separate creator-gated action in Vibe Studio (a brand-new app's first deploy auto-promotes).

The function creates its own tables on first use (`init-schema` runs idempotent DDL), so there is no migration step — but `facilio vibe db create` must have run first, or it has no schema to create them in.

To push the source to a repo under the Facilio GitHub org: `facilio vibe git push` (zips the project honoring `.gitignore`, server-side push, creates the repo if missing).

## Floorplan Editor (edit mode)

Edit mode implements the "Floorplan Editor" design (`.design-src/Floorplan Editor.dc.html`):

- **Edit view panel** with **Tools | Markers** tabs: a live active-tool banner (name + hint), a
  "Work with units" grid (Select `V` / Room / Scale), and an "Add to plan" grid (Desk, Locker,
  Parking — drag onto the plan or click to arm; Asset opens the asset list).
- **Marker library** (Markers tab): 9 built-ins (stairs, elevator, restroom, fire extinguisher,
  first aid, fire exit, printer, pantry, reception) plus **custom markers** (name, 1–2 char chip
  label, optional image URL, color) created inline and persisted via settings
  (`customMarkers`). Markers drag onto the plan or click-to-arm, and render as colored chips.
- **Available to place** tray (Location panel): unplaced records drag onto the plan **or
  click-to-arm** ("Click map" pill) and place on the next canvas click.
- **Replace semantics**: dropping a record (tray drag or an on-canvas marker drag) onto an
  existing marker of the same type gives the dragged record that exact spot; the old record
  moves back to "Available to place" (green ring shows the drop target).
- **Inspector card**: single selection (label, desk type, room, area, delete) or marquee
  multi-selection ("N selected", Delete N). Deleting keeps records — they return to the tray.
- Dark **save bar** (`N unsaved changes · Discard · Save changes`), Shift+drag marquee,
  `V`/`Esc`/`Delete` shortcuts.

Deliberately not ported from the design prototype: the mock Facilio top-bar chrome (the app
gets real chrome from the connected-app host when embedded), and the "empty desk slot"
(`filled: false`) markers — a placeholder-slot concept with no counterpart in the real
floorplanmarker data model yet.

## Known simplifications vs. the original prototype

- **Floorplan background image**: the original referenced a rendered raster PNG that wasn't available to this rebuild (it exceeded the design-tool's file-size cap). Replaced with a generated SVG architectural schematic (`src/components/canvas/FloorplanBackground.tsx`) that follows the same desk/room layout — actually crisper at high zoom than a raster would be. Users can upload a real plan (PNG/JPG/PDF/DWG/DXF) via "Upload floorplan", which replaces it per-floor.
- **DWG/DXF upload**: rendered fully client-side via `@mlightcad/cad-simple-viewer` (MIT-licensed, WASM-backed CAD parser — no external conversion service). This is a heavier, best-effort integration I couldn't interactively test against a real DWG file; it degrades gracefully to an error message if parsing fails. Its DWG parser worker is ~13MB, lazy-loaded only when a DWG/DXF is actually selected.
- **Settings → module color overrides**: not persisted (matches the original prototype's behavior — resets on reload). Permissions and slot-granularity are persisted via the data layer's mock tier.
- **Vestigial features from the original were intentionally dropped**, not ported: a dead third panel, unwired mobile pan/zoom/pinch, a computed-but-unrendered mobile tooltip, and role/permission enforcement that in the original was cosmetic only (toggles in Settings didn't actually gate anything). If real permission enforcement is wanted, `state.perms` + `state.role` are already modeled and just need to gate the relevant actions/buttons.
- **Floor id mismatch when the real backend tier is configured**: the app's default floor (`state.floorId`, hardcoded to the mock seed's `'hqA3'`) won't exist in a real org's portfolio, so the canvas shows "No floorplan yet" for it even though the Location panel's spaces list still shows the 41 mock units (those come from the mock tier, keyed to `'hqA3'`, independently of the real portfolio tree). This also means uploading a floorplan while on that floor uploads the file for real but can't attach it to a real `indoorfloorplan` record (the toast says so rather than overclaiming success). Not fixed yet — the fix is to auto-select a real floor from the loaded portfolio when the real backend tier answers `getPortfolio()`, at the cost of losing the mock demo data's richness for that floor (mock units are only seeded for `'hqA3'`).
