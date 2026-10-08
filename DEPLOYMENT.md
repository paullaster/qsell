# Production deployment

## Multi-installation model

- A push/merge to `release` validates source and publishes one immutable app,
  worker, and migrator image set. It **does not deploy anywhere**.
- Production deploys are started explicitly with GitHub Actions →
  **Deploy release to instance**. Choose the target GitHub Environment and the
  successful release SHA to deploy.
- Each installation has a separate database, Compose project, secrets, uploads,
  media volume, hostname, and local Caddy port. Deploying one target leaves the
  others running their current image and database schema.
- Images are shared across installations; runtime configuration is not.
- Keep each instance on one application version at a time. The target’s
  migrator updates only that target’s own Postgres service before its app/worker
  containers are replaced.

The original production server remains the existing `production` installation.
Keep its GitHub Environment name and set `COMPOSE_PROJECT_NAME=qsell` to preserve
the existing containers and volumes. A new installation gets a separate GitHub
Environment and must use a fresh project name, for example
`qsell-new-baremetal`, plus its own PostgreSQL database/secret.

## Provision a bare-metal host

1. Create a dedicated SSH deploy account and install its public key. The setup
   script adds the account to the Docker group; Docker access is root-equivalent.
2. As root, run `sudo ./scripts/setup-server.sh`. It installs Docker Engine and
   Compose/Buildx, creates `/opt/qsell`, and opens ports 22, 80, and 443.
3. For each installation on this host, create a separate directory, e.g.
   `/opt/qsell/instances/new-shop`, with `.env.runtime` and
   `secrets/postgres_password` (both mode `600`). The deployment account must
   own the directory and be able to run Docker Compose there.
4. Set `DATABASE_URL` to the installation’s own Compose service, e.g.
   `postgresql://qsell:<URL-ENCODED-PASSWORD>@db:5432/qsell`, and put the same
   password in that instance’s secret file. Never point two production
   installations at the same database.
5. Create a GitHub Actions Environment for each instance. Configure the
   instance-specific variables and secrets in
   [GITHUB_SECRETS.md](./GITHUB_SECRETS.md).
6. Point the instance’s DNS name at this host, configure its TLS virtual host
   in Nginx, and include the generated instance snippet described below.
   Assign an unused loopback port to every instance sharing a host.

Nginx owns public ports 80/443 and TLS. Each Compose Caddy service binds only to
`127.0.0.1:$EDGE_HTTP_PORT`; Nginx forwards that hostname to its matching port.
After the first deployment of an instance, include the generated file inside
that hostname’s HTTPS server block, for example:

```nginx
include /opt/qsell/instances/new-shop/deploy/nginx/new-shop.conf;
```

Hosts set up before per-instance snippets include
`<DEPLOY_PATH>/deploy/nginx/omnicommerce-locations.conf`. Deploys keep that file
refreshed from the template, so such hosts keep working; switch the include to
`<instance-id>.conf` when convenient.

Keep the hostname’s existing ACME and TLS directives unchanged, then run
`sudo nginx -t && sudo systemctl reload nginx`. Cloudflare should use **Full
(strict)** when enabled. Use different `EDGE_HTTP_PORT` values for multiple
installations on one server.

## Build and selectively deploy

1. Open a pull request into `release`. CI installs the locked dependencies,
   migrates its disposable test database, typechecks, runs `pnpm test` (including
   the database integration tests), runs `pnpm media:verify`, and builds the
   application. Lint is not gated yet.
2. Merge to `release`. The build pipeline publishes immutable images tagged
   `sha-<commit>`, `worker-<commit>`, and `migrator-<commit>`.
3. After that build succeeds, open GitHub Actions → **Deploy release to
   instance**. Select a configured instance Environment and enter the full
   40-character commit SHA. The workflow verifies that the SHA has a successful
   release build, checks that target’s configuration, migrates that target’s
   database, deploys its app and worker, and verifies its HTTPS health endpoint.
4. Repeat the manual deploy for any other targets you choose. No other
   installation is changed unless selected.

GitHub only lists a `workflow_dispatch` workflow in the Actions UI when the file
exists on the **default branch** (`main`). Merge `deploy-instance.yml` into
`main` as well as `release`, then run it with branch `release` selected (the job
refuses any other ref).

On a failed health check the deploy **rolls the app, worker and Caddy back** to
the previously deployed image set (`.env.deploy.previous`). A failed migration
stops before anything is replaced. The database schema is never rolled back, so
write migrations to be backward-compatible with the previous release: add
columns/tables first, and drop or rename them in a later release. Replacing the
single app container still causes a brief interruption.

The first deploy of a new instance generates its Nginx snippet, so the final
HTTPS check only warns (rather than fails) until Nginx includes it.

Set repository variable `SERVER_ACTION_ALLOWED_ORIGINS` to the comma-separated
list of all installed public domains before building a release; Server Action
origin allowlists are embedded in the shared build image.

Deploy logs are available under GitHub Actions → **Deploy release to instance**.
On a host, use the selected instance path and project name:

```sh
cd /opt/qsell/instances/new-shop
docker compose --env-file .env.deploy -f compose.production.yaml ps
docker compose --env-file .env.deploy -f compose.production.yaml logs -f app worker
```

## GitHub target configuration

