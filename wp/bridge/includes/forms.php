<?php
defined( 'ABSPATH' ) || exit;

/**
 * Creates or updates a form in the seed's forms plugin from a plugin-neutral spec.
 *
 * Body: {
 *   source_key: string,           // stable id from the migration plan; makes this idempotent
 *   title: string,
 *   description?: string,
 *   fields: [{ label, type, required?, choices?: string[], placeholder?, description?, content? }],
 *   notify_email?: string,        // defaults to the site admin email
 *   sensitive_fields?: string[],  // labels of fields left out of the notification email
 *   retention_days?: int,         // entries are deleted this many days after submission
 *   confirmation_message?: string, // shown after submitting (else the plugin's default)
 *   captcha?: bool                // add the forms plugin's CAPTCHA (the seed's reCAPTCHA settings)
 * }
 * Field types: text, email, phone, textarea, select, radio, checkbox, number, date, url, name,
 * address, file, hidden, section, html.
 *
 * The spec is the whole truth for what it covers: re-posting it replaces the fields, the
 * notification, the retention policy and (when one was set here) the confirmation.
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

	$sensitive_ids = $form['wmSensitiveFieldIds'];
	unset( $form['wmSensitiveFieldIds'] );

	$existing_id = wm_bridge_gf_find( $spec['source_key'] );
	if ( $existing_id ) {
		$current = GFAPI::get_form( $existing_id );
		// Keep the form's other personal-data settings (IP storage, export/erase) as they are.
		$form['personalData'] = array_merge( (array) ( $current['personalData'] ?? array() ), $form['personalData'] );
		if ( ! isset( $form['confirmations'] ) && isset( $current['confirmations']['wm-confirmation'] ) ) {
			// The confirmation was ours and the spec no longer has one: back to the plugin's default.
			$default               = GFFormsModel::get_default_confirmation();
			$form['confirmations'] = array( $default['id'] => $default );
		}
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
			'plugin'              => 'gravityforms',
			'id'                  => (int) $form_id,
			'created'             => ! $existing_id,
			// Field ids left out of the notification, and the retention policy, for the caller's checks.
			'sensitive_field_ids' => $sensitive_ids,
			'retention'           => $form['personalData']['retention'],
			// The block the content converter should insert where the source form was.
			'block'               => array(
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
	// Spam protection, as the source forms had. Added last so the other fields keep their ids.
	if ( ! empty( $spec['captcha'] ) ) {
		$fields[] = array( 'id' => count( $fields ) + 1, 'type' => 'captcha', 'label' => 'CAPTCHA', 'captchaType' => '' );
	}

	$notify = sanitize_email( $spec['notify_email'] ?? get_option( 'admin_email' ) );

	// Sensitive fields (government ids, bank accounts) never go out by email: the notification
	// lists every other field by its own merge tag instead of {all_fields}, which has no way to
	// leave fields out (GF 3.1's {all_fields} options are only value, empty, admin, noadmin, nohidden).
	$sensitive_ids = array();
	foreach ( (array) ( $spec['sensitive_fields'] ?? array() ) as $label ) {
		$label   = sanitize_text_field( (string) $label );
		$matches = array_filter( $fields, fn( $f ) => $f['label'] === $label && ! in_array( $f['type'], array( 'section', 'html' ), true ) );
		if ( ! $matches ) {
			// Fail closed: a sensitive field we can't find would otherwise be emailed.
			return new WP_Error( 'wm_invalid', "sensitive_fields: no field labeled \"$label\".", array( 'status' => 400 ) );
		}
		foreach ( $matches as $f ) {
			$sensitive_ids[] = $f['id'];
		}
	}
	$message = $sensitive_ids ? wm_bridge_gf_message( $fields, $sensitive_ids ) : '{all_fields}';

	// Personal-data retention (GF's form setting personalData.retention): entries are deleted by
	// the plugin's daily cron once older than retain_entries_days.
	$retention_days = isset( $spec['retention_days'] ) ? (int) $spec['retention_days'] : 0;
	if ( isset( $spec['retention_days'] ) && $retention_days < 1 ) {
		return new WP_Error( 'wm_invalid', 'retention_days must be at least 1.', array( 'status' => 400 ) );
	}
	$retention = $retention_days
		? array( 'policy' => 'delete', 'retain_entries_days' => $retention_days )
		: array( 'policy' => 'retain' );

	$form = array(
		'title'               => sanitize_text_field( $spec['title'] ),
		'description'         => wp_kses_post( $spec['description'] ?? '' ),
		'labelPlacement'      => 'top_label',
		'button'              => array( 'type' => 'text', 'text' => 'Submit' ),
		'fields'              => $fields,
		'notifications'       => array(
			array(
				'id'       => 'wm-admin',
				'name'     => 'Admin notification',
				'isActive' => true,
				'to'       => $notify,
				'toType'   => 'email',
				'event'    => 'form_submission',
				'subject'  => 'New submission: {form_title}',
				'message'  => $message,
			),
		),
		'personalData'        => array( 'retention' => $retention ),
		'wmSourceKey'         => (string) $spec['source_key'],
		'wmSensitiveFieldIds' => $sensitive_ids,
	);

	if ( ! empty( $spec['confirmation_message'] ) ) {
		$form['confirmations'] = array(
			'wm-confirmation' => array(
				'id'          => 'wm-confirmation',
				'name'        => 'Default Confirmation',
				'isDefault'   => true,
				'type'        => 'message',
				'message'     => wp_kses_post( $spec['confirmation_message'] ),
				'url'         => '',
				'pageId'      => '',
				'queryString' => '',
			),
		);
	}

	return $form;
}

/**
 * Notification body listing every field except `$excluded_ids`, in form order, with a link to
 * the entry (where the excluded values can be read by staff who can sign in).
 */
function wm_bridge_gf_message( array $fields, array $excluded_ids ) {
	$rows     = array();
	$excluded = array();
	foreach ( $fields as $f ) {
		if ( in_array( $f['id'], $excluded_ids, true ) ) {
			$excluded[] = $f['label'];
			continue;
		}
		if ( 'html' === $f['type'] ) {
			continue;
		}
		if ( 'section' === $f['type'] ) {
			$rows[] = '<h3>' . esc_html( $f['label'] ) . '</h3>';
			continue;
		}
		// {Label:id}: the label part is only for people reading the template; GF keys on the id.
		$tag    = '{' . str_replace( array( '{', '}', ':' ), '', $f['label'] ) . ':' . $f['id'] . '}';
		$rows[] = sprintf( '<p><strong>%s</strong><br>%s</p>', esc_html( $f['label'] ), $tag );
	}
	$rows[] = sprintf(
		'<p>%s <a href="{entry_url}">%s</a></p>',
		esc_html( 'Not included in this email for security: ' . implode( '; ', $excluded ) . '.' ),
		esc_html( 'View the entry' )
	);
	return implode( "\n", $rows );
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
