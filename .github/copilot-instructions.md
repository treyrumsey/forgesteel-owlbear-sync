# Copilot instructions: Forge Steel Owlbear Sync ("Table Link")

This repo is a **public fork of [`andyaiken/forgesteel`](https://github.com/andyaiken/forgesteel)**. It adds a two-way sync between Forge Steel heroes and the Draw Steel Tools token trackers in Owlbear Rodeo, plus server-side storage of each hero in full.

**Read before working:**
1. `docs/table-link/SETUP.md`: current state, setup and next steps.
2. `docs/table-link/plan.md`: decisions and architecture.
3. `docs/table-link/forgesteel-owlbear-sync-report.md`: the research report. **Where it and the plan differ, the report wins**; for example, §4.4 has the merge design.

## Environment

- **Node 26** (Active LTS) via nvm: run `nvm use 26`.
- **Don't edit `.nvmrc`.** It's an upstream file and says `24`, so a bare `nvm use` picks 24.
- Install with `npm ci`. `.npmrc` sets `ignore-scripts=true` and `min-release-age=7`; keep both.
- Checks:
  - `npm run check` runs lint + tsc + vitest + `npm audit`. Its Vitest run also picks up the `server/` and `obr-extension/` tests.
  - `npx vitest run src/table-link server obr-extension` runs only our tests.
  - Lint our packages with `npx eslint server/src obr-extension/src`; root `npm run lint` only covers `src/`.
  - Type-check with `npm run typecheck --prefix server` and `npm run build --prefix obr-extension`. Both need `npm ci --prefix <dir>` first.
- **`npm audit` currently fails on upstream dev dependencies** (12 moderate). That's a known baseline; don't fix it in the fork. Lint, tsc and vitest must pass.
- Run the pieces: `npm start --prefix server` (stub Warehouse, :8787), `npm start` (fork, :5173), and `npm run dev --prefix obr-extension` (:5174). See `docs/table-link/SETUP.md`.

## Working rules

- **Minimal diff to upstream: add new files only.**
  - **Never edit** `src/components/main/main.tsx`, `src/contexts/data-context.tsx`, `src/hooks/use-persistence.ts` or `src/services/storage/warehouse-service.ts`.
  - The only planned upstream edits are about two hook lines: mounting `TableLinkProvider` in `src/index.tsx`, and a menu or route entry.
  - Don't change upstream models (e.g. `Hero`). Extend them with local types in our own files.
- **Layout:**
  ```
  src/table-link/     Forge Steel sync module (new files only)
  server/             backend (Node/TypeScript, Warehouse-compatible API + WebSocket)
  obr-extension/      Owlbear companion extension
  docs/table-link/    plan, report, decisions, spike results
  ```
- **`server/` and `obr-extension/` are standalone npm packages**, each with its own `package.json`, lockfile and `.npmrc`.
  - Never add their dependencies to the root `package.json` (an upstream file).
  - Always `cd` into the package, or pass `--prefix`, before `npm install`. Without a `package.json` there, npm walks up to the root.
  - Their tests run under the root Vitest, so they must not import package-only dependencies. `obr-extension/src/dst-token.ts` imports no SDK; server tests use only `node:` built-ins.
- **Server runtime code runs as plain `node src/main.ts`** (Node type stripping), so it needs:
  - only erasable TypeScript: no enums, parameter properties or namespaces;
  - `import type` for types;
  - explicit `.ts` extensions on relative imports.

  `server/src/main.test.ts` catches violations.
- **Warehouse compatibility:** the server must keep the reference Warehouse's response shapes. `server/src/warehouse-compat.test.ts` runs upstream's unmodified `WarehouseService` against it.
- **Upstream sync:** merge `upstream/main`. **Never rebase or force-push.**
- **Branches:** one branch per phase off `main` (e.g. `table-link/phase-1`), merged back by PR **with a merge commit**.
- **Draw Steel Tools data:**
  - Write only schema-valid values (finite numbers, valid strings; never `NaN` or `null`) to `com.draw-steel-stat-bubbles/metadata`. DST's `parseTokenData` throws on invalid data.
  - Patch only the synced fields; keep `notes`, `gmOnly` and `heroicResourceButton` untouched.
  - Build DST data only through `obr-extension/src/dst-token.ts`.
  - Keep our own token data under our own key: DST drops unknown keys from its object whenever it writes.
- **Owlbear writes** (spike findings 5–9 in `docs/table-link/spike-results.md`):
  - Exactly one client may write a given token; two concurrent writers lost about half their updates.
  - Stay well under Owlbear's limit of about 10 `updateItems` calls/s per client: batch writes, and retry on `RateLimitHit`.
  - Detect changes by comparing values, not JSON.
  - Owner Only does not block SDK writes.
- **Heroic resource:** the primary resource is the first `type === 'heroic'` entry of `HeroLogic.getHeroicResources`. Read and write it **by feature id** (`data.value`), as `hero-resources-modal.tsx` does.
- **Revision stamp:** the server stamps `_tableLink: { rev }` at the top level of each hero. Upstream keeps unknown top-level fields; `src/table-link/table-link-stamp.test.ts` guards that.
  - Forge Steel ignores PUT responses, so a client keeps its load-time stamp.
  - The merge base is therefore the later of the stamp and the session's own last write (JWT `sid`). See `docs/table-link/spike-results.md`, finding 2.
- **Never commit secrets.** They go in Railway variables and GitHub Actions secrets.
- **Ricky's bridge** (`RickyTan01/forgesteel-obr-bridge`) has no license: use it as reference only and don't copy its code or images.

## Code style (enforced by `eslint.config.js`)

- Formatting:
  - tabs for indentation;
  - single quotes;
  - no trailing commas;
  - spaces inside array brackets (`[ a, b ]`) and object braces (`{ a }`);
  - braces on every `if`;
  - semicolons required;
  - arrow functions without parens for a single parameter (`x => x`).
- Imports:
  - use the `@/` alias for `src/`;
  - keep them sorted (`sort-imports`): `{ a, b }` multi-member imports first, then single default imports, each group alphabetical.
- `no-console` warns on everything except `console.warn` and `console.error`. `no-warning-comments` warns on "todo", "fix" and similar words.
- Static-method "logic" classes in the fork's `src/`, as in `src/logic/*` (e.g. `export class FooLogic { static bar = (...) => {...} }`). Plain exported functions are fine in `server/` and `obr-extension/`.
- Tests are Vitest, co-located as `*.test.ts` next to the code, and run in Node. Build heroes the way `src/logic/hero-logic.test.ts` does: `FactoryLogic.createHero()` plus `Utils.copy(classData)`.
- Commits: short, sentence-case summaries, like upstream.
