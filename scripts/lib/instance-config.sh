#!/usr/bin/env bash
# Shared helpers for the instance scripts. Source this file; do not execute it.
#
# One config file describes one installation (see deploy/instance.env.example).
# Every value can also be supplied as an environment variable, which wins over
# the file, so CI and one-off runs need no file at all.

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# load_config <file>  — read KEY=VALUE lines without executing anything in them.
# Values already present in the environment take precedence.
load_config() {
  local file="$1" line key value
  [[ -f "$file" ]] || die "Config file not found: $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"                       # strip comments
    line="${line#"${line%%[![:space:]]*}"}"  # trim leading space
    line="${line%"${line##*[![:space:]]}"}"  # trim trailing space
    [[ -z "$line" ]] && continue
    [[ "$line" == *=* ]] || die "$file: not KEY=VALUE: $line"
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "$file: invalid variable name: $key"
    value="${value#\"}"; value="${value%\"}"
    value="${value#\'}"; value="${value%\'}"
    if [[ -z "${!key+x}" ]]; then printf -v "$key" '%s' "$value"; export "$key"; fi
  done < "$file"
}

# parse_common_args "$@" — handles --config FILE and leaves other flags in REST_ARGS.
parse_common_args() {
  REST_ARGS=()
  CONFIG_FILE="${CONFIG_FILE:-}"
  while (($#)); do
    case "$1" in
      --config) [[ $# -ge 2 ]] || die "--config needs a file"; CONFIG_FILE="$2"; shift 2 ;;
      --config=*) CONFIG_FILE="${1#--config=}"; shift ;;
      *) REST_ARGS+=("$1"); shift ;;
    esac
  done
  if [[ -n "$CONFIG_FILE" ]]; then load_config "$CONFIG_FILE"; fi
}

require_vars() {
  local missing=() v
  for v in "$@"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
  ((${#missing[@]} == 0)) || die "Missing required setting(s): ${missing[*]} (set in the config file or environment)"
}

# Derive defaults, then validate with the SAME rules the deploy workflow enforces,
# so a bad value is caught here instead of in a failed Actions run.
derive_defaults() {
  APP_DIR="${APP_DIR:-/opt/qsell}"
  EDGE_HTTP_PORT="${EDGE_HTTP_PORT:-8080}"
  MEDIA_DRIVER="${MEDIA_DRIVER:-local}"
  if [[ -n "${INSTANCE_ID:-}" ]]; then
    DEPLOY_PATH="${DEPLOY_PATH:-$APP_DIR/instances/$INSTANCE_ID}"
    COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-qsell-$INSTANCE_ID}"
  fi
  export APP_DIR EDGE_HTTP_PORT MEDIA_DRIVER DEPLOY_PATH COMPOSE_PROJECT_NAME
}

validate_instance_settings() {
  [[ "${INSTANCE_ID:-}" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] \
    || die "INSTANCE_ID must be lowercase letters, digits and hyphens (max 40), e.g. new-shop."
  [[ "${PUBLIC_DOMAIN:-}" =~ ^[A-Za-z0-9.-]+$ ]] \
    || die "PUBLIC_DOMAIN must be a bare hostname such as shop.example.com (no scheme, slash or port)."
  [[ "${DEPLOY_PATH:-}" =~ ^/[A-Za-z0-9/_-]+$ ]] \
    || die "DEPLOY_PATH must be an absolute path of letters, digits, / _ and - only."
  [[ "${EDGE_HTTP_PORT:-}" =~ ^[0-9]{2,5}$ ]] && ((EDGE_HTTP_PORT >= 1024 && EDGE_HTTP_PORT <= 65535)) \
    || die "EDGE_HTTP_PORT must be a TCP port between 1024 and 65535."
  [[ "${COMPOSE_PROJECT_NAME:-}" =~ ^[a-z0-9][a-z0-9_-]{0,49}$ ]] \
    || die "COMPOSE_PROJECT_NAME must be lowercase letters, digits, _ and -."
  case "${MEDIA_DRIVER,,}" in local|cloudinary) ;; *) die "MEDIA_DRIVER must be 'local' or 'cloudinary'." ;; esac
}