Use a GitHub Environment named for each installation (keep the existing
`production` Environment; add names such as `new-shop` for new instances).
Environment protection rules can
require a reviewer for higher-risk targets. The workflow refuses to deploy if
the named environment is not fully configured.

Each target has its own runtime secrets and local database. If Cloudinary is
used, share the account if desired but assign a distinct `CLOUDINARY_FOLDER`
per installation. With local media storage, Docker volume names are isolated by
the Compose project name.

## Operations

Create and test encrypted off-host database backups before accepting production
traffic. `scripts/backup-instance.sh <deploy-path>` dumps Postgres and the local
media volume, prunes after `BACKUP_KEEP_DAYS` (default 14), and rsyncs to
`BACKUP_REMOTE` when set. Schedule it per instance, e.g. in the deploy user's
crontab (the script is copied with the repo; run it from a checkout or copy it
to the host):

```sh
15 2 * * * BACKUP_REMOTE=backup@backup-host:/srv/qsell/new-shop/ /opt/qsell/scripts/backup-instance.sh /opt/qsell/instances/new-shop >> /opt/qsell/backup.log 2>&1
```

A basic manual logical backup is:

```sh
cd /opt/qsell/instances/new-shop
docker compose --env-file .env.deploy -f compose.production.yaml exec -T db \
  pg_dump -U qsell -d qsell | gzip > "$HOME/new-shop-$(date -u +%F-%H%M).sql.gz"
```

Store backups away from this host and regularly test a restore. PostgreSQL 18
uses `/var/lib/postgresql` as its volume root; do not reuse an older major
version's data volume without a planned `pg_upgrade` or dump/restore.

The worker has a container healthcheck (`scripts/worker-healthcheck.mjs`) that
confirms it can reach Postgres and that Graphile Worker's tables exist.

Each installation is an independent single-host Compose stack. It is not a
multi-host cluster or a horizontally scaled app. Tune `APP_MEMORY_LIMIT`,
`POSTGRES_MEMORY_LIMIT`, `WORKER_MEMORY_LIMIT`, CPU settings, database pool size,
and worker concurrency for the host that runs that particular installation.

## Image uploads (media storage)

Product images can be uploaded (not just linked). Storage is a pluggable
provider chosen by `MEDIA_DRIVER` in that installation's `DEPLOY_PATH/.env.runtime`:

| `MEDIA_DRIVER`        | Where files go                                                      | Notes                                                 |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `local` (the default) | The persistent `media_data` volume, mounted at `/app/storage/media` | Single host. Survives releases. Back it up (below).   |
| `cloudinary`          | Your Cloudinary account                                             | Needs the settings below. Recommended for production. |

### What a release does for you

- **Schema:** the migration image creates the media tables and, on the first run,
  turns every existing product image link into a library asset. Nothing to run.
- **Storage:** the `media_data` volume is created on first deploy, owned by the
  app user, and mounted on both the app and the worker (the nightly sweep deletes
  files). It stays mounted after you switch to Cloudinary, so earlier uploads keep
  working.
- **Network:** the worker can reach the internet (needed to delete files from
  Cloudinary). Before, it sat on an internal-only network.
- **Checks:** before touching the selected stack, deployment validates that
  instance's media settings. After deploying it confirms `media.uploadsReady`, and
  (Cloudinary only) a final non-blocking step uploads and removes two tiny test
  images to prove the credentials work. A failure is shown as a red step with the
  reason.
- **Sweep:** a nightly worker job removes uploads that were never attached to a
  product and deleted images past their 30-day retention.

### Using Cloudinary

Add to the selected instance's `.env.runtime` (keep it `chmod 600`), then deploy
that instance or run `docker compose --env-file .env.deploy -f compose.production.yaml up -d app worker` from its `DEPLOY_PATH`:

```sh
MEDIA_DRIVER=cloudinary
# Either the single value from the Cloudinary console...
CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
# ...or the three parts:
# CLOUDINARY_CLOUD_NAME=
# CLOUDINARY_API_KEY=
# CLOUDINARY_API_SECRET=
# Optional: distinct root folder for this installation
# CLOUDINARY_FOLDER=new-shop
```

These are secrets; they live only on the host, like the rest of `.env.runtime`.
No GitHub secret is needed.

Switching providers affects new uploads only. Existing images keep being served
from wherever they were stored.

### Operating it

```sh
cd /opt/qsell/instances/new-shop
# Check the configured provider end to end (uploads and removes two test images)
docker compose --env-file .env.deploy -f compose.production.yaml run --rm -T --no-deps worker pnpm media:check
# Run the cleanup sweep now instead of waiting for the nightly job
docker compose --env-file .env.deploy -f compose.production.yaml run --rm -T worker pnpm media:purge
# Back up locally stored images (when MEDIA_DRIVER=local)
docker run --rm -v "${COMPOSE_PROJECT_NAME}_media_data:/media:ro" -v "$PWD":/backup alpine \
  tar czf "/backup/${COMPOSE_PROJECT_NAME}-media-$(date -u +%F).tar.gz" -C /media .
```

`/api/health` includes `"media": { "uploadsReady": true }`. It is informational:
it never makes the app report unhealthy, so a media misconfiguration cannot take
the site down. If it is `false`, the app log names the setting that is wrong.

If uploads are not configured, product forms still work and show a clear message;
pasting an image link always works.
