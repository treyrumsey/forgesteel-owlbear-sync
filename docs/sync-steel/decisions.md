# Decisions

Decisions that change or refine the [research report](./forgesteel-owlbear-sync-report.md), newest first. Each says what was decided, why, and what it replaced. Setup and current state are in [SETUP.md](./SETUP.md).

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

**Decision:** Hono on `@hono/node-server`, both pure JS. `@hono/node-server` 2.x has WebSocket support built in, so Phase 3 needs no extra package.

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
