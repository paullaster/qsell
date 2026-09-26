# qsell Docker Deployment Guide

## Quick Start (Development)

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Generate secure passwords
# Edit .env with your secure passwords

# 3. Start development stack
docker compose up -d

# 4. Run migrations
docker compose exec app pnpm db:migrate:deploy

# 5. Start dev server
docker compose exec app pnpm dev
```

## Production Deployment

### Prerequisites

- Docker 24+ with Buildx
- Docker Compose v2+
- Swarm mode enabled (for multi-replica deployment)
- SSL certificates (Let's Encrypt recommended)

### Secrets Setup

```bash
# Create secrets directory
mkdir -p secrets

# Generate secure passwords
openssl rand -base64 32 > secrets/postgres_password.txt
openssl rand -base64 32 > secrets/redis_password.txt
openssl rand -base64 32 > secrets/nextjs_secrets.txt
openssl rand -base64 16 > secrets/grafana_password.txt

# Set permissions
chmod 600 secrets/*.txt
```

### Build & Deploy

```bash
# 1. Build production image
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

# 2. Deploy stack (Swarm mode required)
docker swarm init
docker stack deploy -c docker-compose.yml -c docker-compose.prod.yml qsell

# 3. Verify deployment
docker stack services qsell
docker stack ps qsell
```

### SSL Certificates

```bash
# Using Let's Encrypt with certbot
sudo certbot certonly --standalone -d qsell.com -d www.qsell.com

# Copy to nginx ssl directory
sudo cp /etc/letsencrypt/live/qsell.com/fullchain.pem docker/nginx/ssl/
sudo cp /etc/letsencrypt/live/qsell.com/privkey.pem docker/nginx/ssl/
sudo cp /etc/letsencrypt/live/qsell.com/chain.pem docker/nginx/ssl/
sudo chown -R $USER:$USER docker/nginx/ssl/
```

### Scale Services

```bash
# Scale app replicas
docker service scale qsell_app=6

# Scale workers
docker service scale qsell_worker=4
```

## Architecture

```
                    ┌─────────────────┐
                    │   Cloudflare/   │
                    │     CDN/WAF     │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │     Nginx       │
                    │  (SSL + LB)     │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         ┌─────────┐  ┌─────────┐  ┌─────────┐
         │ App #1  │  │ App #2  │  │ App #3  │
         │ (Next.js)│  │ (Next.js)│  │ (Next.js)│
         └────┬────┘  └────┬────┘  └────┬────┘
              │             │             │
              └─────────────┼─────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌─────────┐  ┌─────────┐  ┌─────────┐
         │PostgreSQL│  │  Redis  │  │ Worker  │
         │ (Primary)│  │ (Cache) │  │(x2)     │
         └─────────┘  └─────────┘  └─────────┘
```

## Monitoring

Access Grafana at `http://server:3001` (internal only)
Access Prometheus at `http://server:9090` (internal only)

Key metrics to watch:
- HTTP request latency (p50, p95, p99)
- Error rate by endpoint
- Database connection pool usage
- Redis memory usage
- Queue depth (Graphile Worker)
- Container CPU/Memory

## Backup Strategy

```bash
# Automated daily backup (add to crontab)
0 2 * * * docker exec qsell-postgres-prod pg_dump -U qsell qsell | gzip > /backups/qsell_$(date +\%F).sql.gz

# Retain 30 days
find /backups -name "qsell_*.sql.gz" -mtime +30 -delete
```

## Troubleshooting

### Check Logs

```bash
# Application logs
docker service logs -f qsell_app

# Worker logs
docker service logs -f qsell_worker

# Nginx logs
docker service logs -f qsell_nginx
```

### Database Issues

```bash
# Connect to postgres
docker exec -it $(docker ps -qf name=qsell-postgres) psql -U qsell -d qsell

# Check connections
SELECT count(*) FROM pg_stat_activity;

# Kill idle connections
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND state_change < now() - interval '5 minutes';
```

### Redis Issues

```bash
# Connect to redis
docker exec -it $(docker ps -qf name=qsell-redis) redis-cli

# Check memory
INFO memory

# Flush cache (careful!)
FLUSHALL
```

## Performance Tuning

### PostgreSQL

Key settings in `docker-compose.prod.yml`:
- `shared_buffers=1GB` (25% of RAM)
- `effective_cache_size=3GB` (75% of RAM)
- `work_mem=8MB`
- `maintenance_work_mem=256MB`
- `max_connections=500`

### Next.js

- Use `output: 'standalone'` in next.config.js
- Enable ISR for dynamic pages
- Configure `images.remotePatterns` for external images
- Set `poweredByHeader: false`

### Nginx

- `worker_processes auto`
- `worker_connections 8192`
- `proxy_cache` for static assets
- Rate limiting per endpoint type

## Security Checklist

- [ ] All secrets in Docker secrets (not env files)
- [ ] TLS 1.2+ only, strong ciphers
- [ ] HSTS header enabled
- [ ] CSP header configured
- [ ] Rate limiting on all endpoints
- [ ] Database passwords rotated quarterly
- [ ] Redis AUTH enabled
- [ ] Non-root containers
- [ ] Read-only root filesystem where possible
- [ ] Regular vulnerability scanning (`docker scout cves`)

## Rollback Procedure

```bash
# Quick rollback to previous image
docker service update --image qsell/app:v1.2.3 qsell_app

# Or using docker stack
docker stack deploy -c docker-compose.prod.yml qsell
```
