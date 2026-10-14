#!/usr/bin/env bash
# Copies the seed codebase (read-only source: SEED_CODE_PATH) into .local/seed, starts WordPress
# in Docker, installs it fresh and activates the framework theme and plugins.
# Usage: e2e/seed/setup.sh [--fresh]   (--fresh wipes the local DB and re-copies the code)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/e2e/seed"
DEST="$ROOT/.local/seed"
set -a; . "$ROOT/.env"; set +a
: "${SEED_CODE_PATH:?Set SEED_CODE_PATH in .env}"
PORT="${SEED_LOCAL_PORT:-8088}"
compose() { docker compose -f "$HERE/compose.yaml" "$@"; }
wp() { compose run --rm -T cli wp "$@"; }

if [[ "${1:-}" == "--fresh" ]]; then
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

if ! wp core is-installed 2>/dev/null; then
  wp core install --url="http://localhost:$PORT" --title="JHA Seed (local)" \
    --admin_user=admin --admin_password="${SEED_LOCAL_ADMIN_PASSWORD:?Set SEED_LOCAL_ADMIN_PASSWORD in .env}" \
    --admin_email=admin@example.test --skip-email
fi
wp rewrite structure '/%postname%/' --hard >/dev/null
wp theme activate planeteriaweb

# Activate the framework's plugins. Skipped locally: ones that call external services or send mail
# (staff SSO, AI alt text, BugHerd, link checker, SMTP, social feeds), and WP Sheet Editor - Media
# Library, whose Enable Media Replace integration is a fatal error on the post edit screen
# (EnableMediaReplace\Replacer is missing in Enable Media Replace 4.1.5).
SKIP="planeteria-sso alttext-ai bugherd broken-link-checker gravitysmtp custom-facebook-feed-pro instagram-feed-pro wordpress-importer wp-sheet-editor-media-library-premium"
TO_ACTIVATE=()
for p in $(wp plugin list --field=name --status=inactive); do
  [[ " $SKIP website-mover-bridge " == *" $p "* ]] || TO_ACTIVATE+=("$p")
done
if [[ ${#TO_ACTIVATE[@]} -gt 0 ]]; then wp plugin activate "${TO_ACTIVATE[@]}"; fi
wp plugin activate website-mover-bridge
wp plugin list --fields=name,status,version
echo "Seed running at http://localhost:$PORT (admin user: admin; password from SEED_LOCAL_ADMIN_PASSWORD)"
