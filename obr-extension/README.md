# Sync Steel Owlbear extension

The Owlbear Rodeo companion extension for Sync Steel (report §4.7). It shows each linked hero's stamina, max stamina, temporary stamina, recoveries, surges and heroic resource on their **Draw Steel Tools** token, plus condition labels in the style and stack of the token-labels extension, kept up to date from Forge Steel.

**Current state (Phase 5):** both ways.
- **Token → Forge Steel:** a change made on a linked token in Draw Steel Tools (stamina, temporary stamina, recoveries, surges, heroic resource) goes back to the hero.
- **Conditions:** the **Conditions** token menu adds and removes them.
- **One-way fields:** the name, maximum stamina and resource name follow Forge Steel only.

**Production address:** `https://syncsteel.app/owlbear/manifest.json`, served by `fs-web` (`Dockerfile.sync-steel`, `nginx/sync-steel.conf`). The group's steps are in the [how-to](../docs/sync-steel/how-to.md#owlbear).

## How it works

| Page | Runs | Does |
|---|---|---|
| `background.html` (`src/background.ts`) | on every client in the room, all the time | Follows the room's connection, keeps every hero's summary from the api's hub, writes tokens and their condition labels (the elected writer only), sends token edits (the editing player's client only), makes condition changes for the other pages, and adds the token menus: the GM's **Link to hero** and **Unlink from hero**, and everyone's **Conditions** panel |
| `conditions-embed.html` (`src/conditions-embed.ts`) | embedded in the token menu of any selection of characters | The **Conditions** panel: the Ends switch and a chip for each of Draw Steel's nine conditions, filled, half filled or empty across the selection. A click toggles it for every selected token. **⋯** opens the popover on its Conditions tab |
| `index.html` (`src/popover.ts`, `src/conditions-tab.ts`) | the toolbar popover | Two tabs. **Conditions:** with tokens selected, the same chips, a custom condition, and each token's conditions to remove one by one; with none, every token in the scene with conditions, and **Clear End of turn**. **Sync Steel:** status, and the GM's **Connect** box |
| `picker.html` (`src/picker.ts`) | a modal from **Link to hero** | Lists the room's heroes (name matches first) and links the token |

**Conditions** (`src/condition-ops.ts`, no SDK, tested):
- The panel and the tab send `conditions.apply { tokenIds, op }`. The background page answers `conditions.done` once every change is made.
- A **linked** token's conditions are its hero's. The change goes to the hub as one patch per **hero**, even when several of its tokens are selected. The token and its labels update once the server's summary comes back.
- **Any other** token keeps its own, under `CONDITIONS_KEY`. It's written straight away, and works without a connection to Sync Steel.
- Pages share `src/condition-ui.ts` (the selection, chips, Ends switch, a token's conditions) and `src/theme.ts` (Owlbear's light or dark theme).

The pages talk over a `LOCAL` broadcast (`src/messages.ts`).

