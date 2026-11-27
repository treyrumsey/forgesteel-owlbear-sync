# Decisions

Decisions that change or refine the [research report](./forgesteel-owlbear-sync-report.md), newest first. Each says what was decided, why, and what it replaced. Setup and current state are in [SETUP.md](./SETUP.md).

## Live panels (27 Nov 2026)

Found in the Phase 5 Owlbear test: with the Resources drawer open in Forge Steel, a change made on the token in Owlbear reached the hero page but not the open drawer. That's Phase 3's known limit, "open panels keep their copy": upstream builds each drawer once, and the drawer keeps its own copy of the hero. **No data was lost.** Saves from a stale drawer merge correctly: Owlbear's +1 and two clicks in the drawer made +3 on the server. But the drawer showed the wrong number.

All the decisions below were the user's.

### Sync Steel's own copies of the drawers, behind a switch

**Decision:** Sync Steel has its own copies of the **Resources**, **Vitals** and **Inventory** drawers (`src/sync-steel/panels/copies/`), which follow changes made elsewhere while open.
- **The switch:** a **Live panels** switch on the Sync Steel page ("This device"), saved per device, chooses between them and upstream's originals. It's **on** by default, and off gives upstream's drawers untouched.
- **Why not upstream's feature flags:** their list is private to `src/utils/feature-flags.ts`, an upstream file.

**How they're swapped in, with no upstream edit:**
- `vite.sync-steel.config.ts` runs a plugin (`src/sync-steel/build/live-panels.ts`). It sends every import of an upstream drawer to Sync Steel's switcher (`src/sync-steel/panels/<drawer>-modal.tsx`), which renders the copy or the original.
- It covers every importer, including the tactical map's and the encounter runner's Vitals.
- `npm start` uses upstream's config, so it keeps upstream's drawers. Use the branded build (`vite preview`) to try them.

**How a copy follows changes:**
- `SyncSteelProvider` now also publishes each hero it applies from the hub (`src/sync-steel/live/remote-heroes.ts`).
- An open copy takes those, and only those. Changes from this device's own saves don't count, so a drawer never jumps back while you click.
- **Remounts:**
  - **Vitals** remounts its health panel on each remote change, because that panel keeps its own copy too.
  - **Inventory** remounts its items and notes only when the remote change touched `inventory` or `inventoryText`, so notes being typed aren't reset by, say, damage.

**Keeping the copies in step with upstream:**
- **Generated, not hand-edited:** each copy is generated from upstream's current file by `src/sync-steel/panels/live-copy.ts`. Every change is marked `Sync Steel:`: the name, the stylesheet path, following remote changes, and the remounts.
- **A drift test:** `panels.test.ts` fails when a copy isn't exactly that, which happens when upstream changes a drawer. The daily upstream merge's PR then fails CI and waits.
- **The fix:** run `node scripts/sync-steel/update-live-panels.ts`, then review the diff.
- **If upstream moves a drawer:** the branded build fails rather than quietly shipping the original.

**Why copies rather than a wrapper:** the user chose copies, so Sync Steel can diverge from upstream's drawer if it needs to. Generating them keeps that cheap until then. To diverge, change `live-copy.ts`'s transform, not the copy.

## Phase 5: Owlbear, token → Forge Steel (26 Nov 2026)

The first four were confirmed with the user before building; the rest are defaults chosen while planning and building, listed so they can be revisited. Built on branch `sync-steel/phase-5`.

### Token edits travel as a hub message

