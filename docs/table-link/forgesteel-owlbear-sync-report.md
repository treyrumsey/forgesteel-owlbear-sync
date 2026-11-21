# Forge Steel ⇄ Owlbear Rodeo (Draw Steel Tools) Sync Bridge: Research Report

*Prepared 21 Nov 2026 for a home Draw Steel group. Research and design only; no code has been written. Source versions examined are listed in [Appendix A](#appendix-a-sources-and-versions-examined).*

---

## 1. Executive summary

**Goal.** Players manage heroes in **Forge Steel** (Andy Aiken) and play on **Owlbear Rodeo** with **Draw Steel Tools 2** (Seamus Finlayson). The bridge should:

1. Keep table stats in **two-way sync** between a hero in Forge Steel and that hero's Draw Steel Tools token: stamina, max stamina, temporary stamina, recoveries, surges, heroic resource, and conditions.
2. Store **each hero in full** (plus homebrew and session data) **on a server**, so a lost or wiped device never loses a hero.
3. Work on **iPads**.

**Recommendation.** Use three pieces, all hosted on **Railway**:

| Piece | What it is |
|---|---|
| **Forge Steel fork** | A public GitHub fork of `andyaiken/forgesteel`, merged with upstream daily, plus a small self-contained **Table Link** module (join a room, live updates). |
| **Backend** | Your own Node/TypeScript service. It **speaks Forge Steel's existing "Warehouse" storage API** and adds room codes, revision history, server-side stat calculation, conflict-aware merging, and a WebSocket hub. Postgres stores everything. |
| **Owlbear extension** | A new companion extension. It reads and writes the stat fields Draw Steel Tools keeps on each token, and draws condition badges. Draw Steel Tools itself is not modified. |

**Why this is feasible:**
- Forge Steel can already save full heroes to a remote server: its Warehouse client calls 14 HTTP endpoints. A backend that implements those endpoints gets full-hero storage, cross-device access and a device-to-server migration path (Forge Steel's Transfer page) **with no storage code in the fork**.
- Forge Steel's rules engine (`HeroLogic`) needs nothing but the hero JSON, and its tests already run in Node. So the backend can **compute max stamina, max recoveries and the heroic resource itself**, and apply edits from Owlbear directly to the stored hero.
- Upstream Forge Steel has had a central data store since May 2026 (`DataManager`). The fork can apply remote updates through it with **about two one-line hooks** into upstream files; everything else lives in new files.
- Owlbear Rodeo does **not** restrict which extension writes which token-data key. One extension can update another's data; Ricky's bridge and Seamus's own Party Continuity both already do this.

**Key design ideas:**
- **Room codes replace accounts.** A player joins with the room's code and picks their own hero. A new device recovers the hero the same way.
- **The revision stamp travels inside the hero.** The server writes `_tableLink.rev` into every hero it returns, and Forge Steel keeps unknown fields when it saves. Each save therefore says which revision it was based on, and the server can do a **field-level three-way merge**: an edit made in Owlbear survives a stale save from Forge Steel, even from unmodified forgesteel.net.
- **Writes are paced on the Owlbear side.** Every stage has per-token debouncing with a maximum wait, plus a quiet window, scene-settle, single-flight writes and batching. This minimises collisions with Draw Steel Tools, Party Continuity and humans, at an expected 1–3 s end-to-end latency.
- **Party Continuity is handled.** Token links live on the tokens themselves, and each token records the revision it last synced. When Party Continuity restores old values into a scene, they are recognised as stale and replaced from the server instead of being sent to Forge Steel.

**Main costs you accept:**
- Players must move their heroes to the fork's web address. Easiest path: point forgesteel.net at your backend once and use its own Transfer page.
- Patreon cloud storage is not available on the fork's domain.
- You own hosting, security and backups.
- Daily fork upkeep is automated, but merge conflicts occasionally need a human.

**First step:** a short spike to confirm the handful of assumptions listed in [§10](#10-risks-and-spike-checklist) before building.

---

## 2. Current state of the pieces

### 2.1 Forge Steel (upstream `andyaiken/forgesteel`)

**Project.** A React/Vite progressive web app (PWA) at forgesteel.net. It is GPL‑3 and published under the DRAW STEEL Creator License. Upstream head examined: `3c6b4ab` (20 Nov 2026).
- **Activity:** 127 commits since 1 Aug 2026; about 4 a week over the last 12 weeks, in bursts.
- **Outside contributions are accepted:** 12 PRs merged since June, 11 of them from other people, including Veritas1000 (Warehouse author) and RickyTan01.

**Hero model:**
- `Hero` (`src/models/hero.ts:21`) has a string `id`, identity and build data, a feature tree, and `state: HeroState`.
- `HeroState` (`src/models/hero-state.ts:8`) holds the live values:
  - stamina: `staminaDamage`, `staminaTemp`
  - resources: `recoveriesUsed`, `surges`, `heroTokens`
  - progression: `victories`, `xp`, `renown`, `wealth`, `projectPoints`
  - `conditions[]`
  - inventory, projects, titles, notes and encounter flags.
- **The heroic resource is not in `state`.** It is `data.value` on the hero's `HeroicResource` feature, found by feature id. That is exactly how the resources modal sets it (`src/components/modals/hero-resources/hero-resources-modal.tsx:153`).
- **Conditions** are `{ id, type, text, ends }`:
  - `type` (`src/enums/condition-type.ts:1`) is one of Bleeding, Dazed, Frightened, Grabbed, Prone, Restrained, Slowed, Taunted, Weakened, Custom or Quick;
  - `ends` (`:15`) is End of turn, Save ends or Until removed.
- **Derived values come from `HeroLogic`** (`src/logic/hero-logic.ts`):
  - `getStamina` (`:758`) and `getRecoveries` (`:799`) give the maxima;
  - `getHeroicResources` (`:1350`) returns all of a hero's resources and uses the first one whose `data.type === 'heroic'` as the default for resource gains, so we treat that one as the primary resource. Most classes have one heroic resource plus an epic one at higher levels; the Beastheart has two heroic resources (Ferocity and Rampage). Talent's Clarity can go negative;
  - `getFeatures` (`:58`).

  All of these take only the `hero`. They do not need sourcebooks, because features are copied into the hero when it is built. `hero-logic.ts` uses no browser APIs, and its tests run in vitest's default Node environment (there is no `test.environment` setting in `vite.config.ts`).

**Persistence:**
- **Local mode:** localforage (IndexedDB) under the keys `forgesteel-heroes`, `forgesteel-homebrew-settings`, `forgesteel-session` and `forgesteel-hidden-setting-ids` (`src/services/storage/local-service.ts:9-12`).
- **Warehouse mode:** `WarehouseService` (`src/services/storage/warehouse-service.ts`) talks to a remote server. Behaviours that matter for a compatible server:
  - **Auth (manual Warehouse):** `POST /connect` with `Authorization: Bearer <warehouse token>` returns `{access_token, refresh_token}`. The access token is sent as a Bearer header.
  - **Token refresh:** the client reads the JWT's `exp` claim and refreshes early. It also refreshes when it gets a `401` with `{"msg": "Token has expired"}`, calling `POST /refresh` with the refresh token.
  - **Response shapes:** reads expect `{ "data": … }`. `GET /data/forgesteel-heroes?fields=name,folder` returns **partial** heroes, so the loader then fetches each hero in full (`src/components/panels/data-loader/data-loader.tsx:150-154`).
  - **`putHero` returns the hero it sent and ignores the response body.** A server-side merge result therefore never reaches the client through the save itself.
  - **"Test connection"** (`src/components/panels/connection-settings/connection-settings-panel.tsx`) first calls `GET /healthz` and reads `version`. If the major version is above 0 it calls `POST /connect` (otherwise `GET`), and it sends that request **with credentials**, so CORS must allow credentials for that origin.
  - **Patreon mode** uses cookies and XSRF against `https://warehouse.forgesteel.net` (`src/utils/config.ts:6`).
- **Save debouncing:** `usePersistence.persistHero` (`src/hooks/use-persistence.ts:80`) waits **400 ms** after the last change, then saves a **copy taken when `persistHero` was called** (`HERO_SAVE_DEBOUNCE_MS`, `:16`).
- **State store:** `DataManager` (`src/contexts/data-context.tsx:21`) is mounted in `src/index.tsx:43`. `saveHero` (`:68`) saves to storage and then updates the hero list via `HeroesReducer` (`:173`), so every view re-renders. Components read heroes with `useHeroes()` (`:286`); for example the hero page derives its hero from it (`hero-view-page.tsx:83`).
- **Unknown top-level fields survive.** `Utils.copy` uses `structuredClone` (`src/utils/utils.ts:38`), and `HeroUpdateLogic.updateHero` changes the hero in place. Extra top-level fields therefore survive loading, editing and saving. This is what makes the revision stamp in §4.4 possible.
- **Transfer page** (`src/components/pages/transfer/transfer-page.tsx:74`): copies **heroes and homebrew** from Local to Warehouse, or back. It does not copy session data.

**Integration surfaces:**
- There are none: no API, no `postMessage` or `BroadcastChannel`, no VTT code.
- The "Extensions" feature added on 8 Oct 2026 (`746e855`) is for homebrew **rules content**, not code plug-ins.
- The repo ships a `Dockerfile` (Node build, served by nginx) and `nginx/env.sh`, which substitutes `FORGESTEEL_*` environment variables when the container starts.

### 2.2 Draw Steel Tools 2 (`SeamusFinlayson/draw-steel-tools-2`)

**Project.** An Owlbear extension, GPL‑3, manifest version 2.8.0. The last commit, "Add license", is dated 23 Jul 2026.

**Token data:**
- Stored on each scene item under **`com.draw-steel-stat-bubbles/metadata`**:
  - `getPluginId` returns `com.draw-steel-stat-bubbles/<path>` (`src/helpers/getPluginId.ts`);
  - `TOKEN_METADATA_KEY = getPluginId("metadata")` (`src/helpers/tokenHelpers.ts:13`).
- **Hero schema** (`src/types/tokenDataZod.ts:10`):
  - `type: "HERO"`, `name`, `gmOnly`
  - `stamina`, `staminaMaximum`, `temporaryStamina`
  - `heroicResource`, `recoveries` (**remaining**), `surges`
  - `heroicResourceButton` (`"D3" | "D3+1" | "+2" | "+3"`), `heroicResourceName`, `notes`
- No schema version, no owner or external id, **no conditions**.
- **Invalid data breaks the token:** `parseTokenData` (`tokenHelpers.ts:56`) **throws** if the data doesn't match the schema (`:65`).

**Party-wide trackers.** Room data key `com.draw-steel-stat-bubbles/trackers` holds `{ malice, heroTokens }` (`src/types/roomTrackersZod.ts:5-6`). Victories live only in the GM's browser storage.

**How it writes** (`src/contextMenu/TokenEditor.tsx:64-96`):
- Each change calls `OBR.scene.items.updateItems` with a filter, so the token is re-read just before writing.
- It re-parses the existing data and overlays only the changed fields.
- **Text inputs commit on blur or Enter** (`src/components/logic/FreeWheelInput.tsx:62-71`); +/- and spend buttons write on every click.

**No public API** for reading or writing stats.

### 2.3 Owlbear Rodeo platform (SDK `@owlbear-rodeo/sdk` 3.1.0)

**Token data is unrestricted:**
- `Metadata` is `Record<string, unknown>` (`lib/types/Metadata.d.ts`).
- `scene.items.updateItems(filterOrItems, update)` (`lib/api/scene/SceneItemsApi.d.ts:11`) accepts any change.
- The SDK source (`src/api/scene/SceneItemsApi.ts:46`) computes the change, then sends the changed **top-level** properties. It has **no check on which extension owns a key**.

**Permissions are per item layer, not per extension** (`lib/types/Permission.d.ts`): for example `CHARACTER_UPDATE` and `CHARACTER_OWNER_ONLY`. Owlbear's own extensions check them against the whole item. With `CHARACTER_OWNER_ONLY` set, a player may only update items they created (`owlbear-rodeo/ranges` `src/background/permission.ts`).

**Useful facts:**
- `item.createdUserId` and `item.lastModifiedUserId` (`lib/types/items/Item.d.ts:11-14`) say who made and who last edited each item.
- Other APIs used here: `OBR.room.id`, `OBR.player.hasPermission` (`PlayerApi.d.ts:22`), `OBR.scene.onReadyChange` (`SceneApi.d.ts:17`), and `OBR.modal.open({url})`.
- Extensions run in cross-origin iframes. A personal extension is added by manifest URL; no store review is involved.
- Owlbear fetches the manifest and icon SVGs cross-origin, so they need `Access-Control-Allow-Origin: *` (documented from experience in Ricky's `nginx.conf`).

### 2.4 Prior art: RickyTan01's bridge and fork

**`RickyTan01/forgesteel-obr-bridge`** (66 commits, 12–24 Aug 2026, **no LICENSE file**) is an Owlbear extension that **polls a Forge Steel Warehouse** and writes Draw Steel Tools' key:
- One-way only, Forge Steel → Owlbear (`src/logic/conversion.ts:13`; the reverse at `:49` is unused).
- Only the GM's browser holds the Warehouse token, so **all players share one Warehouse account**.
- Draws condition badges and caches conditions in room data for players.
- Polls conditions every 15 s and debounces change events by 2 s (`src/background/main.ts:16,23`).

**`RickyTan01/forgesteel@dev`** adds `staminaMax`, `recoveriesMax`, `heroicResourceValue` and `heroicResourceName` to each Warehouse save (commit `d1f18f1`, 13 lines). It uses `heroicResources[0]`, which can pick the wrong resource for a hero with more than one.
- Its daily `sync-upstream.yml` **rebases and force-pushes** onto upstream.
- It has **stalled 57 commits behind** since 24 Aug: upstream reworked `src/components/main/main.tsx` and `src/contexts/data-context.tsx`, the two files the fork had edited, and a test merge conflicts in both.
- **Lesson:** don't edit upstream files that change often, and merge rather than rebase.

### 2.5 Forge Steel Warehouse (`Veritas1000/forgesteel-warehouse`)

- A Flask service that stores each user's data as JSON (`FsHero.data`, `models.py:112-119`).
- Every user has their own data; users are created by a CLI script.
- **No revisions or ETags**; a PUT simply replaces the hero.
- CORS allows credentials (`__init__.py:104`).
- Patreon login is tied to forgesteel.net: the redirect URL comes from an environment variable (`resources/token_handler.py:133`) and cookies default to `SameSite=Lax` (`__init__.py:43`).
- Its endpoint shapes are the reference for compatibility, for example `{"data": …}` bodies, `204` on PUT, and `400` if the hero id doesn't match the URL (`resources/forgesteel_data.py`).

### 2.6 Party Continuity (Seamus Finlayson)

Party Continuity is a **paid, closed-source** extension for Seamus's Patreon members, announced 20 Dec 2025. Draw Steel Tools' sidebar recommends it (`src/action/header/SideBarMenu.tsx:144`). From the public part of [the announcement](https://www.patreon.com/posts/new-extension-146279272):
- It saves party tokens **in the GM's browser**, separately for each Owlbear room and user.
- "Insert Party" creates a spawn area in a scene. Party tokens are then added to every scene opened, and removed when taken out of the party.
- It carries **name, description, layer, visibility, image and all token data** between scenes. Draw Steel Tools is listed by name, so our extension's data will travel too.
- If browser data is cleared or the GM changes device, the saved party is lost; it can "re-host" from the tokens in the current scene.

---

## 3. Options considered

| # | Option | Two-way | Fork needed | iPad | Users stay on forgesteel.net | Verdict |
|---|---|---|---|---|---|---|
| A | Import exported hero files into an Owlbear extension | ✗ (manual, one-way) | No | ✓ | ✓ | Too manual |
| B | Browser extension bridging the two tabs | ✓ | No | ✗ (iPad needs an App Store app) | ✓ | Rejected |
| C | Embed Forge Steel in an Owlbear modal and connect with `postMessage` | ✓ while open | Yes | ⚠ separate storage inside the frame; Owlbear's room page sends strict cross-origin headers | ✗ | Rejected |
| D | Warehouse hub: Ricky's bridge, improved | Only with PRs to Forge Steel **and** the Warehouse | No, once upstreamed | ✓ | ✓ (self-hosted Warehouse only) | Shared account and polling; licence blocker |
| E | Upstream "Table Link" module in forgesteel.net, plus your backend | ✓ | No | ✓ | ✓ | Depends entirely on Andy merging |
| F | **Public fork + own Warehouse-compatible backend + room codes + Owlbear extension** | ✓ real-time | Yes | ✓ | ✗ (they move to the fork; forgesteel.net still works in a limited mode) | **Chosen** |

**Why F:**
- It meets all three goals without waiting on anyone, and you control hosting.
- Building the backend to Forge Steel's own storage contract keeps the fork's changes tiny.
- It keeps a route back to E open: the Table Link module is self-contained and could be offered upstream later.

**Why not host Veritas1000's Warehouse itself plus a side service:**
- Each user has their own data and users are created by a script, which doesn't fit room seats.
- There are no revisions to base merges on.
- A second service would have to write into another project's database schema.
- It would mean running both Python and Node.

**Why a server is unavoidable on iPad:**
- Every iPad browser uses Safari's engine (WebKit). It blocks third-party cookies, gives each site separate storage, and suspends background tabs.
- So no purely in-browser channel between forgesteel.net and Owlbear works reliably. A network hop is required, and the server you need for backups doubles as that hop.

---

## 4. Architecture

### 4.1 Overview

```
 Forge Steel fork (browser / iPad PWA)              Railway                                Owlbear Rodeo
 ┌──────────────────────────────┐ HTTPS (Warehouse API) ┌─────────────────────────┐  WSS  ┌──────────────────────────┐
 │ upstream Forge Steel, incl.  │ ────────────────────▶ │ api (Node/TS)           │ ◀───▶ │ companion extension       │
 │  unchanged WarehouseService  │                       │ • Warehouse-compatible  │       │ • room binding            │
 │ src/table-link/ (new files)  │ ◀──── WSS notify ──── │ • rooms/seats/devices   │       │ • token↔hero links        │
 │ • join room / pick hero      │                       │ • HeroLogic (server)    │       │ • writes DST token data   │
 │ • apply remote updates       │                       │ • revisions + 3-way     │       │ • condition badges        │
 └──────────────────────────────┘                       │   merge                 │       └──────────────────────────┘
 forgesteel.net (optional) ── HTTPS (manual Warehouse) ▶ │ • WebSocket hub         │
                                                        └───────────┬─────────────┘
                                                                    │ Postgres (JSONB) ─▶ nightly off-site backup
```

### 4.2 Rooms instead of accounts

| Concept | Details |
|---|---|
| **Room** | Created by the GM. It has a **join code** of about 10 base32 characters (≈50 bits), rate-limited and rotatable, and a separate long random **GM key**. |
| **Seat** | One participant, for example "Trey". A seat owns its heroes, its session data and its hidden-sourcebook ids. **Homebrew sourcebooks are shared across the room**, because heroes depend on them. |
| **Device token** | Issued when someone joins with the code and **picks their seat or hero**. It is used exactly like a Warehouse API token (`/connect` → JWT). It is stored hashed, and the GM can list and revoke tokens. |
| **Recovery** | On a new device: rejoin with the code and pick the same seat, and every hero comes back. Then revoke the lost device's token. |
| **Owlbear room token** | Created by the GM's extension using the GM key and stored in the Owlbear room's shared data, so every client in that room can sync. It can **only** read stat summaries and patch the synced fields of linked heroes. |
| **Visibility** | A seat sees its own heroes plus the room's homebrew; the GM sees everything. |

A small **join page** served by the backend (enter code → pick seat → show a device token) lets unmodified forgesteel.net connect through Settings → Warehouse.

### 4.3 Backend: Warehouse-compatible API

**Compatibility contract.** Implement what `WarehouseService` and the connection test actually call, matching the reference Warehouse's response shapes:

| Endpoint | Behaviour to match |
|---|---|
| `GET /healthz` | `{ "version": "1.x.y" }`. Major ≥ 1 makes Forge Steel use `POST /connect`. |
| `POST /connect` | Bearer device token → `{ access_token, refresh_token }`. JWTs must carry `exp`. Invalid token → `401` with `{message}`. |
| `POST /refresh` | Bearer refresh token → `{ access_token }`. |
| `GET /me` | `{ logged_in_as }` (seat name). |
| `GET /data/forgesteel-heroes[?fields=a,b]` | `{ data: [...] }`. With `fields`, each item is `{ id, ...fields }`. |
| `GET` / `PUT` / `DELETE /data/forgesteel-heroes/{id}` | `GET` → `{ data: hero }` or 404. `PUT` → 204 (`400` if `id` ≠ URL). `DELETE` → 204 (soft delete). |
| `GET` / `PUT` / `DELETE /data/forgesteel-homebrew-settings[/{id}]` | Same pattern; shared across the room. |
| `GET` / `PUT /data/forgesteel-session`, `/data/forgesteel-hidden-setting-ids` | `{ data: … or null }`; PUT → 204. Stored per seat. |
| Expired access token | `401` with `{ "msg": "Token has expired" }`. This exact text drives Forge Steel's refresh-and-retry. |

**Additional endpoints (not used by Forge Steel itself):**
- `POST /rooms` (create)
- `POST /join` (code → seats → device token)
- `GET /rooms/{id}/devices` and `DELETE …/devices/{id}` (GM)
- `POST /obr/bind` (GM key → Owlbear room token)
- `GET /obr/summaries`
- `GET /ws` (WebSocket upgrade)

**Data model (Postgres):**

| Table | Purpose |
|---|---|
| `rooms` | id, join-code hash, GM-key hash, Owlbear room id(s) |
| `seats` | room, display name |
| `device_tokens` | seat, hash, label, created/last-used, revoked |
| `heroes` | id, seat, `data` JSONB, `rev`, `hash`, `updated_at`, `deleted_at` |
| `hero_revisions` | hero id, rev, `data` JSONB, source (device/OBR), timestamp. Used as merge bases and for undo/restore; retention configurable. |
| `homebrew` | room, id, `data` JSONB, rev |
| `seat_session`, `seat_hidden_ids` | seat, `data` JSONB |
| `audit_log` | joins, revocations, restores |

Token ↔ hero links are **not** stored here; they live on the Owlbear tokens (§4.6).

**HeroLogic on the server.** The backend lives in the fork repo and imports `HeroLogic` from the fork's own `src/`, built from the same commit. It does two jobs:
- **Summarise** a hero for Owlbear: name, max stamina, current stamina, temporary stamina, max and current recoveries, surges, the primary heroic resource (feature id, name, value), and conditions.
- **Apply** patches from Owlbear: `state.*` fields directly; the heroic resource by feature id, the same way as the resources modal.

### 4.4 Revisions, merging and echo suppression (refined during this report)

This section addresses three findings from §2.1:
- `putHero` ignores the server's response.
- The 400 ms debounce saves a copy taken earlier, which may be stale.
- A modal can hold its own stale copy of the hero.

The fix is a **revision stamp embedded in the hero JSON**:

1. Every hero the server returns (GET or after a push) carries `"_tableLink": { "rev": n }`. Forge Steel keeps unknown top-level fields, so any later save, even a debounced or stale copy, **carries the revision it was based on**.
2. On `PUT /data/forgesteel-heroes/{id}` the server:
   1. **Echo check:** if the body, ignoring the stamp, hashes the same as the current version, it does nothing. This absorbs echoes, including the fork re-saving a hero it just received.
   2. **Non-synced parts** (build, inventory, notes, …): takes the incoming body, last writer wins. Owlbear never edits these.
   3. **Synced fields:** runs a three-way merge against the base revision from `hero_revisions`:
      - a field the client didn't change (incoming = base) keeps the server's current value, which may be an Owlbear edit;
      - a field the client did change takes the client's value, last writer wins;
      - **conditions** are merged as a set by condition id.
   4. If the stamp is missing or its revision has been pruned (first upload, or the Transfer page), the incoming body wins, and this is logged.
   5. Saves as `rev + 1`, stores the revision, and notifies subscribers. If the merged result differs from what the client sent, the server **pushes it back to that device** (fork only) so its screen is corrected.
3. Owlbear patches carry `baseRev` and go through the same merge at summary level.

**Effect:**
- In the fork, a stale debounced save can no longer undo a remote update, without modifying upstream `usePersistence`.
- With unmodified forgesteel.net, Owlbear edits are **never lost**; they just appear there after a reload.

Two Forge Steel devices editing the **build** of the same hero at once fall back to last writer wins for those fields, which is acceptable for a home group.

### 4.5 WebSocket protocol (sketch)

```
client → server  hello     { jwt, kind: "fs" | "obr", heroes?: { [heroId]: lastRev } }
server → client  welcome   { serverTime }
server → fs      hero.changed { heroId, rev }        → client GETs the full hero via the normal API
server → obr     summary   { heroId, rev, name, staminaMax, stamina, staminaTemp,
                             recoveriesMax, recoveries, surges,
                             resource: { featureId, name, value }, conditions: [...] }
obr → server     patch     { heroId, baseRev, editId, changes: {...}, conditions?: {add, remove} }
server → obr     ack       { editId, rev }  |  reject { editId, reason }
```

- The token goes in the first message, not the URL, so it never appears in logs.
- On reconnect, the client sends the last revision it saw for each hero, and the server sends only the latest state of heroes that changed.
- Notifications are coalesced per hero (§4.8).

### 4.6 Forge Steel fork: the Table Link module (`src/table-link/`)

**Room panel:**
- Join with a code, pick a seat, or create one.
- Fill in Forge Steel's existing `ConnectionSettings` for the backend. The backend address comes pre-filled from a `FORGESTEEL_*` environment variable supplied by `nginx/env.sh`.
- Guide the user through the existing Transfer page (Local → server).

**Live listener (`TableLinkProvider`):**
- Mounted inside `DataManagerProvider` (`src/index.tsx`).
- Keeps the WebSocket open. On `hero.changed`, it fetches the hero and applies it with `dataManager.saveHero()`; the resulting save is an echo and does nothing on the server.
- Reconnects and catches up on `visibilitychange`, which matters on iPad.
- Because the hero page reads from `useHeroes()`, the new values render immediately.

**Hook points in upstream files: about two.** One mounts the provider in `src/index.tsx` (4 upstream changes since Aug). The other adds a menu or route entry for the room panel. Everything else is new files.

**Not changed:** `WarehouseService`, `usePersistence`, `data-context.tsx` and `main.tsx`, the files where Ricky's fork conflicted.

### 4.7 Owlbear companion extension

**Room binding.** The GM enters the GM key once; it is kept in the GM's browser storage. The extension binds the Owlbear room (`OBR.room.id`) and stores the **room token** in Owlbear room data, so every player's client can sync. Room data is size-limited, so it holds only the token and the server URL.

**Linking:**
- Each token carries **its own link** under our key, for example `com.<you>.table-link/metadata` = `{ heroId, syncedRev, conditions: [...] }`.
- Because the link is on the token, it follows Party Continuity's copies into every scene.
- Tokens are linked by name match or with a picker.

**Server → token writes (an "elected writer").** Exactly one client writes, chosen in this order:
1. a GM client, if one is online;
2. otherwise the token creator's client (`item.createdUserId`), if `OBR.player.hasPermission` allows it;
3. otherwise the write is queued.

Writes follow the pacing rules in §4.8, re-read the token immediately before writing, **patch only the synced Draw Steel Tools fields** (keeping `notes`, `gmOnly` and `heroicResourceButton`), and are checked afterwards.

**Token edits → server.** Only the client whose player matches `item.lastModifiedUserId` forwards a change, so each edit is sent once. The diff is taken against the last-synced snapshot and sent with `baseRev = syncedRev`.

**Conditions:**
- Stored in our key on the token.
- Each client draws **local** badge items from that data, as Draw Steel Tools does for its bars, so there are no shared writes and nothing for Party Continuity to copy.
- A context menu lets players add or remove conditions.

**Hosting.** Static files with CORS headers on `manifest.json` and the SVG icons.

### 4.7.1 Coexisting with Draw Steel Tools

**Yes, Owlbear lets our extension write Draw Steel Tools' data** (evidence in §2.3). Names like `com.draw-steel-stat-bubbles/...` avoid collisions but grant no ownership. Ricky's bridge and Seamus's own Party Continuity already write it, and Ricky's screenshots show Draw Steel Tools displaying the synced values.

Constraints:

| Constraint | Response |
|---|---|
| The writing player's permissions apply to the whole token (`CHARACTER_UPDATE`, `CHARACTER_OWNER_ONLY`) | Elected-writer rule (§4.7) |
| An update replaces the token's whole data object, so a write by Draw Steel Tools or Party Continuity in between can be lost | Pacing (§4.8), re-read before writing, skip unchanged writes, check afterwards and reconcile |
| Draw Steel Tools **throws** on invalid data | Write only values that match its schema (finite numbers, valid strings); validate against our copy of the schema before writing |
| The schema is undocumented and unversioned | Daily contract check against `tokenDataZod.ts` in Seamus's repo (§7). Fallbacks: ask Seamus for an API, fork Draw Steel Tools (GPL‑3), or draw our own trackers |

### 4.7.2 Coexisting with Party Continuity

| Aspect | Effect | Design response |
|---|---|---|
| Complementary | Party Continuity moves tokens between scenes; we keep their stats current | The link lives on the token, so you **link once** and it works in every scene |
| **Stale restore** | When a scene opens, Party Continuity may write **old** Draw Steel Tools values back | Forward a token change only if its `syncedRev` equals the hero's current revision. Otherwise treat it as a restore and **overwrite it from the server**. Always reconcile from the server after the scene settles |
| Durability overlap | Party Continuity's storage exists only in the GM's browser | The server is authoritative for linked heroes; a lost Party Continuity save costs only token cosmetics |
| Badges | Attached items aren't carried | Badges are local, redrawn from token data on every scene load |
| Closed source | Its internals can't be inspected | No dependency on it; test hands-on in the spike (requires a paid membership) |

### 4.8 Write pacing and debouncing

**Principles:**
- Debouncing **reduces** collisions but can't eliminate them, because Owlbear has no compare-and-set. The re-read, unchanged-write skip, check and reconcile always stay.
- Each window applies **per token or per hero** and has a **trailing delay plus a maximum wait**, so a busy token never starves the others.

| Stage | Where | Starting values (tune in the spike) |
|---|---|---|
| 1. Forge Steel edit → server | upstream `persistHero` | Existing 400 ms trailing debounce |
| 2. Server → clients | WebSocket hub | Coalesce per hero: 250 ms trailing, 1 s max; send the latest revision only |
| 3. Elected writer → Draw Steel Tools token | extension | Per-token queue: **300 ms trailing, 1.5 s max**, plus the rules below |
| 4. Token edit → server | editing player's client | Per token: **500 ms trailing, 2 s max**; one diff with `baseRev`; ignore our own echoes by comparing against pending-write signatures |
| 5. Server → Forge Steel fork | `TableLinkProvider` | Coalesce per hero; one `saveHero()` per batch |
| 6. Condition badges | each client | 200 ms redraw debounce |

**Extra rules for stage 3:**
- **Quiet window:** wait while anyone else changed the token in the last **750 ms**; write anyway after 3 s.
- **Scene settle:** after the scene becomes ready or items are added, wait for **1 s** with no changes before reconciling.
- **Single-flight:** at most one write per token in flight at a time.
- **Batch:** write all due tokens in **one** `updateItems` call.
- **Diff on the fresh read:** compare against the values re-read in the updater and skip the write if nothing changed.

**Expected latency:** roughly 0.7–3 s from Forge Steel to Owlbear and 0.8–3 s the other way.

### 4.9 Field mapping

| Forge Steel | Draw Steel Tools token | Direction | Notes |
|---|---|---|---|
| `name` | `name` | FS → OBR | The Owlbear item's own name isn't changed |
| `HeroLogic.getStamina(hero)` | `staminaMaximum` | FS → OBR | Recomputed on the server after every change |
| max − `state.staminaDamage` | `stamina` | ⇄ | Negative values (dying) allowed; reverse: `staminaDamage = max − stamina` |
| `state.staminaTemp` | `temporaryStamina` | ⇄ | Kept separate, **not** folded into damage |
| `HeroLogic.getRecoveries(hero)` − `state.recoveriesUsed` | `recoveries` | ⇄ | Draw Steel Tools stores **remaining** recoveries |
| `state.surges` | `surges` | ⇄ | |
| primary `HeroicResource` feature `.data.value` (by feature id) | `heroicResource` | ⇄ | Primary = the first `heroic`-type resource, the same rule `getHeroicResources` uses. Beastheart's second resource (Rampage) and every class's higher-level epic resource are not synced at first. Talent's Clarity can be negative, which Draw Steel Tools' `z.number()` accepts |
| that feature's name | `heroicResourceName` | FS → OBR | |
| `state.conditions[]` | our key on the token + badges | ⇄ | Merged by condition id |
| — | `heroicResourceButton`, `notes`, `gmOnly` | not touched | Draw Steel Tools-only settings |
| `state.heroTokens`, `state.victories` | (party pool / GM-local) | not synced | Different meaning in each app |

---

## 5. iPad behaviour

- **Install:** players install the fork as a home-screen app from its own domain, and use Split View or Stage Manager next to Owlbear.
- **Reconnecting:** WebSockets only run while the app is in the foreground. On `visibilitychange` the fork and the extension reconnect and catch up by revision.
- **No cookies needed:** everything uses Bearer tokens, so blocked third-party cookies don't matter.
- **Storage:** Safari's per-site storage separation no longer matters, because the server holds the data. Being online-only is acceptable, since Owlbear needs the internet anyway.
- **Lost GM key:** the extension's own browser storage, including the GM key, may be cleared by Safari's storage policies. That only affects GM admin actions, because the Owlbear room token lives in Owlbear room data. Keep the GM key in a password manager.
- **Writer device:** if the GM plays on an iPad that goes to the background, the elected writer pauses and writes are queued. A GM laptop makes the best writer.

---

## 6. Durability and backups

| Layer | Purpose |
|---|---|
| `hero_revisions` + soft delete | Undo or restore a hero, or a bad merge, from inside the app |
| Railway volume backups for Postgres (if your plan includes them) | Fast whole-database rollback |
| **Nightly `pg_dump` cron → off-platform S3-compatible bucket** (e.g. Cloudflare R2, Backblaze B2), encrypted (`age`/`gpg`) before upload | Survives losing the Railway project or account |
| Forge Steel's own hero export and Backup page | Each player's own copy |

- **Retention example:** 30 daily and 12 monthly dumps; revision history pruned to the last N revisions per hero plus daily checkpoints.
- **Test a restore** into a scratch database before relying on the backups, and again after schema changes.

---

## 7. Fork upkeep

**Repo.** A **public fork** of `andyaiken/forgesteel`:
- It stays in the fork network, so GitHub's Sync fork button is available as a manual fallback.
- Pull requests to Andy are possible straight from it.
- Being public satisfies GPL‑3 source availability.
- GitHub-hosted Actions are free for public repos.
- Keep secrets in Railway variables only. Use a distinct name and branding.

**Daily upstream sync (merge, not rebase):**
1. A scheduled workflow fetches `andyaiken/main` and merges it into a `sync/upstream-<sha>` branch.
2. It pushes **with a fine-grained PAT or GitHub App token**. A push made with `GITHUB_TOKEN` doesn't trigger other workflows, so CI would never run.
3. It opens a PR with auto-merge, gated on required checks: `npm run check` (lint, tsc, vitest, audit) plus backend tests plus contract tests.
4. On a conflict or failing checks, the PR stays open, an issue is raised, and production keeps the last good build.
5. Railway deploys `main` with **"Wait for CI"** turned on.

**Contract tests** fail loudly as soon as upstream changes anything we depend on:
- `DataManager.saveHero` and `useHeroes`;
- the `HeroLogic` getters (`getStamina`, `getRecoveries`, `getHeroicResources`, `getFeatures`);
- the `HeroState` field names;
- `WarehouseService`'s endpoint paths and response handling;
- unknown top-level fields surviving `Utils.copy` and `HeroUpdateLogic.updateHero`.

**External contract checks** (daily, raise an issue on change):
- Draw Steel Tools' `src/types/tokenDataZod.ts` hash;
- the `@owlbear-rodeo/sdk` version.

**Minimal-diff rule:** new files only, apart from the two hook lines. Never edit `main.tsx`, `data-context.tsx`, `use-persistence.ts` or `warehouse-service.ts`.

---

## 8. Railway deployment

| Service | Source | Settings |
|---|---|---|
| `fs-web` | Fork, existing `Dockerfile` (nginx) | Runtime `FORGESTEEL_*` variables for the backend URL; custom domain; GitHub autodeploy with Wait for CI |
| `api` | Fork monorepo `server/` (Node/TS) | **Serverless off.** Serverless sleeps a service 5–10 minutes after its last outbound traffic, which would drop WebSockets. Healthcheck `/healthz`; one replica (if you ever scale out, fan out with Postgres `LISTEN/NOTIFY`) |
| `postgres` | Railway Postgres | Volume backups if available |
| `backup` | Small image running `pg_dump` + encrypt + upload | Railway cron schedule (nightly) |
| Extension static files | Served by `api` under `/obr/`, or a separate static service | `Access-Control-Allow-Origin: *` on `manifest.json` and `*.svg` |

**Environment variables:**
- `DATABASE_URL`
- `JWT_SECRET` and `JWT_REFRESH_SECRET`
- `CORS_ORIGINS`: the fork's origin, `https://forgesteel.net` and the extension's origin. The `/connect` test sends credentials, so reply with the **specific** origin plus `Access-Control-Allow-Credentials: true`.
- The backup bucket's credentials and encryption key.

**Abuse limits:**
- Rate-limit `/join` and `/connect`.
- Cap request size: heroes at a few MB, homebrew higher.
- Close idle WebSockets.

---

## 9. Migration, costs, licensing and branding

**Moving a group onto the bridge:**
1. The GM deploys and creates a room, getting a join code and a GM key.
2. **Each player, on the device that has their heroes:**
   1. Open the backend's join page, enter the code and pick a seat to get a device token.
   2. In **forgesteel.net** (inside the installed app on iPad, if that's where the heroes are), go to Settings → Warehouse, enter the backend address and token, and test the connection.
   3. Open the **Transfer** page and copy Local → Warehouse. This uploads heroes and homebrew.
3. Each player opens the fork's address, installs it, joins with the code and picks the same seat. Their heroes load from the server.
4. Session data isn't moved by Transfer; the GM moves it with Backup export and import.
5. The GM adds the extension to the Owlbear room by URL, binds it with the GM key, and links tokens.

**Costs and limits you accept:**
- Players use the fork's address. forgesteel.net still works with the backend, but Owlbear edits show there only after a reload.
- Patreon cloud storage isn't available on the fork's domain.
- You own hosting, uptime, security and backups.

**Licensing and branding:**
- **Forge Steel** is GPL‑3; the public fork satisfies its source requirement. The backend runs only on your server, so it isn't distributed and GPL‑3 adds no source obligation for it (the repo is public anyway). Keep the license and the DRAW STEEL Creator License notices.
- **Our extension** is written from scratch. Draw Steel Tools is referenced only by its token-data key and field names. Ricky's bridge has **no license**, so treat it as reference only and don't copy its code or art.
- **Branding:** use a distinct name and icon so the fork isn't mistaken for official Forge Steel.

---

## 10. Risks and spike checklist

| Risk | Impact | Mitigation | Spike check |
|---|---|---|---|
| Owlbear rejects or ignores a write to another extension's data | High | Evidence says no restriction | Tiny test extension writes Draw Steel Tools' key; Draw Steel Tools re-renders; its schema check accepts the values |
| Lost updates with Draw Steel Tools or Party Continuity writing at the same time | Medium | Pacing, re-read, check after writing, reconcile | Scripted bursts (rapid clicks in Draw Steel Tools, rapid +/- in Forge Steel, scene switches) count lost updates; tune the windows |
| `CHARACTER_OWNER_ONLY` blocks players' writes | Medium | Elected writer, queueing | Test with the room's permission set both ways |
| `HeroLogic` misbehaves in Node or with homebrew | High | Same-commit import; contract tests | Compute summaries in Node for sample heroes, including homebrew, a Beastheart (Ferocity + Rampage), a Talent with negative Clarity, and a high-level hero with an epic resource |
| Unknown top-level fields stripped somewhere | High (breaks §4.4) | Contract test; fall back to a per-device server-side copy of what each device last held | Round-trip `_tableLink` through load, edit, modal save, the Transfer page and hero export/import |
| Stale debounced save overwrites a remote update | Medium | Revision stamp plus three-way merge | Remote update arrives during an open resources modal and an in-flight debounce |
| iPad WebSocket resume is flaky | Low–medium | Catch up by revision on `visibilitychange`; queued writes | Background and foreground Safari and the installed app |
| Party Continuity restores stale values | Medium | `syncedRev` guard; reconcile after the scene settles | Edit in Forge Steel, then switch scenes with Party Continuity; confirm our keys are carried (needs membership) |
| Draw Steel Tools schema changes | Medium | Daily hash check; schema validation before writing | — |
| Upstream merge conflicts | Medium | Minimal-diff rule; merge PRs; keep the last good build | Do a trial merge of the module onto upstream head |
| Transfer page doesn't carry homebrew correctly | Low | Room-shared homebrew merged by id | Transfer a hero that depends on homebrew |

---

## 11. Phased roadmap

No time estimates; each phase leaves something usable.

0. **Spike:** the checklist above, with a throwaway Owlbear extension, a Node script using `HeroLogic`, and a stub Warehouse-compatible server tested against unmodified forgesteel.net.
1. **Backend storage MVP:** the Warehouse-compatible API, rooms, seats, device tokens, join page, revisions and nightly off-site backups. Migrate the group using forgesteel.net's Transfer page. **This alone delivers the "lost device" goal.**
2. **Fork setup:**
   - public fork, branding, Railway `fs-web`;
   - daily merge workflow, contract tests, Wait for CI;
   - Table Link room panel.
3. **Live Forge Steel side:** the WebSocket hub, `TableLinkProvider`, the revision stamp and three-way merge.
4. **Owlbear, Forge Steel → token:** room binding, linking, summaries, elected writer, pacing, Draw Steel Tools writes, condition badges.
5. **Owlbear, token → Forge Steel:** edit forwarding, patches, the Party Continuity stale-restore guard, condition editing.
6. **Hardening:** rate limits, audit log views, a restore drill, monitoring, short how-to docs for the group.

**Optional requests to Andy that would shrink the fork** (each useful on its own):
1. A stable `HeroLogic` summary helper for VTTs (max stamina, max recoveries, heroic resources with feature ids).
2. A supported way to apply an external hero update that also cancels or merges a pending debounced save.
3. Re-fetching remote heroes on focus or on an interval in Warehouse mode.
4. A documented, preserved place for third-party fields on a hero (e.g. `hero.meta`), formalising what §4.4 relies on.
5. A lightweight slot for a provider and a menu entry, so the module needs no edits to upstream files.

---

## Appendix A: sources and versions examined

| Project | Commit / version |
|---|---|
| Forge Steel upstream | [`andyaiken/forgesteel@3c6b4ab`](https://github.com/andyaiken/forgesteel/tree/3c6b4ab79ff871adfea74f290dd1c3d4069cf4b3) (20 Nov 2026) |
| Draw Steel Tools 2 | [`SeamusFinlayson/draw-steel-tools-2@a445eb9`](https://github.com/SeamusFinlayson/draw-steel-tools-2/tree/a445eb90c5d662d3237d94038f32eeb377e7b75d) (23 Jul 2026, manifest 2.8.0) |
| Owlbear Rodeo SDK | [`owlbear-rodeo/sdk@f408472`](https://github.com/owlbear-rodeo/sdk/tree/f40847243b2c90eeb39acf63d68de74de5be8c00) and npm `@owlbear-rodeo/sdk` 3.1.0 |
| Ricky's bridge | [`RickyTan01/forgesteel-obr-bridge@7b6454a`](https://github.com/RickyTan01/forgesteel-obr-bridge/tree/7b6454abb885310c972683e79d54ad41ea09665a) (no license) |
| Ricky's Forge Steel fork | [`RickyTan01/forgesteel@71f1103`](https://github.com/RickyTan01/forgesteel/tree/71f1103cc6c46616dcae501a56441fd09a7ebf2f) (dev); derived-fields commit [`d1f18f1`](https://github.com/RickyTan01/forgesteel/commit/d1f18f160f9ac7b1b3d3aee18dfb496015394714) |
| Forge Steel Warehouse | [`Veritas1000/forgesteel-warehouse@25f24db`](https://github.com/Veritas1000/forgesteel-warehouse/tree/25f24db14903ed4616cfeb8dfdd1b8c63d59c289) |
| Owlbear permission examples | [`owlbear-rodeo/ranges`](https://github.com/owlbear-rodeo/ranges) `src/background/permission.ts`, [`owlbear-rodeo/outliner`](https://github.com/owlbear-rodeo/outliner) `src/hasPermission.ts` |
| Party Continuity | [Patreon announcement](https://www.patreon.com/posts/new-extension-146279272) (public excerpt, 20 Dec 2025) |
| GitHub | [Fork visibility](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-permissions-and-visibility-of-forks) |
| Railway | [Serverless (app sleeping)](https://docs.railway.com/reference/app-sleeping), [GitHub autodeploys / Wait for CI](https://docs.railway.com/guides/github-autodeploys), [Cron jobs](https://docs.railway.com/guides/cron-jobs) |

**Not verifiable from scripts:** Owlbear's documentation site (behind a Cloudflare challenge) and the closed-source Owlbear app and Party Continuity. Claims about them are based on the SDK source and types, Owlbear's own open-source extensions, and observed prior art, and are marked for hands-on confirmation in §10.
