#!/usr/bin/env bash
# Copies the seed codebase (read-only source: SEED_CODE_PATH) into .local/seed and runs it in Docker,
# either as a fresh install (framework theme + plugins activated) or with the seed's database
# imported from a Pantheon backup.
# Usage: e2e/seed/setup.sh [--fresh] [--db <backup.sql.gz>]
#   --fresh  wipe the local DB and re-copy the code
#   --db     replace the local DB with a seed database export (e.g. inputs/framework/*_database.sql.gz)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/e2e/seed"
DEST="$ROOT/.local/seed"
# Read only the keys this script needs (other .env values may contain characters bash would expand).
env_get() { grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -E "s/^['\"](.*)['\"]$/\\1/"; }
SEED_CODE_PATH=$(env_get SEED_CODE_PATH)
SEED_LOCAL_ADMIN_PASSWORD=$(env_get SEED_LOCAL_ADMIN_PASSWORD)
SEED_LOCAL_APP_PASSWORD=$(env_get SEED_LOCAL_APP_PASSWORD)
: "${SEED_CODE_PATH:?Set SEED_CODE_PATH in .env}"
PORT=$(env_get SEED_LOCAL_PORT); PORT=${PORT:-8088}
compose() { docker compose -f "$HERE/compose.yaml" "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

LOCAL_USER=wm-local
FRESH=0
DB_FILE=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh) FRESH=1 ;;
    --db) DB_FILE="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
: "${SEED_LOCAL_ADMIN_PASSWORD:?Set SEED_LOCAL_ADMIN_PASSWORD in .env}"

if [[ $FRESH == 1 ]]; then
  compose down -v || true
  rm -rf "$DEST"
fi

# Copy without VCS/tooling dirs. .ddev is skipped: it is local tooling and may hold credentials.
mkdir -p "$DEST"
rsync -a --delete \
  --exclude .git --exclude .ddev --exclude .tmb --exclude .circleci --exclude .github --exclude .vscode \
  --exclude wp-config-local.php --exclude wp-salts-local.php --exclude .htaccess \
  --exclude wp-content/uploads --exclude wp-content/plugins/website-mover-bridge \
  "$SEED_CODE_PATH/" "$DEST/"
cp "$HERE/wp-config-local.php" "$DEST/wp-config-local.php"
if [[ ! -f "$DEST/wp-salts-local.php" ]]; then
  {
    echo '<?php'
    for k in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do
      echo "define( '$k', '$(openssl rand -base64 48 | tr -d '\n/+=')' );"
    done
  } > "$DEST/wp-salts-local.php"
fi
cat > "$DEST/.htaccess" <<'HT'
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
HT
mkdir -p "$DEST/wp-content/uploads" "$DEST/wp-content/plugins/website-mover-bridge"

compose up -d --wait db wordpress

# Skipped locally: plugins that call external services or send mail (staff SSO, AI alt text,
# BugHerd, link checker, SMTP, social feeds), and WP Sheet Editor - Media Library, whose Enable
# Media Replace integration is a fatal error on the post edit screen (EnableMediaReplace\Replacer is
# missing in Enable Media Replace 4.1.5).
SKIP="planeteria-sso alttext-ai bugherd broken-link-checker gravitysmtp custom-facebook-feed-pro instagram-feed-pro wordpress-importer wp-sheet-editor-media-library-premium"

if [[ -n "$DB_FILE" ]]; then
  echo "Importing $DB_FILE"
  # Through the db container: the WP-CLI image's client insists on TLS, which this server lacks.
  compose exec -T db mysql -uroot -proot -e 'DROP DATABASE IF EXISTS wordpress; CREATE DATABASE wordpress'
  gzip -dc "$DB_FILE" | compose exec -T db mysql -uroot -proot wordpress
  # Point the seed's own URLs at the local copy (other sites' URLs in demo content are left alone).
  OLD_HOST=$(wp option get siteurl | sed -E 's#^https?://([^/]+).*#\1#')
  wp search-replace "https://$OLD_HOST" "http://localhost:$PORT" --all-tables --skip-columns=guid --report-changed-only
  wp search-replace "http://$OLD_HOST" "http://localhost:$PORT" --all-tables --skip-columns=guid --report-changed-only
  # Keep the seed's own plugin selection; only switch off the ones skipped locally.
  for p in $SKIP; do
    if wp plugin is-active "$p" 2>/dev/null; then wp plugin deactivate "$p"; fi
  done
elif ! wp core is-installed 2>/dev/null; then
  wp core install --url="http://localhost:$PORT" --title="JHA Seed (local)" \
    --admin_user="$LOCAL_USER" --admin_password="$SEED_LOCAL_ADMIN_PASSWORD" \
    --admin_email=wm-local@example.test --skip-email
  wp rewrite structure '/%postname%/' --hard >/dev/null
  wp theme activate planeteriaweb
  TO_ACTIVATE=()
  for p in $(wp plugin list --field=name --status=inactive); do
    [[ " $SKIP website-mover-bridge " == *" $p "* ]] || TO_ACTIVATE+=("$p")
  done
  if [[ ${#TO_ACTIVATE[@]} -gt 0 ]]; then wp plugin activate "${TO_ACTIVATE[@]}"; fi
fi
wp plugin activate website-mover-bridge

# A local admin for the tool and tests, separate from the seed's real accounts.
if wp user get "$LOCAL_USER" >/dev/null 2>&1; then
  wp user update "$LOCAL_USER" --user_pass="$SEED_LOCAL_ADMIN_PASSWORD" --role=administrator --skip-email >/dev/null
else
  wp user create "$LOCAL_USER" wm-local@example.test --role=administrator --user_pass="$SEED_LOCAL_ADMIN_PASSWORD" >/dev/null
fi
# Application Password for the REST client, stored in .env (SEED_LOCAL_APP_PASSWORD).
if ! curl -sf -o /dev/null -u "$LOCAL_USER:${SEED_LOCAL_APP_PASSWORD:-}" "http://localhost:$PORT/wp-json/wp/v2/users/me"; then
  for uuid in $(wp user application-password list "$LOCAL_USER" --name=website-mover-local --field=uuid); do
    wp user application-password delete "$LOCAL_USER" "$uuid" >/dev/null
  done
  APP_PW=$(wp user application-password create "$LOCAL_USER" website-mover-local --porcelain | tr -d '\r')
  if grep -q '^SEED_LOCAL_APP_PASSWORD=' "$ROOT/.env"; then
    sed -i.bak "s|^SEED_LOCAL_APP_PASSWORD=.*|SEED_LOCAL_APP_PASSWORD=$APP_PW|" "$ROOT/.env" && rm "$ROOT/.env.bak"
  else
    echo "SEED_LOCAL_APP_PASSWORD=$APP_PW" >> "$ROOT/.env"
  fi
  echo "Stored a new Application Password for $LOCAL_USER in .env"
fi

echo "Theme: $(wp option get stylesheet) (parent $(wp option get template))"
wp plugin list --fields=name,status,version
echo "Seed running at http://localhost:$PORT (user $LOCAL_USER; password from SEED_LOCAL_ADMIN_PASSWORD)"
