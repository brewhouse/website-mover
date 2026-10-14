<?php
// Local config for the seed copy in .local/seed. wp-config.php loads this when not on Pantheon.
// Do not include wp-settings.php here.
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', 'wordpress' );
define( 'DB_PASSWORD', 'wordpress' );
define( 'DB_HOST', getenv( 'WM_DB_HOST' ) ?: 'db' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

require __DIR__ . '/wp-salts-local.php';

define( 'WP_HOME', getenv( 'WM_HOME' ) ?: 'http://localhost:8088' );
define( 'WP_SITEURL', WP_HOME );

// 'local' lets Application Passwords work over plain HTTP.
define( 'WP_ENVIRONMENT_TYPE', 'local' );
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', true );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_AUTO_UPDATE_CORE', false );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'DISABLE_WP_CRON', true );
define( 'FS_METHOD', 'direct' );
