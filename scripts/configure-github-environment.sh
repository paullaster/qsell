#!/usr/bin/env bash
# Create/update the GitHub Environment for ONE instance from its config file.
# Run on your own machine (needs the `gh` CLI, logged in with repo admin rights):
#   scripts/configure-github-environment.sh --config deploy/instances/new-shop.env --key-only
#   scripts/configure-github-environment.sh --config deploy/instances/new-shop.env [--yes] [--dry-run]
#
# --key-only      create the deploy key (if missing), print its PUBLIC half, and stop.
#                 Needs no network access and changes nothing on GitHub.
# --generate-key  like above, but then continue with the GitHub configuration.
#
# required: INSTANCE_ID PUBLIC_DOMAIN DEPLOY_HOST DEPLOY_USER GITHUB_REPO GHCR_USERNAME SSH_KEY_FILE
# optional: APP_DIR DEPLOY_PATH COMPOSE_PROJECT_NAME EDGE_HTTP_PORT
# secrets:  GHCR_READ_TOKEN (environment variable, otherwise prompted — never stored in the config file)
#
# Sets the 7 Environment variables and the 3 Environment secrets the deploy workflow needs
# and prints the host key fingerprint for you to confirm before it is trusted.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/lib/instance-config.sh"

parse_common_args "$@"
GENERATE_KEY=0; KEY_ONLY=0; ASSUME_YES=0; DRY_RUN=0
for a in "${REST_ARGS[@]}"; do
  case "$a" in
    --generate-key) GENERATE_KEY=1 ;; --key-only) KEY_ONLY=1; GENERATE_KEY=1 ;; --yes) ASSUME_YES=1 ;; --dry-run) DRY_RUN=1 ;;
    *) die "Unknown argument: $a" ;;
  esac
done

if ((KEY_ONLY)); then
  require_vars INSTANCE_ID SSH_KEY_FILE
  key="${SSH_KEY_FILE/#\~/$HOME}"
  if [[ -f "$key" ]]; then
    echo "Key already exists: $key (not overwritten)."
  else
    ssh-keygen -t ed25519 -a 100 -N '' -C "qsell-actions-$INSTANCE_ID" -f "$key"
  fi
  echo
  echo "PUBLIC key — give this to the server (SSH_PUBLIC_KEY='...' for scripts/setup-server.sh,"
  echo "or append it to ~<deploy user>/.ssh/authorized_keys):"
  echo
  cat "$key.pub"
  echo
  echo "Keep the private file ($key) on this machine; phase F uploads it to GitHub."
  exit 0
fi

require_vars INSTANCE_ID PUBLIC_DOMAIN DEPLOY_HOST DEPLOY_USER GITHUB_REPO GHCR_USERNAME SSH_KEY_FILE
derive_defaults
validate_instance_settings
[[ "$DEPLOY_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "DEPLOY_HOST must be a hostname or IPv4 address."
[[ "$DEPLOY_USER" =~ ^[A-Za-z0-9._-]+$ ]] || die "DEPLOY_USER has invalid characters."
[[ "$GITHUB_REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "GITHUB_REPO must look like owner/name."
key="${SSH_KEY_FILE/#\~/$HOME}"

command -v gh >/dev/null || die "Install the GitHub CLI (gh) and run 'gh auth login'."
command -v ssh-keyscan >/dev/null || die "ssh-keyscan (openssh-client) is required."

if [[ ! -f "$key" ]]; then
  ((GENERATE_KEY)) || die "SSH key $key not found. Pass --generate-key to create one."
  ((DRY_RUN)) || ssh-keygen -t ed25519 -a 100 -N '' -C "qsell-actions-$INSTANCE_ID" -f "$key"
  echo
  echo "Install this PUBLIC key on the host (SSH_PUBLIC_KEY=... when running scripts/setup-server.sh,"
  echo "or append it to ~$DEPLOY_USER/.ssh/authorized_keys):"
  ((DRY_RUN)) || cat "$key.pub"
  echo
fi

scan="$(ssh-keyscan -t ed25519 "$DEPLOY_HOST" 2>/dev/null | grep -v '^#' || true)"
[[ -n "$scan" ]] || die "Could not read an ed25519 host key from $DEPLOY_HOST (is it reachable on port 22?)."
echo "Host key fingerprint offered by $DEPLOY_HOST:"
echo "$scan" | ssh-keygen -lf -
echo "Verify it matches the host (on the server: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)."
if ((ASSUME_YES == 0 && DRY_RUN == 0)); then
  read -r -p "Trust this host key? [y/N] " ok
  [[ "$ok" =~ ^[Yy]$ ]] || die "Aborted."
fi

token="${GHCR_READ_TOKEN:-}"
if [[ -z "$token" && "$DRY_RUN" -eq 0 ]]; then
  read -r -s -p "GHCR read token (fine-grained, read:packages): " token; echo
fi
[[ -n "$token" || "$DRY_RUN" -eq 1 ]] || die "GHCR_READ_TOKEN is required."

run() { if ((DRY_RUN)); then echo "[dry-run] $*"; else "$@"; fi; }

info "Environment '$INSTANCE_ID' in $GITHUB_REPO"
run gh api -X PUT "repos/$GITHUB_REPO/environments/$INSTANCE_ID" --silent

set_var() { run gh variable set "$1" --env "$INSTANCE_ID" --repo "$GITHUB_REPO" --body "$2"; }
set_var DEPLOY_HOST "$DEPLOY_HOST"
set_var DEPLOY_USER "$DEPLOY_USER"
set_var DEPLOY_PATH "$DEPLOY_PATH"
set_var COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"
set_var PUBLIC_DOMAIN "$PUBLIC_DOMAIN"
set_var EDGE_HTTP_PORT "$EDGE_HTTP_PORT"
set_var GHCR_USERNAME "$GHCR_USERNAME"

set_secret_file() { # name, file
  if ((DRY_RUN)); then echo "[dry-run] gh secret set $1 --env $INSTANCE_ID < $2"
  else gh secret set "$1" --env "$INSTANCE_ID" --repo "$GITHUB_REPO" < "$2"; fi
}
if ((DRY_RUN)); then
  echo "[dry-run] would set secrets DEPLOY_SSH_PRIVATE_KEY, DEPLOY_KNOWN_HOSTS, GHCR_READ_TOKEN"
else
  set_secret_file DEPLOY_SSH_PRIVATE_KEY "$key"
  printf '%s\n' "$scan" | gh secret set DEPLOY_KNOWN_HOSTS --env "$INSTANCE_ID" --repo "$GITHUB_REPO"
  printf '%s' "$token" | gh secret set GHCR_READ_TOKEN --env "$INSTANCE_ID" --repo "$GITHUB_REPO"
fi

cat <<DONE

GitHub Environment '$INSTANCE_ID' is configured.
Remember the REPOSITORY-level variable SERVER_ACTION_ALLOWED_ORIGINS must include $PUBLIC_DOMAIN
(comma-separated list of every instance's domain) BEFORE the release build you deploy:
  gh variable list --repo $GITHUB_REPO
DONE
