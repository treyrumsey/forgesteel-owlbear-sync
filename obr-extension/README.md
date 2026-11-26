# Sync Steel Owlbear extension

The Owlbear Rodeo companion extension for Sync Steel (report §4.7). It shows each linked hero's stamina, max stamina, temporary stamina, recoveries, surges and heroic resource on their **Draw Steel Tools** token, plus condition badges, kept up to date from Forge Steel.

**Current state (Phase 4):** Forge Steel → token only. A change made on the token in Draw Steel Tools stays only until the hero next changes; Phase 5 sends token edits back.

**Production address:** `https://syncsteel.app/owlbear/manifest.json`, served by `fs-web` (`Dockerfile.sync-steel`, `nginx/sync-steel.conf`). The group's steps are in the [how-to](../docs/sync-steel/how-to.md#owlbear).

## How it works

| Page | Runs | Does |
|---|---|---|
| `background.html` (`src/background.ts`) | on every client in the room, all the time | Follows the room's connection, keeps every hero's summary from the api's hub, writes tokens (the elected writer only), draws condition badges, and adds the GM's **Link to hero** and **Unlink from hero** token menus |
| `index.html` (`src/popover.ts`) | the toolbar popover | Status, and the GM's **Connect** box |
| `picker.html` (`src/picker.ts`) | a modal from **Link to hero** | Lists the room's heroes (name matches first) and links the token |

The pages talk over a `LOCAL` broadcast (`src/messages.ts`).

**Data in Owlbear** (`src/keys.ts`):
- **Room metadata** `com.treyrumsey.sync-steel/room`: `{ api, token }`, the api address and the room's Owlbear token. Every client in the room can read it, so the token can only read hero summaries (see `server/README.md`).
- **Token metadata** `com.treyrumsey.sync-steel/metadata`: `{ heroId, syncedRev, conditions }`. The link lives on the token, so it follows the token into every scene, including Party Continuity's copies.
- **Draw Steel Tools' own data** `com.draw-steel-stat-bubbles/metadata`: only the synced fields are written (`src/dst-token.ts`), never `notes`, `gmOnly` or `heroicResourceButton`.
- **Condition badges** are local items, drawn by each client; nothing shared is written for them.

**Writing tokens** (report §4.8, `src/writer.ts`):
- **One writer:** every client elects the same one (`src/election.ts`): a GM first, then the lowest connection id. Two writers lose about half the updates (spike finding 7).
- **Pacing, per token:** 300 ms trailing, 1.5 s at most. It waits while someone else edited the token in the last 750 ms (3 s at most), and for the scene to settle for 1 s after it opens or items arrive.
- **Each call** re-reads the tokens (the filter form of `updateItems`), diffs against that fresh copy and skips unchanged tokens (`src/token-update.ts`). It batches every due token into one call and keeps to about 3 calls a second. It backs off 1 s on `RateLimitHit`.
- **After each write:** 1.5 s later it re-reads the token. A field back at its old value is DST saving an older copy (spike finding 8), so the writer writes it again.
- **Staleness:** a token whose `syncedRev` isn't the hero's current summary revision is rewritten, which also covers Party Continuity restoring old values.

## Run locally

```bash
nvm use 26
npm ci --prefix obr-extension
npx vite build --config vite.sync-steel-summary.config.ts   # from the repo root, once: the api's summaries
DEV_SEED=1 npm start --prefix server                        # the api; its default CORS list includes :5174
npm start                                                   # the fork, to create a room and the Owlbear connection
npm run dev --prefix obr-extension                          # http://localhost:5174/manifest.json
```

1. In the fork (`http://localhost:5173`), create a room, then open **Sync Steel → GM tools → Owlbear → Connect Owlbear** and copy the connection.
2. In an Owlbear room with Draw Steel Tools, add a custom extension with the URL `http://localhost:5174/manifest.json`.
3. Open the **Sync Steel** popover as the GM, paste the connection and press **Connect**.
4. Right-click a hero token → **Link to hero**.

`localhost` only works in a browser on the same machine. Other devices, iPads included, need the extension served over HTTPS.

**The Phase 0 spike tool** is still served in development, at `http://localhost:5174/spike.html` (not in the build). It writes test values to hero tokens, so use it in a test room only. Its runbook is in [spike-results.md](../docs/sync-steel/spike-results.md#owlbear-runbook-manual).

**Logs:** the background page logs what the writer does (writes, skipped tokens, rate limits, rewrites) to the browser console with a `[Sync Steel]` prefix.

## Develop

```bash
npm run build --prefix obr-extension        # tsc + vite build into dist/, for /owlbear/
npx vitest run obr-extension                # from the repo root; also part of `npm run check`
npx eslint obr-extension/src
```

**Rules for code here:**
- **Draw Steel Tools data:** only `src/dst-token.ts` builds it. It:
  - writes only finite numbers and strings (DST's zod 4 schema throws otherwise and breaks the token);
  - patches only the synced fields.
- **Keep the logic SDK-free** (`dst-token`, `writer`, `token-update`, `links`, `election`, `badges`, `hub-client`, `connection`, `summary`), so its tests run under the repo's Vitest. Only the three page scripts import the Owlbear SDK.
- **Sync Steel's own data** goes under our own keys, never inside DST's object: DST drops unknown keys when it writes.
- **The manifest** is generated by `vite.config.ts`, because its paths depend on where the extension is served. Owlbear refuses a description over 128 characters.
- **External contracts:** `contract/pins.json` pins DST's schema file and the Owlbear SDK version. `.github/workflows/sync-steel-external.yml` checks them daily and opens an `external-contract` issue when either changes.
