#!/bin/bash
# =============================================================================
# Server Setup Script for qsell Production Deployment
# Run on fresh Ubuntu 22.04/24.04 server as root
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date +'%H:%M:%S')]${NC} $*"; }
error() { echo -e "${RED}[$(date +'%H:%M:%S')]${NC} $*"; }

# =============================================================================
# Configuration
# =============================================================================
SERVER_USER="creame"
DOMAIN="onmicommerce.brainsporellc.com"
DOCKER_COMPOSE_VERSION="v2.27.0"

# =============================================================================
# System Updates & Base Packages
# =============================================================================
log "Updating system packages..."
apt-get update && apt-get upgrade -y

log "Installing base packages..."
apt-get install -y \
    curl \
    wget \
    git \
    unzip \
    jq \
    htop \
    net-tools \
    ufw \
    fail2ban \
    certbot \
    python3-certbot-nginx \
    nginx \
    docker.io \
    docker-compose-plugin \
    postgresql-client \
    redis-tools \
    prometheus-node-exporter \
    grafana-agent \
    build-essential \
    libssl-dev \
    libpq-dev

# =============================================================================
# Docker & Buildx Setup
# =============================================================================
log "Configuring Docker..."
systemctl enable --now docker

# Enable Buildx
docker buildx create --name qsell-builder --use --bootstrap || true

# Configure Docker daemon for production
cat > /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "5"
  },
  "storage-driver": "overlay2",
  "max-concurrent-downloads": 10,
  "max-concurrent-uploads": 5,
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 64000,
      "Soft": 64000
    }
  },
  "live-restore": true,
  "userland-proxy": false
}
EOF

systemctl restart docker

# =============================================================================
# Create Application User
# =============================================================================
log "Creating application user: ${SERVER_USER}..."
if ! id "${SERVER_USER}" &>/dev/null; then
    useradd -m -s /bin/bash -G docker "${SERVER_USER}"
    echo "${SERVER_USER}:lckiki#nuks26" | chpasswd
    echo "${SERVER_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${SERVER_USER}
    chmod 440 /etc/sudoers.d/${SERVER_USER}
fi

# =============================================================================
# Firewall Configuration
# =============================================================================
log "Configuring firewall..."
ufw --force enable
ufw default deny incoming
ufw default allow outgoing

# SSH
ufw allow 22/tcp comment 'SSH'

# HTTP/HTTPS (Nginx)
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'

# Application (internal only - behind nginx)
ufw allow from 127.0.0.1 to any port 3069 comment 'Next.js App'
ufw allow from 127.0.0.1 to any port 3001 comment 'Grafana'
ufw allow from 127.0.0.1 to any port 9090 comment 'Prometheus'

# PostgreSQL (internal only)
ufw allow from 127.0.0.1 to any port 5434 comment 'PostgreSQL'

# Redis (internal only)
ufw allow from 127.0.0.1 to any port 6379 comment 'Redis'

# Docker Swarm (if clustering)
ufw allow 2377/tcp comment 'Docker Swarm'
ufw allow 7946/tcp comment 'Docker Swarm'
ufw allow 7946/udp comment 'Docker Swarm'
ufw allow 4789/udp comment 'Docker Swarm'

log "Firewall configured"

# =============================================================================
# Fail2Ban Configuration
# =============================================================================
log "Configuring Fail2Ban..."
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5
backend = systemd

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
port = http,https
logpath = /var/log/nginx/error.log

[nginx-limit-req]
enabled = true
filter = nginx-limit-req
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 10

[nginx-botsearch]
enabled = true
filter = nginx-botsearch
port = http,https
logpath = /var/log/nginx/access.log
maxretry = 2
EOF

systemctl enable --now fail2ban

# =============================================================================
# System Limits & Kernel Tuning
# =============================================================================
log "Configuring system limits..."
cat > /etc/security/limits.d/qsell.conf << 'EOF'
# Increase file descriptor limits
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535

# Memory locking
* soft memlock unlimited
* hard memlock unlimited
EOF

cat > /etc/sysctl.d/99-qsell.conf << 'EOF'
# Network tuning for high traffic
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_max_tw_buckets = 2000000
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.ip_local_port_range = 1024 65535

# Memory management
vm.swappiness = 10
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
vm.overcommit_memory = 1

# File system
fs.file-max = 1000000
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288
EOF

sysctl --system

# =============================================================================
# Nginx Configuration (SSL termination + load balancing)
# =============================================================================
log "Configuring Nginx..."
mkdir -p /etc/nginx/ssl /etc/nginx/conf.d /var/cache/nginx /var/log/nginx

