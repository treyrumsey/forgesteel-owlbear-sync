# Table Link Owlbear extension

The Owlbear Rodeo companion extension for Table Link (report §4.7).

**Current state:** a **Phase 0 spike tool** that tests writing to Draw Steel Tools' token data. It writes test values to hero tokens, so **use it in a test room only**.

## Run

```bash
nvm use 26
npm ci --prefix obr-extension
npm run dev --prefix obr-extension          # http://localhost:5174/manifest.json
```

1. In an Owlbear Rodeo room, add a custom extension with the URL `http://localhost:5174/manifest.json`.
2. Open the **Table Link spike** popover.
3. Select a Draw Steel Tools hero token.

The test steps are in the [runbook](../docs/table-link/spike-results.md#owlbear-runbook-manual).

**Serving notes:**
- The Vite server sends `Access-Control-Allow-Origin` for `*.owlbear.rodeo`, because Owlbear fetches the manifest and icons cross-origin.
- `localhost` only works in a browser on the same machine. Other devices, iPads included, need the extension served over HTTPS.

## What the spike does

- **Status:** shows the room, your role, and the room's character permissions (`CHARACTER_UPDATE`, `CHARACTER_OWNER_ONLY`).
- **Write and verify:**
  - patches only the synced Draw Steel Tools fields of the selected token, re-reading the token just before writing;
  - checks the result immediately and again 1.5 s later, to catch server rollbacks;
  - confirms `notes`, `gmOnly` and `heroicResourceButton` weren't touched.
- **Burst test:** fires N `+1 stamina` writes, on this client or on every client with the popover open (via broadcast), then counts lost updates.
- **Log:** shows each Draw Steel Tools data change with its author, plus scene events and snapshots. **Copy log** copies it for the results doc.

## Develop

```bash
npm run build --prefix obr-extension        # tsc + vite build into dist/
npx vitest run obr-extension                # from the repo root; also part of `npm run check`
npx eslint obr-extension/src
```

**Rules for code here:**
- `src/dst-token.ts` is the only code that builds Draw Steel Tools data. It:
  - writes only finite numbers and strings (DST's zod 4 schema throws otherwise and breaks the token);
  - patches only the synced fields.
- Keep it free of SDK imports, so its tests run under the repo's Vitest without `npm ci --prefix obr-extension`.
- Store Table Link's own data under our own metadata key, never inside DST's object. DST drops unknown keys when it writes.
