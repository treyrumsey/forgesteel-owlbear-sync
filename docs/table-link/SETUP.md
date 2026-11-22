# Setup and handoff

Everything a new session needs to work on the Forge Steel ⇄ Owlbear Rodeo sync.
- **Starting Phase 1?** Begin at [Next: Phase 1](#next-phase-1-the-backend-storage-mvp).
- Background is in [plan.md](./plan.md) and the [research report](./forgesteel-owlbear-sync-report.md). The report wins where they differ.
- Phase 0 results are in [spike-results.md](./spike-results.md).

## Current state (22 Nov 2026)

| Item | State |
|---|---|
| Fork | [`treyrumsey/forgesteel-owlbear-sync`](https://github.com/treyrumsey/forgesteel-owlbear-sync), public, linked to `andyaiken/forgesteel` |
| Local clone | `~/dev/forgesteel-owlbear-sync`. Remotes: `origin` (your fork) and `upstream` (`git@github.com:andyaiken/forgesteel.git`) |
| Branch | **`main`** holds Phase 0, merged from `table-link/spike` on 22 Nov 2026, on top of upstream `3c6b4ab` ("Dice false", 20 Nov 2026). Work on **one branch per phase off `main`** (next: `table-link/phase-1`) and merge back by PR **with a merge commit**; never squash or rebase |
| Dependencies | Installed with `npm ci` on Node 26 |
| Node | **v26.13.1 "Lithium"**, the latest stable release and the Active LTS. It's the nvm `default`. It satisfies `engines.node >= 24`. See [Node version](#node-version) |
| nvm | v0.41.0 at `~/.nvm`, upgraded from 0.25.1 (2015), which couldn't list LTS or recent releases |
| Baseline `npm run check` | lint ✅, tsc ✅, vitest ✅ (36 files, 799 tests). `npm audit` ❌: 12 moderate advisories, all in dev tooling (`eslint`, `typescript-eslint`, `vite-plugin-pwa`, `workbox-build` via `glob`/`minimatch`: GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249). `npm audit --omit=dev` finds 0. Upstream baseline; **don't fix in the fork** |
| GitHub CLI | Signed in as `treyrumsey`, version 2.105.0 |
| Docker | Installed (`/usr/local/bin/docker`); useful for a local Postgres and for building the `Dockerfile` |
| Postgres client | Not installed (optional) |
| Railway CLI | Not installed (not needed until deployment) |
| Code written | Phase 0 code is done; results are in [spike-results.md](./spike-results.md).<br>• [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md).<br>• `HeroSummaryLogic` and the `_tableLink` tests in [`src/table-link/`](../../src/table-link/).<br>• The stub Warehouse in [`server/`](../../server/).<br>• The Owlbear spike extension in [`obr-extension/`](../../obr-extension/).<br>`npm run check` runs all of their tests: lint, tsc and vitest pass; the audit is unchanged from the baseline. |
| Still open (optional) | E2, the Party Continuity stale-restore test (needs a paid membership); C3, player writes with Character Update removed; the Transfer page with homebrew; hero export/import. None blocks Phase 1 |

### Node version

- **Develop on Node 26**, the current Active LTS. Node 24 moved to Maintenance LTS on 20 Oct 2026, and 27 is still an alpha.
- **`.nvmrc` still says `24`.** It's an upstream file, so the minimal-diff rule keeps it as is. As a result, a bare `nvm use` or `nvm install` in this repo selects Node 24. **Always type `nvm use 26`.**
- Upstream CI (`.github/workflows/digitalocean.yml`) builds on Node 24. The `Dockerfile` uses `node:latest`. Our own CI should test on 26, and optionally 24.

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

# 2. Install dependencies and confirm the unmodified fork passes all checks
npm ci
npm run check                # lint + tsc + vitest + npm audit

# 3. Start from main, on a branch for the phase
git switch main && git pull
git switch -c table-link/phase-1
```

If `npm audit` fails on the untouched upstream code, note it as a baseline and don't fix it in the fork. It currently does; see the table above.

## Running the pieces

Run each from `~/dev/forgesteel-owlbear-sync`, after `nvm use 26`, in its own terminal.

| What | Command | Address |
|---|---|---|
| Stub backend | `npm start --prefix server` (no install needed) | `http://localhost:8787`, device token `dev-token` |
| The fork | `npm start` | `http://localhost:5173` |
| Owlbear extension | `npm ci --prefix obr-extension`, then `npm run dev --prefix obr-extension` | `http://localhost:5174/manifest.json` |

To connect the fork (or forgesteel.net) to a Warehouse:
1. Settings → **Advanced** → Feature Flags: enter `Treat Curve`. This upstream flag hides the manual Warehouse settings; see [spike finding 1](./spike-results.md#1-upstream-hides-manual-warehouse-settings-behind-a-feature-flag).
2. Settings → Connections: turn on the manual Warehouse and enter the host and token.

**Checks:**
- `npm run check` covers the fork and the `server/` and `obr-extension/` tests.
- Lint `server/src` and `obr-extension/src` with `npx eslint server/src obr-extension/src`.
- Type-check with `npm run typecheck --prefix server` and `npm run build --prefix obr-extension`. Both need `npm ci --prefix …` first.

## Accounts and resources

| Needed for | Requirement |
|---|---|
| Phase 0 spike: Owlbear test | An Owlbear Rodeo account and a **test room** with **Draw Steel Tools** installed |
| Phase 0: permission tests | A **second browser or account** joined to that room as a player; try the room's character permission with "owner only" both on and off |
| Phase 0: iPad checks | An iPad running Safari, and later the fork installed to the home screen |
| Phase 0, optional | A paid Patreon membership for Seamus Finlayson's **Party Continuity**, to test stale restores |
| Phase 1 onward: hosting | A Railway account (you have one) with Postgres, plus the Railway CLI (`brew install railway`) |
| Phase 1: backups | An S3-compatible bucket (e.g. Cloudflare R2 or Backblaze B2) and an encryption key (`age` or `gpg`) |
| Phase 2: daily upstream sync | A fine-grained **personal access token** (or GitHub App) with contents and pull-request write access to the fork, stored as an Actions secret. The built-in `GITHUB_TOKEN` won't trigger CI |
| Phase 2: deployment | A domain or subdomain for the fork's web app. **Choose it carefully:** installed home-screen apps and browser data are tied to it |

## Working rules for this repo

- **Minimal diff to upstream:** add new files only. **Never edit** `src/components/main/main.tsx`, `src/contexts/data-context.tsx`, `src/hooks/use-persistence.ts` or `src/services/storage/warehouse-service.ts`. The only planned upstream edits are about two hook lines: mounting `TableLinkProvider` in `src/index.tsx`, and a menu or route entry.
- **Layout:**
  ```
  src/table-link/     Forge Steel sync module (new files only)
  server/             backend (Node/TypeScript, Warehouse-compatible API + WebSocket); its own npm package
  obr-extension/      Owlbear companion extension; its own npm package
  docs/table-link/    plan, report, decisions, spike results
  ```
  `server/` and `obr-extension/` each have their own `package.json`, lockfile and `.npmrc`. **Never add their dependencies to the root `package.json`** (an upstream file).
- **Upstream sync:** merge `upstream/main`; never rebase or force-push.
- **Draw Steel Tools data:** write only schema-valid values to `com.draw-steel-stat-bubbles/metadata`. Patch only the synced fields, and keep `notes`, `gmOnly` and `heroicResourceButton` untouched.
- **Never commit secrets.** They go in Railway variables and GitHub Actions secrets.
- **Ricky's bridge** (`RickyTan01/forgesteel-obr-bridge`) has no license: use it as reference only and don't copy its code or images.

## Next: Phase 1, the backend storage MVP

**Goal** (report §11, item 1): a real backend on Railway that delivers the "lost device" goal on its own. It needs:
- the Warehouse-compatible API;
- rooms, seats and device tokens;
- a join page;
- hero revisions;
- nightly off-site backups.

Then migrate the group with forgesteel.net's Transfer page. Merging and WebSockets come later (Phase 3).

**Read first:**
- report §4.2 (rooms);
- §4.3 (API and data model);
- §4.4 (revisions, including the spike refinement);
- §6 (durability), §8 (Railway) and §9 (migration);
- [spike findings 1–2](./spike-results.md#findings).

**Build on Phase 0.** The `server/` stub is the starting point. Replace its in-memory store with Postgres and keep everything else:
- the Warehouse contract and its tests: `warehouse-compat.test.ts` runs upstream's own client against the server;
- `_tableLink.rev` on reads, revisions that are never reused, and echo detection;
- the JWT `sid` per `/connect`. **Store the session id with every hero revision**, so Phase 3's merge can use base = the later of the stamp and that session's last write ([finding 2](./spike-results.md#2-the-stamp-alone-is-not-a-safe-merge-base)).

**Decisions to confirm with the user at the start** (recommendations in brackets):
1. **HTTP layer:** keep `node:http`, or use a framework such as Hono or Fastify. [Keep `node:http` for now; the API is small.]
2. **Postgres driver and migrations.** [`postgres` or `pg`, with plain numbered SQL migration files and a small runner.]
3. **Token hashing.** The report says argon2. [But device tokens, refresh tokens and the GM key are long random secrets, so a SHA-256 hash is enough. The ~10-character join code is the guessable one: protect it with rate limits and rotation.] `.npmrc` sets `ignore-scripts=true`, so avoid packages that compile on install, such as `argon2`; prebuilt ones like `@node-rs/argon2` work.
4. **Join page:** static HTML served by the backend [yes], or part of the fork's Table Link panel (Phase 2).
5. **Backups:** a Railway cron service runs `pg_dump`, encrypts with `age`, and uploads to R2 or B2. This needs the bucket and key; see [Accounts and resources](#accounts-and-resources).
6. **CI:** our own GitHub Actions workflow is planned for Phase 2. It could come earlier to protect `main`. Upstream's two workflows are registered but disabled (see Notes), and they must stay that way.

**Constraints to know:**
- **Server runtime:** `server/` runs as plain `node src/main.ts`. When the server starts importing the fork's `src/` (Phase 3–4, for `HeroLogic`), it will need a build step such as esbuild, because `src/` uses `@/` aliases, imports without extensions, and enums. Phase 1 doesn't need `src/`.
- **Database tests:** root `vitest run` picks up `server/**/*.test.ts`. Tests that need Postgres must skip when there's no `DATABASE_URL` (`describe.skipIf`), so `npm run check` still passes without a database. Run them against a local Postgres in Docker.
- **Installing packages:** use `npm install --prefix server …`. Without `--prefix`, npm walks up to the root `package.json`.

**Before or during Phase 1, from the user:**
- the Railway CLI (`brew install railway`);
- an S3-compatible bucket (R2 or B2);
- an `age` key.

The Transfer-page check from the spike (still open) fits naturally into the migration test.

**Suggested first prompt for the new session:**

> Read `docs/table-link/SETUP.md`, starting with "Next: Phase 1", then the report sections and spike findings it lists. Use Node 26 (`nvm use 26`). Create the branch `table-link/phase-1` from `main`. Plan Phase 1 (the backend storage MVP) and confirm the open decisions with me before building.

## Phase 0, the spike (done)

1. ✅ **Repo setup for Copilot:** add `.github/copilot-instructions.md` summarising the working rules and layout above.
2. ✅ **First test (no accounts needed):** Vitest tests in new files under `src/table-link/` that:
   - compute the Owlbear summary with `HeroLogic` for sample heroes: max stamina, max recoveries, and the primary heroic resource by feature id. Include a Beastheart (Ferocity + Rampage), a Talent with negative Clarity, and a high-level hero with an epic resource;
   - prove a top-level `_tableLink: { rev }` field survives `Utils.copy`, `HeroUpdateLogic.updateHero`, and the save path. The report's merge design (§4.4) depends on this.

   **Result:** both confirmed in Node.
   - `HeroSummaryLogic.getSummary` gives the rules values:
     - Fury 21 stamina / 10 recoveries;
     - Beastheart 21 / 12 (129 stamina at level 10);
     - Talent 18 / 8.
   - It picks Ferocity (`beastheart-resource`) over Rampage (`beastheart-1-4`), keeps negative Clarity, and ignores the epic Ferox (`beastheart-10-4`).
   - `_tableLink` survives:
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
   - The real UI carries the `_tableLink` stamp. That surfaced a merge-base refinement: [finding 2](./spike-results.md#2-the-stamp-alone-is-not-a-safe-merge-base).
5. ✅ Results are recorded in [`spike-results.md`](./spike-results.md), with raw logs in [`spike-logs/`](./spike-logs/). The spike's design refinements are marked in the report (§4.4, §4.7, §4.8 and §9):
   - the merge base also uses the session's last write;
   - a single elected writer per token, working within a write budget.

## Notes

- The empty, unused `~/dev/forge-steel-owlbear-sync` folder (with hyphens) has been deleted.
- **Upstream's workflows are registered in the fork but disabled.**
  - GitHub registered "Build and deploy" (`digitalocean.yml`) and "Cleanup container registry" (`do-registry-cleanup.yml`) when Phase 0 merged to `main` on 22 Nov 2026. Both were disabled with `gh workflow disable` before they ever ran.
  - **Keep them disabled.** They deploy to upstream's DigitalOcean registry with secrets the fork doesn't have, and their `check` job fails on the `npm audit` baseline.
  - After merging upstream changes, confirm with `gh workflow list --all` that they're still disabled.
  - Our own CI will be a separate workflow file.
- Research copies of the other repos (Draw Steel Tools, Ricky's bridge, the Warehouse, the Owlbear SDK) aren't kept here. Source versions and links are listed in the report's Appendix A.
