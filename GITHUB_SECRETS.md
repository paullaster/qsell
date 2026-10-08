# GitHub Actions: release builds and deployment targets

## Release build pipeline

The `Release build pipeline` validates pull requests into `release`. A push/merge
to `release` builds and publishes immutable GHCR images; **it does not deploy**.
Production deploys are manual, target-selected runs of
`.github/workflows/deploy-instance.yml`.

Set this **repository Actions variable** once, to the comma-separated hostnames
of every installed instance (the app image is shared and Server Action origins
are compiled into it):

| Variable                        | Example                                               |
| ------------------------------- | ----------------------------------------------------- |
| `SERVER_ACTION_ALLOWED_ORIGINS` | `omnicommerce.brainsporellc.com,new-shop.example.com` |

If another hostname is added, add it to that variable and publish a fresh build
before deploying that release to the new instance.

## One GitHub Environment per installation

Keep using the existing `production` GitHub Environment for the deployed
installation; create another Environment (e.g. `new-shop`) for each additional
instance. The `Deploy release to instance` workflow
uses the selected environment, so all host-specific variables and secrets are
resolved from that target. Add environment protection/reviewer approval where
appropriate.

Set these **environment variables** for each target:

| Variable               | Purpose                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_HOST`          | SSH-reachable bare-metal host IP or DNS name                                                                                                                                 |
| `DEPLOY_USER`          | Dedicated SSH/Compose deployment account                                                                                                                                     |
| `DEPLOY_PATH`          | Absolute, unique installation directory, e.g. `/opt/qsell` for the existing installation or `/opt/qsell/instances/new-shop`                                                  |
| `COMPOSE_PROJECT_NAME` | Unique Compose project/volume namespace. **Keep `qsell` for the already deployed installation** so its database and volumes are reused; use a fresh name for a new instance. |
| `PUBLIC_DOMAIN`        | Public hostname for this installation                                                                                                                                        |
| `EDGE_HTTP_PORT`       | Unused host-loopback TCP port routed by this hostname's Nginx vhost (e.g. `8080`, `8081`)                                                                                    |
| `GHCR_USERNAME`        | GitHub user allowed to pull the private GHCR images                                                                                                                          |

Set these **environment secrets** for each target:

| Secret                   | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `DEPLOY_SSH_PRIVATE_KEY` | Dedicated SSH key accepted by that host's deploy account |
| `DEPLOY_KNOWN_HOSTS`     | Pinned `known_hosts` entry for the host                  |
| `GHCR_READ_TOKEN`        | Fine-grained token with read access to the GHCR package  |

The workflow requires `DEPLOY_PATH/.env.runtime` and
`DEPLOY_PATH/secrets/postgres_password` to exist already. Keep both mode `600`.
Runtime secrets are never copied through GitHub Actions. Each instance must have
its own Postgres service and `DATABASE_URL` must use Compose host `db`, for
example `postgresql://qsell:<URL-ENCODED-PASSWORD>@db:5432/qsell`; put that same
instance-specific password in `secrets/postgres_password`. Do not share one
database between installs.

## Provision and deploy

1. Bootstrap each new Ubuntu host with `scripts/setup-server.sh`, add the
   deployment SSH key, and create the target directory, runtime env and Postgres
   secret. Multiple instances on one host need distinct directories, Compose
   project names, domains and `EDGE_HTTP_PORT`s.
2. Configure DNS and TLS/Nginx for the target domain. The first successful
   instance deployment writes
   `DEPLOY_PATH/deploy/nginx/<instance-id>.conf`; include this file inside that
   domain's HTTPS server block and reload Nginx.
3. After the release build succeeds, run GitHub Actions → **Deploy release to
   instance** on branch `release`. Enter the target Environment name and the
   full release commit SHA.
4. To deploy the same build elsewhere, start another run and choose the other
   Environment. Other installations are not changed by the deployment.

For the current server, preserve its deployed Compose identity by setting its
environment's `COMPOSE_PROJECT_NAME=qsell`, its existing deployment directory,
the current public domain, and port `8080`. This keeps its existing database
volume intact. A new server gets a separate environment, fresh project name,
fresh DB password/volume and its own domain/port.

## Dedicated key

`webfactory/ssh-agent` cannot unlock passphrase-protected keys. Use a dedicated
deployment key with no passphrase; do not use your personal SSH key. Install its
public half in the target deployment account's `authorized_keys` and store its
private half only in that target's GitHub Environment secret:

```sh
ssh-keygen -t ed25519 -a 100 -N '' -C 'qsell-github-actions' \
  -f ~/.ssh/qsell_actions_deploy
ssh-copy-id -i ~/.ssh/qsell_actions_deploy.pub <deploy-user>@<server-host>
ssh -i ~/.ssh/qsell_actions_deploy -o IdentitiesOnly=yes \
  <deploy-user>@<server-host> 'id -un'
```

Docker socket access is root-equivalent. Restrict deployment accounts to trusted
operators and protect GitHub Environments accordingly.
