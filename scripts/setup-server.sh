#!/usr/bin/env bash
# Bootstrap a clean Ubuntu 22.04/24.04/26.04 host for Compose deployment.
# Run as root. Settings (all optional, pass as environment variables):
#   APP_USER             deploy account to create            (default: deploy)
#   APP_DIR              root directory for installations    (default: /opt/qsell)
#   SSH_PUBLIC_KEY       public key line to authorise for APP_USER
#   SSH_PUBLIC_KEY_FILE  file containing that public key line
# The account has a locked password, so ssh-copy-id cannot work: pass the key here,
# or append it to ~APP_USER/.ssh/authorized_keys yourself.
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root (sudo $0)." >&2
  exit 1
fi

APP_USER="${APP_USER:-deploy}"
APP_DIR="${APP_DIR:-/opt/qsell}"
if [[ ! "${APP_USER}" =~ ^[a-z_][a-z0-9_-]{0,30}$ || ! "${APP_DIR}" =~ ^/[A-Za-z0-9/_-]+$ ]]; then
  echo "Invalid APP_USER or APP_DIR." >&2
  exit 1
fi
source /etc/os-release

if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "This bootstrap currently supports Ubuntu only." >&2
  exit 1
fi
case "${VERSION_ID:-}" in
  22.04|24.04|26.04) ;;
  *)
    echo "Unsupported Ubuntu release: ${VERSION_ID:-unknown} (expected 22.04, 24.04, or 26.04)." >&2
    exit 1
    ;;
esac

apt-get update
apt-get install -y ca-certificates curl ufw

# Install current Docker Engine, Compose v2, and Buildx from Docker's apt repo.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "local",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  },
  "live-restore": true
}
EOF
systemctl enable --now docker
systemctl restart docker

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${APP_USER}"
  passwd --lock "${APP_USER}"
fi
usermod -aG docker "${APP_USER}"

# Docker socket access is root-equivalent. Use this account only for deploys;
# do not set a password or grant passwordless sudo here.
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${APP_DIR}"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${APP_DIR}/instances"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0700 "${APP_DIR}/secrets"

# Authorise the deployment key (never needs a password on the account).
PUBKEY="${SSH_PUBLIC_KEY:-}"
if [[ -z "${PUBKEY}" && -n "${SSH_PUBLIC_KEY_FILE:-}" ]]; then PUBKEY="$(head -n 1 "${SSH_PUBLIC_KEY_FILE}")"; fi
if [[ -n "${PUBKEY}" ]]; then
  [[ "${PUBKEY}" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+)\  ]] || { echo "SSH public key is not a valid single key line." >&2; exit 1; }
  home="$(getent passwd "${APP_USER}" | cut -d: -f6)"
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0700 "${home}/.ssh"
  touch "${home}/.ssh/authorized_keys"
  grep -qxF "${PUBKEY}" "${home}/.ssh/authorized_keys" || printf '%s\n' "${PUBKEY}" >> "${home}/.ssh/authorized_keys"
  chown "${APP_USER}:${APP_USER}" "${home}/.ssh/authorized_keys"
  chmod 600 "${home}/.ssh/authorized_keys"
  echo "Authorised the supplied SSH key for ${APP_USER}."
fi

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "Docker Engine and Compose are ready. Deployment root: ${APP_DIR}"
echo "Next: run scripts/provision-instance.sh as ${APP_USER} for each installation."
echo "If you did not pass SSH_PUBLIC_KEY, add the deploy key to ~${APP_USER}/.ssh/authorized_keys."
