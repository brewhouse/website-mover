<?php
defined( 'ABSPATH' ) || exit;

/**
 * Creates or updates an ACF post type, taxonomy or field group from its JSON export format.
 *
 * Uses ACF's own import, so the result is stored as a normal ACF item (editable under ACF in
 * wp-admin) and keeps working after the bridge is removed. Idempotent: matched by `key`.
 *
 * @param WP_REST_Request $request JSON body: the ACF item, as exported by ACF (must include `key`).
 * @param string          $type    acf-post-type | acf-taxonomy | acf-field-group.
 */
function wm_bridge_acf_upsert( WP_REST_Request $request, string $type ) {
	if ( ! function_exists( 'acf_import_internal_post_type' ) ) {
		return new WP_Error( 'wm_acf_missing', 'ACF 6.1 or later is required.', array( 'status' => 424 ) );
	}

	$item = $request->get_json_params();
	if ( empty( $item['key'] ) || empty( $item['title'] ) ) {
		return new WP_Error( 'wm_invalid', 'The ACF item needs a key and a title.', array( 'status' => 400 ) );
	}
	if ( 'acf-post-type' === $type && empty( $item['post_type'] ) ) {
		return new WP_Error( 'wm_invalid', 'post_type is required.', array( 'status' => 400 ) );
	}
	if ( 'acf-taxonomy' === $type && empty( $item['taxonomy'] ) ) {
		return new WP_Error( 'wm_invalid', 'taxonomy is required.', array( 'status' => 400 ) );
	}

	$existing = acf_get_internal_post_type_post( $item['key'], $type );
	if ( $existing ) {
		$item['ID'] = $existing->ID;
		// Import adds fields; remove ones no longer in the definition so the group matches it exactly.
		if ( 'acf-field-group' === $type ) {
			wm_bridge_acf_delete_missing_fields( $existing->ID, $item['fields'] ?? array() );
		}
	}

	$saved = acf_import_internal_post_type( $item, $type );
	if ( empty( $saved['ID'] ) ) {
		return new WP_Error( 'wm_acf_import_failed', 'ACF did not save the item.', array( 'status' => 500 ) );
	}

	// Post types and taxonomies are registered by ACF on init; flush rewrites on the next request
	// so their URLs resolve.
	if ( 'acf-field-group' !== $type ) {
		update_option( 'wm_bridge_flush_rewrite', 1 );
	}

	return new WP_REST_Response(
		array(
			'key'     => $saved['key'],
			'id'      => $saved['ID'],
			'type'    => $type,
			'created' => ! $existing,
		),
		$existing ? 200 : 201
	);
}

/**
 * The seed's existing content model: every registered post type and taxonomy (whoever registered
 * it), plus ACF's stored definitions and field groups. Lets the planner target what the framework
 * already has instead of creating duplicates.
 */
function wm_bridge_schema() {
	$post_types = array();
	foreach ( get_post_types( array( 'public' => true ), 'objects' ) as $pt ) {
		$post_types[ $pt->name ] = array(
			'label'        => $pt->label,
			'show_in_rest' => (bool) $pt->show_in_rest,
			'rest_base'    => $pt->rest_base ?: $pt->name,
			'has_archive'  => $pt->has_archive,
			'rewrite'      => $pt->rewrite ? $pt->rewrite['slug'] : false,
			'hierarchical' => $pt->hierarchical,
			'taxonomies'   => get_object_taxonomies( $pt->name ),
		);
	}

	$taxonomies = array();
	foreach ( get_taxonomies( array( 'public' => true ), 'objects' ) as $tax ) {
		$taxonomies[ $tax->name ] = array(
			'label'        => $tax->label,
			'object_type'  => $tax->object_type,
			'show_in_rest' => (bool) $tax->show_in_rest,
			'rest_base'    => $tax->rest_base ?: $tax->name,
			'hierarchical' => $tax->hierarchical,
		);
	}

	$acf = null;
	if ( function_exists( 'acf_get_field_groups' ) ) {
		$acf = array(
			'post_types'   => array_values( acf_get_internal_post_type_posts( 'acf-post-type' ) ),
			'taxonomies'   => array_values( acf_get_internal_post_type_posts( 'acf-taxonomy' ) ),
			'field_groups' => array_map(
				fn( $group ) => $group + array( 'fields' => acf_get_fields( $group ) ?: array() ),
				acf_get_field_groups()
			),
		);
	}

	return array(
		'post_types' => $post_types,
		'taxonomies' => $taxonomies,
		'acf'        => $acf,
	);
}

function wm_bridge_acf_delete_missing_fields( int $group_id, array $fields ) {
	$keep = wp_list_pluck( $fields, 'key' );
	foreach ( acf_get_fields( $group_id ) ?: array() as $field ) {
		if ( ! in_array( $field['key'], $keep, true ) ) {
			acf_delete_field( $field['ID'] );
		}
	}
}

add_action(
	'init',
	function () {
		if ( get_option( 'wm_bridge_flush_rewrite' ) ) {
			delete_option( 'wm_bridge_flush_rewrite' );
			flush_rewrite_rules( false );
		}
	},
	99
);
