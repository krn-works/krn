<?php
/**
 * Uninstall script for AntiSpam Lite.
 *
 * @package AntiSpam Lite
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
    exit;
}

// Cleanup: usuń opcje.
delete_option( 'asl_settings' );

// Cleanup transients (rate-limit).
global $wpdb;
$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '_transient_asl_%' OR option_name LIKE '_transient_timeout_asl_%'" );
