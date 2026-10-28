# Floorplan Manager

## Use case

Workplace and facilities teams at an org running Facilio need to see, on the real floor plan, where every desk, locker, parking stall, room and delivery area is, who holds it, and what is booked. Before this app, assignments, bookings and floor layouts lived in separate Facilio modules and lists, with no plan that tied them together.

The app runs inside Facilio — embedded in the web app as a connected app, and in the Facilio mobile app — and as a standalone vibe app. Admins lay out floors (upload a plan, place markers, draw rooms), assign desks, lockers and stalls to employees, and configure modules, booking rules, access and first responders. Everyone else finds their desk, books a desk, room or stall for a time window, and sees who sits where. On a phone the same plan opens with pan/zoom, a QR scanner that jumps to a space, and booking sheets.

The org's first responders (first aiders, floor wardens and the org's own roles) are marked on the desks they hold, listed per floor, and printed on the floor's emergency notice.

## Business requirements

1. **R1** The plan for any floor in the org's portfolio (site → building → floor) can be opened, searched and navigated; the app reopens on the floor in the URL, else the viewer's own desk's floor.
2. **R2** Desks, lockers, parking stalls (point markers) and rooms, delivery areas (polygon zones) are drawn at their real positions, coloured by state or by department.
3. **R3** An admin can upload a floor plan (image, PDF, DWG/DXF), place, move and delete markers, draw zones, and save; a save writes to the org's own floor-plan records, and nothing is reported "saved" that the org did not store. Deleting a desk asks for confirmation first.
4. **R4** Assigning a desk creates the org's own Move; assigning a locker or stall writes its `employee` field. The plan shows the holder; "My desk" finds the viewer's desk.
5. **R5** A desk, room or stall can be booked for a time window through the org's space booking (or facility booking, per Settings); the calendar lists the org's bookings and the viewer's own. A booking is made or cancelled in Facilio or not at all: with no Facilio host it is refused, and a cancel Facilio refuses says so — nothing is "booked" or "cancelled" in the browser alone. The plan reads only its floor's bookings; the calendar reads org-wide.
6. **R6** Settings › Roles & access decides which roles see each tab and mode (map, assign, book, edit, bookings, people, settings); Settings always stays open to the org's admin roles, and is closed to a viewer whose role is unknown (the app's own URL outside Facilio). Only an admin, or a role the stored grid gives Settings, can change the grid or the responders — checked on the server against Facilio, which also records who did it.
16. **R16** Demo data (sample sites, people, desks, bookings) appears only under the local dev server — never in a deployed build, even when an org list comes back empty.
7. **R7** Settings › Modules switches any of the five modules off; a disabled module is hidden everywhere, never emptied, and the last one cannot be switched off.
8. **R8** Department colours, state colours, desk label style and booking slot granularity are configurable and shared org-wide.
9. **R9** First responders: Settings › First responders names people from the employee directory under responder roles. Nothing about a person is typed in — their name, department and mobile are read off their employee record.
10. **R10** Responder roles: first aider and floor warden are built in and cannot be removed; the org adds its own, each with a badge (symbol, shape, colour). A removed role comes off everyone who held it.
11. **R11** A responder is marked on the plan at the desk they hold on that floor (badges on the desk, up to four roles), listed in the floor's responder list (pick one to centre their desk), and printed on the floor's notice page (name, mobile, department, desk). Someone with no desk on a floor is not shown there.
12. **R12** Who holds which responder role is stored in the app's own database, never as new fields or configuration in the Facilio org.
13. **R13** The floor prints as a sheet: the plan, a legend, and the responder notice as the last page when the floor has responders.
14. **R14** On a phone (Facilio mobile app) the plan opens, pans and zooms, and a scanned space QR code opens that space — or says why it matched none or several.
15. **R15** Every action is reachable by keyboard; dialogs trap focus, close on Esc (innermost first) and return focus to what opened them.

## Solution implemented

