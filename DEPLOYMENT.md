# Production deployment

## Architecture

- Cloudflare proxies `omnicommerce.brainsporellc.com` to the Ubuntu host.
- Existing host Nginx owns public ports 80/443 and terminates TLS.
- Host Nginx proxies to Caddy on `127.0.0.1:8080`; Caddy proxies to the Next.js
  service on Compose port 3069.
- Next.js is built with Next standalone output and runs as an unprivileged user.
- PostgreSQL 18 stores application data and Graphile Worker jobs.
- The web app, Graphile Worker, and migration runner use images built from the
  same release commit. Only the Caddy proxy is published to host loopback.
- There is no unused Redis service, Swarm dependency, public database port, or
  fake cache/health service in the production stack.

## One-time host setup

1. Create a dedicated SSH deploy account and install its public key. The setup
   script adds the account to the Docker group; Docker access is root-equivalent.
2. As root, run `sudo ./scripts/setup-server.sh`. It installs Docker Engine and
   the Compose/Buildx plugins, creates `/opt/qsell`, and opens ports 22, 80, and
   443. It does not set account passwords or configure passwordless sudo.
3. Create `/opt/qsell/.env.runtime` from `.env.example`, then set production
   values. Restrict it with `chmod 600 /opt/qsell/.env.runtime`.
4. Create the Postgres secret. Generate a URL-safe value with
   `openssl rand -hex 32`, put that same value in the URL-encoded `DATABASE_URL`
   password and in `/opt/qsell/secrets/postgres_password`, then set
   `chmod 600 /opt/qsell/secrets/postgres_password`.
5. Configure the repository Actions variables and secrets listed in
   [GITHUB_SECRETS.md](./GITHUB_SECRETS.md).
6. In Cloudflare, create a proxied `A` record for `omnicommerce` pointing to the
   host. Ensure the existing Nginx virtual host has a valid TLS certificate and
   proxy configuration before selecting **Full (strict)** in Cloudflare.
7. Integrate the Nginx location snippet into the existing HTTPS server block
   for this hostname. The release workflow copies the latest snippet to
   `/opt/qsell/deploy/nginx/omnicommerce-locations.conf`.

Inside the existing `listen 443 ssl` server block for
`omnicommerce.brainsporellc.com`, replace its current application catch-all
`location /` with:

```sh
include /opt/qsell/deploy/nginx/omnicommerce-locations.conf;
```

Keep existing ACME handling and TLS certificate directives unchanged. Then:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Keep the current valid TLS certificate and set Cloudflare SSL/TLS to
**Full (strict)**. Nginx continues to own ports 80/443; Compose publishes Caddy
only on loopback port 8080.

The runtime environment must include at least `DATABASE_URL` and `AUTH_SECRET`.
Configure enabled payment, email, encryption, and storage integrations there as
needed. Do not place secrets in the repository or in the deployment workflow.

