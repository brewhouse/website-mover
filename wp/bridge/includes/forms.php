<?php
defined( 'ABSPATH' ) || exit;

/**
 * Creates or updates a form in the seed's forms plugin from a plugin-neutral spec.
 *
 * Body: {
 *   source_key: string,           // stable id from the migration plan; makes this idempotent
 *   title: string,
 *   description?: string,
 *   fields: [{ label, type, required?, choices?: string[], placeholder?, description? }],
 *   notify_email?: string         // defaults to the site admin email
 * }
 * Field types: text, email, phone, textarea, select, radio, checkbox, number, date, url, name,
 * address, file, hidden, section, html.
 *
 * Only Gravity Forms is supported so far (it is what the Planeteria seed ships).
 */
function wm_bridge_forms_upsert( WP_REST_Request $request ) {
	if ( ! class_exists( 'GFAPI' ) ) {
		return new WP_Error( 'wm_forms_missing', 'No supported forms plugin is active.', array( 'status' => 424 ) );
	}

	$spec = $request->get_json_params();
	if ( empty( $spec['source_key'] ) || empty( $spec['title'] ) || ! isset( $spec['fields'] ) || ! is_array( $spec['fields'] ) ) {
		return new WP_Error( 'wm_invalid', 'source_key, title and fields are required.', array( 'status' => 400 ) );
	}

	$form = wm_bridge_gf_form( $spec );
	if ( is_wp_error( $form ) ) {
		return $form;
	}

	$existing_id = wm_bridge_gf_find( $spec['source_key'] );
	if ( $existing_id ) {
		$current = GFAPI::get_form( $existing_id );
		$form    = array_merge( $current, $form, array( 'id' => $existing_id ) );
		$result  = GFAPI::update_form( $form, $existing_id );
		$form_id = $existing_id;
	} else {
		$result  = GFAPI::add_form( $form );
		$form_id = $result;
	}
	if ( is_wp_error( $result ) ) {
		return new WP_Error( 'wm_forms_failed', $result->get_error_message(), array( 'status' => 500 ) );
	}

	return new WP_REST_Response(
		array(
			'plugin'  => 'gravityforms',
			'id'      => (int) $form_id,
			'created' => ! $existing_id,
			// The block the content converter should insert where the source form was.
			'block'   => array(
				'name'  => 'gravityforms/form',
				'attrs' => array( 'formId' => (string) $form_id ),
			),
		),
		$existing_id ? 200 : 201
	);
}

function wm_bridge_gf_find( string $source_key ) {
	foreach ( GFAPI::get_forms( null ) as $form ) {
		if ( ( $form['wmSourceKey'] ?? '' ) === $source_key ) {
			return (int) $form['id'];
		}
	}
	return 0;
}

function wm_bridge_gf_form( array $spec ) {
	$fields = array();
	foreach ( array_values( $spec['fields'] ) as $i => $field ) {
		$gf_field = wm_bridge_gf_field( $field, $i + 1 );
		if ( is_wp_error( $gf_field ) ) {
			return $gf_field;
		}
		$fields[] = $gf_field;
	}

	$notify = sanitize_email( $spec['notify_email'] ?? get_option( 'admin_email' ) );

	return array(
		'title'          => sanitize_text_field( $spec['title'] ),
		'description'    => wp_kses_post( $spec['description'] ?? '' ),
		'labelPlacement' => 'top_label',
		'button'         => array( 'type' => 'text', 'text' => 'Submit' ),
		'fields'         => $fields,
		'notifications'  => array(
			array(
				'id'      => 'wm-admin',
				'name'    => 'Admin notification',
				'isActive' => true,
				'to'      => $notify,
				'toType'  => 'email',
				'event'   => 'form_submission',
				'subject' => 'New submission: {form_title}',
				'message' => '{all_fields}',
			),
		),
		'wmSourceKey'    => (string) $spec['source_key'],
	);
}

function wm_bridge_gf_field( array $field, int $id ) {
	$types = array(
		'text'     => 'text',
		'email'    => 'email',
		'phone'    => 'phone',
		'textarea' => 'textarea',
		'select'   => 'select',
		'radio'    => 'radio',
		'checkbox' => 'checkbox',
		'number'   => 'number',
		'date'     => 'date',
		'url'      => 'website',
		'name'     => 'name',
		'address'  => 'address',
		'file'     => 'fileupload',
		'hidden'   => 'hidden',
		'section'  => 'section',
		'html'     => 'html',
	);
	$type = $field['type'] ?? '';
	if ( ! isset( $types[ $type ] ) ) {
		return new WP_Error( 'wm_invalid', "Unsupported field type: $type", array( 'status' => 400 ) );
	}

	$gf = array(
		'id'          => $id,
		'type'        => $types[ $type ],
		'label'       => sanitize_text_field( $field['label'] ?? '' ),
		'isRequired'  => ! empty( $field['required'] ),
		'placeholder' => sanitize_text_field( $field['placeholder'] ?? '' ),
		'description' => wp_kses_post( $field['description'] ?? '' ),
	);

	if ( in_array( $type, array( 'select', 'radio', 'checkbox' ), true ) ) {
		$gf['choices'] = array_map(
			fn( $choice ) => array( 'text' => (string) $choice, 'value' => (string) $choice ),
			$field['choices'] ?? array()
		);
		if ( 'checkbox' === $type ) {
			// Gravity Forms stores each checkbox choice as a sub-input (id.1, id.2, ...), skipping
			// multiples of 10.
			$gf['inputs'] = array();
			$n            = 0;
			foreach ( $gf['choices'] as $choice ) {
				if ( 0 === ++$n % 10 ) {
					++$n;
				}
				$gf['inputs'][] = array( 'id' => "$id.$n", 'label' => $choice['text'] );
			}
		}
	}
	if ( 'phone' === $type ) {
		$gf['phoneFormat'] = 'standard';
	}
	if ( 'date' === $type ) {
		$gf['dateType'] = 'datepicker';
	}
	if ( 'html' === $type ) {
		$gf['content'] = wp_kses_post( $field['content'] ?? '' );
	}

	return $gf;
}
