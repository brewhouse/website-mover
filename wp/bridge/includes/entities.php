<?php
defined( 'ABSPATH' ) || exit;

/*
 * Every object the tool creates carries `_wm_source_key` (the source URL's key) and `_wm_job_id`.
 * Registering them lets the tool set them through core REST (`meta`); they stay as plain post meta
 * after the bridge is removed.
 */
add_action(
	'init',
	function () {
		// Core REST only exposes `meta` for post types that support custom fields (the seed's
		// `people` type doesn't). While the bridge is active, every public type does.
		foreach ( get_post_types( array( 'public' => true ) ) as $post_type ) {
			if ( ! post_type_supports( $post_type, 'custom-fields' ) ) {
				add_post_type_support( $post_type, 'custom-fields' );
			}
		}
		foreach ( array( '_wm_source_key', '_wm_job_id' ) as $key ) {
			register_post_meta(
				'',
				$key,
				array(
					'type'          => 'string',
					'single'        => true,
					'show_in_rest'  => true,
					'auth_callback' => 'wm_bridge_can_manage',
				)
			);
		}
	},
	20
);

/**
 * Lists content on the site: what the tool created (by source key) and what was already there.
 *
 * Query: types (comma-separated post types, default: all public types + attachment).
 */
function wm_bridge_entities( WP_REST_Request $request ) {
	$types = $request['types']
		? array_map( 'sanitize_key', explode( ',', $request['types'] ) )
		: array_values( get_post_types( array( 'public' => true ) ) );

	$ids = get_posts(
		array(
			'post_type'        => $types,
			'post_status'      => array( 'publish', 'draft', 'pending', 'private', 'future', 'inherit' ),
			'posts_per_page'   => -1,
			'fields'           => 'ids',
			'orderby'          => 'ID',
			'order'            => 'ASC',
			'suppress_filters' => true,
		)
	);
	update_postmeta_cache( $ids );

	$front = (int) get_option( 'page_on_front' );
	$items = array();
	foreach ( $ids as $id ) {
		$post    = get_post( $id );
		$items[] = array(
			'id'         => $id,
			'type'       => $post->post_type,
			'status'     => $post->post_status,
			'title'      => html_entity_decode( get_the_title( $post ), ENT_QUOTES ),
			'slug'       => $post->post_name,
			'link'       => 'attachment' === $post->post_type ? wp_get_attachment_url( $id ) : get_permalink( $post ),
			'template'   => get_page_template_slug( $post ) ?: null,
			'front_page' => $id === $front,
			'source_key' => get_post_meta( $id, '_wm_source_key', true ) ?: null,
			'job_id'     => get_post_meta( $id, '_wm_job_id', true ) ?: null,
		);
	}
	return $items;
}

/**
 * Moves posts of any type to the trash (reversible). Body: { ids: number[] }.
 * Used for the seed's demo content, which the approved plan lists.
 */
function wm_bridge_trash( WP_REST_Request $request ) {
	$result = array();
	foreach ( (array) $request['ids'] as $id ) {
		$id   = (int) $id;
		$post = get_post( $id );
		if ( ! $post ) {
			$result[ $id ] = 'missing';
		} elseif ( 'trash' === $post->post_status ) {
			$result[ $id ] = 'already-trashed';
		} else {
			$result[ $id ] = wp_trash_post( $id ) ? 'trashed' : 'failed';
		}
	}
	return $result;
}
