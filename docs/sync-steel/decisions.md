# Decisions

Decisions that change or refine the [research report](./forgesteel-owlbear-sync-report.md), newest first. Each says what was decided, why, and what it replaced. Setup and current state are in [SETUP.md](./SETUP.md).

## Phase 3: live sync (23 Nov 2026)

All confirmed with the user before building, except the counter rule and the session base, which came out of the live test and were confirmed then. Built on branch `sync-steel/phase-3`.

### The `ws` package in `server/`

**Decision:** add [`ws`](https://github.com/websockets/ws) to `server/package.json` (with `@types/ws` for development). It's pure JS with no dependencies of its own.

**Why:** `@hono/node-server` 2.x's `upgradeWebSocket` needs a WebSocket server object to hand the upgrade to, which is `ws` in practice (its own tests use it). Node 26 has a WebSocket client but no server. This corrects the Phase 1 note below that Phase 3 would need no extra package.

### Railway keeps idle WebSockets open

**Finding (Railway's networking docs, 23 Nov 2026):** WebSocket connections are exempt from the 60-second idle and 15-minute request limits, and "can stay open indefinitely, even while idle". The api already has sleeping off (report §8).

**Still:** the hub pings every 30 s and drops sockets that don't answer. That finds an iPad's socket that died in the background without closing.

### The hub pushes the whole hero

**Decision:** the provider opens `GET /live` on the api, sends its **device token in the first message** (never the URL, so it stays out of logs), and the hub pushes each changed hero **whole and stamped** (about 100 KB). It replaces the report's `hero.changed { heroId, rev }` followed by a GET (§4.5).

**Why:** the provider then needs no JWTs, no refresh and no second auth path, and catching up on reconnect is the same message. The hub checks the token exactly as `/connect` does, including revocation and the failure limit.

**Details** (protocol in [server/README.md](../../server/README.md#api)):
- **Own saves:** a device's own save, stored as sent, comes back as `hero.own { heroId, rev }` only. Re-applying it could overwrite what the player typed since. A merged save comes back whole, to correct the device's screen.
- **Coalescing:** per hero, 250 ms trailing with a 1 s maximum, sending the latest revision; a revision already pushed isn't pushed again.
- **Catch-up:** `hello` lists the revisions the device has. The hub sends what differs, and `hero.deleted` for heroes it can no longer see.
- **Revocation:** disconnecting a device in the GM tools closes its sockets at once (4001), and the provider stops retrying.
- **Origin:** the upgrade must come from one of `CORS_ORIGINS`, since CORS doesn't apply to WebSockets.

### The three-way merge

**Decision** (`server/src/merge.ts`, replacing last writer wins). A device's save is merged against its base:
- **A part the saving device didn't change** keeps the server's current value.
- **A part it did change** takes its value. If the server changed it too, the save wins, and the log names the field.
- **Top-level parts are atomic** (`class`, `ancestry`, `features`, …), **except `state`**, whose fields merge one by one (`notes`, `inventory` as a whole, …).
- **`state.conditions`** merges as a set by condition id. Additions from either side are kept; a removal stands unless the other side changed that condition.
- **Heroic resource values** merge by feature id, wherever the feature is, so a remote change survives a save that changed something else in `class`.
- **Counters combine** when both sides changed them: `staminaDamage`, `staminaTemp`, `recoveriesUsed`, `surges` and heroic resource values become the server's value plus the save's change from its base.
- **Imports and restores** replace the hero, as before.

**Why counters combine** (found in the live test): Forge Steel takes damage from temporary stamina first. A GM adding 4 temporary stamina while a player took 1 damage from an open Vitals panel lost the GM's +4 under last writer wins. Combined, it's +3.

**Why this scope** (rather than the report's synced fields only): the GM editing a hero's notes or inventory while a player tracks stamina keeps both.

### The merge base

The base is what the saving copy started from:
- **The stamp** it carries, the revision it was loaded or pushed at.
- **This session's own last save,** if newer (spike [finding 2](./spike-results.md#2-the-stamp-alone-is-not-a-safe-merge-base)).
- **After a merged save,** the session's copy is what it **sent**, not the merged revision. An open drawer such as Vitals keeps saving from that copy. The server stores what was sent (migration `002-session-base.sql`) and uses it as that session's base. Without that, a second save from the same drawer counted its first change twice.
- **An unchanged save (an echo)** doesn't count as the session's save. The provider's re-save of a pushed hero is an echo, and counting it would make the session's older copies merge against the newer revision and undo the remote change.

### `SyncSteelProvider` and the `src/index.tsx` hook

**Decision:** `src/sync-steel/live/sync-steel-provider.tsx` wraps `<Main>` inside `DataManagerProvider`, the third and last planned upstream hook. It's an import plus a wrapper, which re-indents `<Main>`'s three lines. `contract.test.ts` checks that it's there and inside `DataManagerProvider`.

**What it does:**
- **When:** only while this browser is connected to the Sync Steel api (`SyncSteelConnection.isConnected`).
- **Applying a pushed hero:** through `dataManager.saveHero()`, so every page reading `useHeroes()` re-renders. Heroes that arrive together are applied together. The resulting PUT is an echo, which the server treats as a no-op.
- **Applying a delete:** through `dataManager.deleteHero()`. The api's hero DELETE is now idempotent, because upstream only updates the screen once the DELETE succeeds.
- **Reconnecting:** with backoff (1 s, doubling to 30 s, with jitter). On `visibilitychange`, `online` and `pageshow`, it reconnects at once if the socket is gone, or pings it and reconnects if there's no answer within 5 s.
- **Status:** the footer's Sync Steel button shows a dot, green when live and grey otherwise, drawn by `sync-steel-status.tsx` in our own footer action, with no upstream change.

**Known limits:**
- **Open panels keep their copy.** Upstream's drawers (Vitals and the like) and the hero editor copy the hero when they open, so they show remote changes only when reopened. Saves from them merge correctly.
- **Two tabs in one browser** share a device, so a save in one reaches the other only on its next reload or reconnect.
- **A brief flicker** is possible when a remote change lands during the 400 ms save debounce; the merged revision follows within a second.

## Phase 2: the fork goes live (22 Nov 2026)

All confirmed with the user before building. Built on branch `sync-steel/phase-2`.

### Domain: syncsteel.app, bought through Railway

**Decision:** the web app lives at **`https://syncsteel.app`**, the bare domain. The user bought it through Railway, so Railway's DNS serves it, and it's attached to the `fs-web` service. **The api keeps its generated domain** (`api-production-d612ac15.up.railway.app`).

**Why:**
- **The app's domain is permanent.** Installed home-screen apps and browser storage are tied to it.
- **The api's address isn't.** Players never type it: the build bakes in a placeholder that `fs-web` fills at startup, and each device saves the address when it joins. Moving the api later only means players rejoin.

**Notes:**
- `.app` is on the HSTS preload list, so the site is HTTPS-only.
- Railway is the domain's registrant contact. Transfers out are possible after ICANN's 60-day lock.

### Branding at build time, with no upstream edits

**Decision:** `vite.sync-steel.config.ts` imports upstream's `vite.config.ts` unchanged and adds one plugin (`src/sync-steel/build/branding.ts`). The plugin:
- rewrites `index.html`: the title, the Apple and Open Graph tags, and the icons;
- **removes upstream's Google Analytics tag**, which would otherwise report the group's use to upstream's account;
- rewrites the emitted `manifest.json`: the name, description, colours and icons, dropping upstream's screenshots.

The icon is original (sync arrows around a hex nut), in `public/sync-steel/`, rendered by `scripts/sync-steel/render-icons.mjs`.

**Why reuse rather than copy upstream's config:** upstream's build, PWA and workbox settings stay in step with every merge, with nothing to drift.

**Drift guard:** every rewrite must match, or the build fails. `branding.test.ts` runs the rewrites against upstream's real `index.html` in CI.

**Not rebranded:** in-app "Forge Steel" text (the logo panel, page titles, the about modal). The license notices stay.

### The Sync Steel page: its own route and a footer button

**Decision:** a `/sync-steel` route in `app-routes.tsx` and a **Sync Steel** button in the footer's actions (`app-footer.tsx`): two lines each, and the only upstream edits so far. `src/index.tsx` stayed untouched until Phase 3's provider. `contract.test.ts` fails if a merge drops either hook.

**What the page does:**
- **Join:** enter the code, then pick a seat or create one. The GM seat also asks for the GM key, and a GM's extra device can join with the GM key alone.
- **Create a room:** shows the join code and GM key **once**, behind an "I've saved these" check.
- **GM tools:**
  - seats and devices, with rename and disconnect;
  - a new join code;
  - export, with a reminder after 7 days without one;
  - restore from an export or a daily snapshot, always as a dry run first.

**Out of scope until Phase 6:** the revision, undelete and audit views.

**How joining connects:** it writes upstream's own manual Warehouse `ConnectionSettings` (host and device token) through the route's `persistConnectionSettings`, then reloads. It also turns on the `Treat Curve` feature flag. Without the flag, a device the server rejects (revoked, or after a database reset) is stuck on upstream's data load error, which offers the Warehouse settings (to switch back to local) only when the flag is on.

**The api address:** `src/sync-steel/config.ts` reads `VITE_SYNC_STEEL_API_HOST`. The branded build defines it as the placeholder `FORGESTEEL_SYNC_STEEL_API_HOST`, which upstream's `nginx/env.sh` replaces at container start. Unset (or `npm start`), it falls back to `http://localhost:8787`.

### fs-web: its own Dockerfile

**Decision:** `Dockerfile.sync-steel` builds `fs-web`. It runs `node:26-slim`, honours `.npmrc`, copies only what the web build needs, builds with the branded config, and serves with upstream's nginx config and `env.sh`. Upstream's `Dockerfile` (`node:latest`, no `.npmrc`) is unchanged.

### Railway: CLI-applied settings for both services

**Decision:** both services are configured with the Railway CLI. The commands are recorded in [railway.md](./railway.md). Railway IaC is still not used: it would need the `railway` npm SDK outside upstream's `package.json`, for two services' worth of settings.

`fs-web`'s watch paths are `**` minus `server/`, `obr-extension/` and `docs/`; the api's stay `server/**`. Both deploy `main` with "Wait for CI".

### Upstream sync: a daily workflow with a fine-grained PAT

**Decision:** `.github/workflows/sync-steel-upstream.yml` runs daily.
1. It merges upstream `main` into `sync/upstream-<sha>` (never a rebase) and opens a PR, or updates the open one.
2. It turns on auto-merge with a merge commit, gated by the required `check` status from Sync Steel CI.

**Authentication:** `SYNC_STEEL_UPSTREAM_TOKEN` is a fine-grained PAT for this repo only, with contents, pull requests and workflows read and write, and a one-year expiry. It isn't a GitHub App: a PAT is less setup for a single-maintainer fork. When it expires, the workflow opens an issue.

**What it won't merge alone:**
- **A merge that changes `.github/workflows/`** gets a review label instead of auto-merge. Upstream workflows added to `main` would be enabled in the fork.
- **Conflicts** open an `upstream-sync` issue.

**Contract tests** (`src/sync-steel/contract.test.ts`) add to the Warehouse compatibility and stamp tests. They cover:
- the `HeroLogic` getters;
- the `HeroState` fields;
- the data context's entry points;
- the `ConnectionSettings` shape;
- the two hooks.

**Deferred to Phase 4:** the external checks on Draw Steel Tools' schema and the Owlbear SDK version.

### Production reset before go-live

**Decision:** start the group on an empty database. That leaves behind the inert Phase 1 drill room, its audit entries, and the test rooms from Phase 2's deployment checks.

**How (22 Nov 2026):** the api now uses a new database file and snapshot folder (`DATABASE_PATH=/data/sync-steel-live.db`, `SNAPSHOT_DIR=/data/snapshots-live`). Deleting the old files needs `railway ssh`, which needs an SSH key on the Railway account, so they stay on the volume, unused, and switching back undoes the reset.

## Phase 1: backend storage (22 Nov 2026)

All confirmed with the user before building. Built on branch `sync-steel/phase-1`.

### The group's table

The group plays **in person**. Owlbear Rodeo is open on the GM's laptop and on a shared TV the players watch. Players keep their sheets in the deployed fork on their own phones or iPads and don't run Owlbear. A remote player (occasionally) opens both the Owlbear room and the fork.

**What follows from this:**
- players join a room and recover a device **in the fork**, not in Owlbear;
- the Owlbear extension runs only on the GM's laptop, the TV and remote players;
- the Phase 4 writer election is simple: the GM's laptop first, then the always-on TV. The report's worry about an iPad writer going to the background mostly disappears.

### Name: Sync Steel

The project was called "Table Link". It's now **Sync Steel**:
- the hero stamp is `_syncSteel: { rev }`;
- the module lives in `src/sync-steel/` and the docs in `docs/sync-steel/`;
- identifiers use `SyncSteel*`;
- the Owlbear key prefix is `com.treyrumsey.sync-steel`.

**Why rename then:** the stamp travels into players' own copies of their heroes and into exports, so the rename had to land before real heroes were stored. The merged `table-link/spike` branch and the raw spike logs keep the old name.

### Storage: SQLite on a Railway volume

**Decision:** one `api` service. It stores everything in SQLite through Node's built-in `node:sqlite`, in a file on a Railway volume. Data access is plain SQL in small modules, with numbered `.sql` migrations (the schema version is SQLite's `user_version`).

**Why:**
- **Fewest services:** no separate database service, and no database driver dependency.
- **Tests use the real database:** server tests run against an in-memory SQLite in `npm run check`, with no Docker and no skipped tests.
- **Shape of the data:** the data is relational on the outside (rooms → seats → devices; heroes → revisions) and documents on the inside (hero and homebrew JSON, never queried into). SQLite handles both.

**Costs accepted:**
- **Downtime on deploy:** a few seconds per api deploy, because Railway won't overlap deployments that use a volume. Deploy outside play sessions.
- **Scale:** one replica, which the design assumed anyway.
- **Maturity:** `node:sqlite` is a release candidate (stability 1.2) in Node 26.
- **Tooling:** there's no Railway data browser for it.

**Alternatives rejected:**

| Option | Why not |
|---|---|
| Railway Postgres (the report's plan) | A second service, a driver dependency, and Docker for local database tests |
| Firebase (Firestore or Realtime Database) | **Heroes don't fit:** measured pregen heroes are 67–114 KiB and nested 18–19 levels deep, against Firestore's 20-level limit, and the Realtime Database drops nulls and empty arrays. **A server is still needed** for the Warehouse API, room codes, HeroLogic and the merge. **Upstream fit:** using it as the fork's storage means editing upstream files the minimal-diff rule forbids |
| Supabase, or sync engines and CRDTs (Yjs, Automerge, Replicache, ElectricSQL, Convex) | **Server work:** they still need the server code. **Upstream fit:** sync engines and CRDTs need fine-grained operations, which means deep upstream changes, because upstream saves whole heroes |
| Prisma | **Build overhead:** a code-generation step that `ignore-scripts=true` won't run automatically, and about three packages. **SQLite support:** no `node:sqlite` adapter. **Little to type:** heroes are JSON blobs anyway |

**Speed:** the database choice doesn't affect how fast updates appear. A commit takes under 5 ms either way; the deliberate debounce windows (report §4.8) and Owlbear's propagation account for nearly all the delay.

### HTTP layer: Hono

**Decision:** Hono on `@hono/node-server`, both pure JS. `@hono/node-server` 2.x has WebSocket support built in. (Phase 3 found it needs the `ws` package as its server; see [above](#the-ws-package-in-server).)

**Consequence:** `server/` now has runtime dependencies. Server tests run under the root Vitest, so run `npm ci --prefix server` before `npm run check`; CI does this.

### Secrets: HMAC-SHA256

**Decision:** device tokens, the GM key and the join code are stored only as HMAC-SHA256 hashes, keyed by `TOKEN_HASH_KEY` (a Railway variable). A copy of the database file alone can't be used to sign in or to check guesses.

**Why not argon2:** device tokens and the GM key are 32 random bytes, so a slow hash adds nothing. The join code (10 Crockford base32 characters, about 50 bits) is the guessable one, and it's protected by per-IP and server-wide failure limits plus rotation.

**Consequence:** the server can't show the join code again. The GM sees it when the room is created and each time it's rotated, and rotating doesn't sign out devices that already joined.

### Rooms, seats and access

- **Room creation:** open to anyone, from a UI (Phase 2's Sync Steel page). Each IP may create 5 rooms an hour, and the server holds at most `MAX_ROOMS` (10).
- **Seat claims:** anyone with the join code can pick or create a **player** seat. **Claiming the GM seat also needs the GM key** (added for safety: otherwise the code alone would grant GM access). With only the GM key, a new device can join the GM seat without the code.
- **Visibility:** players see and edit only their own seat's heroes. **GM devices see and edit every hero in the room.** A player's save to another seat's hero gets `403`. Homebrew is shared by the room (last writer wins, soft delete, audited).
- **Revocation:** checked on every request, so a revoked device is cut off at its next request, not when its access token expires.
- **Tokens:** access tokens last 15 minutes and refresh tokens 90 days. An installed iPad app can stay open for weeks, and Forge Steel can't recover from a failed refresh without a reload.

### Onboarding: JSON import, not a forgesteel.net migration

**Decision:** players start using Sync Steel in **Phase 2**, when the fork is deployed. Each player:
- exports `.ds-hero` files (and any homebrew `.ds-sourcebook` files) from forgesteel.net;
- imports them into the fork with **Import Hero Files**. That saves through `persistHero` → `DataManager.saveHero`, so heroes go straight to the server and keep their ids.

**What it replaces:** the report's migration (§9) pointed forgesteel.net's hidden Warehouse settings at the backend and used the Transfer page.

**forgesteel.net isn't supported as a client:** CORS lists only the fork's origins and local development. The Warehouse API stays, because the fork itself uses it through upstream's unmodified `WarehouseService`.

**Join and GM screens:** they live in a **Sync Steel page in the fork, built in Phase 2**. The backend serves no HTML. Phase 1 delivers and tests the API.

### Durability: Railway backups need a Pro workspace

**Finding (22 Nov 2026):** Railway refused to turn on volume backups: *"Manual backups and backup schedules are only available for Pro workspaces."* The workspace isn't on Pro, so the report's middle layer (§6) isn't available.

**Decision:** keep the "no extra services" rule and replace that layer in the server itself.

| Layer | Covers |
|---|---|
| Hero revisions (last 100 per hero, plus each day's last for 90 days) and soft deletes | Undoing a bad edit or delete for one hero, from the GM API |
| **Daily snapshots:** `VACUUM INTO /data/snapshots/sync-steel-YYYY-MM-DD.db`, keeping the last 14 | Rolling back the whole room. The GM exports the room from a snapshot (`GET /gm/snapshots/:date/export`) and imports it, so no SSH access is needed |
| GM export (current data, gzipped JSON) and import (dry run first; never deletes) | The copy outside Railway; also a restore into a new room |

**What snapshots don't cover:** they live on the same volume, so they don't survive losing it; the GM export covers that.

**If you upgrade to Pro:** turn on Railway's schedules with one API call:

```bash
railway api 'mutation { volumeInstanceBackupScheduleUpdate(volumeInstanceId: "<id>", kinds: [DAILY, WEEKLY, MONTHLY]) }'
```

The volume instance id is in [SETUP.md](./SETUP.md#railway).

### CI

**Decision:** our own workflow, `.github/workflows/sync-steel-ci.yml`, runs on pushes and PRs to `main` (Node 26):
- lint, the type checks and the extension build;
- every test;
- `npm audit` for `server/` and `obr-extension/` only. The root audit's upstream dev-dependency baseline stays excluded.

Upstream's two workflows stay disabled.

### Railway configuration lives in service settings

**Decision:** the api's build and deploy settings are set with the Railway CLI, and the exact commands are in [server/README.md](../../server/README.md#railway). The settings are:
- Dockerfile `server/Dockerfile`, built from the repo root;
- watch paths `server/**`;
- health check `/healthz`;
- restart on failure;
- no sleeping.

**Why not a config file:** `railway.json` config-as-code is deprecated (new services can't opt in, and existing files stop being read on 1 Dec 2026). Railway's replacement, Infrastructure as Code (`.railway/railway.ts`), needs the `railway` npm SDK at the repo root, which is upstream's `package.json`. Reconsider IaC in Phase 2, when a second service (`fs-web`) arrives.
