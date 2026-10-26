# Deployment runbook

This document takes you from "a blank Ubuntu server" to "a running, TLS-secured
installation", and then through every later release. Nothing here is tied to one
server: every host-specific value lives in a single **instance config file**, and
the scripts and GitHub workflows read it.

- [1. How it works](#1-how-it-works)
- [2. The parameter sheet](#2-the-parameter-sheet)
- [3. One-time repository setup](#3-one-time-repository-setup)
- [4. New server: step by step](#4-new-server-step-by-step)
- [5. Releasing](#5-releasing)
- [6. Operations](#6-operations)
- [7. Troubleshooting](#7-troubleshooting)
- [8. Image uploads (media storage)](#8-image-uploads-media-storage)

## 1. How it works

```
 you ──PR/merge──▶ release branch ──▶ "Release build pipeline"
                                        validate (typecheck, tests, build)
                                        publish immutable GHCR images:
                                          sha-<commit> · worker-<commit> · migrator-<commit>
                                        (deploys NOTHING)

 you ──run manually──▶ "Deploy release to instance" (pick Environment, SHA optional)
                          │ SSH (per-Environment key, pinned host key)
                          ▼
   ┌────────────────────── one server, one installation ──────────────────────┐
   │ Internet ─▶ Cloudflare (optional) ─▶ Nginx :80/:443 (TLS, host-owned)    │
   │              ─▶ Caddy 127.0.0.1:$EDGE_HTTP_PORT ─▶ app :3069             │
   │ Docker Compose project $COMPOSE_PROJECT_NAME:                            │
   │   db (Postgres 18) · app (Next.js) · worker (Graphile) · caddy · migrate │
   │ Files: $DEPLOY_PATH/.env.runtime  secrets/postgres_password             │
   └───────────────────────────────────────────────────────────────────────────┘
```

Principles:

- **Build once, deploy many.** Images are shared; runtime configuration is not.
- **Nothing deploys by itself.** A merge publishes images. A person picks which
  installation gets which release.
- **Isolation.** Each installation has its own database, secrets, volumes, domain,
  Compose project and loopback port. Deploying one never touches another. Never
  point two installations at one database.
- **Secrets stay on the host.** `.env.runtime` and the Postgres password are
  created on the server and never pass through GitHub. GitHub holds only what is
  needed to reach and pull: an SSH key, the pinned host key and a read-only
  registry token.
- **Safe rollouts.** Order is: validate → pull → migrate → replace → health check.
  A failed migration stops before anything is replaced; a failed health check
  rolls app, worker and Caddy back to the previous images.

## 2. The parameter sheet

Everything that differs per server is one of these. Copy
`deploy/instance.env.example` to `deploy/instances/<INSTANCE_ID>.env` (git-ignored)
and fill it in. All scripts accept `--config <file>`, and any value can instead be
passed as an environment variable (which wins over the file).

| Parameter              | Required | Default                           | Meaning / rules                                                                                     |
| ---------------------- | -------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `INSTANCE_ID`          | yes      | –                                 | Lowercase letters, digits, hyphens (max 40). Becomes the GitHub Environment and Nginx snippet name. |
| `PUBLIC_DOMAIN`        | yes      | –                                 | Bare hostname (`shop.example.com`). No `https://`, slash or port.                                   |
| `DEPLOY_HOST`          | yes\*    | –                                 | IP/DNS GitHub Actions SSHs to. \*GitHub step only.                                                  |
| `DEPLOY_USER`          | yes\*    | –                                 | Account that owns the instance dir and runs Docker (`setup-server.sh` creates it as `APP_USER`).    |
| `APP_DIR`              | no       | `/opt/qsell`                      | Root for all installations on the host.                                                             |
| `DEPLOY_PATH`          | no       | `$APP_DIR/instances/$INSTANCE_ID` | Absolute path; letters, digits, `/ _ -` only. Its folder name need not equal `INSTANCE_ID`.         |
| `COMPOSE_PROJECT_NAME` | no       | `qsell-$INSTANCE_ID`              | Namespaces containers/volumes. Unique per installation on a host. **Never change on a live one.**   |
| `EDGE_HTTP_PORT`       | no       | `8080`                            | Loopback port for Caddy (1024–65535). Unique per installation on a host.                            |
| `ADMIN_EMAIL`          | yes      | –                                 | Initial super-admin login.                                                                          |
| `MEDIA_DRIVER`         | no       | `local`                           | `s3`, `local` or `cloudinary` (see [section 8](#8-image-uploads-media-storage)).                          |
| `CERT_EMAIL`           | yes      | –                                 | Let's Encrypt expiry notices.                                                                       |
| `GITHUB_REPO`          | yes\*    | –                                 | `owner/name` of the repository.                                                                     |
| `GHCR_USERNAME`        | yes\*    | –                                 | GitHub user whose token can read the private images.                                                |
| `SSH_KEY_FILE`         | yes\*    | –                                 | Path (on your machine) of the passphrase-less deploy key for this installation.                     |

Where each value ends up:

| GitHub Environment **variable**                  | From                         |
| ------------------------------------------------ | ---------------------------- |
| `DEPLOY_HOST` `DEPLOY_USER`                      | same names                   |
| `DEPLOY_PATH`                                    | same name (derived if unset) |
| `COMPOSE_PROJECT_NAME`                           | same name (derived if unset) |
| `PUBLIC_DOMAIN` `EDGE_HTTP_PORT` `GHCR_USERNAME` | same names                   |

| GitHub Environment **secret** | Source                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `DEPLOY_SSH_PRIVATE_KEY`      | contents of `SSH_KEY_FILE`                                    |
| `DEPLOY_KNOWN_HOSTS`          | `ssh-keyscan -t ed25519 $DEPLOY_HOST` (fingerprint confirmed) |
| `GHCR_READ_TOKEN`             | fine-grained token with read access to the package            |

On the server, per installation: `$DEPLOY_PATH/.env.runtime` (app configuration and
secrets) and `$DEPLOY_PATH/secrets/postgres_password`, both mode `600`.

## 3. One-time repository setup

Done once per repository, not per server.

1. Merge `.github/workflows/ci-cd.yml` **and** `deploy-instance.yml` into `release`
   _and_ `main`. GitHub lists a manually-run workflow only when it exists on the
   default branch (`main`); the deploy job itself refuses to run from any ref but
   `release`.
2. Repository **variable** `SERVER_ACTION_ALLOWED_ORIGINS`: comma-separated list of
   **every** installation's domain. It is compiled into the shared image, so add a
   new domain here and publish a fresh release build _before_ deploying to it.
   Optional: `NEXT_PUBLIC_SENTRY_DSN`; secret `SENTRY_AUTH_TOKEN` for source maps.
3. Create a fine-grained GitHub token with read access to the repository's
   package (GHCR). Keep it ready for `GHCR_READ_TOKEN`.
4. Install the GitHub CLI (`gh`) on your machine and run `gh auth login` as someone
   with admin rights on the repository.

## 4. New server: step by step

Variables below are shown as `$NAME`; they all come from your config file. Phases
marked **laptop** run on your machine, **root** / **deploy** on the server.

### Phase A — DNS (laptop)

Create an `A` record for `$PUBLIC_DOMAIN` pointing to the server's public IP. With
Cloudflare, leave the record **DNS only** (grey cloud) until the certificate is
issued, then proxy it and set SSL mode to **Full (strict)**.

### Phase B — Deploy key (laptop)

```sh
scripts/configure-github-environment.sh --config deploy/instances/<id>.env --key-only
```

This creates `$SSH_KEY_FILE` (ed25519, no passphrase — `webfactory/ssh-agent`
cannot use passphrase-protected keys), never overwrites an existing one, and prints
its **public** half: one line starting `ssh-ed25519 AAAA…`. Do not reuse your
personal key.

**What to do with the output:** copy that whole line. You paste it into phase C as
`SSH_PUBLIC_KEY='…'`, which authorises the key on the server. Keep the private file
on your machine; phase F uploads it to GitHub for you. Nothing else is needed, and
nothing has been sent to the server or GitHub yet.

### Phase C — Bootstrap the host (root, on the server)

```sh
git clone https://github.com/$GITHUB_REPO /tmp/qsell && cd /tmp/qsell
sudo APP_USER=$DEPLOY_USER APP_DIR=$APP_DIR \
     SSH_PUBLIC_KEY='ssh-ed25519 AAAA… qsell-actions-<id>' \
     ./scripts/setup-server.sh
```

Installs Docker Engine + Compose/Buildx (log rotation, live-restore), creates the
deploy account with a **locked password** (so `ssh-copy-id` cannot work — hence
`SSH_PUBLIC_KEY`), creates `$APP_DIR/instances`, and opens UFW for 22/80/443.
Supports Ubuntu 20.04, 22.04, 24.04 and 26.04 (20.04 is past standard support; the Nginx script detects its older nginx 1.18 and writes `listen 443 ssl http2` instead of `http2 on`). Docker group membership is root-equivalent:
restrict the account to trusted operators. Log in again so the group applies, and
reboot if Ubuntu reports a pending kernel update.

Check: `ssh -i $SSH_KEY_FILE $DEPLOY_USER@$DEPLOY_HOST 'id -un && docker ps'`.

### Phase D — Create the instance (deploy user, on the server)

Copy your config file to the server (it holds no secrets), then:

```sh
cd /tmp/qsell
scripts/provision-instance.sh --config /path/to/<id>.env
```

Creates `$DEPLOY_PATH` and `secrets/`, generates a random Postgres password and all
application secrets, and writes `.env.runtime` (mode `600`). It prompts for the admin
password (or generates one and shows it once). It will **not overwrite** an existing
`.env.runtime` or password — regenerating the DB password after the volume exists
would lock the app out of its own database.

- Extra settings (SMTP, payment providers, Cloudinary…): put `KEY=VALUE` lines in a
  file and pass `EXTRA_ENV_FILE=…`, or edit `.env.runtime` afterwards.
- **Back up** `DATA_ENCRYPTION_KEY` / `PAYMENT_DATA_KEY` somewhere safe; losing them
  makes encrypted data unreadable.

### Phase E — Nginx and TLS (root, on the server)

```sh
sudo scripts/setup-nginx-site.sh --config /path/to/<id>.env
```

Installs Nginx + certbot, obtains the certificate through the port-80 webroot
challenge, writes `/etc/nginx/sites-available/$INSTANCE_ID`, enables it and reloads.
Until the first deploy, `/` answers `503`. Preview without changing anything:
`--dry-run`. Certificates renew automatically (`certbot.timer`).

### Phase F — GitHub Environment (laptop)

```sh
scripts/configure-github-environment.sh --config deploy/instances/<id>.env
```

Creates the Environment named `$INSTANCE_ID`, sets the seven variables and three
secrets from [section 2](#2-the-parameter-sheet), shows the host-key fingerprint and
asks you to confirm it matches the server (`ssh-keygen -lf
/etc/ssh/ssh_host_ed25519_key.pub`) before trusting it, and prompts (hidden) for the
registry token. Add reviewers to the Environment for higher-risk targets. Remember
[section 3](#3-one-time-repository-setup) step 2: the new domain must be in
`SERVER_ACTION_ALLOWED_ORIGINS` and a release must have been built **after** adding it.

### Phase G — First deploy

GitHub → Actions → **Deploy release to instance** → _Run workflow_ on branch
`release`, Environment `$INSTANCE_ID`, SHA empty (= newest successful release build).

The workflow: validates the Environment → resolves the release → SSHes in → refuses
unless `.env.runtime` and the Postgres password exist and `DATABASE_URL` uses host
`db` → validates media settings → pulls images → runs migrations → starts the stack →
writes `$DEPLOY_PATH/deploy/nginx/$INSTANCE_ID.conf` → waits for a healthy `/api/health`
→ checks `media.uploadsReady`. The final HTTPS check only **warns** on this first run,
because Nginx does not include the snippet yet.

### Phase H — Switch the site on (root, on the server)

```sh
sudo scripts/setup-nginx-site.sh --config /path/to/<id>.env --no-cert
```

Re-running detects the generated snippet, replaces the `503` placeholder with the
include, validates (`nginx -t`) and reloads.

### Phase I — Go-live checklist

- [ ] `curl -s https://$PUBLIC_DOMAIN/api/health` → `"status":"healthy"`, `uploadsReady:true`
- [ ] Log in at `/admin` as `$ADMIN_EMAIL`; change the initial password
- [ ] Upload a product image (and, for Cloudinary, check the deploy's media step was green)
- [ ] Cloudflare proxy on, SSL **Full (strict)** (if used)
- [ ] Backups scheduled and a restore tested ([6.4](#64-backups))
- [ ] `sudo reboot` once if a kernel update was pending; confirm the stack returns

## 5. Releasing

1. Open a pull request into `release`. CI installs locked dependencies, migrates a
   disposable database, typechecks, runs `pnpm test` (including database integration
   tests), `pnpm media:verify`, and a production build. Lint is not gated yet.
2. Merge. `Release build pipeline` publishes the three images for that commit.
3. Run **Deploy release to instance** for each installation you want to update.
   Leave the SHA empty for the newest build, or paste a full 40-character SHA to
   deploy or roll back to a specific one (it must have a successful build).

Safety behaviour: a failed migration stops before anything is replaced. A failed
health check **rolls back** app, worker and Caddy to the previous image set
(`.env.deploy.previous`). **The database schema is never rolled back**, so migrations
must be backward-compatible with the previous release (add columns/tables first;
drop or rename in a later release). Replacing the app container causes a brief
interruption. One deploy per Environment runs at a time.

## 6. Operations

All commands run on the server in `$DEPLOY_PATH`:

```sh
alias dc='docker compose --env-file .env.deploy -f compose.production.yaml'
```

### 6.1 Status and logs

```sh
dc ps                    # app/worker/db/caddy and health
dc logs -f app worker
```

### 6.2 Roll back by hand

Run the deploy workflow with the previous good SHA (preferred). Emergency, on the
host: `cp .env.deploy.previous .env.deploy && dc up -d`.

### 6.3 Change configuration

Edit `.env.runtime` (keep mode `600`), then `dc up -d app worker`. Never edit
`COMPOSE_PROJECT_NAME`, the database password or `DATABASE_URL` on a live instance.

### 6.4 Backups

`scripts/backup-instance.sh $DEPLOY_PATH` dumps Postgres and the local media volume,
prunes after `BACKUP_KEEP_DAYS` (default 14) and rsyncs to `BACKUP_REMOTE` when set.
Copy it to the host once (`install -D scripts/backup-instance.sh $APP_DIR/scripts/backup-instance.sh`),
then schedule it per instance, e.g. in the deploy user's crontab:

```sh
15 2 * * * BACKUP_REMOTE=backup@backup-host:/srv/qsell/<id>/ $APP_DIR/scripts/backup-instance.sh $DEPLOY_PATH >> $APP_DIR/backup.log 2>&1
```

Keep backups off the host and test a restore regularly. PostgreSQL 18 uses
`/var/lib/postgresql` as its volume root; do not reuse an older major version's data
volume without a planned `pg_upgrade` or dump/restore.

### 6.5 Add a domain, move, or decommission

- **Add a hostname:** add it to `SERVER_ACTION_ALLOWED_ORIGINS`, publish a new
  release, extend the Nginx `server_name`/certificate, redeploy.
- **Second installation on the same host:** a new config file with a new
  `INSTANCE_ID`, `PUBLIC_DOMAIN` and a **different `EDGE_HTTP_PORT`**; repeat phases
  A, B, D–I (skip C).
- **Decommission:** `dc down -v` (deletes that installation's data — back up first),
  remove its directory, Nginx site, certificate (`certbot delete`) and GitHub
  Environment.

### 6.6 Capacity

Each installation is an independent single-host Compose stack — not a cluster.
Tune `APP_MEMORY_LIMIT`, `POSTGRES_MEMORY_LIMIT`, `WORKER_MEMORY_LIMIT`, the CPU
settings, DB pool size and `WORKER_CONCURRENCY` for the host. The worker has a
container healthcheck (`scripts/worker-healthcheck.mjs`).

## 7. Troubleshooting

| Symptom (workflow / server output)                             | Cause and fix                                                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Set this environment's PUBLIC_DOMAIN Actions variable`        | Must be an Environment **variable** (not a secret) on the right Environment, bare hostname. Same for the other six variables.     |
| `Invalid instance id`                                          | `INSTANCE_ID` allows only `a-z 0-9 -` (no underscore). The folder name may differ; the Environment may not.                       |
| `Unknown MEDIA_DRIVER '…'`                                     | Typo in `.env.runtime` (`s3`/`cloudinary`/`local` only). Nothing was deployed.                                                         |
| `MEDIA_DRIVER=s3 but … missing S3_BUCKET, …`                  | Add `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` to `.env.runtime`.                                                 |
| `MEDIA_DRIVER=cloudinary but … missing Cloudinary credentials` | Add `CLOUDINARY_URL` (or all three parts) to `.env.runtime`.                                                                      |
| `No successful Release build pipeline exists for …`            | SHA wasn't built on `release` (PR or failed publish). Leave SHA empty or pick one from a green run.                               |
| Workflow not listed in the Actions UI                          | `deploy-instance.yml` isn't on `main` yet ([section 3](#3-one-time-repository-setup)).                                            |
| `Missing …/.env.runtime` / `postgres_password`                 | Run `provision-instance.sh` first (phase D) and check `DEPLOY_PATH` matches.                                                      |
| `DATABASE_URL must address … host db`                          | `.env.runtime` must use `@db:5432`. Never share a database between installations.                                                 |
| SSH `Permission denied (publickey)`                            | Public key not in `~$DEPLOY_USER/.ssh/authorized_keys` (the account has no password; use `SSH_PUBLIC_KEY` in phase C).            |
| Host key / `known_hosts` error                                 | `DEPLOY_KNOWN_HOSTS` must be for the same name/IP as `DEPLOY_HOST`; re-run phase F.                                               |
| `denied` pulling images                                        | `GHCR_READ_TOKEN`/`GHCR_USERNAME` wrong or token lacks package read access.                                                       |
| Health check fails, stack rolled back                          | `dc logs app` (bad env value, DB, migration). Fix and redeploy. First deploys have nothing to roll back to.                       |
| `Failed server action` / origin errors in the browser          | Domain missing from `SERVER_ACTION_ALLOWED_ORIGINS` at **build** time. Add it, publish a new release, redeploy.                   |
| HTTPS check warns "Nginx does not include …"                   | Expected on the first deploy: run phase H.                                                                                        |
| `certbot` fails                                                | DNS not pointing here, port 80 blocked, or Cloudflare proxy on during issuance.                                                   |
| `nginx -t` fails after phase H                                 | Run `setup-nginx-site.sh --dry-run`, compare with `/etc/nginx/sites-available/<id>`; fix and re-run.                              |
| Run is red after a healthy deploy                              | Look at the _last_ failing step: the media smoke test (S3 or Cloudinary credentials) is deliberately last and non-blocking for traffic. |

## 8. Image uploads (media storage)

Product images can be uploaded (not just linked). Storage is a pluggable
provider chosen by `MEDIA_DRIVER` in that installation's `DEPLOY_PATH/.env.runtime`:

| `MEDIA_DRIVER`        | Where files go                                                      | Notes                                                 |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `s3`                  | An S3-compatible bucket (AWS S3, MinIO, R2, B2, Wasabi, Spaces, bundled RustFS) | Needs the settings below. Recommended for production. |
| `local` (the default) | The persistent `media_data` volume, mounted at `/app/storage/media` | Single host. Survives releases. Back it up (below).   |
| `cloudinary`          | Your Cloudinary account                                             | Kept so earlier uploads keep working.                 |

### What a release does for you

- **Schema:** the migration image creates the media tables and, on the first run,
  turns every existing product image link into a library asset. Nothing to run.
- **Storage:** the `media_data` volume is created on first deploy, owned by the
  app user, and mounted on both the app and the worker (the nightly sweep deletes
  files). It stays mounted after you switch to S3 or Cloudinary, so earlier uploads
  keep working: every file is read from the provider it was stored with.
- **Network:** the worker can reach the internet (needed to delete files from
  S3 or Cloudinary). Before, it sat on an internal-only network.
- **Checks:** before touching the selected stack, deployment validates that
  instance's media settings. After deploying it confirms `media.uploadsReady`, and
  (S3 and Cloudinary) a final non-blocking step uploads and removes two tiny test
  images to prove the credentials work. A failure is shown as a red step with the
  reason.
- **Sweep:** a nightly worker job removes uploads that were never attached to a
  product and deleted images past their 30-day retention.

### Using S3-compatible storage

Create a private bucket (block all public access) and a key that may only read, write and delete
inside it, then add to the selected instance's `.env.runtime` (keep it `chmod 600`) and deploy
that instance:

```sh
MEDIA_DRIVER=s3
S3_BUCKET=my-bucket
S3_REGION=eu-west-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
# Anything other than AWS: the store's address (https:// only). Addressed path-style by default.
# S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
# A folder inside the bucket, so installations can share one bucket (default: qsell).
# S3_PREFIX=<instance-id>
# Where public files (product images) are served from: a CDN or a public-read bucket policy
# limited to <prefix>/public/*. Without it public files use signed links that last a few hours.
# S3_PUBLIC_URL=https://cdn.example.com
# S3_SSE=AES256
```

- **Private files** (vendor documents, evidence) are never public: the app hands out a signed link
  that expires in minutes, and only after checking the person may see the file.
- **Public files** are product images. Serve them through `S3_PUBLIC_URL`, never by making the
  whole bucket public.
- **Smoke test:** `pnpm media:check` uploads and removes two tiny test images and checks that a
  private file cannot be read without its signed link.
- **Policy for the key:** allow `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on
  `arn:aws:s3:::<bucket>/<prefix>/*`, and nothing else.

### Using Contabo Object Storage

Contabo's object storage speaks the S3 API. Create a **private** bucket in the Contabo panel (leave
"Public Access" inactive: private files are only ever served by signed links, and product images
use signed links too). Take the S3 key pair from your Contabo account, then:

```sh
MEDIA_DRIVER=s3
# The region's host, not the bucket address: for US-central it is https://usc1.contabostorage.com
S3_ENDPOINT=https://usc1.contabostorage.com
# The plain bucket name (not the tenant-prefixed form some panel pages show).
S3_BUCKET=noels-deliveries
# Contabo signs with the region name "default", whatever region the bucket is in.
S3_REGION=default
# Contabo addresses buckets in the path: https://<host>/<bucket>/<key>.
S3_FORCE_PATH_STYLE=true
S3_PREFIX=<instance-id>
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Check it first from any machine with the same variables set: `pnpm media:check` should end with
"Provider looks good". Do not set `S3_PUBLIC_ENDPOINT`, `S3_SSE`, or `S3_ENDPOINT=http://rustfs…`.

### Using the bundled RustFS (free, self-hosted)

RustFS is open-source, S3-compatible object storage. `compose.production.yaml` includes it as an
optional service (the `storage` profile), so an installation can keep its files in a store of its own
without an outside account. Nothing is started unless you ask for it:

```sh
MEDIA_DRIVER=s3
# The app and worker reach the store by its name on the private network.
S3_ENDPOINT=http://rustfs:9000
# Browsers load files through this site's own address, which forwards /<bucket>/* to the store.
S3_PUBLIC_ENDPOINT=https://shop.example.com   # exactly https://<PUBLIC_DOMAIN>
S3_BUCKET=qsell-media
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...        # choose any; the store is created with this key
S3_SECRET_ACCESS_KEY=...    # a long random value
```

When a deploy sees `S3_ENDPOINT=http://rustfs…` it checks `S3_PUBLIC_ENDPOINT`, starts the `rustfs`
service with that key, creates the bucket (once), and tells Caddy which bucket path to forward.
Nothing else changes: the store has no published port and no route to the internet, and the host
Nginx needs no new server block because requests already reach Caddy.

- **Private files** stay private: they are never public, only reachable through a signed link that
  expires in minutes, handed out after the app checks the person may see the file.
- **Data:** files live in the `rustfs_data` volume. `backup-instance.sh` archives it next to the
  database and media backups; run it when uploads are quiet. Restore by extracting the archive into a
  fresh `rustfs_data` volume before starting the service.
- **Version:** the image is `rustfs/rustfs:latest` unless `RUSTFS_IMAGE` is set; pin a tag once you have
  tested one. RustFS is a newer project, so read its release notes before an upgrade.
- **Reverse proxy:** the signature covers the path and the Host header, so the proxy must pass both
  unchanged. The bundled Caddy route does; if you put your own proxy in front, do the same.

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
# CLOUDINARY_FOLDER=<instance-id>
```

These are secrets; they live only on the host, like the rest of `.env.runtime`.
No GitHub secret is needed.

Switching providers affects new uploads only. Existing images keep being served
from wherever they were stored.

### Operating it

```sh
cd $DEPLOY_PATH
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
