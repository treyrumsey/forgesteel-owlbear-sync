# Railway

The `sync-steel` project (`5726124d-ee72-45a4-9063-d4e99ca74c30`), environment `production` (`847cb03a-42c1-44ee-a97c-0e86e9d12741`), runs two services. Both deploy `main` from `treyrumsey/forgesteel-owlbear-sync` with **"Wait for CI"**, so a commit deploys only after Sync Steel CI passes.

| Service | ID | Builds | Address | Watch paths |
|---|---|---|---|---|
| `api` | `00e960ac-ff05-4d56-8b99-84789a92f9a9` | `server/Dockerfile` (with the hero summary bundle from `src/`) | `https://api-production-d612ac15.up.railway.app` (port 8080) | `server/**`, `src/**`, `vite.sync-steel-summary.config.ts`, `package-lock.json` |
| `fs-web` | `3b8d58cf-ca8a-4cc1-b5cb-b5bb16deee92` | `Dockerfile.sync-steel` (the branded web app, and the Owlbear extension at `/owlbear/`) | **`https://syncsteel.app`**, plus `https://fs-web-production-33b435c3.up.railway.app` (port 80) | `**`, `!/server/**`, `!/docs/**` |

Both use the health check `/healthz`, restart on failure (10 retries) and never sleep. The api's volume, variables and setup commands are in [server/README.md](../../server/README.md#railway).

**Agent shells:** run `. ~/.railway/env` first. This directory is linked to the project; pass `--service` to every command.

## fs-web setup (22 Nov 2026)

```bash
. ~/.railway/env
railway add --service fs-web \
	--variables "FORGESTEEL_SYNC_STEEL_API_HOST=https://api-production-d612ac15.up.railway.app"
railway variable set PORT=80 --service fs-web   # nginx listens on 80; Railway's health check probes $PORT
railway environment edit --json <<'JSON'
{"services":{"3b8d58cf-ca8a-4cc1-b5cb-b5bb16deee92":{
	"build":{"builder":"DOCKERFILE","dockerfilePath":"Dockerfile.sync-steel","watchPatterns":["**","!/server/**","!/obr-extension/**","!/docs/**"]},
	"deploy":{"healthcheckPath":"/healthz","healthcheckTimeout":120,"restartPolicyType":"ON_FAILURE","restartPolicyMaxRetries":10,"sleepApplication":false}}}}
JSON
railway domain --service fs-web --port 80               # the generated domain
railway domain syncsteel.app --service fs-web --port 80 # bought through Railway: DNS and verification are automatic
railway environment edit --json <<'JSON'   # after Phase 2 merged: deploy main once CI passes
{"services":{"3b8d58cf-ca8a-4cc1-b5cb-b5bb16deee92":{"source":{"repo":"treyrumsey/forgesteel-owlbear-sync","branch":"main","checkSuites":true}}}}
JSON
railway variable set "CORS_ORIGINS=https://syncsteel.app,https://fs-web-production-33b435c3.up.railway.app,http://localhost:5173,http://127.0.0.1:5173" --service api
```

**Phase 4 watch paths** (set on 26 Nov 2026, after Phase 4 merged): the api also watches `src/**`, so its hero summaries follow upstream's `HeroLogic`; fs-web also watches `obr-extension/**`, because it serves the extension. **Saving this redeployed both services** on the current commit (a few seconds' downtime for the api), so change Railway settings outside play sessions too.

```bash
railway environment edit --json <<'JSON'
{"services":{
	"00e960ac-ff05-4d56-8b99-84789a92f9a9":{"build":{"watchPatterns":["server/**","src/**","vite.sync-steel-summary.config.ts","package-lock.json"]}},
	"3b8d58cf-ca8a-4cc1-b5cb-b5bb16deee92":{"build":{"watchPatterns":["**","!/server/**","!/docs/**"]}}}}
JSON
```

**`FORGESTEEL_SYNC_STEEL_API_HOST`** is read when the container starts: `nginx/env.sh` writes it into the built files in place of the placeholder. Changing it needs only a restart, not a rebuild.

**`CORS_ORIGINS`** on the api must list every origin the web app is served from. forgesteel.net isn't on it on purpose (see [decisions](./decisions.md#onboarding-json-import-not-a-forgesteelnet-migration)).

## The domain

`syncsteel.app` was bought through Railway on 22 Nov 2026:
- **DNS:** Railway's nameservers serve it, with a CNAME at the apex to fs-web.
- **Renewal:** auto-renews yearly, about 30 days before expiry.
- **Privacy:** WHOIS privacy is on.
- **Leaving Railway:** the domain can be transferred out (after ICANN's 60-day lock), or its DNS delegated elsewhere with custom nameservers.

**Never change the web app's domain lightly:** installed home-screen apps and each browser's saved connection belong to it.

## Deploying by hand

Normally pushing to `main` deploys whichever services the change touches. To deploy a branch for testing:

```bash
railway up --service fs-web --ci -m "<summary>"   # or --service api
```

Each deploy restarts the service. The api is down for a few seconds (it has a volume, so deployments can't overlap); deploy outside play sessions.

## Resetting the api's database

**This empties every room for the app. Take a GM export first if anything matters.**

**Without SSH (how go-live did it, 22 Nov 2026):** point the api at a new database file and snapshot folder on the same volume. The old files stay on the volume, unused, so switching the variables back undoes it.

```bash
railway variable set DATABASE_PATH=/data/sync-steel-live.db SNAPSHOT_DIR=/data/snapshots-live --service api
```

The server creates the empty database on start. The pre-go-live files (`/data/sync-steel.db`, `/data/snapshots/`) hold only test rooms and can be deleted once SSH is set up (`railway ssh keys github`, then `railway ssh --service api`).

Devices that had joined stop at Forge Steel's data load error; see the [how-to](./how-to.md#players-a-new-or-lost-device).
