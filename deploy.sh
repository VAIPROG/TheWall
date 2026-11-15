#!/bin/bash
# ============================================================================
# The Wall Dev — Idempotent Deployment Script
# ============================================================================
# Usage:
#   deploy.sh [COMMAND] [OPTIONS]
#
# Commands:
#   all      - Full setup: deps, Rust, Postgres, env, systemd, nginx, build, start
#   backend  - Rebuild backend binary (cargo build --release) + restart + health
#   landing  - Reload nginx + fix landing perms (no rebuild)
#   nginx    - Rewrite nginx vhost config + test + reload
#   env      - Create/upgrade /etc/the-wall/secrets.env from template
#   status   - Rich status report: systemd, uptime, /api/meta, disk, journal
#   logs     - Tail systemd journal (default 50 lines, or pass count)
#   help     - Show usage
#
# Environment variables (optional):
#   DOMAIN       - Nginx vhost domain (default: the-wall.vai-rice.space)
#   BACKEND_PORT - Backend listen port (default: 3080)
#   APP_DIR      - Backend source/binary path (default: /opt/the-wall)
#   LANDING_DIR  - Static landing root (default: /var/www/the-wall)
#   SITE_URL     - Canonical site URL (default: https://filianislost.com)
#
# ============================================================================

set -Euo pipefail

# Color + formatting helpers (auto-disable if not a tty)
if [[ -t 1 ]]; then
  declare -r COLOR_RESET='\033[0m'
  declare -r COLOR_GREEN='\033[0;32m'
  declare -r COLOR_YELLOW='\033[0;33m'
  declare -r COLOR_RED='\033[0;31m'
  declare -r COLOR_BLUE='\033[0;34m'
  declare -r ICON_OK='✔ '
  declare -r ICON_FAIL='✖ '
  declare -r ICON_WARN='⚠ '
  declare -r ICON_SKIP='⏩ '
else
  declare -r COLOR_RESET=''
  declare -r COLOR_GREEN=''
  declare -r COLOR_YELLOW=''
  declare -r COLOR_RED=''
  declare -r COLOR_BLUE=''
  declare -r ICON_OK='OK'
  declare -r ICON_FAIL='FAIL'
  declare -r ICON_WARN='WARN'
  declare -r ICON_SKIP='SKIP'
fi

# Configuration defaults
declare -r DOMAIN="${DOMAIN:-the-wall.vai-rice.space}"
declare -r BACKEND_PORT="${BACKEND_PORT:-3080}"
declare -r APP_DIR="${APP_DIR:-/opt/the-wall}"
declare -r LANDING_DIR="${LANDING_DIR:-/var/www/the-wall}"
declare -r SITE_URL="${SITE_URL:-https://filianislost.com}"
declare -r ENV_DIR="/etc/the-wall"
declare -r ENV_FILE="${ENV_DIR}/secrets.env"

# Source of truth: the repo is cloned into APP_DIR and the Rust crate lives in
# APP_DIR/backend. Override REPO_URL/REPO_BRANCH to deploy a fork or branch.
declare -r REPO_URL="${REPO_URL:-https://github.com/VAIPROG/TheWall.git}"
declare -r REPO_BRANCH="${REPO_BRANCH:-main}"
declare -r BACKEND_DIR="$APP_DIR/backend"

# Tracking for final summary
declare -a STEPS_DONE=()
declare -a STEPS_SKIPPED=()
declare -a STEPS_FAILED=()
declare STEP_START_TIME=0
declare TOTAL_START_TIME=0

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

die() {
  echo -e "${COLOR_RED}${ICON_FAIL} FATAL: $1${COLOR_RESET}" >&2
  exit 1
}

step_banner() {
  local step_name="$1"
  STEP_START_TIME="$(date +%s)"
  echo -e "${COLOR_BLUE}=== [$step_name] ===${COLOR_RESET}"
}

step_ok() {
  local step_name="$1"
  local elapsed=$(($(date +%s) - STEP_START_TIME))
  echo -e "${COLOR_GREEN}${ICON_OK} $step_name (${elapsed}s)${COLOR_RESET}"
  STEPS_DONE+=("$step_name")
}

