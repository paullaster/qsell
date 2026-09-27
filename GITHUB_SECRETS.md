# GitHub Actions deployment settings

The release workflow validates pull requests targeting `release`. A push to
`release` after merge publishes the app, worker, and migrator images to GHCR,
runs the migration image, then updates the Compose services by commit tag.

Set these **Actions variables** under repository Settings → Secrets and
variables → Actions → Variables:

| Variable | Value |
| --- | --- |
| `DEPLOY_HOST` | The production host IP or DNS name |
| `DEPLOY_USER` | SSH account created for deployment |
| `GHCR_USERNAME` | GitHub user that can read the GHCR package |

Set these **Actions secrets** under the same settings page:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_SSH_PRIVATE_KEY` | Private SSH key for the deployment account |
| `DEPLOY_KNOWN_HOSTS` | Pinned SSH `known_hosts` line for the host |
| `GHCR_READ_TOKEN` | Fine-grained GitHub token with read access to the GHCR package |

Application secrets stay on the host in `/opt/qsell/.env.runtime`; the Postgres
bootstrap password stays in `/opt/qsell/secrets/postgres_password`. The Actions
workflow does not write or print either file.

Generate unique values locally and keep them out of Git:

```sh
openssl rand -hex 32       # PostgreSQL password (URL-safe)
openssl rand -base64 32    # AUTH_SECRET
openssl rand -base64 32    # DATA_ENCRYPTION_KEY
openssl rand -base64 32    # PAYMENT_DATA_KEY
```

Use the PostgreSQL password both in the Postgres secret file and URL-encoded in
`DATABASE_URL` in `.env.runtime`. `GITHUB_SECRETS.md` does not contain working
credentials.
