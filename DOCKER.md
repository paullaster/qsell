# Docker commands

The repository pins **pnpm 12.6.0** through `package.json` and builds with
`pnpm-lock.yaml`. Keep that lockfile committed; Docker and CI intentionally use
`--frozen-lockfile` so a deployment cannot resolve different dependency versions.

## Local development

```sh
docker compose up --build
```

Open <http://localhost:3069>. PostgreSQL 18 is available to local database tools
at `127.0.0.1:5434`.

Run migrations:

```sh
docker compose exec app pnpm db:migrate
```

Run the asynchronous callback worker as well:

```sh
docker compose --profile worker up --build
```

## Production

Production uses `compose.production.yaml` with a single Compose project: the
standalone Next.js app, a separate Graphile Worker process, a one-shot Drizzle
migrator, PostgreSQL 18, and Caddy as the app reverse proxy. Caddy listens on
loopback port 8080 because host Nginx already owns public ports 80/443. Nginx
terminates TLS and proxies to Caddy; Caddy proxies to the app on port 3069. The
release workflow publishes
immutable images and updates the server; it does not build images on the host.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for host provisioning and first deployment.

The server deployment is one host. App/worker resource limits and worker
concurrency are configurable in Compose, but read/write capacity is bounded by
that host and its PostgreSQL storage. Use Cloudflare caching for immutable
`/_next/static/*` assets; keep personalized pages and `/api/*` uncached.
