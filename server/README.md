# Table Link server

The backend for the Table Link fork: a Warehouse-compatible API, plus later rooms, revisions and the WebSocket hub (report §4.3–4.5).

**Current state:** a **Phase 0 stub**. It's in memory only and has a fixed set of device tokens, so it isn't for real data.

## Run

Node 26 runs the TypeScript directly; there's no build step and there are no runtime dependencies.

```bash
nvm use 26
npm start --prefix server            # from the repo root, or `npm start` in server/
npm run dev --prefix server          # restarts on file changes
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `STUB_DEVICE_TOKENS` | `dev-token=Dev` | `token=Seat` pairs, comma-separated; several tokens may share a seat. Each pair is split at its **last** `=`, so base64 tokens work. A malformed entry stops the server |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,https://forgesteel.net` | Exact origins allowed to make credentialed requests |
| `JWT_SECRET` | random per start | HS256 secret; when it's random, a restart signs everyone out |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime. Set it low to exercise refresh |

To connect Forge Steel:
1. Settings → Advanced → Feature Flags: enter `Treat Curve`.
2. Settings → Connections: turn on the manual Warehouse, with host `http://localhost:8787` and a device token.

## API

The stub matches the reference [Forge Steel Warehouse](https://github.com/Veritas1000/forgesteel-warehouse) where the client depends on it:
- `GET /healthz`, `POST /connect`, `POST /refresh`, `GET /me`, `GET /data`;
- `GET`/`PUT`/`DELETE /data/forgesteel-heroes[/{id}]` (the list takes `?fields=`);
- the same for `/data/forgesteel-homebrew-settings`;
- `GET`/`PUT /data/forgesteel-session` and `/data/forgesteel-hidden-setting-ids`.

**Response details:**
- reads return `{data}`;
- PUTs return `204`, or `400` when the id doesn't match the URL;
- an expired access token returns `401 {"msg":"Token has expired"}`.

**Table Link additions:**
- **Stamped reads:** every full hero read carries `_tableLink: {rev}`.
- **Monotonic revisions:** revision numbers are never reused for a hero id, even after a delete.
- **Echo detection:** a PUT that changes nothing keeps the revision.
- **Merge-base logging:** each hero save logs the base a three-way merge would use: the later of the stamp and the session's last write (see [spike-results.md](../docs/table-link/spike-results.md), finding 2). Bases from a deleted copy of the hero are flagged.

## Develop

```bash
npm ci --prefix server               # dev types only (@types/node, typescript)
npm run typecheck --prefix server
npx vitest run server                # from the repo root; also part of `npm run check`
npx eslint server/src
```

**Rules for code here:**
- Runtime code must use only TypeScript that Node's type stripping supports:
  - no enums, parameter properties or namespaces;
  - `import type` for types;
  - explicit `.ts` extensions on relative imports.
- Tests run under the repo's Vitest and must need nothing beyond Node built-ins, so `npm run check` passes without `npm ci --prefix server`.
- `main.test.ts` starts `node src/main.ts` for real, to catch syntax that type stripping can't run.
