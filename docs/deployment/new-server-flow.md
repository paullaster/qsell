# New-server deployment flow: summary

The full runbook is [DEPLOYMENT.md](../../DEPLOYMENT.md). This page summarises the
config-file-driven flow and what the scripts do.

## How it works

You fill in one file per server, `deploy/instances/<id>.env`, and every script reads
it. The template is `deploy/instance.env.example`; real copies are git-ignored.

- A value passed as an environment variable overrides the file.
- Defaults are derived from `INSTANCE_ID`:
  - directory: `$APP_DIR/instances/<id>` (`APP_DIR` defaults to `/opt/qsell`)
  - Compose project name: `qsell-<id>`
  - loopback port: `8080`
- There are no hardcoded users, IPs or domains.

| Step                                                      | Script                                                               | Where it runs              |
| --------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| Create the deploy key                                     | `configure-github-environment.sh --generate-key`                     | your laptop                |
| Bootstrap the host                                        | `setup-server.sh` (takes `APP_USER`, `APP_DIR` and `SSH_PUBLIC_KEY`) | server, as root            |
| Create the instance directory, secrets and `.env.runtime` | `provision-instance.sh`                                              | server, as the deploy user |
| Nginx, certificate and vhost                              | `setup-nginx-site.sh`                                                | server, as root            |
| Create the GitHub Environment (7 variables, 3 secrets)    | `configure-github-environment.sh`                                    | your laptop                |
| Deploy                                                    | the "Deploy release to instance" workflow (the SHA is optional)      | GitHub                     |
| Switch the site on                                        | `setup-nginx-site.sh --no-cert` (re-run after the first deploy)      | server, as root            |

## What `DEPLOYMENT.md` covers

- An architecture diagram.
- The full parameter table: what each value means, its rules, its default, and where
  it ends up in GitHub.
- One-time repository setup.
- Phases A to I for a new server, with a go-live checklist.
- The release flow, rollback behaviour and operations (logs, backups, adding a domain,
  decommissioning).
- A troubleshooting table covering the errors hit while setting up `san-marina`:
  - the missing `PUBLIC_DOMAIN` variable
  - the underscore in the instance id
  - the `MEDIA_DRIVER` typo
  - the locked-account `ssh-copy-id` problem
  - the unset `RELEASE_SHA`
  - the missing Nginx include

## Mistakes the scripts now prevent

- **Config checked before CI.** They validate your values with the same rules the
  deploy workflow uses, so a bad `INSTANCE_ID` or domain fails before you run anything
  on the server.
- **Secrets never overwritten.** `provision-instance.sh` refuses to replace an existing
  `.env.runtime` or Postgres password. Regenerating the password after the database
  volume exists would lock the app out of its own database.
- **Host key confirmed.** `configure-github-environment.sh` shows the host key
  fingerprint and asks you to confirm it before trusting it.
- **Key install fixed.** `SSH_PUBLIC_KEY` installs the deploy key directly. This
  replaces the `ssh-copy-id` step, which cannot work because the deploy account has a
  locked password.
- **Default deploy user changed.** `setup-server.sh` now defaults `APP_USER` to
  `deploy` (it was `creame`). Pass `APP_USER` explicitly if you relied on the old
  default.

## What was tested

- **Provisioning:** `provision-instance.sh` ran into a scratch directory.
  - It created the files with mode 600.
  - A second run left them untouched.
  - It rejected a bad instance id and a `https://` domain.
  - The Cloudinary variant warned about missing credentials.
  - `EXTRA_ENV_FILE` was appended.
- **Nginx and GitHub:** `setup-nginx-site.sh --dry-run` renders the vhost, and
  `configure-github-environment.sh --dry-run` printed the right `gh` calls.
- **A bug the tests caught:** an apostrophe broke the closing summary of
  `provision-instance.sh`. It is fixed.

## Not verified

- **Real server:** nothing has run on an actual server. The `apt` installs, the certbot
  webroot flow and the include swap in phase H follow the setup done by hand, but they
  are untested as scripts.
- **GitHub:** the `gh` writes (creating the Environment, setting variables and secrets)
  have only been dry-run.
- **Shellcheck:** not installed, so only `bash -n` was run.

On the next server, run `setup-nginx-site.sh --dry-run` first. It does not touch the
live `san-marina` instance.
