# Setup and handoff

Everything a new session needs to work on Sync Steel, the Forge Steel ⇄ Owlbear Rodeo sync.
- **Phase 5 is built on `sync-steel/phase-5`, not yet merged.** Its remaining steps are under [Phase 5](#phase-5-owlbear-token--forge-steel-built). After it merges, [Next: Phase 6](#next-phase-6-hardening).
- The group's how-to (players and GM) is [how-to.md](./how-to.md); both Railway services are described in [railway.md](./railway.md).
- Decisions made since the report are in [decisions.md](./decisions.md). Background is in [plan.md](./plan.md) and the [research report](./forgesteel-owlbear-sync-report.md); the report wins over the plan, and decisions.md wins over both.
- Phase 0 results are in [spike-results.md](./spike-results.md).

## Current state (26 Nov 2026, Phase 5 built)

| Item | State |
|---|---|
| Fork | [`treyrumsey/forgesteel-owlbear-sync`](https://github.com/treyrumsey/forgesteel-owlbear-sync), public, linked to `andyaiken/forgesteel` |
| Local clone | `~/dev/forgesteel-owlbear-sync`. Remotes: `origin` (your fork) and `upstream` (`git@github.com:andyaiken/forgesteel.git`) |
| Branches | **`main`** holds Phases 0 and 1 (PRs #1 and #2), on top of upstream `3c6b4ab` ("Dice false", 20 Nov 2026).<br>**Phase 2** merged in PR #3 (`sync-steel/phase-2`), with fixes in #4 and #5.<br>**Phase 3** (live sync) merged in PR #6 and deployed on 25 Nov 2026.<br>**Phase 4** (Owlbear, Forge Steel → token) merged in PR #7 (`41f2130b`) and deployed on 26 Nov 2026.<br>**Phase 5** (Owlbear, token → Forge Steel) is built on `sync-steel/phase-5`, not yet merged.<br>`main` has a ruleset requiring the `check` status, with no force-pushes or deletion, and auto-merge is allowed.<br>Work on **one branch per phase off `main`** and merge back by PR **with a merge commit**; never squash or rebase. `gh pr create` defaults to upstream, so pass `--repo treyrumsey/forgesteel-owlbear-sync` |
| Name | **Sync Steel** (it was "Table Link" until Phase 1; see [decisions](./decisions.md#name-sync-steel)) |
| Dependencies | Installed with `npm ci`, `npm ci --prefix server` and `npm ci --prefix obr-extension` on Node 26 |
| Node | **v26.13.1 "Lithium"**, the latest stable release and the Active LTS. It's the nvm `default`. It satisfies `engines.node >= 24`. See [Node version](#node-version) |
| nvm | v0.41.0 at `~/.nvm`, upgraded from 0.25.1 (2015), which couldn't list LTS or recent releases |
| `npm run check` | lint ✅, tsc ✅, vitest ✅ (66 files, 1042 tests: upstream's 799 plus 243 of ours). `npm audit` ❌: the upstream baseline of 12 moderate advisories, all in dev tooling (`eslint`, `typescript-eslint`, `vite-plugin-pwa`, `workbox-build` via `glob`/`minimatch`: GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249). `npm audit --omit=dev` finds 0. **Don't fix it in the fork.** Our CI audits `server/` and `obr-extension/` instead (both clean) |
| CI | [`sync-steel-ci.yml`](../../.github/workflows/sync-steel-ci.yml) runs on pushes and PRs to `main`. Upstream's two workflows stay disabled (see [Notes](#notes)) |
| Deployment | **Two Railway services** (see [Railway](#railway)): `api` (SQLite on a volume: rooms, seats, device tokens, revisions, GM export, import and snapshots) and `fs-web`, the branded web app at **https://syncsteel.app** |
| GitHub CLI | Signed in as `treyrumsey`, version 2.105.0 |
| Docker | Installed (OrbStack); the daemon isn't usually running. Railway builds `server/Dockerfile` itself |
| Railway CLI | v5.75.0, installed with Railway's own installer (**not** Homebrew) at `~/.railway/bin/railway`, and logged in. `~/.zshrc` adds it to `PATH` by sourcing `~/.railway/env`. Agent and other non-interactive shells skip `~/.zshrc`, so run `. ~/.railway/env` first (as with `. ~/.nvm/nvm.sh`). Update it the same way it was installed, not with `brew`. This directory is linked to the `sync-steel` project; pass `--service api` or `--service fs-web` |
| Still open (optional) | E2, the Party Continuity stale-restore test (needs a paid membership); C3, player writes with Character Update removed |

### Railway

| Item | Value |
|---|---|
| Project | `sync-steel` (`5726124d-ee72-45a4-9063-d4e99ca74c30`), environment `production` (`847cb03a-42c1-44ee-a97c-0e86e9d12741`) |
| Services | `api` (`00e960ac-ff05-4d56-8b99-84789a92f9a9`): `server/Dockerfile` (built from the repo root), watch paths `server/**`, `src/**`, `vite.sync-steel-summary.config.ts`, `package-lock.json` (Phase 4's; set 26 Nov 2026). Setup commands in [server/README.md](../../server/README.md#railway).<br>`fs-web` (`3b8d58cf-ca8a-4cc1-b5cb-b5bb16deee92`): `Dockerfile.sync-steel`, watch paths `**` minus `server/` and `docs/` (Phase 4's; set 26 Nov 2026). Serves the Owlbear extension at `/owlbear/`. Setup commands in [railway.md](./railway.md).<br>Both: health check `/healthz`, no sleeping, deploy `main` with "Wait for CI" |
| Addresses | Web app **`https://syncsteel.app`** (bought through Railway; also `https://fs-web-production-33b435c3.up.railway.app`).<br>api **`https://api-production-d612ac15.up.railway.app`** (generated; players never type it) |
| Volume | `api-volume` at `/data` (volume instance `3d1716a9-e86a-4bc6-8caf-813e80c327db`). Database `/data/sync-steel-live.db`; daily snapshots in `/data/snapshots-live/`, last 14 kept. The pre-go-live files (`/data/sync-steel.db`, `/data/snapshots/`) hold only test rooms; see [railway.md](./railway.md#resetting-the-apis-database) |
| Variables | `JWT_SECRET`, `JWT_REFRESH_SECRET` and `TOKEN_HASH_KEY` (random, never printed), plus `DATABASE_PATH=/data/sync-steel-live.db`, `SNAPSHOT_DIR=/data/snapshots-live`, `TRUST_PROXY=1`, `MAX_ROOMS=10` and `CORS_ORIGINS` (`https://syncsteel.app`, the fs-web generated domain, and localhost dev).<br>fs-web: `FORGESTEEL_SYNC_STEEL_API_HOST` (the api's address) and `PORT=80` |
| Backups | **Railway's volume backups need a Pro workspace**, and this one isn't Pro. The server's daily snapshots and the GM export replace them; see [decisions](./decisions.md#durability-railway-backups-need-a-pro-workspace) |
| Deploys | Pushing to `main` deploys whichever service the change touches, once CI passes. Each api deploy restarts it for a few seconds, so deploy outside play sessions. **Saving service settings (`railway environment edit`) redeploys too** |
| Production data | Reset for go-live on 22 Nov 2026 (fresh database file). The group's real room starts here |

### Node version

- **Develop on Node 26**, the current Active LTS. Node 24 moved to Maintenance LTS on 20 Oct 2026, and 27 is still an alpha.
- **`.nvmrc` still says `24`.** It's an upstream file, so the minimal-diff rule keeps it as is. As a result, a bare `nvm use` or `nvm install` in this repo selects Node 24. **Always type `nvm use 26`.**
- Upstream CI (`.github/workflows/digitalocean.yml`, disabled here) builds on Node 24. The root `Dockerfile` uses `node:latest`; `server/Dockerfile` uses `node:26-slim`. Our CI tests on 26.

## One-time setup

Done on 21 Nov 2026; repeat these steps on a new machine.

```bash
cd ~/dev/forgesteel-owlbear-sync

# 1. nvm 0.40+ (older versions can't list LTS releases), then Node 26 as the default
#    Upgrade an existing git install of nvm in place:
#    (cd ~/.nvm && git fetch --tags origin && git checkout v0.41.0) && . ~/.nvm/nvm.sh
nvm install 26               # not a bare `nvm install`: .nvmrc says 24
nvm alias default 26
nvm use 26
node -v                      # expect v26.x

# 2. Install dependencies and confirm everything passes
npm ci
npm ci --prefix server       # needed before npm run check: server tests import Hono
npm ci --prefix obr-extension
npm run check                # lint + tsc + vitest pass; npm audit fails on the upstream baseline

# 3. Start from main, on a branch for the phase
git switch main && git pull
git switch -c sync-steel/phase-2
```

## Running the pieces

Run each from `~/dev/forgesteel-owlbear-sync`, after `nvm use 26`, in its own terminal.

| What | Command | Address |
|---|---|---|
| Hero summary bundle (once, and after upstream merges) | `npx vite build --config vite.sync-steel-summary.config.ts` | `server/build/hero-summary.mjs`; without it the api turns the Owlbear extension away |
| Backend | `DEV_SEED=1 npm start --prefix server` | `http://localhost:8787`. The Dev room's device tokens are `dev-token` (seat "Dev") and `dev-gm-token` (seat "GM"). Data in `server/.data/` |
| The fork | `npm start` | `http://localhost:5173` |
| Owlbear extension | `npm run dev --prefix obr-extension` | `http://localhost:5174/manifest.json`; steps in [obr-extension/README.md](../../obr-extension/README.md#run-locally). Production: `https://syncsteel.app/owlbear/manifest.json` |

To connect the local fork to the local backend, open **Sync Steel** in the footer and join: `npm start` uses `http://localhost:8787`. Once joined, the dot on the footer's Sync Steel button turns green when live sync is connected. The Dev room's join code isn't fixed, so create a room there, or use Settings → Advanced → Feature Flags `Treat Curve` and enter a `dev-token` by hand in Settings → Connections.

**The branded build:** `npx vite build --config vite.sync-steel.config.ts`, or the whole image with `docker build -f Dockerfile.sync-steel .`. Check it with `npx vite preview --config vite.sync-steel.config.ts`. That's on port 4173, which the local api allows only if you start it with `CORS_ORIGINS` listing `http://localhost:4173`.

**Two devices on one machine:** each origin has its own storage, so serve the branded build on a second port too (`--port 4174`), add it to `CORS_ORIGINS`, and join from each. That's how Phase 3 was tested.

The local fork (`http://localhost:5173`) may also connect to the deployed api; its CORS list allows it.

**Checks** (CI runs all of them):
- `npm run check` covers the fork and the `server/` and `obr-extension/` tests.
- Lint `server/src` and `obr-extension/src` with `npx eslint server/src obr-extension/src`.
- Type-check with `npm run typecheck --prefix server` and `npm run build --prefix obr-extension`.

## Accounts and resources

| Needed for | Requirement |
|---|---|
| Owlbear tests | An Owlbear Rodeo account and a **test room** with **Draw Steel Tools** installed, plus a **second browser or account** as a player |
| iPad checks | An iPad running Safari, and later the fork installed to the home screen |
| Optional | A paid Patreon membership for Seamus Finlayson's **Party Continuity**, to test stale restores (E2) |
| Hosting | Railway (Hobby workspace) with the `sync-steel` project. **Volume backups would need Pro**; not needed, given the snapshots and GM export |
| Daily upstream sync | `SYNC_STEEL_UPSTREAM_TOKEN`: a fine-grained PAT for this repo only (contents, pull requests and workflows: read and write; one-year expiry), stored as an Actions secret. The workflow opens an issue when it expires |
| Domain | `syncsteel.app`, bought through Railway, auto-renewing yearly |

## Working rules for this repo

- **Minimal diff to upstream:** add new files only. **Never edit** `src/components/main/main.tsx`, `src/contexts/data-context.tsx`, `src/hooks/use-persistence.ts` or `src/services/storage/warehouse-service.ts`. The only upstream edits are hook lines, guarded by `src/sync-steel/contract.test.ts`: the `/sync-steel` route in `app-routes.tsx` and the footer button in `app-footer.tsx` (Phase 2), and `SyncSteelProvider` wrapping `<Main>` inside `DataManagerProvider` in `src/index.tsx` (Phase 3). No more are planned. Branding is applied at build time; never edit `index.html`, `vite.config.ts` or upstream's `public/` files for it.
- **Live panels:** the branded build swaps upstream's Resources, Vitals and Inventory drawers for Sync Steel's generated copies, at build time (`src/sync-steel/panels/`; [decisions](./decisions.md#live-panels-27-nov-2026)).
  - **Never edit a copy by hand:** change `src/sync-steel/panels/live-copy.ts` and run `node scripts/sync-steel/update-live-panels.ts`.
  - **When upstream changes a drawer,** `panels.test.ts` fails, including on the daily upstream-merge PR. Run the same script, review the diff and commit it.
- **Layout:**
  ```
  src/sync-steel/     Forge Steel sync module (new files only)
  server/             backend (Node/TypeScript, Warehouse-compatible API, merge, WebSocket hub, hero summaries); its own npm package
  obr-extension/      Owlbear companion extension, served by fs-web at /owlbear/; its own npm package
  docs/sync-steel/    plan, report, decisions, spike results
  ```
  `server/` and `obr-extension/` each have their own `package.json`, lockfile and `.npmrc`. **Never add their dependencies to the root `package.json`** (an upstream file). Install with `npm install --prefix server …`; without `--prefix`, npm walks up to the root.
- **Upstream sync:** merge `upstream/main`; never rebase or force-push.
- **The api's hero summaries** come from a bundle of `src/` (`vite.sync-steel-summary.config.ts`), so the api's image depends on `src/`; never import `src/` from `server/src` runtime code except through `summary.ts` (type imports are fine).
- **Draw Steel Tools data:** write only schema-valid values to `com.draw-steel-stat-bubbles/metadata`. Patch only the synced fields, and keep `notes`, `gmOnly` and `heroicResourceButton` untouched.
- **Never commit secrets.** They go in Railway variables and GitHub Actions secrets.
- **Ricky's bridge** (`RickyTan01/forgesteel-obr-bridge`) has no license: use it as reference only and don't copy its code or images.

## Phase 5, Owlbear, token → Forge Steel (built)

Branch `sync-steel/phase-5`, from `main` plus the Phase 4 handoff commit. Every decision is in [decisions.md](./decisions.md#phase-5-owlbear-token--forge-steel-26-nov-2026); the four open ones were confirmed with the user on 26 Nov 2026.

1. ✅ **The reverse mapping:** `HeroSummaryLogic.applyTokenPatch` writes a token's values (stamina, temporary stamina, recoveries, surges, heroic resource) and condition changes back into a hero. It's in the summary bundle, and the api loads both functions (`server/src/summary.ts`).
2. ✅ **Patches on the hub** (`server/src/hub.ts`, `server/src/token-patch.ts`):
   - `patch` → `ack` / `reject`;
   - applied to the hero at `baseRev` and saved through the three-way merge, so counters combine with Forge Steel's changes;
   - edit ids remembered for 2 minutes;
   - 300 patches a minute per Owlbear token.
3. ✅ **Summary revisions:** every summary, live or catch-up, carries the revision at which it last changed, so all Owlbear clients agree. This also fixes a Phase 4 gap where a catch-up could stop a live summary reaching other clients.
4. ✅ **The extension:**
   - `src/forwarding.ts`: who sends, what's sent, the stale guard, the clobber exclusion, and the per-token queue;
   - the hub client's `patch` with answers;
   - the writer holds a token while its patch is out;
   - a **Conditions** token menu and modal (`conditions.html`) for everyone;
   - the popover's "Token edits" row.
5. **Verified:**
   - **Tests:**
     - `applyTokenPatch` (Fury, level 10 Beastheart, Talent with negative Clarity; clamping; conditions);
     - the bundle against the source, for patches too;
     - the extension's condition list against the fork's enums;
     - the hub over real sockets: ack and the new summary, the whole hero pushed to Forge Steel, combining with a concurrent Forge Steel change, conditions, one edit from two clients applied once, an unchanged edit, every reject reason, patches from Forge Steel devices ignored, summary revisions across a notes change and two catch-ups;
     - the extension's own `HubClient` queuing patches until the catch-up;
     - `forwarding.test.ts`: forwarder choice, the stale guard, sparse data, clobbers, the queue's pacing and holds.
   - **The api image, built and run locally:** it loads the new bundle and applies a patch over `/live` from the extension's hub client: a Talent to 10/18 stamina, Clarity −2 and Dazed, logged as `Owlbear edit image-1: … rev 1 -> 2`.
   - **Not yet:** in Owlbear, and production.

**To finish:**
1. **In Owlbear, locally** (needs the user's accounts; steps in [obr-extension/README.md](../../obr-extension/README.md#run-locally)): use a test room with Draw Steel Tools, a GM account and a player account, with the fork against the local api.
   - A DST change to stamina, temporary stamina, recoveries, surges or the resource reaches the Forge Steel sheet within about 3 s.
   - **Conditions** add and remove, and the badges follow on both clients.
   - A player's edit is sent once (the api log shows one `Owlbear edit` line).
   - A GM in two tabs doesn't apply an edit twice.
   - Pasting back an old link (an older `syncedRev`) gets the token overwritten, not sent.
2. **PR and deploy:** open the PR (`--repo treyrumsey/forgesteel-owlbear-sync`) and merge it with a merge commit **outside a play session**. Both services deploy, and the api needs the new bundle, which `server/Dockerfile` builds.
3. **On production:**
   - add `https://syncsteel.app/owlbear/manifest.json` to a test room, connect, link;
   - check `railway logs --service api` for `Owlbear connected` and an `Owlbear edit` line;
   - edit a token and see the change in the fork.

   This also closes Phase 4's production check. Then set up the group's room (how-to, "Owlbear").
4. Optional, still open: E2, a real Party Continuity restore (needs a paid membership); the GM-leaves writer handoff with a second player account.

## Next: Phase 6, hardening

**Goal** (report §11, item 6): rate limits, audit log views (the GM's revision, undelete and audit views, deferred from Phase 2), a restore drill, monitoring, and short how-to docs for the group. Start once Phase 5 is merged and checked on production.

## Phase 4, Owlbear, Forge Steel → token (merged)

Merged from `sync-steel/phase-4` in PR #7 on 26 Nov 2026. Every decision is in [decisions.md](./decisions.md#phase-4-owlbear-forge-steel--token-25-nov-2026).

1. ✅ **Hero summaries on the server:** `vite.sync-steel-summary.config.ts` bundles `HeroSummaryLogic` with upstream's `HeroLogic`; `server/Dockerfile` builds it and `server/src/summary.ts` loads it.
2. ✅ **The Owlbear token** (migration 003, `POST /gm/owlbear`): a GM-seat device that `/connect` refuses. The hub sends it hero summaries (only when they change), deletions and `synced`.
3. ✅ **GM tools → Owlbear** on the Sync Steel page: the manifest URL, and a connection string shown once.
4. ✅ **The extension** (`obr-extension/`):
   - a background page with the hub client;
   - the elected writer with report §4.8's pacing;
   - Draw Steel Tools writes, links on the token, condition badges;
   - the GM's **Link to hero** / **Unlink from hero** menus and hero picker;
   - a popover with status and the **Connect** box.
5. ✅ **Hosting:** fs-web serves it at `/owlbear/` (`Dockerfile.sync-steel`, `nginx/sync-steel.conf`, with a drift test against upstream's nginx config).
6. ✅ **External contract checks:** `sync-steel-external.yml`, daily, against `obr-extension/contract/pins.json`.
7. **Verified:**
   - **Tests** (`npm run check` parts: lint, tsc, the extension build, vitest):
     - the bundle against the source;
     - the hub's Owlbear kind over real sockets: sign-in, `/connect` refusing it, summaries of every seat's heroes, no push for a notes-only change, deletions, 6 clients on one token, replacement closing the old token's sockets, a server without the bundle;
     - the extension's own hub client against the real server;
     - the writer's pacing with fake timers: trailing, max wait, quiet window, settle, batching, rate budget, rate-limit retry, single flight;
     - token updates (only the synced fields; DST's settings kept), clobber detection, links, election, badges, the manifest, the connection string;
     - the GM page's api client;
     - nginx drift.
   - **Images, built and run locally:**
     - the api image applies migration 003, loads the bundle and sends a Talent's summary (18 stamina, 8 recoveries, Clarity) over `/live`;
     - the fs-web image serves `/owlbear/manifest.json` and the icons with CORS for `owlbear.rodeo` only, and 404s for missing extension files.
   - **In Owlbear, locally** (26 Nov 2026), in a test room with Draw Steel Tools: linking, stats and condition badges all worked. The one issue, **Link to hero** still showing on an already linked token, was fixed: it now shows only on unlinked tokens (relink by unlinking first).
   - **Not yet:** production.

**To finish:**
1. ✅ In Owlbear, locally (see Verified).
2. ✅ PR #7 merged with a merge commit; both services deployed it on merge (26 Nov 2026, 11:34 ET). The api applied migration 003 and passes `/healthz`; `https://syncsteel.app/owlbear/manifest.json` returns 200.
3. ✅ **Railway watch paths:** set to Phase 4's on 26 Nov 2026, with the user's OK ([railway.md](./railway.md)). Saving them redeployed both services on `41f2130b`; both came back healthy.
4. **On production:** the user tested it in Owlbear locally, so the production check moved to [Phase 5's](#phase-5-owlbear-token--forge-steel-built). Repeat it with the PWA installed on the GM's laptop.
5. Optional, not yet done: the GM-leaves writer handoff with a second player account, if it wasn't part of the local test.

## Phase 3, live sync (done)

Branch `sync-steel/phase-3`. Every decision is in [decisions.md](./decisions.md#phase-3-live-sync-23-nov-2026).

1. ✅ **The three-way merge** (`server/src/merge.ts`):
   - top-level parts, each `state` field, conditions by id, and heroic resources by feature id;
   - counters combine;
   - each session's base is tracked, including what it sent when a save was merged (migration `002-session-base.sql`).
2. ✅ **The WebSocket hub** at `GET /live` (`server/src/hub.ts`, with the `ws` package). It pushes whole heroes, coalesced per hero, catches devices up on reconnect, follows seat visibility, and closes a disconnected device's sockets at once.
3. ✅ **`SyncSteelProvider`** (`src/sync-steel/live/`):
   - mounted in `src/index.tsx`, guarded by `contract.test.ts`;
   - applies pushed heroes with `dataManager.saveHero()` and deletes with `deleteHero()`;
   - reconnects with backoff, and checks the socket on `visibilitychange`;
   - the status dot on the footer's Sync Steel button.
4. ✅ **Railway:** WebSockets aren't subject to the idle limits (Railway's docs), so no settings change.
5. **Verified:**
   - **Tests:**
     - the merge rules;
     - the store's merge bases (stale copies, echoes, merged saves, fresh copies);
     - the hub over real sockets (auth, origin, visibility, own saves, coalescing, catch-up, deletes, pings, revocation);
     - the socket class (backoff, the visibility check, stopping);
     - end to end with upstream's real `WarehouseService`;
     - the new contract test.
   - **Locally, in the branded build** (`vite preview` on two ports as two devices, against a local api):
     - a GM and a player both live;
     - the player's new hero appeared on the GM's list without a reload;
     - the player's damage appeared on the GM's sheet within 2 s;
     - restarting the api, both reconnected by themselves;
     - concurrent temporary stamina (GM) and damage (player, from a stale Vitals panel, twice) combined correctly on both screens.
   - **Not yet:** an iPad in the background, and production.

**Go-live (25 Nov 2026):** PR #6 merged; both services deployed, and the api applied migration 002.

**Still open:**
- the production check: two devices, a live update, and `railway logs --service api` showing `GET /live`;
- **iPad:** install from the home screen, leave the app in the background for a few minutes while another device edits, come back, and check the change appears.

## Phase 2, the fork goes live (done)

Branch `sync-steel/phase-2`. Every decision is in [decisions.md](./decisions.md#phase-2-the-fork-goes-live-22-nov-2026).

1. ✅ **The Sync Steel page** (`src/sync-steel/components/`): join with a code and a seat, create a room, and the GM tools (seats and devices, join code, export, import and snapshot restore, each restore a dry run first). Reached by a `/sync-steel` route and a footer button.
2. ✅ **Branding** at build time: `vite.sync-steel.config.ts` with an original icon, and upstream's Google Analytics removed.
3. ✅ **`fs-web`** on Railway from `Dockerfile.sync-steel`, at **https://syncsteel.app**; the api's CORS lists it.
4. ✅ **Upkeep:** the daily upstream-merge workflow (`sync-steel-upstream.yml`) and contract tests (`contract.test.ts`).
5. ✅ **The group's how-to:** [how-to.md](./how-to.md).
6. **Verified:**
   - Tests: the page's api client against the real server (create, join, the GM key, revoke, token renewal, export, dry-run and real import, snapshots); branding against upstream's real `index.html`; the contract tests.
   - Locally, in the browser: create a room, a second "device" joins and adds a hero, the GM sees it and disconnects the device, the device recovers from the data load error and rejoins its seat, and the hero comes back.
   - The image (`docker build -f Dockerfile.sync-steel .`): `/healthz`, deep links, the manifest, and the api address filled in at startup.
   - Deployed, against production: a GM created a room on the generated domain, a player joined on https://syncsteel.app and added a hero, and the GM saw it.
7. ✅ **Go-live (22 Nov 2026):**
   - PR #3 merged;
   - `fs-web` deploys `main` with "Wait for CI";
   - `main`'s ruleset requires `check`, and auto-merge is allowed;
   - `SYNC_STEEL_UPSTREAM_TOKEN` is set, and a manual run of the upstream sync passed;
   - production reset to a fresh database file.

   **Still open:** installing on an iPad from the home screen.

## Phase 1, the backend storage MVP (done)

Branch `sync-steel/phase-1`, [PR #2](https://github.com/treyrumsey/forgesteel-owlbear-sync/pull/2). Every decision is in [decisions.md](./decisions.md#phase-1-backend-storage-22-nov-2026).

1. ✅ **Renamed** Table Link to Sync Steel.
2. ✅ **Server:** Hono and SQLite (`node:sqlite`) replace the in-memory stub.
   - **Kept from the stub:** the Warehouse contract (`warehouse-compat.test.ts` still runs upstream's own client), `_syncSteel` stamps, revision numbers that are never reused, echo detection, and merge-base logging.
   - **Every revision records its session id** (finding 2), and committed changes raise events for Phase 3.
3. ✅ **Rooms, seats and device tokens**, with secrets stored as HMAC hashes.
   - The GM seat needs the GM key.
   - The GM sees every hero in the room; players see only their own seat's heroes.
   - Revocation takes effect at the device's next request.
   - Rate limits and body caps.
4. ✅ **Revisions:** retention and soft deletes. GM endpoints for revisions, restore, undelete, audit, export and import (with a dry run), and snapshot restore.
5. ✅ **Durability:** Railway's backups turned out to need Pro, so the server writes its own daily snapshots.
6. ✅ **CI:** `sync-steel-ci.yml`.
7. ✅ **Deployed** to Railway, then verified against production:
   - **Upstream's real client:** `WarehouseService` uploaded a 90 KB pregen hero, homebrew and session data. The stamp went rev 1 → 2.
   - **Export and restore:** a GM export, then a deliberate bad edit and a deleted sourcebook. The dry-run import changed nothing; the real import restored both.
   - **The real fork in headless Chrome:** connected to the api and imported a `.ds-hero` file, which reached the server as one PUT. A second, fresh browser profile on the same seat loaded the hero.
   - **Revocation:** a revoked device's still-valid access token got `401` at once.
8. ✅ **Spike items closed:**
   - **Transfer page:** dropped; players import hero files instead.
   - **Export and import:** the hero export is `JSON.stringify(hero)`, so it keeps `_syncSteel`; import goes through `updateHero` and the save path, which the stamp tests cover.

## Phase 0, the spike (done)

1. ✅ **Repo setup for Copilot:** add `.github/copilot-instructions.md` summarising the working rules and layout above.
2. ✅ **First test (no accounts needed):** Vitest tests in new files under `src/sync-steel/` that:
   - compute the Owlbear summary with `HeroLogic` for sample heroes: max stamina, max recoveries, and the primary heroic resource by feature id. Include a Beastheart (Ferocity + Rampage), a Talent with negative Clarity, and a high-level hero with an epic resource;
   - prove a top-level `_syncSteel: { rev }` field survives `Utils.copy`, `HeroUpdateLogic.updateHero`, and the save path. The report's merge design (§4.4) depends on this.

   **Result:** both confirmed in Node.
   - `HeroSummaryLogic.getSummary` gives the rules values:
     - Fury 21 stamina / 10 recoveries;
     - Beastheart 21 / 12 (129 stamina at level 10);
     - Talent 18 / 8.
   - It picks Ferocity (`beastheart-resource`) over Rampage (`beastheart-1-4`), keeps negative Clarity, and ignores the epic Ferox (`beastheart-10-4`).
   - `_syncSteel` survives:
     - `Utils.copy` and `updateHero`;
     - a Warehouse GET → load → edit → `DataManager.saveHero` PUT;
     - a local save and reload.

     Mutation checks (stripping the field in `updateHero`, `WarehouseService.putHero` or `LocalService.putHero`) make the tests fail, as they should.
3. ✅ **Owlbear test:** a minimal extension in `obr-extension/`, served by Vite on localhost and added to the test room by manifest URL. Confirm:
   - writes to Draw Steel Tools' token data are accepted and Draw Steel Tools redraws them;
   - behaviour under each permission setting;
   - fast-repeated click and scene-switch bursts, counting lost updates.

   **Result (22 Nov, GM + player accounts):**
   - **Writes:** accepted, verified and displayed, with Draw Steel Tools' own settings untouched.
   - **Owner Only** doesn't block extension writes.
   - **Two writers on one token** lose about half the updates, so the single elected writer is confirmed as essential.
   - **Rate limit:** Owlbear allows about **10 writes/s per client**.
   - **Draw Steel Tools clicks** can overwrite a write made milliseconds earlier (1 of 40).
   - **Scene switches** cause no rewrites.

   Details are in [spike-results.md](./spike-results.md#manual-results), findings 5–9; the design changes are noted in report §4.7–4.8. E2 (Party Continuity) is deferred.
4. ✅ **Stub backend:** a minimal Warehouse-compatible server in `server/` that the fork's local dev server can connect to. Check:
   - `/healthz` returns `{"version":"1.x"}`;
   - `/connect` works through the CORS credentials preflight;
   - an expired access token returns `401 {"msg":"Token has expired"}`.

   **Result:**
   - All three checks pass, in tests and in a real browser.
   - Upstream's unmodified `WarehouseService` works against the stub, including refresh-and-retry.
   - The real UI carries the `_syncSteel` stamp. That surfaced a merge-base refinement: [finding 2](./spike-results.md#2-the-stamp-alone-is-not-a-safe-merge-base).
5. ✅ Results are recorded in [`spike-results.md`](./spike-results.md), with raw logs in [`spike-logs/`](./spike-logs/). The spike's design refinements are marked in the report (§4.4, §4.7, §4.8 and §9):
   - the merge base also uses the session's last write;
   - a single elected writer per token, working within a write budget.

## Notes

- The empty, unused `~/dev/forge-steel-owlbear-sync` folder (with hyphens) has been deleted.
- **Upstream's workflows are registered in the fork but disabled.**
  - GitHub registered "Build and deploy" (`digitalocean.yml`) and "Cleanup container registry" (`do-registry-cleanup.yml`) when Phase 0 merged to `main` on 22 Nov 2026. Both were disabled with `gh workflow disable` before they ever ran.
  - **Keep them disabled.** They deploy to upstream's DigitalOcean registry with secrets the fork doesn't have, and their `check` job fails on the `npm audit` baseline.
  - After merging upstream changes, confirm with `gh workflow list --all` that they're still disabled.
  - Our own CI is [`sync-steel-ci.yml`](../../.github/workflows/sync-steel-ci.yml).
- Research copies of the other repos (Draw Steel Tools, Ricky's bridge, the Warehouse, the Owlbear SDK) aren't kept here. Source versions and links are listed in the report's Appendix A.
