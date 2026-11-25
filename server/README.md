# Sync Steel server

The backend for the Sync Steel fork (report §4.3–4.5, decisions in [decisions.md](../docs/sync-steel/decisions.md)):
- a Forge Steel Warehouse-compatible API;
- rooms, seats and revocable device tokens;
- hero revisions;
- GM tools: restore, audit, export and import, and daily snapshots;
- live sync (Phase 3): the three-way hero merge and the WebSocket hub at `GET /live`.

**Stack:**
- Node 26 runs the TypeScript directly; there's no build step.
- [Hono](https://hono.dev) on `@hono/node-server` handles HTTP, and its WebSocket support (with [`ws`](https://github.com/websockets/ws)) the live hub.
- Storage is SQLite through the built-in `node:sqlite`, in one database file.

## Run locally

```bash
nvm use 26
npm ci --prefix server                     # Hono, plus dev types
DEV_SEED=1 npm start --prefix server       # http://localhost:8787
npm run dev --prefix server                # restarts on file changes
```

`DEV_SEED=1` creates a **Dev** room with fixed device tokens:
- `dev-token` (seat "Dev");
- `dev-gm-token` (seat "GM").

The database is `server/.data/dev.db` (git-ignored); delete the folder to start over.

To connect the fork: open the **Sync Steel** page (footer button) in `npm start`, which uses `http://localhost:8787`, and create or join a room. It writes Forge Steel's `ConnectionSettings` with this host and a device token. To use a `DEV_SEED` token instead: Settings → Advanced → Feature Flags `Treat Curve`, then Settings → Connections.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port (Railway sets it) |
| `DATABASE_PATH` | `server/.data/dev.db` locally; **required** on Railway | The SQLite file, on the volume in production |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `TOKEN_HASH_KEY` | fixed development values locally; **required** on Railway (32+ characters, all different) | Signing keys for access and refresh tokens, and the HMAC key for stored secrets. **Changing `TOKEN_HASH_KEY` invalidates every device token, join code and GM key** |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Exact origins allowed to make credentialed requests. Production lists `https://syncsteel.app` too (see [railway.md](../docs/sync-steel/railway.md)) |
| `TRUST_PROXY` | off | Read the client IP from `X-Real-IP` (Railway sets it) for rate limits |
| `MAX_ROOMS` | `10` | Room creation is open, so the server holds at most this many rooms |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_SECONDS` | 15 minutes, 90 days | Token lifetimes |
| `REVISION_KEEP_LAST`, `REVISION_DAILY_DAYS` | `100`, `90` | Each hero keeps its last N revisions, plus each day's last revision for this many days |
| `SNAPSHOT_DIR`, `SNAPSHOT_KEEP` | `snapshots/` next to the database, `14` | Daily whole-database copies; `SNAPSHOT_KEEP=0` turns them off |
| `DEV_SEED` | off | Create the Dev room. Refused in production |

The server counts as **in production** when Railway's variables are present or `NODE_ENV=production`. There it refuses to start without real secrets and a `DATABASE_PATH`.

## API

**Warehouse API** (what Forge Steel's `WarehouseService` calls; shapes match the reference Warehouse):

| Endpoint | Notes |
|---|---|
| `GET /healthz` | `{ version: "1.x" }` |
| `POST /connect` | Bearer device token → `{ access_token, refresh_token }`. Each call starts a session (`sid`) |
| `POST /refresh` | Bearer refresh token → `{ access_token }` |
| `GET /me` | `{ logged_in_as, room, seat }` |
| `GET /data` | The data keys |
| `GET`/`PUT`/`DELETE /data/forgesteel-heroes[/{id}]` | The list takes `?fields=`. Players see their seat's heroes; the GM sees the room's |
| `GET`/`PUT`/`DELETE /data/forgesteel-homebrew-settings[/{id}]` | Shared by the room |
| `GET`/`PUT /data/forgesteel-session`, `/data/forgesteel-hidden-setting-ids` | Per seat |

Behaviour details:
- An expired access token gets `401 {"msg":"Token has expired"}`, which triggers Forge Steel's refresh and retry.
- PUTs return `204`, or `400` when the id doesn't match the URL.
- A player's PUT to another seat's hero gets `403`.
- Deletes are soft.

**Sync Steel additions to heroes:**
- **Stamped reads:** every full hero read carries `_syncSteel: { rev }`.
- **Monotonic revisions:** a hero id's revision numbers are never reused, even after a delete.
- **Echo detection:** a PUT that changes nothing keeps the revision.
- **Three-way merge** (`src/merge.ts`): a device's save merges against its base, so a stale or concurrent copy can't undo another device's change. Rules are in [decisions.md](../docs/sync-steel/decisions.md#the-three-way-merge).
  - **Base:** the copy's stamp, or this session's own last save if newer ([finding 2](../docs/sync-steel/spike-results.md#2-the-stamp-alone-is-not-a-safe-merge-base)). After a merged save, the session's base is what it sent.
  - **Logging:** each save logs its stamp, session and base revisions, and whether it was merged.
- **Revision records:** each revision stores the session id (`sid`), device, seat and source.
- **Idempotent delete:** deleting a hero that's already deleted (and was visible to the caller) returns `204`, so a device can apply a delete made elsewhere through Forge Steel's own `deleteHero`.
- **Events:** each committed change emits `hero.changed` or `hero.deleted`, and a GM disconnecting a device emits `device.revoked` (`src/events.ts`). The live hub listens to them.

**Live sync** (`GET /live`, a WebSocket; `src/hub.ts`):

| Message | Notes |
|---|---|
| → `{ type: "hello", token, heroes: { [id]: rev } }` | The device token, in the first message (never the URL), and the revisions the device has. Within 10 s, or the socket closes (4000) |
| ← `{ type: "welcome", serverTime, seat }` | Then everything the device is missing: heroes at another revision, and `hero.deleted` for any it can no longer see |
| ← `{ type: "hero", hero }` | A stamped hero to apply. Changes are coalesced per hero (250 ms trailing, 1 s maximum) |
| ← `{ type: "hero.own", heroId, rev }` | This device's own save, stored as sent: only the revision |
| ← `{ type: "hero.deleted", heroId }` | |
| → `{ type: "ping" }` / ← `{ type: "pong" }` | The app checks the socket when it comes back to the foreground |

- **Visibility:** the same as the Warehouse API: players get their seat's heroes; the GM gets the room's.
- **Origin:** the upgrade must come from one of `CORS_ORIGINS` (`403` otherwise).
- **Close codes:** `4001` for a bad or revoked device token (also sent at once when the GM disconnects the device), `4008` when a device opens more than 4 sockets (the oldest closes) or a room passes 60, `4029` after too many failed tokens, `1009` for a message over 1 KB after hello.
- **Heartbeat:** a protocol ping every 30 s; a socket that misses one is dropped.

**Rooms** (no device token needed; rate-limited per IP):

| Endpoint | Body → result |
|---|---|
| `POST /rooms` | `{ roomName, gmSeatName?, deviceLabel }` → `{ room, seat, joinCode, gmKey, deviceToken }` |
| `POST /join/lookup` | `{ code }` → `{ room: { name }, seats }` |
| `POST /join` | `{ code, seatId \| newSeatName, deviceLabel, gmKey? }` → `{ room, seat, deviceToken }`. The GM seat needs `gmKey`; `{ gmKey, deviceLabel }` alone joins the GM seat |

Join codes are 10 Crockford base32 characters shown as `XXXXX-XXXXX`. They're case-insensitive, and `O`/`I`/`L` are read as `0`/`1`/`1`.

**GM** (devices in the GM seat only):

| Endpoint | Does |
|---|---|
| `GET /gm/room` | Seats with their devices and heroes, and the last export date |
| `POST /gm/join-code` | Rotates the join code and returns the new one. Devices that already joined stay signed in |
| `PATCH /gm/seats/{id}` | `{ name }`: renames a seat |
| `DELETE /gm/devices/{id}` | Revokes a device, effective at its next request |
| `GET /gm/heroes/deleted` | Lists soft-deleted heroes |
| `GET /gm/heroes/{id}/revisions[/{rev}]` | Lists a hero's kept revisions, or shows one |
| `POST /gm/heroes/{id}/restore` | `{ rev }` restores a revision as a new revision; `{}` brings back a deleted hero |
| `GET /gm/audit?limit=` | Joins, revocations, code rotations, deletes, restores, exports and imports |
| `GET /gm/export` | The whole room as `sync-steel-<room>-<date>.json.gz`. No device tokens or secrets |
| `POST /gm/import[?dryRun=1]` | Restores an export (gzipped or plain). Seats match by id, then name. Heroes and homebrew are upserted as new revisions. It never deletes |
| `GET /gm/snapshots`, `GET /gm/snapshots/{date}/export` | Lists the daily snapshots, and exports this room from one, ready for `POST /gm/import` |

**Limits:**
- request bodies: heroes 5 MB, homebrew and session data 20 MB, imports 50 MB, everything else 64 KB;
- rate limits on `/rooms`, `/join` and `/connect`, with separate limits on failed codes and tokens. Everyone at an in-person table shares one IP, so the per-IP limits allow for a whole group.

## Restoring data

| Problem | Fix |
|---|---|
| One hero was edited or deleted by mistake | `GET /gm/heroes/{id}/revisions`, then `POST /gm/heroes/{id}/restore` |
| The whole room needs rolling back | `GET /gm/snapshots/{date}/export`, then `POST /gm/import?dryRun=1`, then the same without `dryRun` |
| The volume or the Railway project is lost | Create a room, then import the latest GM export into it. Players join again with the new code and pick their seats |

`node src/tools/export-room.ts <database file> [room] [--base64]` writes a room export from any database file, such as a downloaded snapshot. Running it on Railway needs an SSH key: `railway ssh keys add`.

## Railway

The `api` service in the `sync-steel` project runs this package. Current IDs and the address are in [SETUP.md](../docs/sync-steel/SETUP.md#railway). It was set up with:

```bash
. ~/.railway/env
railway init --name sync-steel                     # links this directory
railway add --service api
railway service link api
railway volume add --mount-path /data
for name in JWT_SECRET JWT_REFRESH_SECRET TOKEN_HASH_KEY; do
	openssl rand -base64 48 | tr -d '\n' | railway variable set "$name" --stdin --service api --skip-deploys >/dev/null
done
railway variable set DATABASE_PATH=/data/sync-steel.db TRUST_PROXY=1 MAX_ROOMS=10 \
	"CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173" --service api --skip-deploys
railway environment edit --json <<'JSON'
{"services":{"<api service id>":{
	"build":{"builder":"DOCKERFILE","dockerfilePath":"server/Dockerfile","watchPatterns":["server/**"]},
	"deploy":{"healthcheckPath":"/healthz","healthcheckTimeout":120,"restartPolicyType":"ON_FAILURE","restartPolicyMaxRetries":10,"sleepApplication":false}}}}
JSON
railway domain --service api --port 8080
```

**Deploy from the repo root:** `railway up --service api --ci -m "<summary>"`. The Dockerfile copies only `server/`, and the build context is the whole repo, so later phases can import `src/`.

Each deploy restarts the service for a few seconds, so deploy outside play sessions. The service deploys the repo's `main` branch with "Wait for CI". The web app service, `fs-web`, is in [railway.md](../docs/sync-steel/railway.md).

## Develop

```bash
npm ci --prefix server
npm run typecheck --prefix server
npx vitest run server                # from the repo root; also part of `npm run check`
npx eslint server/src
```

**Layout:**

| Path | What |
|---|---|
| `src/main.ts` | Entry point: config, database, migrations, dev seed, snapshots, listen |
| `src/app.ts` | The Hono app, with logging, CORS and errors |
| `src/routes/` | Auth and Warehouse, rooms, GM |
| `src/store/` | SQL for rooms, seats and devices; heroes; homebrew; seat data |
| `src/db/` | Opening the database, migrations, and `migrations/NNN-name.sql` |
| `src/room-export.ts` | Export and import |
| `src/snapshots.ts` | Daily snapshots |
| `src/tools/` | Operator scripts |
| `src/test-support.ts` | Starts a real server on an in-memory database for tests |

**Rules for code here:**
- **TypeScript that Node's type stripping supports.** Runtime code may use only:
  - no enums, parameter properties or namespaces;
  - `import type` for types;
  - explicit `.ts` extensions on relative imports.

  `main.test.ts` starts `node src/main.ts` for real to catch violations.
- **Migrations:** add a new numbered `.sql` file to change the schema; never edit one that has shipped.
- **Dependencies:** install with `npm install --prefix server …`, never into the root `package.json`. Avoid packages that compile on install (`ignore-scripts=true`).