**Decision:** the extension sends `patch { heroId, baseRev, editId, values?, conditions? }` on its existing `/live` socket. The hub answers `ack { editId, rev, summaryRev }` or `reject { editId, reason }` (protocol in [server/README.md](../../server/README.md#api)).

**How it becomes a revision:**
1. The server takes the hero as it was at `baseRev`.
2. It writes the token's values back into that copy with `HeroSummaryLogic.applyTokenPatch`, which is in the summary bundle:
   - stamina becomes damage against `HeroLogic.getStamina`;
   - recoveries become recoveries used, against `getRecoveries`;
   - the primary resource is set by feature id;
   - conditions are added or removed by id, checked against Forge Steel's enums.
3. It saves the copy through `heroes.save` with `baseRev` as the stamp. The existing three-way merge then combines it with whatever Forge Steel changed since: counters add up, and conditions merge by id.

**Why:**
- **No new sign-in path:** the socket is already signed in with the Owlbear token. A REST endpoint would need a second auth path for it.
- **No new merge code:** the server's merge already does the work.
- **No migration:** the revision records the Owlbear device, which is `kind = 'owlbear'`, with source `device`.

**Clamping:**
- damage, temporary stamina, surges and recoveries used never go below 0;
- recoveries used never exceed the maximum;
- negative stamina (dying) and negative Clarity are kept;
- values are rounded to whole numbers.

**One-way fields:** the name, maximum stamina and resource name aren't patched. The writer puts them back.

### The staleness guard: a summary revision, checked by the client

**Decision:** the hub tracks, per hero, the revision at which its summary last changed, and **every summary carries that revision**, live or catch-up. A client sends an edit only if the token's `syncedRev` equals that revision for the hero. Otherwise the token shows an older summary, from a Party Continuity restore or a stale copy, and the writer overwrites it. Any change in the 2 s after the scene opens counts as a restore too.

**Why a summary revision:** Phase 4 stamped each summary with the hero's revision at the time. A catch-up therefore re-sent unchanged summaries with newer revisions, so two Owlbear clients could disagree about the revision of the same summary. A token synced by one client would then look stale to the other. The summary revision is the same for everyone.

**Accepted:**
- After an api restart the map is empty and starts at each hero's current revision. Writers then rewrite each token's link once, with the same values.
- An edit made in the moment between a new summary arriving and the writer applying it is overwritten. It's rare: the GM's laptop is both the usual editor and the writer.

### One client sends each edit

**Decision:** only the lowest connection of the player who made the change sends it, using the item's `lastModifiedUserId` and each party member's `Player.id`. If that player has left, the elected writer sends it.
- **Own writes:** our writes are recognised by signature and never sent.
- **DST clobbers:** a field DST put back to its value from before our write, within 1.5 s, isn't sent (spike finding 8). The writer re-asserts it instead.
- **Edit ids:** each edit's id is the token id plus the item's `lastModified`, which every client sees the same. The hub remembers ids for 2 minutes and answers a repeated id without applying it again.

**Why:** a GM signed in on the laptop and the TV is one player with two connections. Picking the lowest sends each edit once; the edit id is a second guard.

### Conditions: a token menu and a modal, for everyone

**Decision:** a **Conditions** context-menu item on linked tokens, for GM and players, opens a modal (`conditions.html`, plain DOM like the hero picker). It lists the hero's conditions with **Remove**, and adds one with a type, when it ends, and a name for custom and quick conditions.

**Sending:** the background page sends the change at once, against the latest summary. Conditions merge by id, so the base doesn't need to match the token. The badges update when the merged summary comes back; nothing is drawn ahead of the server.

**Why everyone:** Draw Steel Tools lets anyone edit a token's stats; conditions match that.

### Defaults chosen while planning and building

- **No session:** the Owlbear device has no session id (`sid` null), so a patch's base is always its `baseRev`. Up to 20 clients share the token, so a shared session base would be wrong.
- **One patch per token at a time:**
  - The forwarding client holds the token until the answer comes, and after an `ack`, until it has the summary at `summaryRev` (10 s at most). The writer doesn't touch a held token.
  - A change made meanwhile is sent next, against the new summary. Until the writer rewrites the link, the token counts as showing it.
  - Without this, two patches from the same base would count the first change twice.
- **Pacing:** 500 ms trailing, 2 s at most, per token (report §4.8 stage 4).
- **Disconnects:**
  - patches wait for the hub's catch-up before they're sent;
  - a patch sent but not answered when the socket drops is never resent, since it may already be applied; the token is reconciled from the server instead.
- **A reject** shows an Owlbear notification to the editing player, and the token goes back to the server's values.
- **Limits:**
  - 300 patches a minute per Owlbear token;
  - Owlbear messages up to 16 KB (Forge Steel devices stay at 1 KB);
  - `base-gone` when the base revision has been pruned (each hero keeps its last 100).
- **The bundle must export `applyTokenPatch`:** the api won't start with an older bundle, and its error says how to rebuild it.

### Railway: saving watch paths redeploys

**Finding (26 Nov 2026):** setting Phase 4's watch paths with `railway environment edit` committed the change, and that redeployed both services on the current commit. It isn't settings-only, so change Railway settings outside play sessions too.

## Phase 4: Owlbear, Forge Steel → token (25 Nov 2026)

The first four were confirmed with the user before building; the rest are defaults chosen while planning, listed so they can be revisited. Built on branch `sync-steel/phase-4`.

### Summaries are computed on the server, from a bundle

**Decision:** the api computes each hero's summary with the fork's own `HeroSummaryLogic` (Phase 0), which calls upstream's `HeroLogic`. `vite.sync-steel-summary.config.ts` bundles them into one ESM file, `server/build/hero-summary.mjs` (about 4 MB), and the api loads it at startup (`server/src/summary.ts`). This settles the open question left by Phase 3.

**Why a bundle:** Node's type stripping can't run upstream's code (enums, `@/` imports), and `HeroLogic` pulls in upstream's class and ancestry data.

**Why the server rather than the extension:** the extension then needs no copy of `HeroLogic`, and its token never sees whole heroes. Phase 5 needs `HeroLogic` on the server anyway, to turn token edits back into hero state.

**Consequences:**
- `server/Dockerfile` has a first stage that installs the root packages and builds the bundle.
- The api's Railway watch paths include `src/**`, so the summaries follow upstream. Every daily upstream merge (09:23 UTC) therefore restarts the api for a few seconds, early in the morning US time.
- **Locally,** the server runs without the bundle, with a warning, and turns Owlbear away (close code 4003). In production it won't start without it.
- `summary.test.ts` builds the bundle and checks it gives the same summaries as the source for a Fury, a level 10 Beastheart and a Talent.

### The Owlbear token

**Decision:** the extension signs in to the hub with a **room-scoped Owlbear token**:
- The GM creates it in **GM tools → Owlbear** (`POST /gm/owlbear`). The page shows it once, inside a connection string with the api's address, which the GM pastes into the extension.
- It's stored in the Owlbear room's metadata, so every client in the room can use it.
- **It's a device in the GM seat with `kind = 'owlbear'`** (migration `003-owlbear-token.sql`), so it's listed and disconnected like any device, and disconnecting closes its sockets at once.
- **Scope:** `/connect` refuses it, so it can't use the Warehouse API. The hub sends it summaries of every hero in the room and never whole heroes. Phase 5 adds token patches.
- **One per room:** a new one disconnects the previous one.
- Every client in the Owlbear room shares it, so the hub allows it 20 sockets (a device gets 4).

**Why:** anyone in the Owlbear room can read room metadata (spike finding 6), so it must not hold a GM device token or the GM key. Making it in the Sync Steel page keeps the GM key out of Owlbear's iframe storage too.

### The extension is served by fs-web

**Decision:** `Dockerfile.sync-steel` builds `obr-extension/` with base `/owlbear/`, so the manifest is `https://syncsteel.app/owlbear/manifest.json`. No new service is needed, and the extension's origin is the app's, already in the api's `CORS_ORIGINS`.

**nginx:** fs-web now uses `nginx/sync-steel.conf`, which is upstream's `nginx/default.conf` plus marked Sync Steel blocks. The extension's location allows CORS for `*.owlbear.rodeo` only and has no app fallback. `nginx.test.ts` fails if the rest drifts from upstream's file.

**The PWA's service worker:** upstream's workbox `navigateFallback` would answer unknown navigations with the app. It can't affect the extension, though: inside Owlbear the extension is a third-party iframe, and browsers partition service workers by top-level site. The app's worker, registered first-party, never controls that iframe. This is checked by hand with the PWA installed.

**Railway:** fs-web's watch paths no longer exclude `obr-extension/`.

### Condition badges in Phase 4

**Decision:** each Owlbear client draws a coloured label for each condition next to a linked token, as local items attached to it. The conditions come from the token's link, which the writer keeps current. Players don't get badges for tokens the GM has hidden. Adding or removing conditions from Owlbear is Phase 5.

### Defaults chosen while planning

- **Linking:** a GM-only token menu, **Link to hero**, opens a picker listing the room's heroes with name matches first. **Unlink from hero** removes the link; the token keeps its stats.
- **The writer:** a GM first, then the lowest connection id. With nobody else connected, a player's client writes.
- **Edits on the token:** in Phase 4, a DST edit to a synced field stays until the hero next changes (or a stale token is reconciled). The how-to says to edit in Forge Steel until Phase 5. (Phase 5 sends them to Forge Steel.)
- **Summaries only when they change:** the hub pushes a summary only if it differs from the last one, so a token's `syncedRev` is the revision its summary was computed at, not always the hero's latest. **Phase 5's staleness guard must compare against the latest summary's revision**, not the hero's. (Phase 5 made every summary carry the revision at which it last changed; see [above](#the-staleness-guard-a-summary-revision-checked-by-the-client).)
- **Re-asserting after a clobber:** 1.5 s after a write, a field back at its old value is DST saving an older copy (spike finding 8), and is written again.
- **The spike tool** stays as a development-only page (`spike.html`), not in the build.

### External contract checks

**Decision:** `.github/workflows/sync-steel-external.yml` runs daily. It compares Draw Steel Tools' `src/types/tokenDataZod.ts` (by SHA-256) and the latest `@owlbear-rodeo/sdk` version with `obr-extension/contract/pins.json`. On a difference it opens one `external-contract` issue. This was deferred from Phase 2. Pinned on 25 Nov 2026: DST at `a445eb9` (its latest commit, 24 Jul 2026) and SDK 3.1.0.

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
- **Open panels keep their copy.** Upstream's drawers (Vitals and the like) and the hero editor copy the hero when they open, so they show remote changes only when reopened. Saves from them merge correctly. (Since 27 Nov 2026, Sync Steel's [live panels](#live-panels-27-nov-2026) follow remote changes in the Resources, Vitals and Inventory drawers; the hero editor still doesn't.)
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
