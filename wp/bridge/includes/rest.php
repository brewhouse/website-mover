<?php
defined( 'ABSPATH' ) || exit;

function wm_bridge_register_routes() {
	$admin = array( 'permission_callback' => 'wm_bridge_can_manage' );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/status', $admin + array(
		'methods'  => WP_REST_Server::READABLE,
		'callback' => 'wm_bridge_status',
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/schema', $admin + array(
		'methods'  => WP_REST_Server::READABLE,
		'callback' => 'wm_bridge_schema',
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/entities', $admin + array(
		'methods'  => WP_REST_Server::READABLE,
		'callback' => 'wm_bridge_entities',
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/trash', $admin + array(
		'methods'  => WP_REST_Server::CREATABLE,
		'callback' => 'wm_bridge_trash',
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/acf/post-types', $admin + array(
		'methods'  => WP_REST_Server::CREATABLE,
		'callback' => fn( $request ) => wm_bridge_acf_upsert( $request, 'acf-post-type' ),
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/acf/taxonomies', $admin + array(
		'methods'  => WP_REST_Server::CREATABLE,
		'callback' => fn( $request ) => wm_bridge_acf_upsert( $request, 'acf-taxonomy' ),
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/acf/field-groups', $admin + array(
		'methods'  => WP_REST_Server::CREATABLE,
		'callback' => fn( $request ) => wm_bridge_acf_upsert( $request, 'acf-field-group' ),
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/acf/field-groups/(?P<key>group_[A-Za-z0-9_]+)/show-in-rest', $admin + array(
		'methods'  => WP_REST_Server::CREATABLE,
		'callback' => 'wm_bridge_acf_show_in_rest',
	) );

	register_rest_route( WM_BRIDGE_NAMESPACE, '/forms', $admin + array(
		'methods'  => WP_REST_Server::CREATABLE,
		'callback' => 'wm_bridge_forms_upsert',
	) );
}

function wm_bridge_can_manage() {
	return current_user_can( 'manage_options' );
}

/**
 * Seed capabilities, used by the tool's preflight step.
 */
function wm_bridge_status() {
	if ( ! function_exists( 'get_plugins' ) ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
	}
	$active = array();
	foreach ( get_plugins() as $file => $data ) {
		if ( is_plugin_active( $file ) ) {
			$active[ dirname( $file ) ] = $data['Version'];
		}
	}
	$theme = wp_get_theme();

	return array(
		'bridge'          => WM_BRIDGE_VERSION,
		'wordpress'       => get_bloginfo( 'version' ),
		'php'             => PHP_VERSION,
		'theme'           => array(
			'stylesheet' => get_stylesheet(),
			'template'   => get_template(),
			'name'       => $theme->get( 'Name' ),
			'version'    => $theme->get( 'Version' ),
			'is_block'   => wp_is_block_theme(),
		),
		'acf'             => defined( 'ACF_VERSION' ) ? array(
			'version' => ACF_VERSION,
			'pro'     => defined( 'ACF_PRO' ) && ACF_PRO,
		) : null,
		'forms'           => class_exists( 'GFAPI' ) ? array(
			'plugin'  => 'gravityforms',
			'version' => GFForms::$version,
		) : null,
		'active_plugins'  => $active,
		// Block types switched off in the editor (Disable Unused Block Editor Blocks).
		'disabled_blocks' => array_values( (array) get_option( 'dubeb_disabled_blocks', array() ) ),
		'upload_max_size' => wp_max_upload_size(),
		'permalinks'      => get_option( 'permalink_structure' ),
		'timezone'        => get_option( 'timezone_string' ) ?: 'UTC' . ( (float) get_option( 'gmt_offset' ) >= 0 ? '+' : '' ) . get_option( 'gmt_offset' ),
		'front_page'      => (int) get_option( 'page_on_front' ),
		// Slugs WordPress uses for post type and taxonomy URLs; pages must not take them.
		'reserved_slugs'  => wm_bridge_reserved_slugs(),
	);
}

function wm_bridge_reserved_slugs() {
	$slugs = array();
	foreach ( get_post_types( array( 'public' => true ), 'objects' ) as $pt ) {
		if ( ! empty( $pt->rewrite['slug'] ) ) {
			$slugs[] = $pt->rewrite['slug'];
		}
		if ( $pt->has_archive ) {
			$slugs[] = true === $pt->has_archive ? $pt->name : $pt->has_archive;
		}
	}
	foreach ( get_taxonomies( array( 'public' => true ), 'objects' ) as $tax ) {
		if ( ! empty( $tax->rewrite['slug'] ) ) {
			$slugs[] = $tax->rewrite['slug'];
		}
	}
	return array_values( array_unique( $slugs ) );
}
