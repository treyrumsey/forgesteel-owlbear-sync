# Setup and handoff

Everything a new session needs to start building the Forge Steel ⇄ Owlbear Rodeo sync. Read this first, then [plan.md](./plan.md) and the [research report](./forgesteel-owlbear-sync-report.md).

## Current state (22 Nov 2026)

| Item | State |
|---|---|
| Fork | [`treyrumsey/forgesteel-owlbear-sync`](https://github.com/treyrumsey/forgesteel-owlbear-sync), public, linked to `andyaiken/forgesteel` |
| Local clone | `~/dev/forgesteel-owlbear-sync`. Remotes: `origin` (your fork) and `upstream` (`git@github.com:andyaiken/forgesteel.git`) |
| Branch | Work happens on **`table-link/spike`** (pushed to `origin`). `main` stays at upstream `3c6b4ab` ("Dice false", 20 Nov 2026), the commit the research examined |
| Dependencies | Installed with `npm ci` on Node 26 |
| Node | **v26.13.1 "Lithium"**, the latest stable release and the Active LTS. It's the nvm `default`. It satisfies `engines.node >= 24`. See [Node version](#node-version) |
| nvm | v0.41.0 at `~/.nvm`, upgraded from 0.25.1 (2015), which couldn't list LTS or recent releases |
| Baseline `npm run check` | lint ✅, tsc ✅, vitest ✅ (36 files, 799 tests). `npm audit` ❌: 12 moderate advisories, all in dev tooling (`eslint`, `typescript-eslint`, `vite-plugin-pwa`, `workbox-build` via `glob`/`minimatch`: GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249). `npm audit --omit=dev` finds 0. Upstream baseline; **don't fix in the fork** |
| GitHub CLI | Signed in as `treyrumsey`, version 2.105.0 |
| Docker | Installed (`/usr/local/bin/docker`); useful for a local Postgres and for building the `Dockerfile` |
| Postgres client | Not installed (optional) |
| Railway CLI | Not installed (not needed until deployment) |
| Code written | Phase 0 code is done; results are in [spike-results.md](./spike-results.md).<br>• [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md).<br>• `HeroSummaryLogic` and the `_tableLink` tests in [`src/table-link/`](../../src/table-link/).<br>• The stub Warehouse in [`server/`](../../server/).<br>• The Owlbear spike extension in [`obr-extension/`](../../obr-extension/).<br>`npm run check` runs all of their tests: lint, tsc and vitest pass; the audit is unchanged from the baseline. |
| Waiting on you | The Owlbear tests (runbook in [spike-results.md](./spike-results.md#owlbear-runbook-manual)): an Owlbear account, a test room with Draw Steel Tools, and a second account as a player |

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

# 3. Work on the spike branch
git switch table-link/spike  # or: git switch -c table-link/spike
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

## Next steps (Phase 0, the spike, in order)

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
3. 🟡 **Owlbear test:** a minimal extension in `obr-extension/`, served by Vite on localhost and added to the test room by manifest URL. Confirm:
   - writes to Draw Steel Tools' token data are accepted and Draw Steel Tools redraws them;
   - behaviour under each permission setting;
   - fast-repeated click and scene-switch bursts, counting lost updates.

   **Status:**
   - Built and verified outside Owlbear: build, type check, tests, and manifest CORS.
   - The **hands-on tests in a room are waiting on you**: follow the [runbook](./spike-results.md#owlbear-runbook-manual).
4. ✅ **Stub backend:** a minimal Warehouse-compatible server in `server/` that the fork's local dev server can connect to. Check:
   - `/healthz` returns `{"version":"1.x"}`;
   - `/connect` works through the CORS credentials preflight;
   - an expired access token returns `401 {"msg":"Token has expired"}`.

   **Result:**
   - All three checks pass, in tests and in a real browser.
   - Upstream's unmodified `WarehouseService` works against the stub, including refresh-and-retry.
   - The real UI carries the `_tableLink` stamp. That surfaced a merge-base refinement: [finding 2](./spike-results.md#2-the-stamp-alone-is-not-a-safe-merge-base).
5. 🟡 Results are in [`spike-results.md`](./spike-results.md); paste the Owlbear logs there. Then start Phase 1 (report §11).

## Notes

- The empty, unused `~/dev/forge-steel-owlbear-sync` folder (with hyphens) has been deleted.
- **Upstream's workflows also run in the fork.** Actions are enabled, and `digitalocean.yml` builds and deploys on every push to `main`. It's harmless on `table-link/*` branches. Before anything merges to the fork's `main` (Phase 2), disable upstream's deploy and registry-cleanup workflows with `gh workflow disable`, which needs no file edits.
- Research copies of the other repos (Draw Steel Tools, Ricky's bridge, the Warehouse, the Owlbear SDK) aren't kept here. Source versions and links are listed in the report's Appendix A.