**Data in Owlbear** (`src/keys.ts`):
- **Room metadata** `com.treyrumsey.sync-steel/room`: `{ api, token }`, the api address and the room's Owlbear token. Every client in the room can read it, so the token can only read hero summaries (see `server/README.md`).
- **Token metadata** `com.treyrumsey.sync-steel/metadata`: `{ heroId, syncedRev, conditions }`. The link lives on the token, so it follows the token into every scene, including Party Continuity's copies.
- **Token metadata** `com.treyrumsey.sync-steel/conditions`: an unlinked token's own conditions, in the same shape as a hero's. **Link to hero** clears it.
- **Draw Steel Tools' own data** `com.draw-steel-stat-bubbles/metadata`: only the synced fields are written (`src/dst-token.ts`), never `notes`, `gmOnly` or `heroicResourceButton`.
- **Condition labels** (`src/labels.ts`) are shared Label items attached to the token, in [token-labels](https://github.com/SeamusFinlayson/token-labels)' stack.
  - **Ids:** `<tokenId>-label-sync-steel-<conditionId>`. token-labels counts anything starting `<tokenId>-label`.
  - **Tag:** `com.treyrumsey.sync-steel/badge` = `{ tokenId, conditionId }`.
  - **Who writes them:** only the elected writer, alongside the token's stats.
  - **Its look:** size 16 on a dark background, the same size at any zoom.
  - **Stacking:** at the token's top-left, at +15, +50, then upward, 35 apart. When the set of conditions changes, ours are packed into the free slots after token-labels' own, and otherwise left where they are.
  - **Unlinked tokens** with conditions of their own get the same labels, also written by the elected writer only.
  - **Deleted by hand:** one comes back while the token has the condition.
  - **On unlink:** ours are removed.
  - token-labels' tool file is pinned in `contract/pins.json`.

**Writing tokens** (report §4.8, `src/writer.ts`):
- **One writer:** every client elects the same one (`src/election.ts`): a GM first, then the lowest connection id. Two writers lose about half the updates (spike finding 7).
- **Pacing, per token:** 300 ms trailing, 1.5 s at most. It waits while someone else edited the token in the last 750 ms (3 s at most), and for the scene to settle for 1 s after it opens or items arrive.
- **Each call** re-reads the tokens (the filter form of `updateItems`), diffs against that fresh copy and skips unchanged tokens (`src/token-update.ts`). It batches every due token into one call and keeps to about 3 calls a second. It backs off 1 s on `RateLimitHit`.
- **After each write:** 1.5 s later it re-reads the token. A field back at its old value is DST saving an older copy (spike finding 8), so the writer writes it again.
- **Staleness:** a token whose `syncedRev` isn't the hero's current summary revision is rewritten, which also covers Party Continuity restoring old values.
- **Held tokens:** while a token's edit is on its way to the server, the writer leaves that token alone.

**Sending token edits** (Phase 5, report §4.7 "Token edits → server", `src/forwarding.ts`):
- **Who sends:** only the lowest connection of the player who made the change (the item's `lastModifiedUserId`), so a GM on the laptop and the TV sends it once. If that player has left, the elected writer sends it. Our own writes, recognised by signature, aren't sent.
- **What's sent:** the edited fields, compared by value against the summary the token shows:
  - fields DST hasn't stored (sparse data) aren't edits;
  - a field DST put back to its value from before our write, within 1.5 s, is a clobber (spike finding 8): the writer puts it right, and it isn't sent.

  It goes as a `patch` with `baseRev` = that summary's revision and `editId` = token id + the item's `lastModified`. That id is the same on every client, and the server applies an edit id once.
- **Stale guard:** an edit is sent only if the token shows the latest summary revision this client has. A token showing an older one is a restore or a stale copy, and the writer overwrites it. So is any change in the 2 s after the scene opens (Party Continuity, report §4.7.2). An edit made in the moment between a new summary arriving and the writer applying it is overwritten too; it's rare.
- **Pacing, per token:** 500 ms trailing, 2 s at most (report §4.8 stage 4).
- **One patch per token at a time:**
  - The token is held until the answer comes, and on an `ack`, until the summary at `summaryRev` arrives (10 s at most).
  - A change made meanwhile is sent next, against the new summary. Until the writer rewrites the link, the token counts as showing that summary.
  - On a `reject`, the editing player gets an Owlbear notification, and the token goes back to the server's values.
- **Offline:**
  - patches wait for the hub's catch-up before they're sent;
  - a patch sent but not answered when the connection drops is never resent, since it may already be applied; the token is reconciled from the server instead.

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
5. Change the token's stamina in Draw Steel Tools: the hero's sheet in the fork follows within a few seconds. Right-click → **Conditions** to add one.

`localhost` only works in a browser on the same machine. Other devices, iPads included, need the extension served over HTTPS.

**The Phase 0 spike tool** is still served in development, at `http://localhost:5174/spike.html` (not in the build). It writes test values to hero tokens, so use it in a test room only. Its runbook is in [spike-results.md](../docs/sync-steel/spike-results.md#owlbear-runbook-manual).

**Logs:** the background page logs what it does (writes, skipped tokens, rate limits, rewrites, edits sent and their answers) to the browser console with a `[Sync Steel]` prefix.

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
- **Keep the logic SDK-free** (`dst-token`, `writer`, `token-update`, `forwarding`, `conditions`, `labels`, `links`, `election`, `hub-client`, `connection`, `summary`), so its tests run under the repo's Vitest. Only the four page scripts import the Owlbear SDK.
- **Conditions** (`src/conditions.ts`) copy the fork's `ConditionType` and `ConditionEndType`; `server/src/summary.test.ts` fails if they drift.
- **Sync Steel's own data** goes under our own keys, never inside DST's object: DST drops unknown keys when it writes.
- **The manifest** is generated by `vite.config.ts`, because its paths depend on where the extension is served. Owlbear refuses a description over 128 characters.
- **External contracts:** `contract/pins.json` pins DST's schema file, token-labels' tool file and the Owlbear SDK version. `.github/workflows/sync-steel-external.yml` checks them daily and opens an `external-contract` issue when one changes.