- **Screens and flows:** four views — Floorplans (`/`), Bookings, People, Settings — plus a mobile layout. Floorplans has a Location panel (portfolio tree, floor search, spaces list, filter chips), the plan canvas with legend and responder chip, the Assignment / Booking / Edit modes, an inspector panel, a print viewer, and a floating toolbar (Edit, My desk, print, refresh). Settings tabs: Roles & access, Modules, Bookings, First responders, Desks, Lockers, Parking, Rooms, Delivery areas.
- R1 → `PortfolioTree` + floor search; `urlFloor` reads/writes `?floorId=`; boot picks URL floor, then `fetchMyDesk`'s floor.
- R2 → `Canvas` / `Marker` / zones; `markerModel` resolves colour by state or department.
- R3 → Edit mode (`EditPanel`, `FloorUploadModal`, `DeleteConfirmModal`); `persistUnits` writes `floorplanmarker` / `floorplanmarkedzone` / `indoorfloorplan` and reports exactly what the org stored.
- R4 → `assignEmployeeToRecord` (desk → `createDeskMove`, locker/stall → `employee` field update); `fetchMyDesk`.
- R5 → `BookingModal`, `createRealBooking` (`spacebooking`), Bookings calendar via `fetchOrgBookingsForRange`; standalone booking forms in `standalone/booking-forms`. `submitBooking` and `cancelBooking` call `refuseOrgWrite` first; inside Facilio `cancelBooking` calls `cancelRealBooking` (the record's Cancel transition) and toasts the refusal instead of falling through to the browser store. The plan's `getBookings` scopes the query to the floor (`floorIds`), ids split 150 to a query.
- R6 → `state.access` per surface, gated by `canSee` (Settings closed when `viewerRole` is null; `npm run dev` stands in a local admin). The grid is stored by `floorplanResponders.save-access` once the app database answers (`state.accessInDb`); it is the grid's only source once it holds one (`state.accessStoredInDb`), until then the settings blob's grid shows. The viewer's role from `fetchCurrentRole`, the org's roles from `facilio-user-management.list-roles`.
- R16 → `featureFlags.DEMO_DATA` (`import.meta.env.DEV`): the local tier's seed is empty in a build, and the boot falls back to `[]`, not the seed; a build with no floor to open shows the empty plan rather than the demo floor id.
- R7–R8 → Settings tabs; stored in the settings blob (see Technical details › Files).
- R9–R12 → `FirstRespondersTab` (people picker over the directory, roles editor), `lib/firstResponders` (sanitising, placement by desk, names from records), `lib/sharedSettings` + function `floorplanResponders` (app database).
- R11 → `ResponderBadges` on `Marker` and the mobile plan, `FloorResponders` chip/popover, `ResponderNoticePage` in `PrintSheet`.
- R13 → `PrintViewer` / `PrintSheet`.
- R14 → `MobileApp`, `MobileQrScanner` + `qrMatch.matchSpaceCode`.
- R15 → `Modal` (focus trap, open stack, initial focus), `keyboard.activateOnKey`, `planShortcutAllowed`, keyboard-operable markers and tree rows.
- **Out of scope / deferred:** a responder with no desk is on no plan; at most four role badges per desk; the `floorplanApi` function (units/assignments/bookings/settings in the app DB) is written but not deployed — its in-function DDL cannot run (see Technical details › App database) — and `featureFlags.FLOORPLAN_API_DEPLOYED` is off, so nothing calls it. Settings other than the access grid and the responders (module colours, label style, enabled modules…) still live in the file-store blob, which any signed-in browser can write.

## Technical details

- **Frontend:** React 18 + TypeScript (strict) + Vite 5. One `FloorplanProvider` (`src/state/FloorplanContext.tsx`) with a reducer (`src/state/reducer.ts`); routes in `src/lib/routes.ts`. Host detection in `src/lib/hostKind.ts`: `'mobile'` (React Native WebView bridge), `'iframe'` (embedded connected app) or `'none'`. The viewer is identified off the account payload (`v2/fetchAccount`, else `v2/account`): people id and role.
- **Facilio data & connections:**
  - Connected-app V3 (through the host bridge, `src/lib/facilioApi.ts` / `facilioApiDataSource.ts`) — first tier when inside a Facilio host. Reads: `floor`, `employee` (all pages, `mapEmployee` → name, department, email, HRMS id, mobile), `department`, `desks`, `spacebooking`, `asset`, `indoorfloorplan`, `v3/floorplan/getFloorplanDetailsByType`, `v2/forms`, `v2/filter/advanced/fields/employee`, `v2/setup/getRoles`, state transitions. Writes: `floorplanmarker`, `floorplanmarkedzone`, `indoorfloorplan` (create/update/delete), `moves` (desk assignment), `spacebooking`, `employee` field on lockers/stalls. The mobile host needs bare API paths (`bridgeApiPath`).
  - Connection `facilio-cmms` (`src/lib/connectorDataSource.ts`, via `vibe.executeAction`) — second tier, and the whole data layer outside a Facilio host: `list-sites`, `list-buildings`, `list-floors`, `list-employees`, `list-assets`, `list-custom-module-records`, `create-space`.
  - Local JSON (`src/data/*.json` + localStorage) — offline `npm run dev` only.
- **App database** (vibe Postgres schema; the function login has SELECT/INSERT/UPDATE/DELETE but never CREATE — tables are made with `facilio vibe db import` from the CSVs in `functions/floorplanResponders/tables/`, all columns text except `sort_order`):
  - `fp_responder_role` — one row per responder role: `id, name, plural, color, icon, shape, badge_text, sort_order, updated_at, updated_by`. Seeded with `firstAider`, `floorWarden`.
  - `fp_employee_responder_role` — one row per (employee, role), the multi-lookup the employee record has no field for: `employee_id, role_id, updated_at, updated_by`. `employee_id` is the org's people id.
  - `fp_responder_detail` — one row per responder: `employee_id, employee_name` (a fallback copy of the record's name; the app shows the record's). Its `group_name, ext, mobile` columns are from a first draft, left empty and unread.
  - `fp_access` — one row per surface (`map`, `map.edit`, `bookings`, `people`, `settings`): `surface`, `all_roles` (numeric: 1 = every role), `roles` (JSON list of role ids), `updated_at`, `updated_by`. No row = the app's default for that surface.
  - A `__seed__` row from the import is skipped by reads and removed by the first save. `updated_at` is ISO time from the function; `updated_by` is the caller's name as Facilio gives it (the browser's value is ignored).
