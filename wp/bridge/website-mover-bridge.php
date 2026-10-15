<?php
/**
 * Plugin Name: Website Mover Bridge
 * Description: Build-time REST endpoints used by Website Mover to set up the seed site. Everything it creates is stored natively (ACF post types and field groups, Gravity Forms forms), so the plugin can be removed after migration.
 * Version: 0.1.1
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * License: GPL-2.0-or-later
 */

defined( 'ABSPATH' ) || exit;

const WM_BRIDGE_VERSION   = '0.1.1';
const WM_BRIDGE_NAMESPACE = 'website-mover/v1';

require_once __DIR__ . '/includes/rest.php';
require_once __DIR__ . '/includes/acf.php';
require_once __DIR__ . '/includes/forms.php';
require_once __DIR__ . '/includes/entities.php';
require_once __DIR__ . '/includes/uploads.php';
require_once __DIR__ . '/includes/rollback.php';

add_action( 'rest_api_init', 'wm_bridge_register_routes' );
