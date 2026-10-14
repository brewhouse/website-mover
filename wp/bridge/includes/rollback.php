<?php
defined( 'ABSPATH' ) || exit;

/*
 * What rollback needs beyond core REST (docs/m5/design.md §5): read the theme options it restores,
 * bring back the content a job trashed, and trash the forms and ACF items a job created. Everything
 * goes through WordPress's, Gravity Forms' and ACF's own functions, and trashing stays reversible.
 */

/**
 * Restores trashed posts to the status they had before. Core would make them drafts.
 * Body: { ids: number[] }.
 */
function wm_bridge_untrash( WP_REST_Request $request ) {
	add_filter( 'wp_untrash_post_status', 'wp_untrash_post_set_previous_status', 10, 3 );
	$result = array();
	foreach ( (array) $request['ids'] as $id ) {
		$id   = (int) $id;
		$post = get_post( $id );
		if ( ! $post ) {
			$result[ $id ] = 'missing';
		} elseif ( 'trash' !== $post->post_status ) {
			$result[ $id ] = 'not-trashed';
		} else {
			$result[ $id ] = wp_untrash_post( $id ) ? 'restored' : 'failed';
		}
	}
	remove_filter( 'wp_untrash_post_status', 'wp_untrash_post_set_previous_status', 10 );
	return $result;
}

/**
 * Current values of ACF options fields, unformatted (image fields as IDs).
 * Query: names=field_a,field_b.
 */
function wm_bridge_acf_options_get( WP_REST_Request $request ) {
	if ( ! function_exists( 'get_field' ) ) {
		return new WP_Error( 'wm_acf_missing', 'ACF is required.', array( 'status' => 424 ) );
	}
	$values = array();
	foreach ( array_filter( array_map( 'sanitize_key', explode( ',', (string) $request['names'] ) ) ) as $name ) {
		$values[ $name ] = acf_get_field( $name ) ? get_field( $name, 'option', false ) : null;
	}
	return $values;
}

/** Moves Gravity Forms forms to the forms trash. Body: { ids: number[] }. */
function wm_bridge_forms_trash( WP_REST_Request $request ) {
	if ( ! class_exists( 'GFFormsModel' ) ) {
		return new WP_Error( 'wm_forms_missing', 'Gravity Forms is required.', array( 'status' => 424 ) );
	}
	$result = array();
	foreach ( (array) $request['ids'] as $id ) {
		$id = (int) $id;
		if ( ! GFAPI::form_id_exists( $id ) ) {
			$result[ $id ] = 'missing';
			continue;
		}
		GFFormsModel::trash_form( $id );
		$result[ $id ] = 'trashed';
	}
	return $result;
}

/**
 * Trashes ACF post types, taxonomies or field groups by key.
 * Body: { type: 'acf-post-type'|'acf-taxonomy'|'acf-field-group', keys: string[] }.
 */
function wm_bridge_acf_trash( WP_REST_Request $request ) {
	$type = (string) $request['type'];
	if ( ! in_array( $type, array( 'acf-post-type', 'acf-taxonomy', 'acf-field-group' ), true ) ) {
		return new WP_Error( 'wm_invalid', 'Unknown ACF item type.', array( 'status' => 400 ) );
	}
	if ( ! function_exists( 'acf_trash_internal_post_type' ) ) {
		return new WP_Error( 'wm_acf_missing', 'ACF 6.1 or later is required.', array( 'status' => 424 ) );
	}
	$result = array();
	foreach ( (array) $request['keys'] as $key ) {
		$key  = sanitize_text_field( $key );
		$post = acf_get_internal_post_type_post( $key, $type );
		if ( ! $post ) {
			$result[ $key ] = 'missing';
			continue;
		}
		$result[ $key ] = acf_trash_internal_post_type( $post->ID, $type ) ? 'trashed' : 'failed';
	}
	update_option( 'wm_bridge_flush_rewrite', 1 );
	return $result;
}
