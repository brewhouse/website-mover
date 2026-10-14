<?php
defined( 'ABSPATH' ) || exit;

/*
 * WordPress allows Office formats such as .dotx/.docx/.xlsx, but its content sniffing sees them as
 * a different Office (or zip) type than the extension says and rejects the upload ("not allowed
 * to upload this file type"). For REST uploads by an administrator, trust the extension when
 * WordPress itself allows that extension. Uploaded files stay ordinary attachments.
 */
add_filter(
	'wp_check_filetype_and_ext',
	function ( $data, $file, $filename, $mimes ) {
		if ( ! empty( $data['ext'] ) || ! defined( 'REST_REQUEST' ) || ! REST_REQUEST || ! wm_bridge_can_manage() ) {
			return $data;
		}
		$allowed = wp_check_filetype( $filename, $mimes );
		$office  = array( 'doc', 'docx', 'docm', 'dotx', 'dotm', 'xls', 'xlsx', 'xlsm', 'xltx', 'ppt', 'pptx', 'pptm', 'potx', 'rtf' );
		if ( $allowed['ext'] && in_array( strtolower( $allowed['ext'] ), $office, true ) ) {
			return array( 'ext' => $allowed['ext'], 'type' => $allowed['type'], 'proper_filename' => false );
		}
		return $data;
	},
	10,
	4
);
