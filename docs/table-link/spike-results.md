# Phase 0 spike results

The spike checks the riskiest assumptions in the [research report](./forgesteel-owlbear-sync-report.md) (§10) before Phase 1. Setup and commands are in [SETUP.md](./SETUP.md).

**Status (22 Nov 2026):**
- Everything that can run without an Owlbear account is done and passing.
- The Owlbear tests (A–E1) were run on 22 Nov with a GM and a player account. Results are under [Manual results](#manual-results) and findings 5–9.
- Still open: **E2** (Party Continuity, deferred), the optional **C3**, Transfer, and export/import.

**Versions tested:**
- Node 26.13.1;
- Forge Steel upstream `3c6b4ab`;
- Draw Steel Tools 2 `a445eb9` (unchanged since July);
- `@owlbear-rodeo/sdk` 3.1.0.

## Checklist (report §10)

| Check | Status | Result |
|---|---|---|
| `HeroLogic` in Node: summary values and primary heroic resource | ✅ | `HeroSummaryLogic` gives the rules values:<br>• Fury 21 stamina / 10 recoveries;<br>• Beastheart 21 / 12, and 129 at level 10;<br>• Talent 18 / 8.<br>Primary resource:<br>• Ferocity, not Rampage;<br>• negative Clarity kept;<br>• the epic resource is never primary. |
| Heroes with more than one heroic resource | ✅ | The Beastheart's primary resource is the first `heroic` resource, read and written by feature id. |
| `_tableLink` survives copy, update, load and save (unit) | ✅ | Survives:<br>• `Utils.copy` and `HeroUpdateLogic.updateHero`;<br>• a Warehouse GET → `DataManager.saveHero` PUT;<br>• a local save and reload.<br>Mutation checks fail the tests, as they should. |
| `_tableLink` round trip through the **real UI** | ✅ | Load → Vitals modal (damage) and Resources modal (Clarity −2) → debounced PUTs all carried the stamp. The server stored `talent-resource` = −2 by feature id. See [finding 2](#2-the-stamp-alone-is-not-a-safe-merge-base). |
| Stub backend: `/healthz`, `/connect` CORS preflight with credentials, expired-token 401 | ✅ | Automated tests, plus a real browser. Forge Steel's **Test Connection** showed "Success! (v1.0.0-stub)", with the requests `GET /healthz` → `OPTIONS /connect 204` → `POST /connect 200`. |
| Upstream `WarehouseService`, unmodified, against the stub | ✅ | Real HTTP: heroes, homebrew, session and hidden ids. Expired token → `401 Token has expired` → `POST /refresh` → retry succeeds. Forge Steel shows the stub's `{message}` text to the user. |
| Owlbear accepts our writes to DST data; DST re-renders; DST's schema accepts the values | ✅ | A and B:<br>• every write passed both checks;<br>• notes, gmOnly and the resource button were never touched;<br>• negative stamina and Clarity were accepted. |
| Room permissions (`CHARACTER_OWNER_ONLY`) for player writes | ✅, with a surprise | A player's extension wrote the **GM's** token with Owner Only **on**, and the GM saw it. See [finding 6](#6-owner-only-does-not-stop-extension-writes). |
| Lost updates when writes collide | ✅ measured | • One client: 0 lost.<br>• **Two clients on one token: 39 of 80 lost.**<br>• DST clicks during a burst: 1 of 40 lost.<br>• Owlbear **rate-limits** about 10 writes/s per client.<br>See findings [5](#5-owlbear-rate-limits-writes-per-client), [7](#7-two-writers-on-one-token-lose-about-half-the-updates) and [8](#8-dst-can-overwrite-our-write-made-milliseconds-earlier). |
| Party Continuity stale restore | Deferred | E2 not run yet. Without Party Continuity, a scene switch caused no DST rewrites (E1). |
| Transfer page moves homebrew | ⏳ manual | Not tried yet (see the browser steps under [Reproducing](#reproducing-the-browser-checks)). |
| iPad WebSocket resume | Later | No WebSocket until Phase 3. |
| Trial merge of the module onto upstream head | Later | Nothing in upstream files is changed yet (new files only). |

## Findings

### 1. Upstream hides manual Warehouse settings behind a feature flag
- **What:** Settings → Connections shows only Patreon until the **"Manual Forge Steel Warehouse connections"** feature flag is on. To turn it on, go to Settings → **Advanced** → Feature Flags and enter the phrase **`Treat Curve`**. The source only contains its hash, `1551245932421255`; the phrase comes from the reference Warehouse README.
- **Effect:** the migration guide (report §9, step 2.2) needs an extra first step for forgesteel.net users.
- **Fork:** unaffected. The Table Link room panel will write `ConnectionSettings` directly.

### 2. The stamp alone is not a safe merge base
`putHero` ignores the response, so a client keeps the `_tableLink.rev` it **loaded** for every later save in that session. Real-UI evidence from the stub, before the fix:

```
hero … "Keth" rev 1 -> 2 (stamp rev 1)
hero … "Keth" rev 2 -> 3 (stamp rev 1) WARNING: stale base (current was rev 2)
```

**Why it matters:** with base = rev 1, a field this device changed in its first save looks "changed again" in the second. It would overwrite any Owlbear edit to that field made in between.

**Refinement (now in the stub):**
- Each `/connect` mints a session id (`sid` claim in both JWTs).
- The server remembers the revision each session last wrote, or last matched for an echo, per hero.
- The **merge base = the later of the stamp and the session's last write**. That's valid because a session's own writes are ancestors of its copy.

Real-UI evidence after the refinement:

```
hero … "Garrick" rev 1 -> 2 (stamp rev 1, session wrote rev none, base rev 1)
hero … "Garrick" rev 2 -> 3 (stamp rev 1, session wrote rev 2, base rev 2)
hero … "Garrick" rev 3 -> 4 (stamp rev 1, session wrote rev 3, base rev 3)
```

**Other notes:**
- A different session still holding an old stamp is correctly flagged as stale; there's a unit test for this.
- Forge Steel calls `/connect` on every app load, so each load or tab is its own session.
- **Not solved by either approach:** a modal saving a copy older than the session's last write. That's an upstream self-race. Phase 3's "re-apply remote fields if a stale save arrives" still applies.

### 3. Draw Steel Tools' schema details that matter
- DST uses **zod 4**, whose `z.number()` rejects both `NaN` and `Infinity`. So "finite number" is exactly DST's rule.
- On its own writes, DST re-parses its data with `z.object`, which **drops unknown keys**. Our link and condition data must therefore stay under our own metadata key (already the design) and never inside DST's object.
- A hero token's `type` may be missing on older tokens; DST treats that as `HERO`.

### 4. Smaller notes
- Each app load makes 1 `/connect`, 4 list GETs and 1 GET per hero (the loader fetches heroes one by one). That's fine for a home group.
- The Owlbear SDK depends on `uuid@^9`, which has a moderate advisory affecting only v3/v5/v6 with a buffer; the SDK only calls `v4`. `obr-extension/package.json` overrides it to `uuid@14`, and its audit is clean.
- In the Settings panel, each setter copies state from the last render, so scripted form fills need short pauses between fields. This is a test-driver quirk, not a user-facing bug.

### 5. Owlbear rate-limits writes per client
- **What happened:** in D1, 20 writes at 50 ms intervals went through for the first **10** in about 0.5 s. The rest failed with `{"name":"RateLimitHit","message":"Too many requests"}` until about 1 s after the first write. Overlapping and one-at-a-time runs behaved the same.
- **The limit is per client:** at 100 ms intervals (about 9/s), one client got no errors (D3). Neither did two clients at about 9/s each on the same token (D2).
- **Failed writes are clean:** they aren't applied (the final values matched the successful writes only), so they can be retried.
- **Design change:**
  - keep the elected writer well under the limit, e.g. **about 3 `updateItems` calls/s per client**, with all due tokens batched into one call;
  - retry on `RateLimitHit` with backoff.

  The limit is probably shared with Draw Steel Tools on the same client (this wasn't tested), so a fast writer could make the GM's own DST clicks fail.

### 6. Owner Only does not stop extension writes
- **What happened:** with Owner Only on (and Character Update granted), a player's extension wrote stamina on a token the **GM** created. Both checks passed, and the GM's client received the change from the player.
- **What it means:** Owner Only limits players in Owlbear's UI, but the SDK's metadata updates aren't blocked by it.
- **Design change:** the elected-writer rule doesn't need the owner check. Any connected client with Character Update can write. Whether a write is blocked when Character **Update** is removed is still untested (optional C3).
- **Related:**
  - `gmOnly` is only a DST display setting: the player's extension read the hidden token's full stats;
  - every client can read every token's metadata, and room metadata too, so never put secrets in either.

### 7. Two writers on one token lose about half the updates
- **What happened:** in D2, two clients each made 40 `+1` writes to the same token at the same time. The final value was 41, not 80, so **39 updates were lost**.
- **Why:** each client mostly saw only its own increments. Owlbear has no compare-and-set, so concurrent writers overwrite each other.
- **What it means:** this confirms the design's single **elected writer per token** is mandatory, not an optimisation.
- **Related:** two humans editing one token through DST at once have the same problem, but that's inherent to Owlbear and DST.

### 8. DST can overwrite our write made milliseconds earlier
- **What happened:** in D3, a Surges click on the same client landed 5 ms after one of our stamina writes and carried the old stamina (`surges 2 -> 3, stamina 33 -> 32`). That cost 1 of 40 stamina updates. The other three clicks, 20–25 ms clear of our writes, lost nothing, and none of our writes undid a surges click (0 of 4 lost).
- **Design change:**
  - keep the quiet window and verify after writing;
  - in the **token → server** direction, don't forward a field that reverts to its pre-write value within the verify window while other fields change. That's a clobber of our write, not a user edit, so re-assert our value instead.

### 9. Other Owlbear and DST behaviour
- **DST saves twice on the editing client.** The second save only reorders the keys; other clients see a single change. Change detection must therefore compare **values**, not serialised JSON. The spike's log now labels these "keys reordered".
- **DST writes sparse data.** A new hero token gets each field only when it's first edited; DST fills in defaults when it reads. Our reader accepts sparse data.
- **Scene switches:**
  - without Party Continuity, DST rewrites nothing when a scene opens;
  - `OBR.room.onPermissionsChange` fires twice on every scene load, with unchanged permissions, so compare before reacting.
- **Latency:**
  - `updateItems` resolves locally in 5–12 ms;
  - a change reaches another client in about 80–670 ms, usually about 100 ms;
  - a broadcast arrives in about 35 ms.
- **Clipboard:** writing to the clipboard is blocked in Owlbear's extension iframe. The spike's select-then-copy fallback works.

## Owlbear runbook (manual)

**You need:**
- an Owlbear Rodeo account and a test room with **Draw Steel Tools** installed;
- a second browser or account joined as a **player**;
- optionally, Party Continuity.

**Start the extension:**

```bash
cd ~/dev/forgesteel-owlbear-sync
nvm use 26
npm ci --prefix obr-extension
npm run dev --prefix obr-extension      # serves http://localhost:5174/manifest.json
```

**Add it to the room:**
1. In the room, open the Extensions menu and add a custom extension with the URL `http://localhost:5174/manifest.json`.
2. Every desktop browser that opens the popover needs the dev server reachable on its own `localhost`. Use the same machine, or serve the extension over HTTPS for other devices (an iPad included).
3. Open the **Table Link spike** popover. **Copy log** after each test and paste the output below.

**Before the tests,** create two character tokens:
- **GM token:** created by the GM;
- **Player token:** created by the player account.

Set both up as **heroes** in Draw Steel Tools, and give each some `notes`, `gmOnly` on, and a non-default resource button (e.g. `+2`), so we can see that we never touch them.

| Test | Steps | Record |
|---|---|---|
| **A. Write acceptance (GM)** | As GM, select the GM token, change stamina and the resource in the form, then **Write**. | Both log checks (`immediately`, `after 1500 ms`) say `OK` and `untouched`. DST's bubbles show the new values. DST's token editor opens without an error. |
| **B. Schema edge values** | **Write Talent sample** (stamina −2/18, temp 3, Clarity −3). | DST renders a dying hero and negative Clarity. The editor opens. Nothing in the browser console from DST. |
| **C1. Player write, owner only off** | As the player, select the **GM token**, then Write. | The prediction, the outcome, and both checks. Does DST update for both users? |
| **C2. Player write, owner only on** | GM: open the **Players** panel (person icon, top left), click the **shield icon** (Player Permissions), then use the **Character** row's dropdown to add the **Owner Only** tag. Keep **Update**; ⓧ removes a tag. The spike log should show `Room permissions changed: owner only on`. Then the player writes to the **GM token**, then to the **Player token**. With Owner Only on, the GM can also assign a token's owner from its toolbar's person icon. | GM token: does `updateItems` throw, or does the "after 1500 ms" check show a rollback (MISMATCH)? Player token: allowed? If you used the Owner menu, does the panel's "Created by" line change to the player? |
| **C3. Player write without Update** (optional) | In Player Permissions, remove the **Update** tag from the Character row. The player writes to the GM token and to their own token. Put Update back afterwards. | Does `updateItems` throw, or does the "after 1500 ms" check show a rollback? If neither, no permission stops extension writes. |
| **D1. Burst, one client** | GM token: 20 writes every 50 ms, overlapping. Repeat with "overlapping" off. | Lost updates for each. |
| **D2. Burst, two clients** | Both users open the popover. Tick **Run on every client**, then run. | Lost updates and per-client write counts. |
| **D3. Burst vs DST clicks** | DST's stamina is a typed field with no +/− buttons, so click a **different** field's button instead. First click **Log DST snapshot** and note the surges value. Run a burst of 40 × 100 ms (about 4 s); while it runs, click DST's **Surges +** about 10 times, spread out, and count them. Then click **Log DST snapshot** again. | **Stamina lost:** the burst's lost count; DST's writes overwrote ours.<br>**Surges lost:** start + clicks − final surges; our writes overwrote DST's.<br>Both come from Owlbear replacing a token's whole metadata on each write. In the `DST change` lines, a surges change is DST's and a stamina change is ours. Both show as "you", because the same player made them. |
| **E1. Scene switch** | With the log open, switch to another scene and back. | Every `DST change … by …` line on scene ready, if any. |
| **E2. Party Continuity** (optional) | With PC managing the party: Write new values, switch scenes, come back. | Does PC write **old** values back? Who's the author (`by …`)? Are our values restored on return? |

### Manual results

**Run:** 22 Nov 2026, 17:13–17:30 UTC. The GM and a player account (`TESTING_PLAYER_ACCOUNT`) were in one room.
- **GM token:** "Charlie", created by the GM.
- **Player token:** "Henge", created by the player after Owner Only was turned on.
- **Setup:** the GM set Charlie's `gmOnly` back to `false` before C1, so the player could see the bubbles.

| Test | Result | Log evidence |
|---|---|---|
| A. Write acceptance | ✅ | `wrote stamina, heroicResource (7 ms)`; both checks `OK; notes/gmOnly/button untouched`. |
| B. Schema edge values | ✅ | All seven synced fields written, including stamina −2 and Clarity −3. Both checks OK. |
| C1. Owner only off | ✅ | Player: `wrote stamina (11 ms)`, both checks OK. The GM saw `DST change on Charlie by TESTING_PLAYER_ACCOUNT: stamina 39 -> 0`. |
| C2. Owner only on | ❗ allowed | Player on the GM's token: `expect allowed = false`, but `wrote stamina`, and both checks OK. The GM received the change ([finding 6](#6-owner-only-does-not-stop-extension-writes)). On the player's own token, both writes were OK. |
| D1. Burst, one client | 0 lost; rate-limited | **Overlapping 20 × 50 ms:** 10 writes, 10 `RateLimitHit`, 0 lost.<br>**One at a time:** 11 writes, 9 `RateLimitHit`, 0 lost.<br>See [finding 5](#5-owlbear-rate-limits-writes-per-client). |
| D2. Burst, two clients | **39 of 80 lost** | One at a time, 40 × 100 ms per client, no errors. Final 41, expected 80 ([finding 7](#7-two-writers-on-one-token-lose-about-half-the-updates)). |
| D3. Burst vs DST clicks | Stamina 1 of 40 lost; surges 0 of 4 lost | Surges went 0 → 4 with 4 clicks. One click clobbered our write 5 ms earlier ([finding 8](#8-dst-can-overwrite-our-write-made-milliseconds-earlier)). |
| E1. Scene switch | ✅ no rewrites | Charlie's values were identical after switching away and back; no `DST change` lines. |
| E2. Party Continuity | Deferred | |

**Raw logs:** [GM, full](./spike-logs/2026-11-22-owlbear-gm.log) and [player, key lines](./spike-logs/2026-11-22-owlbear-player-excerpt.log). The extension logs in UTC.

## Reproducing the browser checks

Each command runs in its own terminal, from `~/dev/forgesteel-owlbear-sync` with `nvm use 26` done first.

```bash
npm start --prefix server   # stub Warehouse on http://localhost:8787, device token "dev-token" (seat "Dev")
npm start                   # the fork on http://localhost:5173
```

Then in the fork:
1. Settings → **Advanced** → Feature Flags: enter `Treat Curve`.
2. Settings → Connections: turn on manual Warehouse, with host `http://localhost:8787` and token `dev-token`.
3. **Test Connection**, then **Save** and **Reload**.
4. Create a premade hero, reload, and edit it in the Vitals and Resources modals.

The stub logs each hero save with its stamp, the session's last write and the base it would merge against.

**Still to try:** Transfer (Local → Warehouse) with a homebrew-dependent hero, and hero export/import with a stamped hero.
