# Phase 0 spike results

The spike checks the riskiest assumptions in the [research report](./forgesteel-owlbear-sync-report.md) (§10) before Phase 1. Setup and commands are in [SETUP.md](./SETUP.md).

**Status (22 Nov 2026):**
- Everything that can run without an Owlbear account is done and passing.
- The Owlbear checks need a person in a test room. The extension for them is built; the [runbook](#owlbear-runbook-manual) is below.

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
| Owlbear accepts our writes to DST data; DST re-renders; DST's schema accepts the values | ⏳ manual | Extension built ([runbook](#owlbear-runbook-manual) A–B). Our values pass a copy of DST's schema rules (finite numbers, strings), with unit tests. |
| Room permissions (`CHARACTER_OWNER_ONLY`) for player writes | ⏳ manual | Runbook C. The extension logs its prediction next to what actually happens. |
| Lost updates when writes collide | ⏳ manual | Runbook D: single-client, multi-client (broadcast) and manual-DST-click bursts. |
| Party Continuity stale restore | ⏳ manual | Runbook E. Needs a paid membership. |
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
| **D1. Burst, one client** | GM token: 20 writes every 50 ms, overlapping. Repeat with "overlapping" off. | Lost updates for each. |
| **D2. Burst, two clients** | Both users open the popover. Tick **Run on every client**, then run. | Lost updates and per-client write counts. |
| **D3. Burst vs DST clicks** | DST's stamina is a typed field with no +/− buttons, so click a **different** field's button instead. First click **Log DST snapshot** and note the surges value. Run a burst of 40 × 100 ms (about 4 s); while it runs, click DST's **Surges +** about 10 times, spread out, and count them. Then click **Log DST snapshot** again. | **Stamina lost:** the burst's lost count; DST's writes overwrote ours.<br>**Surges lost:** start + clicks − final surges; our writes overwrote DST's.<br>Both come from Owlbear replacing a token's whole metadata on each write. In the `DST change` lines, a surges change is DST's and a stamina change is ours. Both show as "you", because the same player made them. |
| **E1. Scene switch** | With the log open, switch to another scene and back. | Every `DST change … by …` line on scene ready, if any. |
| **E2. Party Continuity** (optional) | With PC managing the party: Write new values, switch scenes, come back. | Does PC write **old** values back? Who's the author (`by …`)? Are our values restored on return? |

### Manual results

_Paste logs and observations here, per test._

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
