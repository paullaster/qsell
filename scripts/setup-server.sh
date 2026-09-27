#!/usr/bin/env bash
# Bootstrap a clean Ubuntu 22.04/24.04/26.04 host for Compose deployment.
# Run as root. Add the deployment user's SSH public key separately.
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root (sudo $0)." >&2
  exit 1
fi

APP_USER="${APP_USER:-creame}"
APP_DIR="/opt/qsell"
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
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0700 "${APP_DIR}/secrets"

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "Docker Engine and Compose are ready. Deployment root: ${APP_DIR}"
echo "Provision .env.runtime and secrets/postgres_password before deployment."
echo "Add the deployment user's SSH public key and re-login for docker group access."
