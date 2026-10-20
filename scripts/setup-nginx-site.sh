#!/usr/bin/env bash
# Install Nginx + certbot, obtain a certificate and write the vhost for ONE instance.
# Run on the host as root:
#   sudo scripts/setup-nginx-site.sh --config deploy/instances/new-shop.env
#
# required: INSTANCE_ID  PUBLIC_DOMAIN  CERT_EMAIL        optional: APP_DIR DEPLOY_PATH
# Flags:    --dry-run   print the vhost and exit (no root, no changes)
#           --no-cert   skip certbot (certificate already exists)
#
# Safe to re-run. Before the first deploy the vhost answers 503 on "/". Once the deploy
# has generated <DEPLOY_PATH>/deploy/nginx/<INSTANCE_ID>.conf, running this script again
# switches the vhost to include it, validates with `nginx -t`, and reloads.
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/lib/instance-config.sh"

parse_common_args "$@"
DRY_RUN=0; NO_CERT=0
for a in "${REST_ARGS[@]}"; do
  case "$a" in --dry-run) DRY_RUN=1 ;; --no-cert) NO_CERT=1 ;; *) die "Unknown argument: $a" ;; esac
done

require_vars INSTANCE_ID PUBLIC_DOMAIN
derive_defaults
validate_instance_settings

snippet="$DEPLOY_PATH/deploy/nginx/$INSTANCE_ID.conf"
live_dir="/etc/letsencrypt/live/$PUBLIC_DOMAIN"
site="/etc/nginx/sites-available/$INSTANCE_ID"

# True when this nginx understands "http2 on;" (1.25.1+). Unknown or not yet installed
# (e.g. --dry-run) counts as modern; only a detected older version takes the legacy form.
nginx_has_http2_directive() {
  local v
  v="$(nginx -v 2>&1 | sed -n 's|.*nginx/\([0-9][0-9.]*\).*|\1|p')"
  [[ -n "$v" ]] || return 0
  [[ "$(printf '%s\n1.25.1\n' "$v" | sort -V | head -n1)" == "1.25.1" ]]
}

render_vhost() {
  if [[ -f "$snippet" ]]; then
    app_block="    include $snippet;"
  else
    app_block="    # Not deployed yet: re-run this script after the first deploy to enable the app.
    location / { return 503; }"
  fi
  # nginx before 1.25.1 (Ubuntu 20.04 ships 1.18) has no standalone "http2" directive.
  local listen_443
  if nginx_has_http2_directive; then
    listen_443="    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;"
  else
    listen_443="    listen 443 ssl http2;
    listen [::]:443 ssl http2;"
  fi
  cat <<VHOST
# Managed by scripts/setup-nginx-site.sh for instance "$INSTANCE_ID". Re-run the script to change.
server {
    listen 80;
    listen [::]:80;
    server_name $PUBLIC_DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
$listen_443
    server_name $PUBLIC_DOMAIN;
    ssl_certificate     $live_dir/fullchain.pem;
    ssl_certificate_key $live_dir/privkey.pem;
$app_block
}
VHOST
}

if ((DRY_RUN)); then render_vhost; exit 0; fi
[[ "${EUID}" -eq 0 ]] || die "Run as root (sudo $0 ...)."
require_vars CERT_EMAIL

if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then
  info "Installing nginx and certbot"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot
fi
systemctl enable --now nginx

# The cert needs port 80 reachable and DNS pointing here. Fail early with a clear message.
if ((NO_CERT == 0)) && [[ ! -d "$live_dir" ]]; then
  resolved="$(getent hosts "$PUBLIC_DOMAIN" | awk '{print $1; exit}' || true)"
  [[ -n "$resolved" ]] || die "$PUBLIC_DOMAIN does not resolve yet. Create the DNS record first (Cloudflare: DNS-only until the cert is issued)."
  info "$PUBLIC_DOMAIN resolves to $resolved (confirm this host's public IP matches)."
  install -d /var/www/html
  # Webroot challenge through the stock nginx site on port 80; no vhost needed yet.
  certbot certonly --webroot -w /var/www/html -d "$PUBLIC_DOMAIN" \
    --non-interactive --agree-tos -m "$CERT_EMAIL"
fi
[[ -d "$live_dir" ]] || die "No certificate at $live_dir. Issue one, or fix DNS and re-run."

render_vhost > "$site"
ln -sf "$site" "/etc/nginx/sites-enabled/$INSTANCE_ID"
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

if [[ -f "$snippet" ]]; then
  info "Done. $PUBLIC_DOMAIN now proxies to 127.0.0.1:$EDGE_HTTP_PORT via $snippet"
else
  info "Done. $PUBLIC_DOMAIN answers 503 until the first deploy; then re-run this script."
fi