# Generate self-signed cert for initial setup (replace with Let's Encrypt later)
if [ ! -f /etc/nginx/ssl/fullchain.pem ]; then
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout /etc/nginx/ssl/privkey.pem \
        -out /etc/nginx/ssl/fullchain.pem \
        -subj "/CN=onmicommerce.brainsporellc.com" \
        -addext "subjectAltName=DNS:onmicommerce.brainsporellc.com"
fi

# Main nginx config (already in repo - deploy from repo)
systemctl enable --now nginx

# =============================================================================
# Swap File (for memory safety)
# =============================================================================
log "Creating swap file..."
if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# =============================================================================
# Create Application Directory Structure
# =============================================================================
log "Creating application directories..."
mkdir -p /opt/qsell/{secrets,backups,logs}
chown -R ${SERVER_USER}:${SERVER_USER} /opt/qsell
chmod 700 /opt/qsell/secrets

# =============================================================================
# Log Rotation
# =============================================================================
cat > /etc/logrotate.d/qsell << 'EOF'
/opt/qsell/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 640 creame creame
    sharedscripts
    postrotate
        docker compose -f /opt/qsell/docker-compose.prod.yml kill -s USR1 nginx 2>/dev/null || true
    endscript
}

/var/log/nginx/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 640 www-data www-data
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 `cat /var/run/nginx.pid`
    endscript
}
EOF

# =============================================================================
# Monitoring: Node Exporter
# =============================================================================
log "Setting up Node Exporter..."
cat > /etc/systemd/system/node_exporter.service << 'EOF'
[Unit]
Description=Prometheus Node Exporter
After=network.target

[Service]
User=prometheus
Group=prometheus
Type=simple
ExecStart=/usr/bin/node_exporter \
    --collector.systemd \
    --collector.processes \
    --collector.diskstats \
    --collector.filesystem \
    --collector.netdev \
    --collector.netclass \
    --collector.meminfo \
    --collector.cpu \
    --collector.loadavg \
    --collector.filefd \
    --collector.uname \
    --collector.time \
    --collector.thermal_zone \
    --web.listen-address=:9100
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

useradd -r -s /bin/false prometheus 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now node_exporter

# =============================================================================
# Grafana Agent (metrics + logs)
# =============================================================================
log "Setting up Grafana Agent..."
cat > /etc/grafana-agent.yaml << 'EOF'
server:
  log_level: info
  http_listen_port: 12345

metrics:
  wal_directory: /tmp/grafana-agent-wal
  global:
    scrape_interval: 15s
    remote_write:
      - url: http://prometheus:9090/api/v1/write

  configs:
    - name: integrations
      scrape_configs:
        - job_name: 'node_exporter'
          static_configs:
            - targets: ['localhost:9100']
        - job_name: 'nginx'
          static_configs:
            - targets: ['localhost:8080']
        - job_name: 'postgres'
          static_configs:
            - targets: ['localhost:9187']
        - job_name: 'redis'
          static_configs:
            - targets: ['localhost:9121']

integrations:
  node_exporter:
    enabled: true
  nginx:
    enabled: true
    exporter:
      enabled: true
      stub_status_endpoint: http://localhost:8080/stub_status
  postgres_exporter:
    enabled: true
    datasource_names:
      - qsell
    exporter:
      enabled: true
      extend_query_path: /etc/grafana-agent/postgres-queries.yaml
  redis_exporter:
    enabled: true
    exporter:
      enabled: true
      redis_addr: redis://localhost:6379
EOF

# =============================================================================
# PostgreSQL Exporter Queries
# =============================================================================
mkdir -p /etc/grafana-agent
cat > /etc/grafana-agent/postgres-queries.yaml << 'EOF'
queries:
  - name: pg_stat_database
    query: |
      SELECT datname, numbackends, xact_commit, xact_rollback,
             blks_read, blks_hit, tup_returned, tup_fetched,
             tup_inserted, tup_updated, tup_deleted, conflicts,
             temp_files, temp_bytes, deadlocks, blk_read_time, blk_write_time
      FROM pg_stat_database
      WHERE datname = 'qsell'
    metrics:
      - datname:
          usage: LABEL
      - numbackends:
          usage: GAUGE
      - xact_commit:
          usage: COUNTER
      - xact_rollback:
          usage: COUNTER
      - blks_read:
          usage: COUNTER
      - blks_hit:
          usage: COUNTER

  - name: pg_stat_statements
    query: |
      SELECT queryid, query, calls, total_exec_time, mean_exec_time,
             rows, shared_blks_hit, shared_blks_read, shared_blks_dirtied,
             shared_blks_written, local_blks_hit, local_blks_read,
             local_blks_dirtied, local_blks_written, temp_blks_read, temp_blks_written
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'qsell')
      ORDER BY total_exec_time DESC
      LIMIT 20
    metrics:
      - queryid:
          usage: LABEL
      - query:
          usage: LABEL
      - calls:
          usage: COUNTER
      - total_exec_time:
          usage: COUNTER
      - mean_exec_time:
          usage: GAUGE
