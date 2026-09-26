# GitHub Secrets Configuration

Add these secrets to your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**

## Required Secrets (Production)

### Server Access
| Secret Name | Description | Example |
|-------------|-------------|---------|
| `SSH_PRIVATE_KEY` | Private key for SSH access to server | `-----BEGIN OPENSSH PRIVATE KEY-----...` |
| `SSH_KNOWN_HOSTS` | SSH known hosts for server | `169.58.182.30 ssh-ed25519 AAAAC3...` |

### Database
| Secret Name | Description | Example |
|-------------|-------------|---------|
| `POSTGRES_PASSWORD` | PostgreSQL superuser password | `secure_random_password_32_chars` |
| `REDIS_PASSWORD` | Redis AUTH password | `secure_random_password_32_chars` |

### Application Secrets
| Secret Name | Description | Example |
|-------------|-------------|---------|
| `NEXTAUTH_SECRET` | NextAuth.js secret (32+ chars) | `openssl rand -base64 32` |
| `JWT_SECRET` | JWT signing secret (32+ chars) | `openssl rand -base64 32` |
| `DATA_ENCRYPTION_KEY` | Payment data encryption key (32 bytes base64) | `openssl rand -base64 32` |
| `PAYMENT_DATA_KEY` | Payment credentials encryption key (32 bytes base64) | `openssl rand -base64 32` |
| `GRAFANA_PASSWORD` | Grafana admin password | `secure_password_16_chars` |

### Payment Providers (Production)
| Secret Name | Description |
|-------------|-------------|
| `MPESA_DARAJA_CONSUMER_KEY` | Safaricom Daraja consumer key |
| `MPESA_DARAJA_CONSUMER_SECRET` | Safaricom Daraja consumer secret |
| `MPESA_DARAJA_PASSKEY` | Safaricom Daraja passkey |
| `MPESA_DARAJA_SHORTCODE` | Safaricom Daraja shortcode (e.g., 174379) |
| `PESAPAL_CONSUMER_KEY` | Pesapal v3 consumer key |
| `PESAPAL_CONSUMER_SECRET` | Pesapal v3 consumer secret |
| `JENGA_CONSUMER_KEY` | Jenga HQ consumer key |
| `JENGA_CONSUMER_SECRET` | Jenga HQ consumer secret |
| `KCB_BUNI_CONSUMER_KEY` | KCB Buni consumer key |
| `KCB_BUNI_CONSUMER_SECRET` | KCB Buni consumer secret |

### Email & Storage
| Secret Name | Description |
|-------------|-------------|
| `EMAIL_SMTP_PASSWORD` | SendGrid/Mailgun SMTP password |
| `S3_ACCESS_KEY_ID` | AWS S3 / MinIO access key |
| `S3_SECRET_ACCESS_KEY` | AWS S3 / MinIO secret key |

### Cloudflare
| Secret Name | Description |
|-------------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Zone:DNS edit permissions |

---

## Generating Secrets

```bash
# Generate all secrets at once
cat << 'EOF'
# Run these commands locally and copy output to GitHub secrets

# PostgreSQL password (32 chars)
openssl rand -base64 32 | tr -d '\n'

# Redis password (32 chars)
openssl rand -base64 32 | tr -d '\n'

# NextAuth secret (32+ chars)
openssl rand -base64 32 | tr -d '\n'

# JWT secret (32+ chars)
openssl rand -base64 32 | tr -d '\n'

# Data encryption key (32 bytes base64)
openssl rand -base64 32 | tr -d '\n'

# Payment data key (32 bytes base64)
openssl rand -base64 32 | tr -d '\n'

# Grafana password (16 chars)
openssl rand -base64 16 | tr -d '\n'

# SSH key pair (run on your local machine)
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/qsell_deploy
# Add public key to server: ssh-copy-id creame@169.58.182.30
# Private key goes to SSH_PRIVATE_KEY secret
# Run: ssh-keyscan 169.58.182.30 >> ~/.ssh/known_hosts
# Then: cat ~/.ssh/known_hosts | grep 169.58.182.30
# That output goes to SSH_KNOWN_HOSTS secret
EOF
```

---

## Cloudflare Setup

1. **Add Domain**: Add `brainsporellc.com` to Cloudflare
2. **Create API Token**: 
   - Go to My Profile → API Tokens → Create Token
   - Permissions: Zone → DNS → Edit
   - Zone Resources: Include → Specific Zone → brainsporellc.com
3. **Add DNS Record**:
   - Type: A
   - Name: onmicommerce
   - IPv4: 169.58.182.30
   - Proxy: ✅ Proxied (orange cloud)

---

## Server Initial Setup

```bash
# On the server (169.58.182.30) as root:

# 1. Run server setup script
curl -fsSL https://raw.githubusercontent.com/kissingerbrian/qsell/main/scripts/setup-server.sh | bash

# 2. Switch to app user
su - creame

# 3. Clone repository
git clone https://github.com/kissingerbrian/qsell.git /opt/qsell/app

# 4. Copy docker-compose files
cp /opt/qsell/app/docker-compose.yml /opt/qsell/
cp /opt/qsell/app/docker-compose.prod.yml /opt/qsell/

# 4. Create secrets directory and files
mkdir -p /opt/qsell/secrets
chmod 700 /opt/qsell/secrets

# Create secret files (replace with actual values)
cat > /opt/qsell/secrets/postgres_password.txt << 'EOF'
your_postgres_password_here
EOF

cat > /opt/qsell/secrets/redis_password.txt << 'EOF'
your_redis_password_here
EOF

cat > /opt/qsell/secrets/nextjs_secrets.txt << 'EOF'
NEXTAUTH_SECRET=your_nextauth_secret
JWT_SECRET=your_jwt_secret
DATA_ENCRYPTION_KEY=your_encryption_key
PAYMENT_DATA_KEY=your_payment_key
EOF

cat > /opt/qsell/secrets/grafana_password.txt << 'EOF'
your_grafana_password
EOF

chmod 600 /opt/qsell/secrets/*.txt

# 5. Create .env file
cat > /opt/qsell/.env << 'EOF'
DOMAIN=onmicommerce.brainsporellc.com
POSTGRES_PASSWORD=your_postgres_password
REDIS_PASSWORD=your_redis_password
NEXTAUTH_SECRET=your_nextauth_secret
JWT_SECRET=your_jwt_secret
DATA_ENCRYPTION_KEY=your_encryption_key
PAYMENT_DATA_KEY=your_payment_key
EOF

# 6. Deploy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## SSL Certificate (Let's Encrypt)

```bash
# After DNS propagates (check with: dig onmicommerce.brainsporellc.com)
sudo certbot --nginx -d onmicommerce.brainsporellc.com

# Auto-renewal
sudo systemctl enable certbot.timer
sudo systemctl start certbot.timer
```

---

## Verify Deployment

```bash
# Health check
curl https://onmicommerce.brainsporellc.com/api/health

# Check services
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

# Logs
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f app
```

---

## Monitoring Access

- **Grafana**: http://server-ip:3001 (admin / grafana_password)
- **Prometheus**: http://server-ip:9090
- **App Health**: https://onmicommerce.brainsporellc.com/api/health