Image uploads need **no extra setup**: they work out of the box on a persistent
volume. To use Cloudinary instead, add the settings described under
[Image uploads](#image-uploads-media-storage).

## Release path

1. Open a pull request into `release`; CI installs the frozen pnpm lockfile,
   applies database migrations in its disposable PostgreSQL service, typechecks,
   runs the media storage adapter checks (`pnpm media:verify`), and builds
   Next.js.
2. Merge the pull request. The release workflow publishes immutable
   `sha-<commit>`, `worker-<commit>`, and `migrator-<commit>` images to GHCR.
3. The workflow connects to the host with its SSH key, copies the Compose/Nginx
   config, **checks the media storage settings** (stopping with the old release
   still serving if they are wrong), pulls those exact commit images, applies
   migrations, updates Compose, checks the app health endpoint, confirms image
   uploads are ready, and finally smoke-tests the media provider.

Deploy logs are available under GitHub Actions → Release pipeline. On the host:

```sh
cd /opt/qsell
docker compose --env-file .env.deploy -f compose.production.yaml ps
docker compose --env-file .env.deploy -f compose.production.yaml logs -f app
docker compose --env-file .env.deploy -f compose.production.yaml logs -f worker
```

## Operations

Create and test encrypted off-host database backups before accepting production
traffic. A basic manual logical backup is:

```sh
cd /opt/qsell
docker compose --env-file .env.deploy -f compose.production.yaml exec -T db \
  pg_dump -U qsell -d qsell | gzip > "$HOME/qsell-$(date -u +%F-%H%M).sql.gz"
```

Store backups away from this host and regularly test a restore. PostgreSQL 18
uses `/var/lib/postgresql` as its volume root; do not reuse an older major
version's data volume without a planned `pg_upgrade` or dump/restore.

This Compose deployment is a single-host baseline, not a multi-host cluster.
Tune `APP_MEMORY_LIMIT`, `POSTGRES_MEMORY_LIMIT`, `WORKER_MEMORY_LIMIT`, their
CPU settings, database pool size, and worker concurrency to the actual host.
Scale reads beyond one app instance only after configuring a shared Next.js
cache and consistent multi-instance Server Action encryption key.

## Image uploads (media storage)

Product images can be uploaded (not just linked). Storage is a pluggable
provider chosen by `MEDIA_DRIVER` in `/opt/qsell/.env.runtime`:

| `MEDIA_DRIVER` | Where files go | Notes |
| --- | --- | --- |
| `local` (the default) | The persistent `media_data` volume, mounted at `/app/storage/media` | Single host. Survives releases. Back it up (below). |
| `cloudinary` | Your Cloudinary account | Needs the settings below. Recommended for production. |

### What a release does for you

- **Schema:** the migration image creates the media tables and, on the first run,
  turns every existing product image link into a library asset. Nothing to run.
- **Storage:** the `media_data` volume is created on first deploy, owned by the
  app user, and mounted on both the app and the worker (the nightly sweep deletes
  files). It stays mounted after you switch to Cloudinary, so earlier uploads keep
  working.
- **Network:** the worker can reach the internet (needed to delete files from
  Cloudinary). Before, it sat on an internal-only network.
- **Checks:** before touching the running stack, the release validates the media
  settings. After deploying it confirms the app reports `media.uploadsReady`, and
  (Cloudinary only) uploads and removes two tiny test images to prove the
  credentials work. A failure is shown as a red step with the reason.
- **Sweep:** a nightly worker job removes uploads that were never attached to a
  product and deleted images past their 30-day retention.

### Using Cloudinary

Add to `/opt/qsell/.env.runtime` (keep it `chmod 600`), then run a release or
`docker compose --env-file .env.deploy -f compose.production.yaml up -d app worker`:

```sh
MEDIA_DRIVER=cloudinary
# Either the single value from the Cloudinary console...
CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME
# ...or the three parts:
# CLOUDINARY_CLOUD_NAME=
# CLOUDINARY_API_KEY=
# CLOUDINARY_API_SECRET=
# Optional: one root folder per environment inside the account (default: qsell)
# CLOUDINARY_FOLDER=qsell
```

These are secrets; they live only on the host, like the rest of `.env.runtime`.
No GitHub secret is needed.

Switching providers affects new uploads only. Existing images keep being served
from wherever they were stored.

### Operating it

```sh
cd /opt/qsell
# Check the configured provider end to end (uploads and removes two test images)
docker compose --env-file .env.deploy -f compose.production.yaml run --rm -T --no-deps worker pnpm media:check
# Run the cleanup sweep now instead of waiting for the nightly job
docker compose --env-file .env.deploy -f compose.production.yaml run --rm -T worker pnpm media:purge
# Back up locally stored images (when MEDIA_DRIVER=local)
docker run --rm -v qsell_media_data:/media:ro -v "$PWD":/backup alpine \
  tar czf "/backup/qsell-media-$(date -u +%F).tar.gz" -C /media .
```

`/api/health` includes `"media": { "uploadsReady": true }`. It is informational:
it never makes the app report unhealthy, so a media misconfiguration cannot take
the site down. If it is `false`, the app log names the setting that is wrong.

If uploads are not configured, product forms still work and show a clear message;
pasting an image link always works.