EOF

# =============================================================================
# Backup Cron Job
# =============================================================================
cat > /etc/cron.d/qsell-backup << 'EOF'
# Daily database backup at 2 AM
0 2 * * * root docker exec qsell-postgres-prod pg_dump -U qsell qsell | gzip > /opt/qsell/backups/qsell_$(date +\%F).sql.gz

# Weekly full backup (Sunday 3 AM)
0 3 * * 0 root tar -czf /opt/qsell/backups/qsell_full_$(date +\%F).tar.gz /opt/qsell --exclude=/opt/qsell/backups --exclude=/opt/qsell/secrets

# Cleanup old backups (keep 30 days daily, 12 weeks weekly)
0 4 * * * root find /opt/qsell/backups -name "qsell_*.sql.gz" -mtime +30 -delete
0 4 * * 0 root find /opt/qsell/backups -name "qsell_full_*.tar.gz" -mtime +84 -delete
EOF

# =============================================================================
# Prometheus Alert Rules
# =============================================================================
mkdir -p /etc/prometheus/rules
cat > /etc/prometheus/rules/qsell.yml << 'EOF'
groups:
  - name: qsell-alerts
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }} on {{ $labels.instance }}"

      - alert: HighLatency
        expr: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, instance)) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High latency detected"
          description: "P95 latency is {{ $value }}s on {{ $labels.instance }}"

      - alert: DatabaseConnectionsHigh
        expr: pg_stat_database_numbackends / pg_settings_max_connections > 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Database connections high"
          description: "{{ $value | humanizePercentage }} of max connections used"

      - alert: RedisMemoryHigh
        expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Redis memory usage high"
          description: "Redis memory at {{ $value | humanizePercentage }}"

      - alert: DiskSpaceLow
        expr: (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) < 0.15
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Disk space low"
          description: "Only {{ $value | humanizePercentage }} disk space remaining"

      - alert: ContainerRestartLoop
        expr: increase(container_restart_count[15m]) > 3
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Container restart loop detected"
          description: "{{ $labels.name }} restarted {{ $value }} times in 15 minutes"
EOF

# =============================================================================
# Final Steps
# =============================================================================
log "Setting up Docker Swarm (single node mode)..."
docker swarm init --advertise-addr $(curl -s ifconfig.me) 2>/dev/null || true

log "Setting up Docker Compose alias..."
echo 'alias dc="docker compose"' >> /home/${SERVER_USER}/.bashrc
echo 'alias dcp="docker compose -f docker-compose.yml -f docker-compose.prod.yml"' >> /home/${SERVER_USER}/.bashrc

log "Creating MOTD..."
cat > /etc/motd << 'EOF'

╔════════════════════════════════════════════════════════════════════════════╗
║                         qsell Production Server                              ║
║                                                                            ║
║  Domain: onmicommerce.brainsporellc.com                                    ║
║  App Port: 3069 (internal)                                                 ║
║  Nginx: 80/443 (SSL termination)                                           ║
║  PostgreSQL: 5434 (internal)                                               ║
║  Redis: 6379 (internal)                                                    ║
║                                                                            ║
║  Commands:                                                                 ║
║    dc ps                    - List containers                              ║
║    dc logs -f app           - Follow app logs                              ║
║    dc exec app pnpm db:studio - Open Drizzle Studio                        ║
║    dcp up -d                - Deploy updates                               ║
║    dcp ps                   - Check service status                         ║
║                                                                            ║
║  Logs: /opt/qsell/logs/                                                    ║
║  Backups: /opt/qsell/backups/                                              ║
╚════════════════════════════════════════════════════════════════════════════╝

EOF

log "Server setup complete!"
log ""
log "Next steps:"
log "1. Switch to ${SERVER_USER}: su - ${SERVER_USER}"
log "2. Clone repo: git clone https://github.com/kissingerbrian/qsell.git /opt/qsell/app"
log "3. Copy docker-compose files to /opt/qsell/"
log "4. Configure secrets in /opt/qsell/secrets/"
log "5. Run: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d"
log ""
warn "Remember to:"
warn "1. Configure Cloudflare DNS for ${DOMAIN}"
warn "2. Set up Let's Encrypt: certbot --nginx -d onmicommerce.brainsporellc.com"
warn "3. Add GitHub secrets for CI/CD deployment"
warn "4. Test deployment: curl https://${DOMAIN}/api/health"