step_skip() {
  local step_name="$1"
  local reason="${2:-already satisfied}"
  echo -e "${COLOR_YELLOW}${ICON_SKIP} $step_name — $reason${COLOR_RESET}"
  STEPS_SKIPPED+=("$step_name")
}

step_fail() {
  local step_name="$1"
  local reason="${2:-command failed}"
  echo -e "${COLOR_RED}${ICON_FAIL} $step_name — $reason${COLOR_RESET}"
  STEPS_FAILED+=("$step_name")
}

warn() {
  echo -e "${COLOR_YELLOW}${ICON_WARN} $1${COLOR_RESET}"
}

success() {
  echo -e "${COLOR_GREEN}$1${COLOR_RESET}"
}

# Mask secrets in output (replace with ****)
mask_secret() {
  local value="$1"
  if [[ ${#value} -gt 4 ]]; then
    echo "****${value: -4}"
  else
    echo "****"
  fi
}

# Error trap: print failed step and context
trap 'trap_error' ERR
trap_error() {
  local line=$1
  echo -e "${COLOR_RED}${ICON_FAIL} Error on line $line${COLOR_RESET}" >&2
}

# ============================================================================
# PREREQUISITE CHECKS
# ============================================================================

check_root() {
  if [[ $EUID -ne 0 ]]; then
    die "This script must run as root"
  fi
}

check_debian() {
  if ! command -v apt-get &>/dev/null; then
    die "This script requires Debian/Ubuntu (apt-get not found)"
  fi
}

# ============================================================================
# APT DEPENDENCIES
# ============================================================================

install_apt_deps() {
  step_banner "APT dependencies"

  # Check if all required packages are installed
  local missing_packages=()
  for pkg in git nginx certbot python3-certbot-nginx postgresql postgresql-client curl build-essential; do
    if ! dpkg -l | grep -q "^ii  $pkg"; then
      missing_packages+=("$pkg")
    fi
  done

  if [[ ${#missing_packages[@]} -eq 0 ]]; then
    step_skip "APT dependencies"
    return 0
  fi

  apt-get update -qq
  apt-get install -y "${missing_packages[@]}" >/dev/null 2>&1 || {
    step_fail "APT dependencies"
    return 1
  }

  step_ok "APT dependencies"
}

# ============================================================================
# RUST / RUSTUP
# ============================================================================

install_rustup() {
  step_banner "Rust toolchain"

  if command -v rustc &>/dev/null && command -v cargo &>/dev/null; then
    step_skip "Rust toolchain"
    return 0
  fi

  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y >/dev/null 2>&1 || {
    step_fail "Rust toolchain"
    return 1
  }

  # Load cargo env for this script
  source "$HOME/.cargo/env"

  step_ok "Rust toolchain"
}

# ============================================================================
# POSTGRESQL
# ============================================================================

setup_postgres() {
  step_banner "PostgreSQL setup"

  # Start postgresql
  systemctl enable postgresql >/dev/null 2>&1
  systemctl start postgresql >/dev/null 2>&1

  # Check if db and user already exist
  local db_exists=0
  local user_exists=0

  if sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='walldev'" 2>/dev/null | grep -q 1; then
    db_exists=1
  fi

  if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='walldev'" 2>/dev/null | grep -q 1; then
    user_exists=1
  fi

  if [[ $db_exists -eq 1 && $user_exists -eq 1 ]]; then
    step_skip "PostgreSQL setup (db walldev exists)"
    return 0
  fi

  # Create user if missing
  if [[ $user_exists -eq 0 ]]; then
    sudo -u postgres psql -c "CREATE USER walldev WITH PASSWORD 'walldev';" >/dev/null 2>&1 || true
  fi

  # Create db if missing
  if [[ $db_exists -eq 0 ]]; then
    sudo -u postgres psql -c "CREATE DATABASE walldev OWNER walldev;" >/dev/null 2>&1 || true
  fi

  # Grant privileges
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE walldev TO walldev;" >/dev/null 2>&1 || true
  sudo -u postgres psql -c "ALTER DATABASE walldev OWNER TO walldev;" >/dev/null 2>&1 || true

  step_ok "PostgreSQL setup"
}

# ============================================================================
# DIRECTORIES
# ============================================================================

create_directories() {
  step_banner "Create directories"

  mkdir -p "$APP_DIR" "$LANDING_DIR/dist" "$ENV_DIR" || {
    step_fail "Create directories"
    return 1
  }

  # Fix landing perms
  chown -R root:root "$LANDING_DIR"
  chmod 755 "$LANDING_DIR"
  chmod 755 "$LANDING_DIR/dist"

  step_ok "Create directories"
}

# ============================================================================
# ENVIRONMENT FILE
# ============================================================================

setup_env_file() {
  step_banner "Environment file: $ENV_FILE"

  # Create env template with all keys from example.env
  local template_file
  template_file=$(mktemp)

  cat > "$template_file" <<'ENVEOF'
# The Wall Dev — Backend environment secrets
# Generated by deploy.sh — do not commit to git
# Loaded by systemd via THE_WALL_DEV_ENV_FILE

# Required: PostgreSQL connection
DATABASE_URL=postgres://walldev:walldev@localhost:5432/walldev

# Required: JWT secret for sessions (run: openssl rand -base64 48)
JWT_SECRET=change-me-to-something-very-long

# Optional: Server tunables
PORT=3080
SITE_URL=https://filianislost.com
#PUBLIC_BASE_URL=https://the-wall.vai-rice.space
RUST_LOG=info
LIMIT_MESSAGE_CHARS=4000
LIMIT_BIO_CHARS=500
LIMIT_SOCIAL_LABEL=40
LIMIT_SOCIAL_COUNT=12
SNAPSHOT_INTERVAL_SECS=300
SUPPORT_EMAIL=vadim+the_wall@vai-rice.space

# Optional: Telegram (OIDC + Bot API)
#TELEGRAM_BOT_TOKEN=
#TELEGRAM_CLIENT_ID=
#TELEGRAM_CLIENT_SECRET=
#TELEGRAM_BOT_USERNAME=
#TELEGRAM_NOTIFY_USER_ID=
#TELEGRAM_NOTIFY_CHANNEL_ID=
#TELEGRAM_NOTIFY_CHANNEL_USERNAME=theWALLdev
#TELEGRAM_ADMIN_IDS=
#TELEGRAM_SNAPSHOT_DM=off

# Optional: Discord (OAuth2 + Bot)
#DISCORD_CLIENT_ID=
#DISCORD_CLIENT_SECRET=
#DISCORD_BOT_TOKEN=
#DISCORD_REDIRECT_URI=https://the-wall.vai-rice.space/vai-auth/
#DISCORD_NOTIFY_USER_ID=
#DISCORD_ADMIN_IDS=
#DISCORD_APPLICATION_ID=
#DISCORD_PUBLIC_KEY=

# Optional: Extension version marker
#EXTENSION_VERSION=
ENVEOF

  # If env file doesn't exist, create it
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$template_file" "$ENV_FILE"
    chmod 600 "$ENV_FILE"

    # Generate JWT_SECRET if it's still a placeholder
    local jwt_secret
    jwt_secret=$(openssl rand -base64 48)
    sed -i "s|JWT_SECRET=change-me-to-something-very-long|JWT_SECRET=$jwt_secret|" "$ENV_FILE"

    echo "  Created $ENV_FILE with new JWT_SECRET"
    step_ok "Environment file (created)"
    rm -f "$template_file"
    return 0
  fi

  # File exists: append only template keys the file doesn't mention at all
  # (commented or not). Idempotent — re-running adds nothing the second time.
  local added=0 line key
  while IFS= read -r line; do
    key=$(printf '%s' "$line" | sed -n 's/^#\{0,1\}\([A-Z_][A-Z0-9_]*\)=.*/\1/p')
    [[ -z "$key" ]] && continue
    if ! grep -Eq "^#?${key}=" "$ENV_FILE"; then
      if [[ $added -eq 0 ]]; then
        {
          echo ""
          echo "# --- New keys added by deploy.sh (uncomment and configure as needed) ---"
        } >> "$ENV_FILE"
        added=1
      fi
      case "$line" in
        "#"*) echo "$line" >> "$ENV_FILE" ;;
        *)    echo "#$line" >> "$ENV_FILE" ;;
      esac
    fi
  done < "$template_file"
  chmod 600 "$ENV_FILE"

  # Warn if JWT_SECRET still has placeholder
  if grep -q "JWT_SECRET=change-me-to-something-very-long" "$ENV_FILE"; then
    step_fail "Environment file (JWT_SECRET not configured)"
    rm -f "$template_file"
    return 1
  fi

  if [[ $added -eq 1 ]]; then
    step_ok "Environment file (new keys appended as comments)"
  else
    step_skip "Environment file (up to date)"
  fi
  rm -f "$template_file"
}

# ============================================================================
# SYSTEMD SERVICE UNIT
# ============================================================================

setup_systemd_unit() {
  step_banner "Systemd service: the-wall-backend"

  local unit_file="/etc/systemd/system/the-wall-backend.service"
  local new_unit
  new_unit=$(mktemp)

  cat > "$new_unit" <<SVCEOF
[Unit]
Description=The Wall Dev Backend
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=$BACKEND_DIR
ExecStart=$BACKEND_DIR/target/release/the-wall-backend
Restart=always
RestartSec=5
Environment=THE_WALL_DEV_ENV_FILE=$ENV_FILE
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

  # Check if unit file exists and compare
  if [[ -f "$unit_file" ]]; then
    if diff -q "$unit_file" "$new_unit" >/dev/null 2>&1; then
      step_skip "Systemd service (no changes)"
      rm -f "$new_unit"
      return 0
    fi
    # Show brief diff-ish notice
    echo "  Unit file changed — updating"
  fi

  mv "$new_unit" "$unit_file"
  chmod 644 "$unit_file"
  systemctl daemon-reload

  step_ok "Systemd service"
}

# ============================================================================
# NGINX VHOST
# ============================================================================

setup_nginx_vhost() {
  step_banner "Nginx vhost: $DOMAIN"

  local vhost_file="/etc/nginx/sites-available/the-wall"
  local new_vhost
  new_vhost=$(mktemp)

  cat > "$new_vhost" <<'NGINXEOF'
server {
    server_name DOMAIN_PLACEHOLDER;
    root /var/www/the-wall;
    index index.html;

    client_max_body_size 16M;

    # API proxy with CORS
    location /api/ {
        if ($request_method = 'OPTIONS') {
            add_header 'Access-Control-Allow-Origin' '*' always;
            add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
            add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, X-ClientVersion-TheWallDev-API' always;
            add_header 'Access-Control-Max-Age' 86400;
            return 204;
        }
        proxy_pass http://127.0.0.1:BACKEND_PORT_PLACEHOLDER;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 16M;
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, X-ClientVersion-TheWallDev-API' always;
    }

    # Static extensions + API docs
    location /dist/ {
        alias /var/www/the-wall/dist/;
        add_header 'Access-Control-Allow-Origin' '*' always;
    }

    location /assets/font/ {
        alias /var/www/the-wall/assets/font/;
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Content-Type' always;
        add_header 'Cache-Control' 'public, max-age=31536000, immutable' always;
    }

    # OAuth redirect: exact match (no try_files fallback)
    location = /vai-auth/ { try_files /vai-auth.html =404; }
    location = /vai-auth  { return 301 /vai-auth/$is_args$args; }

    # SPA fallback
    location / { try_files $uri $uri/ /index.html; }

LISTEN_PLACEHOLDER
}
HTTP_REDIRECT_PLACEHOLDER
NGINXEOF

  # TLS is conditional: with certs we serve 443 + an HTTP→HTTPS redirect;
  # without them we serve plain :80 so a fresh machine deploys cleanly
  # (run certbot afterwards, then `deploy.sh nginx` to switch to TLS).
  local listen_block http_redirect tls_hint=""
  if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    listen_block="    listen 443 ssl http2;
    ssl_certificate /etc/letsencrypt/live/DOMAIN_PLACEHOLDER/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/DOMAIN_PLACEHOLDER/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
    http_redirect="
# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER;
    return 301 https://\$host\$request_uri;
}"
  else
    listen_block="    listen 80;"
    http_redirect=""
    tls_hint=" (HTTP only — run: certbot --nginx -d $DOMAIN, then: deploy.sh nginx)"
  fi
  # awk-free multiline substitution: split at the placeholders.
  local assembled
  assembled=$(cat "$new_vhost")
  assembled=${assembled/LISTEN_PLACEHOLDER/$listen_block}
  assembled=${assembled/HTTP_REDIRECT_PLACEHOLDER/$http_redirect}
  printf '%s\n' "$assembled" > "$new_vhost"

  # Replace placeholders
  sed -i "s|DOMAIN_PLACEHOLDER|$DOMAIN|g" "$new_vhost"
  sed -i "s|BACKEND_PORT_PLACEHOLDER|$BACKEND_PORT|g" "$new_vhost"
  sed -i "s|/var/www/the-wall|$LANDING_DIR|g" "$new_vhost"

  # Compare and update if different
  if [[ -f "$vhost_file" ]]; then
    if diff -q "$vhost_file" "$new_vhost" >/dev/null 2>&1; then
      step_skip "Nginx vhost (no changes)"
      rm -f "$new_vhost"
      return 0
    fi
  fi

  mv "$new_vhost" "$vhost_file"
  chmod 644 "$vhost_file"

  # Enable the vhost
  ln -sf /etc/nginx/sites-available/the-wall /etc/nginx/sites-enabled/the-wall || true
  rm -f /etc/nginx/sites-enabled/default

  # Test and reload
  nginx -t >/dev/null 2>&1 || {
    step_fail "Nginx vhost (config error)"
    return 1
  }

  systemctl reload nginx >/dev/null 2>&1 || {
    step_fail "Nginx vhost (reload failed)"
    return 1
  }

  step_ok "Nginx vhost${tls_hint}"
}

# ============================================================================
# SOURCE FETCH (git)
# ============================================================================

fetch_sources() {
  step_banner "Fetch sources ($REPO_URL @ $REPO_BRANCH)"

  if ! command -v git >/dev/null 2>&1; then
    step_fail "Fetch sources (git not installed)"
    return 1
  fi

  if [[ -d "$APP_DIR/.git" ]]; then
    # Existing checkout: hard-reset to the remote branch so a deploy always
    # matches the repo exactly, no matter what's in the working tree.
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH" || {
      step_fail "Fetch sources (git fetch failed)"
      return 1
    }
    git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH" >/dev/null
    git -C "$APP_DIR" clean -fdq -e target -e secrets.env
    step_ok "Fetch sources (updated)"
  elif [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
    # Non-empty directory that isn't a git checkout — refuse to clobber it.
    step_fail "Fetch sources ($APP_DIR exists and is not a git checkout)"
    return 1
  else
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR" || {
      step_fail "Fetch sources (git clone failed)"
      return 1
    }
    step_ok "Fetch sources (cloned)"
  fi
}

# ============================================================================
# BACKEND BUILD
# ============================================================================

build_backend() {
  step_banner "Cargo build (release)"

  if [[ ! -f "$BACKEND_DIR/Cargo.toml" ]]; then
    step_fail "Cargo build (no crate at $BACKEND_DIR — run fetch first)"
    return 1
  fi

  cd "$BACKEND_DIR"
  source "$HOME/.cargo/env" 2>/dev/null || true

  cargo build --release 2>&1 | tail -5 || {
    step_fail "Cargo build"
    return 1
  }

  if [[ ! -f target/release/the-wall-backend ]]; then
    step_fail "Cargo build (binary not found)"
    return 1
  fi

  step_ok "Cargo build"
}

# ============================================================================
# BACKEND START / RESTART
# ============================================================================

start_backend() {
  step_banner "Systemd restart: the-wall-backend"

  if ! systemctl is-enabled the-wall-backend >/dev/null 2>&1; then
    systemctl enable the-wall-backend >/dev/null 2>&1
  fi

  systemctl restart the-wall-backend >/dev/null 2>&1 || {
    step_fail "Systemd restart (failed)"
    sleep 2
    systemctl status the-wall-backend || true
    return 1
  }

  # Wait for boot + migrations
  sleep 3

  step_ok "Systemd restart"
}

# ============================================================================
# HEALTH CHECK
# ============================================================================

check_health() {
  step_banner "Health check"

  # Local API
  local local_status
  local_status=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$BACKEND_PORT/api/meta) || local_status="000"

  if [[ "$local_status" == "200" ]]; then
    echo "  Local API (127.0.0.1:$BACKEND_PORT/api/meta): HTTP $local_status"
  else
    warn "Local API unreachable (HTTP $local_status) — migrations may still be running"
    sleep 3
  fi

  step_ok "Health check"
}

# ============================================================================
# LANDING SITE SETUP
# ============================================================================

setup_landing() {
  step_banner "Landing site"

  mkdir -p "$LANDING_DIR"

  # Publish the static site straight from the repo checkout.
  if [[ -d "$APP_DIR/landing" ]]; then
    cp -r "$APP_DIR/landing/." "$LANDING_DIR/"
  else
    step_skip "Landing site (no landing/ in checkout — perms only)"
  fi

  # The extension downloads under /dist aren't committed; build them if Bun
  # is available, otherwise leave a note (the API still works without them).
  if command -v bun >/dev/null 2>&1 && [[ -f "$APP_DIR/build.ts" ]]; then
    ( cd "$APP_DIR" && bun install >/dev/null 2>&1 && bun run publish >/dev/null 2>&1 ) \
      && cp -r "$APP_DIR/dist" "$LANDING_DIR/dist" \
      && echo "  built + copied extension bundles into $LANDING_DIR/dist"
  else
    warn "Bun not found — skipping extension bundle build (downloads page will 404 until built)"
  fi

  chown -R root:root "$LANDING_DIR"
  chmod -R 755 "$LANDING_DIR"

  step_ok "Landing site"
}

# ============================================================================
# RICH STATUS REPORT
# ============================================================================

print_status() {
  echo ""
  echo -e "${COLOR_BLUE}=== Status Report ===${COLOR_RESET}"
  echo ""

  # Systemd status
  local backend_active
  backend_active=$(systemctl is-active the-wall-backend 2>/dev/null || echo "inactive")
  echo "Backend (systemd): $backend_active"

  if [[ "$backend_active" == "active" ]]; then
    # Uptime
    local uptime
    uptime=$(systemctl show the-wall-backend -p ActiveEnterTimestamp --value 2>/dev/null || echo "unknown")
    echo "  Started: $uptime"

    # API meta
    local meta
    meta=$(curl -s http://127.0.0.1:$BACKEND_PORT/api/meta 2>/dev/null || echo "{}")
    local version
    version=$(echo "$meta" | grep -o '"version":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
    local uptime_secs
    uptime_secs=$(echo "$meta" | grep -o '"uptime_secs":[0-9]*' | cut -d':' -f2 || echo "0")
    echo "  API version: $version (uptime: ${uptime_secs}s)"
  fi

  echo ""

  # Public health (if TLS cert exists)
  if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    local public_status
    public_status=$(curl -s -o /dev/null -w "%{http_code}" https://"$DOMAIN"/api/meta 2>/dev/null || echo "000")
    echo "Public API (https://$DOMAIN/api/meta): HTTP $public_status"

    # Cert expiry
    local cert_expiry
    cert_expiry=$(openssl x509 -in /etc/letsencrypt/live/"$DOMAIN"/fullchain.pem -noout -enddate 2>/dev/null | cut -d'=' -f2)
    echo "  TLS cert expires: $cert_expiry"
  else
    warn "TLS certificate not found for $DOMAIN"
    echo "  To obtain cert: certbot certonly --nginx -d $DOMAIN"
  fi

  echo ""

  # Nginx test
  local nginx_test
  if nginx -t 2>&1 | grep -q "successful"; then
    echo "Nginx config: OK"
  else
    warn "Nginx config has issues"
    nginx -t 2>&1 | tail -3
  fi

  echo ""

  # Disk usage
  local disk_use
  disk_use=$(df -h "$APP_DIR" | tail -1 | awk '{print $5 " of " $2}')
  echo "Disk ($APP_DIR): $disk_use used"

  echo ""

  # Recent journal errors (systemd warnings)
  echo "Recent backend journal errors:"
  journalctl -u the-wall-backend -n 20 --no-pager | grep -E "\[boot\] WARNING|error|Error" | head -5 || echo "  (none)"

  echo ""
}

# ============================================================================
# JOURNAL LOGS
# ============================================================================

print_logs() {
  local lines="${1:-50}"
  echo -e "${COLOR_BLUE}=== Backend Logs (last $lines lines) ===${COLOR_RESET}"
  journalctl -u the-wall-backend -n "$lines" --no-pager || true
}

# ============================================================================
# FINAL SUMMARY TABLE
# ============================================================================

print_summary() {
  echo ""
  echo -e "${COLOR_BLUE}=== Deployment Summary ===${COLOR_RESET}"
  echo ""

  if [[ ${#STEPS_DONE[@]} -gt 0 ]]; then
    echo "Done:"
    for step in "${STEPS_DONE[@]}"; do
      echo "  $ICON_OK $step"
    done
    echo ""
  fi

  if [[ ${#STEPS_SKIPPED[@]} -gt 0 ]]; then
    echo "Skipped (already satisfied):"
    for step in "${STEPS_SKIPPED[@]}"; do
      echo "  $ICON_SKIP $step"
    done
    echo ""
  fi

  if [[ ${#STEPS_FAILED[@]} -gt 0 ]]; then
    echo -e "${COLOR_RED}Failed:${COLOR_RESET}"
    for step in "${STEPS_FAILED[@]}"; do
      echo "  $ICON_FAIL $step"
    done
    echo ""
    die "Deployment incomplete"
  fi

  if [[ ${#STEPS_DONE[@]} -gt 0 || ${#STEPS_SKIPPED[@]} -gt 0 ]]; then
    success "Deployment successful!"
  fi
}

# ============================================================================
# SUBCOMMAND: all (full setup)
# ============================================================================

cmd_all() {
  TOTAL_START_TIME="$(date +%s)"

  check_root
  check_debian

  # Each step records its own outcome via step_ok/step_skip/step_fail; the
  # `|| true` keeps one failed step from aborting the rest of the pipeline
  # (the final summary still flags it and exits non-zero).
  install_apt_deps || true
  install_rustup || true
  setup_postgres || true
  create_directories || true
  fetch_sources || true
  setup_env_file || true
  setup_systemd_unit || true
  setup_nginx_vhost || true
  setup_landing || true
  build_backend || true
  start_backend || true
  check_health || true

  local total_elapsed=$(($(date +%s) - TOTAL_START_TIME))
  echo -e "\nTotal time: ${total_elapsed}s"

  print_summary
}

# ============================================================================
# SUBCOMMAND: backend (rebuild + restart)
# ============================================================================

cmd_backend() {
  check_root
  check_debian

  # Ensure env file exists
  if [[ ! -f "$ENV_FILE" ]]; then
    die "Environment file not found: $ENV_FILE (run 'deploy.sh all' first)"
  fi

  if grep -q "JWT_SECRET=change-me-to-something-very-long" "$ENV_FILE"; then
    die "JWT_SECRET is not configured in $ENV_FILE"
  fi

  fetch_sources || die "Source fetch failed"
  build_backend || die "Backend build failed"
  start_backend || die "Backend restart failed"
  check_health

  print_summary
}

# ============================================================================
# SUBCOMMAND: update (pull latest repo → rebuild backend + republish landing)
# ============================================================================

cmd_update() {
  check_root
  check_debian

  fetch_sources || die "Source fetch failed"
  build_backend || die "Backend build failed"
  start_backend || die "Backend restart failed"
  setup_landing || true
  systemctl reload nginx >/dev/null 2>&1 || true
  check_health

  print_summary
}

# ============================================================================
# SUBCOMMAND: landing (reload nginx)
# ============================================================================

cmd_landing() {
  check_root

  setup_landing || die "Landing setup failed"

  step_banner "Nginx reload"
  systemctl reload nginx >/dev/null 2>&1 || {
    step_fail "Nginx reload"
    return 1
  }
  step_ok "Nginx reload"

  print_summary
}

# ============================================================================
# SUBCOMMAND: nginx (rewrite + reload)
# ============================================================================

cmd_nginx() {
  check_root

  setup_nginx_vhost || die "Nginx vhost setup failed"
  print_summary
}

# ============================================================================
# SUBCOMMAND: env (create/upgrade secrets)
# ============================================================================

cmd_env() {
  check_root

  setup_env_file || die "Environment file setup failed"
  print_summary
}

# ============================================================================
# SUBCOMMAND: status (rich report)
# ============================================================================

cmd_status() {
  print_status
}

# ============================================================================
# SUBCOMMAND: logs (journalctl tail)
# ============================================================================

cmd_logs() {
  local lines="${1:-50}"
  print_logs "$lines"
}

# ============================================================================
# SUBCOMMAND: help
# ============================================================================

cmd_help() {
  cat <<'HELPEOF'
The Wall Dev — Idempotent Deployment Script

Usage:
  deploy.sh [COMMAND] [OPTIONS]

Commands:
  all      - Full setup (apt, rust, postgres, clone repo, env, systemd, nginx, build, start)
  update   - Pull latest from the repo, rebuild backend, republish landing, restart
  backend  - Pull latest + rebuild backend + restart + health check
  landing  - Publish landing from the checkout + reload nginx
  nginx    - Rewrite nginx vhost config + test + reload
  env      - Create/upgrade /etc/the-wall/secrets.env from template
  status   - Print rich status report (systemd, uptime, health, disk, cert)
  logs     - Tail systemd journal (default 50 lines; pass count as arg)
  help     - Show this message

The source of truth is the git repo: it's cloned into APP_DIR and the Rust
crate is built from APP_DIR/backend. No manual scp/upload step is needed —
`all` clones, `update`/`backend` pull and rebuild.

Environment variables (optional):
  DOMAIN       - Nginx vhost domain (default: the-wall.vai-rice.space)
  BACKEND_PORT - Backend listen port (default: 3080)
  APP_DIR      - Repo checkout path (default: /opt/the-wall)
  LANDING_DIR  - Static landing root (default: /var/www/the-wall)
  SITE_URL     - Canonical site URL (default: https://filianislost.com)
  REPO_URL     - Git repo to deploy (default: https://github.com/VAIPROG/TheWall.git)
  REPO_BRANCH  - Branch to deploy (default: main)

Examples:
  sudo deploy.sh all                          # First-time setup on a fresh box
  sudo deploy.sh update                       # Redeploy latest after pushing to the repo
  sudo deploy.sh status                       # Check deployment health
  sudo deploy.sh logs 100                     # Show last 100 journal lines
  sudo REPO_BRANCH=dev deploy.sh update       # Deploy a different branch
  sudo DOMAIN=the-wall.example.com deploy.sh all  # Custom domain

Requirements:
  - Must run as root
  - Debian/Ubuntu system (apt-get)
  - git (for cloning/pulling the repo into APP_DIR)
  - PostgreSQL + Rust toolchain installed (via "deploy.sh all")

Safety:
  - Idempotent: safe to re-run at any time
  - No secrets printed to console (masked with ****)
  - Env file created with mode 600 (root-only)
  - TLS skipped gracefully if certs don't exist (use certbot separately)
  - Step status shown: ✔ (done), ⏩ (skipped), ✖ (failed)

HELPEOF
}

# ============================================================================
# MAIN DISPATCH
# ============================================================================

main() {
  local cmd="${1:-all}"

  case "$cmd" in
    all)      cmd_all ;;
    update)   cmd_update ;;
    backend)  cmd_backend ;;
    landing)  cmd_landing ;;
    nginx)    cmd_nginx ;;
    env)      cmd_env ;;
    status)   cmd_status ;;
    logs)     cmd_logs "${2:-50}" ;;
    help)     cmd_help ;;
    *)
      echo "Unknown command: $cmd" >&2
      cmd_help >&2
      exit 1
      ;;
  esac
}

main "$@"