- **Functions:**
  - `floorplanResponders` (`functions/floorplanResponders/code.ts`), called synchronously via `vibe.executeFunction`. Every write first asks Facilio who is calling — `facilio-cmms.get-current-user-profile` (run as the caller) for the role, `facilio-user-management.list-roles` for whether it is privileged — and allows an admin, or a role the stored `settings` row grants (no row: admins only). If Facilio cannot say, the write is refused.
    - `get-settings` () → `{ roles, responders, access }` in one call — what the app reads on boot.
    - `get-responders` () → `{ roles, responders }` (kept for older deployed builds).
    - `save-roles` (`rolesJson`) → replaces all roles in one statement (validates symbol, shape, `#RRGGBB`), then prunes links and names for removed roles.
    - `save-responders` (`respondersJson`) → replaces all links and names in ONE statement (data-modifying CTE over `json_to_recordset`; no transactions exist), dropping unknown roles and merging duplicates.
    - `save-access` (`accessJson`) → replaces the grid in one statement; unknown surfaces refused.
    - A refusal reads "Not saved: …"; the app shows that reason in its toast (`refusalReason`).
  - `floorplanApi` (`functions/floorplanApi/code.ts`) — not deployed; see Out of scope.
- **Jobs:** None.
- **Webhooks:** None.
- **AI agents:** None.
- **Realtime:** None.
- **Polling:** nothing on a timer. One bounded re-check: after Vacate on a held desk the org clears the holder while processing the move, so `waitForDeskVacated` re-reads the desk at most three times (2 s, 4 s, 8 s apart; 14 s, inside the 20 s busy limit), makes no read while the tab is hidden, and stops when the record leaves the card (`StateflowActions` aborts it on close or on a switch to another record). Not seen cleared → the plan re-reads its holders once and the toast says Facilio is still updating.
- **Files** (vibe file store, org-wide): `floorplan-settings.json` — the settings blob (the access grid only until the app database holds one; module colours, colour-by, label style, slot granularity, booking module, custom markers, enabled modules; responders only when the database is unreachable); `floorplan-department-colors.json` — department → colour. Each save uploads a new file and prunes older copies. localStorage is the last tier.
- **Access & config:** `vibe.json` app `floorplan-manager`. Connected app in the ENEC org (web + mobile). Tab/mode access from Settings › Roles & access.
- **Data flow (responders):** Settings › First responders › Save → `actions.setFirstResponders` → reducer (sanitise, names from `state.employees`) → when `state.respondersInDb`, `responderStore.saveResponders` → `floorplanResponders.save-responders` → tables. A refused write shows a toast and re-reads the database. On boot `loadResponders` runs beside the settings load; once it answers, the database is the only source (`APPLY_SETTINGS` ignores the blob's responders and `settingsFromState` omits them). Badges/list/notice then derive from `respondersOnFloor` (desk holder ∈ responders).
- **Preview vs production:** functions are created/built on preview (`<name>_<uuid>_preview`); promoting a deployment copies them to production. Preview and production share one database schema.

## Test cases

| Requirement | Test | Type | Expected |
|-------------|------|------|----------|
| R1 | `urlFloor.test.ts`, `myDesk.test.ts`, `floorLoadPaging.test.ts`, `relatedListPaging.test.ts` | unit | URL floor wins, then the viewer's desk; big floors load every page |
| R2, R8 | `departmentColors.test.ts`, `labelLayout.test.ts`, `fitUnitsView.test.ts`, `tooltipLayer.test.ts` | unit | Colours and labels resolve as configured |
| R3 | `persistUnits*.test.ts`, `markedZones.test.ts`, `roomMarking.test.ts`, `roomGestures.test.tsx`, `RoomPolygon.test.tsx`, `orgWrites.test.ts`, `EmptyPlanState.test.tsx` | unit | Save reports only what the org stored; zones drawn and written as the org's |
| R4 | `deskMoves.test.ts`, `myDesk.test.ts`, `searchEmployees.test.ts`, `employeeFilters.test.ts` | unit | A desk assignment is a Move; people search and filters match the org's |
| R5 | `BookingModal.test.tsx`, `bookingRows.test.ts`, `StateflowActions.test.tsx`, `deskVacated.test.ts`, `stateflowApi.test.ts`, `orgWrites.test.ts` | unit | Booking form and calendar rows; the org's own record actions; the bounded desk-vacated re-check; no-host writes refused |
| R5 | `floorBookings.test.ts` | unit | The plan's bookings query names only the floor's desks/spaces/stalls, ≤150 ids per query; a failed floor list fails the read |
| R6 | `access.test.ts`, `editAccess.test.ts`, `orgRoles.test.ts`, `RoleLookup.test.tsx` | unit | Roles load however the app is opened; Settings stays with admins; Settings closed to an unknown role |
| R6 | `reducer.test.ts` "the access grid in the app database", `sharedSettings.test.ts` | unit | The blob's grid shows until the DB holds one, then the DB's only; refusal reasons passed on |
| R6 | `fn run floorplanResponders save-access / get-settings` as an ENEC admin | live (2026-10-22) | Admin allowed (Facilio confirmed the role), unknown surface refused, grid reset to empty afterwards |
| R16 | `demoData.test.ts`, `floorplanApiOff.test.ts` | unit | No seed in a build (DEV off), an empty directory stays empty; nothing sent to `floorplanApi` |
| R9–R11 | `firstResponders.test.ts` (sanitizeRoles, sanitizeResponders, withRecordNames, respondersOnFloor, responderRolesFor, rolesOnFloor, holdersOf, responderCountLabel, responderDataFrom) | unit | Built-ins never lost; unknown roles and typed details dropped; names follow records; desks only |
| R10–R12 | `reducer.test.ts` "responders from the app database", "responder roles" | unit | DB answer wins over the blob in either load order; a removed role leaves its holders; the blob omits responders |
| R12 | `facilio vibe fn run floorplanResponders get-responders / save-roles / save-responders` with test ids `t-1`, `t-2` | live (2026-10-16) | Duplicates merged, unknown role dropped, role removal prunes holders, empty save clears, bad role refused; tables reset afterwards |
| R13 | `printAreas.test.ts`, `printRoomLabels.test.tsx` | unit | Print sheet areas and labels |
| R14 | `qrMatch.test.ts`, `hostKind.test.ts`, `hostInterface.test.ts` | unit | Codes normalised, none/ambiguous reported; mobile host detected and given bare API paths |
| R15 | `Modal.test.tsx` (focus trap, Esc order, focus return), `keyboard.test.ts`, `useDelayedFlag.test.tsx` | unit | As stated |
| R1–R2, R11, R13 | Local preview: open a floor, the responder chip and list, the Settings dialog, the print sheet | manual | Badges on holders' desks; notice is the last page |

- Run `npm test` (vitest, 479 tests) and `npx tsc --noEmit` before every deploy.
- **Known gaps:** a non-admin caller being refused by the function is not tested live (only an admin identity was available); the browser → `floorplanResponders` path inside a real vibe host, the refusal toasts and the hidden Settings tab are verified only after deploy to preview; DWG parsing not tested against a real DWG; R4/R5 org writes are exercised manually in the ENEC org, not automated.
