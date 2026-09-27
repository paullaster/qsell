# Production deployment

## Architecture

- Cloudflare proxies `onmicommerce.brainsporellc.com` to the Ubuntu host.
- Caddy terminates TLS and proxies to the Next.js container on port 3069.
- Next.js is built with Next standalone output and runs as an unprivileged user.
- PostgreSQL 18 stores application data and Graphile Worker jobs.
- The web app, Graphile Worker, and migration runner use images built from the
  same release commit. Only the web service is exposed to Caddy.
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
6. In Cloudflare, create a proxied `A` record for `onmicommerce` pointing to the
   host. Set SSL/TLS mode to **Full (strict)**. Caddy obtains and renews the
   origin certificate automatically; ports 80 and 443 must be reachable.

The runtime environment must include at least `DATABASE_URL` and `AUTH_SECRET`.
Configure enabled payment, email, encryption, and storage integrations there as
needed. Do not place secrets in the repository or in the deployment workflow.

## Release path

1. Open a pull request into `release`; CI installs the frozen pnpm lockfile,
   applies database migrations in its disposable PostgreSQL service, typechecks,
   and builds Next.js.
2. Merge the pull request. The release workflow publishes immutable
   `sha-<commit>`, `worker-<commit>`, and `migrator-<commit>` images to GHCR.
3. The workflow connects to the host with its SSH key, copies the Compose/Caddy
   config, pulls those exact commit images, applies migrations, updates Compose,
   and checks the app health endpoint.

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
