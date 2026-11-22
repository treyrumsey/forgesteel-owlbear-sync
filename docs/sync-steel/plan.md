# Forge Steel ⇄ Draw Steel Tools (Owlbear Rodeo) Bridge: Plan

> **Status 2026‑11‑21:** research and design are complete. The full write-up is in [forgesteel-owlbear-sync-report.md](./forgesteel-owlbear-sync-report.md). Where this plan and the report differ, **the report wins**; for example, the report's §4.4 has the authoritative merge design (a revision stamp kept inside the hero JSON).
> **Repo:** public fork [`treyrumsey/forgesteel-owlbear-sync`](https://github.com/treyrumsey/forgesteel-owlbear-sync) of `andyaiken/forgesteel`, cloned at `~/dev/forgesteel-owlbear-sync`. Setup steps and next actions are in [SETUP.md](./SETUP.md).
> Phase 0 (the spike) is done and merged to `main` (22 Nov 2026): results are in [spike-results.md](./spike-results.md). **Next: Phase 1, the backend storage MVP**; see [SETUP.md](./SETUP.md#next-phase-1-the-backend-storage-mvp).

## Problem
A home group builds heroes in **Forge Steel** (FS, React PWA, GPL‑3) and plays on **Owlbear Rodeo** (OBR) with **Draw Steel Tools 2** (DST, GPL‑3), which tracks hero stats on tokens. Two goals:
- **Two-way sync** of table stats between FS and the DST token trackers, working on **iPad**.
- **Durable storage of the entire hero** (plus everything it depends on) on a server, so a lost device never loses a room's heroes.

## Decisions
| Topic | Decision |
|---|---|
| Direction | **Long-term self-hosted FS fork** + own backend + new OBR companion extension, all on **Railway** |
| Audience | **Home group only**; the user controls the setup |
| Identity and recovery | **Room code.** A player joins a room with its code and **picks their own hero**. On a new device: rejoin with the code, pick the hero, and it's restored. No separate accounts. |
| Backend | **Own Node/TS backend speaking the FS Warehouse API**, plus rooms and a WebSocket sync hub |
| What the server stores | **Everything FS stores:** full heroes, homebrew sourcebooks, session, hidden-sourcebook ids, plus revision history |
| OBR sync fields | stamina, max stamina, temporary stamina, recoveries, surges, heroic resource value and name, **conditions**. The full hero is never shown in OBR. |
| Not synced | hero tokens (FS tracks them per hero, DST as a party pool), victories |
| forgesteel.net compatibility | **Yes:** unmodified forgesteel.net can use the backend via "manual Warehouse" (backup + FS → OBR; OBR → FS edits appear on reload) |
| OBR extension | **Our own.** Ricky's bridge has no license, so it's prior art only. |
| Outreach drafts | None. Optional upstream asks are listed only as ways to shrink the fork. |

## Target architecture
```
 FS fork (browser/iPad PWA)                     Railway                                   Owlbear Rodeo
 ┌───────────────────────────┐   HTTPS (Warehouse API)   ┌──────────────────────────┐  WSS  ┌───────────────────────┐
 │ upstream FS (unchanged    │ ───────────────────────▶ │ api+ws (Node/TS)         │ ◀───▶ │ companion extension    │
 │  WarehouseService)        │                           │  • Warehouse-compatible  │       │  • room binding        │
 │ src/sync-steel/ module    │ ◀─────── WSS push ─────── │  • rooms/seats/devices   │       │  • token↔hero links    │
 │  • join room / pick hero  │                           │  • HeroLogic (server)    │       │  • writes DST metadata │
 │  • apply pushed heroes    │                           │  • 3-way merge, revs     │       │  • condition badges    │
 └───────────────────────────┘                           └──────────┬───────────────┘       └───────────────────────┘
 forgesteel.net (optional, manual Warehouse) ───HTTPS──▶            │ Postgres (JSONB) + Railway backups + GM export
```

### Room model (replaces accounts)
- **Room:** created by the GM. It has a **join code** (long enough to resist guessing, about 10 base32 characters; rate-limited; rotatable) and a separate **GM key**, kept only in the GM's browser.
- **Seat:** a member of the room ("Trey / Kalla the Fury"). A seat owns its heroes, its session and its hidden-sourcebook ids. **Homebrew sourcebooks are shared across the room.**
- **Device token:** issued when someone joins with the code and **picks their seat or hero**. It acts as the FS Warehouse "API token" (FS → `/connect` → JWT). The GM can list and revoke device tokens. **Recovery** means rejoining with the code and picking the same seat; the old device's token can then be revoked.
- **Visibility:**
  - A seat's token sees its own heroes plus the room's homebrew.
  - The GM sees all heroes.
  - The OBR extension holds a room-scoped token that can only read summaries and patch synced fields of linked heroes.
- **forgesteel.net compatibility:** a small join page served by the backend (code → pick seat → shows a device token to paste into FS Settings → Warehouse).

### Backend (Node/TS on Railway, Postgres)
- **Warehouse-compatible REST API:** the 14 calls FS's `warehouse-service.ts` already makes:
  - `POST /connect` and `POST /refresh` (JWT)
  - `GET/PUT/DELETE /data/forgesteel-heroes[/{id}]` (list with `?fields=`)
  - the same for `/data/forgesteel-homebrew-settings`
  - `GET/PUT /data/forgesteel-session` and `/data/forgesteel-hidden-setting-ids`
  - plus `/healthz` and `/me`

  The fork's storage layer and the Transfer page (`transfer-page.tsx`: Local → Warehouse) work **without code changes**.
- **Tables:** `rooms`, `seats`, `device_tokens` (hashed), `heroes` (JSONB, `rev`, `hash`, `updated_at`, `seat_id`, `deleted_at`), `hero_revisions` (history for undo or restore), `homebrew`, `seat_session`, `seat_hidden_ids`. Token links live on OBR tokens, not in the database.
- **Server-side HeroLogic:** imported from the fork's own `src/` (the backend lives in the fork repo and is built from the same commit). It:
  - computes the OBR summary (max stamina, max recoveries, heroic resources *with feature ids*, current values, conditions);
  - applies OBR patches to the stored hero (`state.*` fields; heroic resource by feature id, as in `hero-resources-modal.tsx`).

  Feasible because FS's logic tests run under vitest's default node environment.
- **Conflict control:**
  - Each hero has a monotonically increasing `rev`.
  - A PUT with an unchanged hash is a no-op, which suppresses echoes.
  - On PUT, the server runs a **3-way merge of the synced fields** against the base revision **stamped in the hero body** (`_syncSteel.rev`, injected by the server into every hero it returns; FS keeps unknown top-level fields). This keeps OBR edits that a stale full-hero PUT would otherwise overwrite, including stale debounced copies and PUTs from unmodified forgesteel.net. *(Refined while writing the report; it replaces the per-device "last delivered rev" idea.)*
- **WebSocket hub:** it tells subscribed fork clients and the room's OBR extension clients when heroes change. Each delivers `{heroId, rev, …}`; fork clients pull the full hero and OBR gets the summary. Missed changes are replayed by rev when a client reconnects.
- **Security:**
  - TLS (Railway).
  - Tokens hashed with argon2.
  - CORS allow-list: fork origin, forgesteel.net, the extension origin.
  - Join and connect rate limits.
  - Request size limits.
  - Audit log of device joins.

### FS fork module (`src/sync-steel/`, minimal diff)
- **Room panel:** join with a code, pick a seat or hero, and create a seat or upload a local hero. It configures `ConnectionSettings` for the backend (pre-filled host via a `FORGESTEEL_*` runtime env var) and walks the user through Transfer (Local → server).
- **Live listener:** a `SyncSteelProvider` mounted inside `DataManagerProvider` (`src/index.tsx`). It holds a WebSocket and applies pushed heroes via `dataManager.saveHero()`; the echo is a no-op server-side. It reconnects and catches up on `visibilitychange` (iPad).
- **Debounce race:** `usePersistence.persistHero` saves a 400 ms-old copy, which could overwrite a remote update. Handled by the server's 3-way merge, plus re-applying remote fields if a stale save arrives.
- **Hook points into upstream files:** about 2 (provider mount in `index.tsx`, and a menu or route entry). Everything else lives in new files.

### OBR companion extension
- **Room binding:** the GM pastes the GM key once (stored in the GM's localStorage). The extension creates or uses a **room-scoped OBR token**, stored in OBR room metadata, so every client can sync.
- **Linking:** each token ↔ hero link lives in the **token's own metadata** (`{heroId, syncedRev}` under our key), so links survive Party Continuity's scene-to-scene copies. Link by name match or with a picker.
- **Server → OBR:** one elected client writes `com.draw-steel-stat-bubbles/metadata`, patching only the synced fields. The writer is the GM if connected, else the token's creator if they have permission, else the write is queued. Writes go through the per-token debounced queue (quiet window, scene settle, batching; see "Write pacing and debouncing"), use the id-filter form of `updateItems`, and are checked after writing.
- **OBR → server:** the client whose player matches `item.lastModifiedUserId` forwards diffs, so each edit is sent once.
- **Conditions:** badges drawn as attached items, plus a flyout listing them.

### OBR side: coexisting with Seamus Finlayson's extensions
**Draw Steel Tools 2 (DST):** the bridge **writes into DST's own token data**. That's the key `com.draw-steel-stat-bubbles/metadata`:
- Defined in `SeamusFinlayson/draw-steel-tools-2`: `src/helpers/getPluginId.ts` returns `com.draw-steel-stat-bubbles/<path>`, and `src/helpers/tokenHelpers.ts:13` sets `TOKEN_METADATA_KEY = getPluginId("metadata")`.
- The manifest author is "Seamus Finlayson".

DST doesn't need changes and keeps rendering its own bars and editors. Rules for our writes:
- Patch only the synced fields; preserve `notes`, `gmOnly` and `heroicResourceButton`.
- Write values that **strictly conform to DST's zod schema** (`src/types/tokenDataZod.ts`). Its `parseTokenData` *throws* on invalid data, so `NaN`, `null` or strings would break the token in DST.
- Keep a copy of DST's schema, plus a daily contract check against Seamus's repo. DST has no schema version.

### Can our extension write Draw Steel Tools' token data? (verified 2026‑11‑21)
**Yes. Owlbear Rodeo has no per-extension ownership of metadata keys.** Evidence:
- **SDK types:** `Metadata = Record<string, unknown>` (`lib/types/Metadata.d.ts`). `updateItems(filterOrItems, update)` accepts any draft mutation (`lib/api/scene/SceneItemsApi.d.ts:11`).
- **SDK source** (`owlbear-rodeo/sdk` `src/api/scene/SceneItemsApi.ts` `updateItems`): it runs immer `produceWithPatches`, then sends `OBR_SCENE_ITEMS_UPDATE_ITEMS` with the changed **top-level properties**. It never checks which extension owns a metadata key.
- **The `Permission` type** (`lib/types/Permission.d.ts`) has only per-item-layer permissions (`CHARACTER_UPDATE`, `CHARACTER_OWNER_ONLY`, …) and nothing per extension or per key. Owlbear's own extensions check permissions against the **whole item**: `owlbear-rodeo/ranges` `src/background/permission.ts` and `owlbear-rodeo/outliner` `src/hasPermission.ts` use `CHARACTER_OWNER_ONLY ⇒ item.createdUserId === OBR.player.id`.
- **Prior art working in practice:**
  - Ricky's bridge writes `com.draw-steel-stat-bubbles/metadata`; its README screenshots show DST displaying the synced values.
  - **Party Continuity, by DST's own author**, rewrites DST's and about 12 other extensions' token metadata.
- Reverse-domain keys (`com.draw-steel-stat-bubbles/…`) are a **naming convention to avoid collisions, not an access control**.
- Caveat: the Owlbear host app is closed source and the docs site sits behind a Cloudflare challenge (403 to scripts), so verify in the spike that a write from our extension is accepted and DST re-renders.

**What does constrain us (and the design changes it forces):**
1. **The writing player's permissions apply to the whole token.**
   - The GM can update anything.
   - Players need `CHARACTER_UPDATE`. If the room enables `CHARACTER_OWNER_ONLY`, they can only update tokens they created.
   - Updated **elected-writer rule** for server → OBR writes:
     1. the GM's client, if connected;
     2. else the client of the token's creator (`item.createdUserId`), checked with `OBR.player.hasPermission`;
     3. else queue until one of them is online.
   - OBR → server forwarding is unaffected: whoever edited the token was evidently allowed to.
2. **A metadata update replaces the item's whole `metadata` object.** The SDK sends the top-level `metadata` property from the extension's copy, so a concurrent write by DST or Party Continuity between our read and our write can be **lost**. This is addressed by the **pacing and debouncing design below**, together with:
   - fresh reads (an id-filter `updateItems`);
   - skipping no-op writes;
   - verify-after-write and reconciling from the server.
3. **Schema conformance:** DST's `parseTokenData` throws on invalid data, so we write only schema-valid numbers and strings.
4. **Contract risk:** DST's schema is undocumented and unversioned, and Seamus could change it. Mitigated by the daily contract check against `draw-steel-tools-2`'s `tokenDataZod.ts`.
   - Fallbacks if it ever becomes impossible: ask Seamus for a supported API; fork DST (GPL‑3 allows it); or render our own trackers.
5. **Distribution:** our extension is added to the home group's room by manifest URL, so no store review applies. The OBR store repo (`owlbear-rodeo/extensions`) README only links to the submission tutorial.

### Write pacing and debouncing (end to end)
**Goal:** fewer writes and fewer collisions with DST, Party Continuity and humans, without making the sync feel laggy.

**Principles:**
- Debouncing **reduces** the read-modify-write race but **cannot eliminate it**: OBR has no compare-and-set. So we always keep the fresh read, skip no-op writes, verify after writing, and reconcile.
- Every window is **per token or per hero**, so one busy token never delays the others.
- Every window is **trailing plus max-wait**, so a constant stream of edits can't starve a write.

**Observed behaviour of the other writers:**
- **DST** (`src/contextMenu/TokenEditor.tsx` `updateToken`):
  - Text fields commit on blur or Enter (`src/components/logic/FreeWheelInput.tsx`).
  - Buttons (spend recovery, resource gain, +/-) write per click.
  - Each write re-reads the token (filter form of `updateItems`) and patches only the changed fields over the fresh value.

  So DST's collision windows are short; bursts come mostly from rapid clicks.
- **Party Continuity:** bursts of rewrites when a scene opens.
- **Prior art:** Ricky's background script debounces `onChange` by 2 s.

| Stage | Where | Strategy (starting values; tune in the spike) | Why |
|---|---|---|---|
| 1. FS edit → server | FS fork (upstream `persistHero`) | Existing 400 ms trailing debounce per hero; unchanged | Already coalesces rapid FS edits |
| 2. Server → clients | backend WebSocket hub | Coalesce per hero: 250 ms trailing, 1 s max-wait; push only the latest rev | A burst of FS saves becomes one push |
| 3. OBR writer → DST token | elected writer in the extension | Per-token queue: **300 ms trailing, 1.5 s max-wait**; only the latest values are written. Five extra rules follow this table. | Fewer writes, and we stay out of the way of other writers |
| 4. DST edit → server | extension (the editing player's client) | Per token: **500 ms trailing, 2 s max-wait**. Send the final diff against the last-synced snapshot, with `baseRev = syncedRev`. Ignore our own echoes (track the signature of pending writes). | Rapid +/- clicks in DST become one patch, one server rev and one push to FS |
| 5. Server → FS fork | `SyncSteelProvider` | Coalesce incoming updates per hero. If a local save for that hero is still pending (the 400 ms debounce), wait for it to flush, then field-merge and call `saveHero()` once. | Avoids the stale-pending-save clobber, and saves churn |
| 6. Condition badges | extension | Redraw per token with a 200 ms debounce | Cosmetic; avoids flicker |

**Extra rules for stage 3:**
- **Quiet window:** defer while the token was changed by anyone else in the last **750 ms**, so we yield to humans and to other extensions. After at most 3 s, write anyway, via a fresh read.
- **Scene settle:** after the scene becomes ready or items are added (for example a Party Continuity restore), wait until the scene has had no metadata changes for **1 s** before reconciling.
- **Single-flight:** at most one of our writes is in flight per token.
- **Batching:** write all tokens that are due in **one** `updateItems` call.
- **Diff inside the updater:** compute the diff against the fresh draft values, and skip the write if nothing changed.

**Expected latency** (well within table tolerance):
- FS → OBR: roughly 0.7–3 s worst case.
- OBR → FS: roughly 0.8–3 s.

**Spike check:** script bursts (rapid DST clicks, FS +/- spam, scene switches with Party Continuity) to measure lost updates, then tune the windows.

### Party Continuity also by **Seamus Finlayson**. Patron-only, announced 2025‑12‑20, closed source; linked from DST's sidebar (`src/action/header/SideBarMenu.tsx:144`). From the public part of the Patreon post:
- **Party tokens:** it saves them **to the GM's browser**, scoped to OBR room + user. "Insert Party" creates a spawn area in a scene. Party tokens are automatically added to (or removed from) every scene opened.
- **What it carries between scenes:** name, description, layer, visibility, image and **all metadata**. DST is explicitly listed, so **our extension's link and condition keys travel too**. Attachments aren't listed.
- **Fragility:** data is lost if browser data is cleared or the GM switches device; it offers "re-host from current scene".

How it fits:
| Aspect | Effect | Design response |
|---|---|---|
| Complementary | PC moves tokens between scenes; we keep their stats in sync with FS. With PC, **link once** and the link follows the token to every scene. | Store the hero link **on the token's metadata**, not keyed by OBR item id (ids differ per scene). Any token carrying our link key is linked. Drop the server-side `obr_links` keyed by item id; keep at most a cache. |
| **Stale restore risk** | When a scene opens, PC rewrites the token's saved metadata. If FS changed in between, PC writes **old** DST values; our extension would see a DST change (with `lastModifiedUserId` = GM) and could push stale stats back to FS. | Our link metadata carries `syncedRev`. Forward a DST change to the server **only if the token's `syncedRev` equals the hero's current rev**. Otherwise it's a restore, so **pull from the server and overwrite**. On scene ready or item add, always reconcile from the server first. |
| Durability overlap | PC's browser-only storage is fragile. | For linked heroes the **server is authoritative**: losing PC data only loses non-synced token cosmetics, and our extension refills stats. |
| Condition badges | PC doesn't list attachments. | Derive badges from our metadata on every scene load (idempotent); never rely on badge items persisting. |
| Opacity | Closed and paid: we can't read its storage format or code. | **No dependency on PC.** Coexist by design; test empirically in the spike (needs a paid membership). |

### Field mapping (OBR two-way)
| FS | DST token | Direction |
|---|---|---|
| `name` | `name` | FS → OBR |
| `HeroLogic.getStamina()` | `staminaMaximum` | FS → OBR |
| max − `state.staminaDamage` | `stamina` | ⇄ |
| `state.staminaTemp` | `temporaryStamina` | ⇄ (not folded into damage) |
| `getRecoveries()` − `state.recoveriesUsed` | `recoveries` | ⇄ |
| `state.surges` | `surges` | ⇄ |
| heroic resource feature `.data.value` (by feature id) | `heroicResource` | ⇄ |
| resource feature name | `heroicResourceName` | FS → OBR |
| `state.conditions[]` (id, type, text, ends) | extension's own key + badges | ⇄ by condition id |

### iPad
- Install the fork as a PWA from its own domain, and use Split View with OBR.
- WebSockets only run in the foreground; reconnect and catch up by rev on resume.
- No third-party cookies are needed: bearer tokens only.
- Being online-only is acceptable, since OBR play needs internet anyway.
- iPad's per-site storage separation is irrelevant because the server holds the data.

### Durability
**Decided 22 Nov 2026: no extra services** (report §6).
- **Railway scheduled backups** of the Postgres volume: daily, weekly and monthly.
- A **GM export**: a download of the whole room as one file, plus an import to restore it. This is the copy outside Railway.
- `hero_revisions` for undo or restore; soft deletes with a retention period.
- Users can still export locally (FS Backup page).
- Optional later: a nightly `pg_dump` to an S3-compatible bucket, if the manual export becomes a chore.

### Fork upkeep
- **Repo setup (decided 2026‑11‑21):** a **normal public GitHub fork** of `andyaiken/forgesteel`. A private copy was considered and rejected; GitHub forks of public repos are always public anyway.
  - Benefits: it stays in Forge Steel's fork network, keeps GitHub's "Sync fork" button as a manual fallback, PRs to Andy can be opened directly from it, and it meets GPL‑3 source availability automatically.
  - Actions minutes are free for public repos on GitHub-hosted runners.
  - **Use a PAT or GitHub App token for the sync push.** Pushes made with the default `GITHUB_TOKEN` don't trigger other workflows, so CI and Railway's "Wait for CI" wouldn't run.
  - Never commit secrets (Railway env vars hold them). Use a distinct name and branding.
- A daily GitHub Action **merges** (not rebases) `andyaiken/main`, then runs `npm run check` (lint, tsc, vitest, audit) plus backend tests.
- **Contract tests** pin the upstream APIs we rely on: `DataManager.saveHero`, `useHeroes`, the HeroLogic getters, the `HeroState` fields, and the WarehouseService endpoint shapes.
- On success, push → Railway **"Wait for CI"** → deploy. On conflict or test failure, open an issue and keep the last good build live.
- Lesson from Ricky's fork (57 commits behind; conflicts in the `main.tsx` and `data-context.tsx` he edited): **don't edit high-churn upstream files.**

### Railway services
1. `fs-web`: the fork, built with its existing Dockerfile (nginx + `env.sh`).
2. `api`: HTTP and WebSocket. **Serverless off**, with a healthcheck.
3. `postgres`, with Railway's scheduled backups turned on.
4. The extension's static files, served by `api` or as their own static service.

### Accepted costs and limits
- Users must migrate their heroes into the fork. Transfer from forgesteel.net's local storage works through Backup export/import; on iPad that includes reinstalling the PWA.
- Patreon cloud storage isn't available on the fork domain.
- You own hosting, uptime and security.
- GPL‑3: the public fork already makes the source available. The backend only runs on your server, so it carries no extra obligation. Also keep the DRAW STEEL Creator License notices.
- A distinct name or branding.

## Evidence summary (details in the archived history)
- **DST:**
  - Its key `com.draw-steel-stat-bubbles/metadata` holds the stats plus `heroicResourceButton` and `notes`.
  - It has no API or conditions.
  - It's unchanged since 2026‑07‑23.
- **FS upstream:**
  - Head `3c6b4ab` (2026‑11‑20), about 4 commits a week.
  - The `DataManager`/reducer seam dates from May 2026.
  - `index.tsx` has changed 4 times since August and the storage factory once since May.
  - "Extensions" (Oct 8) are homebrew content, not plugins.
  - No bridge features upstream.
  - Andy merged 11 outside PRs since June.
- **Ricky's bridge:** a one-way Warehouse poller with condition badges. No license. Requires his fork, which is stalled 57 commits behind.
- **Warehouse (Veritas1000):**
  - Flask, scoped per user, with no revisions.
  - Patreon login is tied to forgesteel.net (redirect env, `SameSite=Lax`).
- **OBR SDK 3.1:** `item.lastModifiedUserId`, `OBR.room.id`, `OBR.modal.open({url})`.
- **Railway:** Serverless sleeps a service 5–10 minutes after its last outbound traffic, so keep it off. "Wait for CI" is available.

## Report outline
1. Executive summary.
2. Current state of FS, DST, the OBR SDK, Ricky's bridge and the Warehouse, with file references.
3. Options considered and why the fork + Warehouse-compatible backend was chosen.
4. Architecture: the room model, backend API and data model, WebSocket protocol, FS module, OBR extension, **coexistence with DST and Party Continuity (write permissions)**, **write pacing and debouncing**, field mapping, and conflict and echo rules.
5. iPad behaviour.
6. Durability and backups.
7. Fork upkeep strategy.
8. Railway deployment.
9. Migration guide outline, accepted costs, licensing and branding.
10. Risks and a spike checklist:
    - HeroLogic in Node with homebrew heroes.
    - Whether Owlbear accepts our writes to DST's data, whether DST re-renders, and whether its zod parse accepts the values.
    - Lost updates when DST or Party Continuity writes concurrently. Tune the debounce, quiet-window and scene-settle values with scripted bursts.
    - OBR permissions (`CHARACTER_OWNER_ONLY`) for player edits and for the elected writer.
    - The debounce race.
    - iPad WebSocket resume.
    - Heroes with more than one heroic resource.
    - Whether Transfer correctly moves homebrew.
    - **Party Continuity:** run a stale-restore test across scene switches and confirm our link and condition keys are carried over. Requires a paid Patreon membership.
11. Phased roadmap (no time estimates) and optional upstream asks that would shrink the fork.
