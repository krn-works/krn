<?php
/**
 * Plugin Name: Rekurencja Antyspam
 * Description: Lokalny scoring antyspamowy Rekurencja dla komentarzy i Contact Form 7.
 * Version: 0.7.0
 * Requires at least: 6.4
 * Tested up to: 6.8.2
 * Requires PHP: 8.0
 * Author: Korneliusz Burian
 * Text Domain: lightweight-rekurencja-antyspam
 * Domain Path: /languages
 * Update URI: https://github.com/Rekurencja/lightweight-rekurencja-antyspam
 *
 * @package AntiSpam Lite
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

define( 'REKURENCJA_ANTISPAM_VERSION', '0.7.0' );
define( 'REKURENCJA_ANTISPAM_TEXT_DOMAIN', 'lightweight-rekurencja-antyspam' );
define( 'REKURENCJA_ANTISPAM_DIR', plugin_dir_path( __FILE__ ) );
define( 'REKURENCJA_ANTISPAM_LOG_TABLE', 'asl_logs' );
define( 'REKURENCJA_ANTISPAM_KEYWORDS_DIR', REKURENCJA_ANTISPAM_DIR . 'keywords' . DIRECTORY_SEPARATOR );

/**
 * Load keyword lists from txt files in REKURENCJA_ANTISPAM_KEYWORDS_DIR.
 * Each line is one keyword; lines starting with # are ignored.
 *
 * @return array{bonus:array,deny:array} Loaded keywords.
 */
function asl_load_keywords_from_files(): array {
    $result = array(
        'bonus' => array(),
        'deny'  => array(),
        'kw_lang_bonus' => array(),
        'kw_lang_deny'  => array(),
    );

    if ( ! is_dir( REKURENCJA_ANTISPAM_KEYWORDS_DIR ) ) {
        return $result;
    }

    $files = glob( REKURENCJA_ANTISPAM_KEYWORDS_DIR . '*.txt' );
    if ( ! $files ) {
        return $result;
    }

    foreach ( $files as $file ) {
        $lines = @file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        if ( ! is_array( $lines ) ) {
            continue;
        }
        $base   = basename( $file );
        $bucket = ( stripos( $base, 'deny' ) !== false ) ? 'deny' : 'bonus';
        // Detect language code between last hyphen and extension (e.g., spam-words-EN.txt -> en).
        $lang = 'misc';
        if ( preg_match( '/-([A-Za-z]{2,5})\.txt$/', $base, $m ) ) {
            $lang = strtolower( $m[1] );
        }
        foreach ( $lines as $line ) {
            $line = trim( $line );
            if ( '' === $line || str_starts_with( $line, '#' ) ) {
                continue;
            }
            $result[ $bucket ][ $line ] = true;
            if ( 'deny' === $bucket ) {
                $result['kw_lang_deny'][ $lang ][ $line ] = true;
            } else {
                $result['kw_lang_bonus'][ $lang ][ $line ] = true;
            }
        }
    }

    $result['bonus'] = array_keys( $result['bonus'] );
    $result['deny']  = array_keys( $result['deny'] );
    // Normalize language maps to arrays of values.
    foreach ( array_keys( $result['kw_lang_bonus'] ) as $k ) {
        $result['kw_lang_bonus'][ $k ] = array_keys( $result['kw_lang_bonus'][ $k ] );
    }
    foreach ( array_keys( $result['kw_lang_deny'] ) as $k ) {
        $result['kw_lang_deny'][ $k ] = array_keys( $result['kw_lang_deny'][ $k ] );
    }
    return $result;
}

register_activation_hook( __FILE__, 'asl_on_activate' );
register_deactivation_hook( __FILE__, 'asl_on_deactivate' );

/**
 * Plugin activation hook.
 */
function asl_on_activate(): void {
    $defaults = array(
        'threshold_soft'       => 30,
        'threshold_block'      => 70,
        'safe_mode'            => false,
        'allow_urls'           => false,
        'log_retention_d'      => 0,
        'allowlist'            => array(),
        'denylist'             => array(),
        // DNS/WHOIS defaults.
        'enable_dnsbl'         => false,
        'enable_surbl'         => false,
        'enable_whois'         => false,
        'reputation_cache_ttl' => 360,
        'dns_timeout_ms'       => 800,
        'whois_timeout_ms'     => 1200,
        'whois_age_days'       => 90,
        'weight_dnsbl'         => 15,
        'weight_surbl'         => 12,
        'weight_whois_young'   => 10,
        // Keywords defaults.
        'keywords_bonus'        => array(),
        'weight_keyword'        => 8,
        'keywords_deny'         => array(),
        'keyword_min_len'       => 3,
        // Contact Form 7 request protection.
        'cf7_min_completion_s'  => 3,
        'cf7_attempt_limit'     => 0,
        'cf7_attempt_window_m'  => 15,
        'cf7_ip_limit'          => 10,
        'cf7_ip_window_m'       => 15,
        'cf7_identity_limit'    => 3,
        'cf7_identity_window_h' => 24,
        // Optional diagnostic copies for internal form notifications.
        'diagnostic_bcc'        => '',
        'diagnostic_domain'     => '',
        'turnstile_enabled'     => false,
    );

    add_option( 'asl_settings', $defaults, '', false );

    // Create logs table.
    global $wpdb;
    $table_name      = $wpdb->prefix . REKURENCJA_ANTISPAM_LOG_TABLE;
    $charset_collate = $wpdb->get_charset_collate();
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $sql = "CREATE TABLE {$table_name} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        time DATETIME NOT NULL,
        type VARCHAR(32) NOT NULL,
        source_ip VARCHAR(64) NULL,
        score INT NOT NULL DEFAULT 0,
        decision VARCHAR(16) NOT NULL,
        content TEXT NULL,
        reasons TEXT NULL,
        extra TEXT NULL,
        PRIMARY KEY  (id),
        KEY time_idx (time),
        KEY type_idx (type)
    ) {$charset_collate};";
    dbDelta( $sql );

    // Schedule daily purge.
    if ( ! wp_next_scheduled( 'asl_purge_logs' ) ) {
        wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'asl_purge_logs' );
    }
}

/**
 * Plugin deactivation hook.
 */
function asl_on_deactivate(): void {
    $timestamp = wp_next_scheduled( 'asl_purge_logs' );
    if ( $timestamp ) {
        wp_unschedule_event( $timestamp, 'asl_purge_logs' );
    }
}

add_action( 'asl_purge_logs', 'asl_handle_purge_logs' );
/**
 * Purge old logs based on retention setting.
 */
function asl_handle_purge_logs(): void {
    global $wpdb;
    $table_name = $wpdb->prefix . REKURENCJA_ANTISPAM_LOG_TABLE;
    $settings = get_option( 'asl_settings', array() );
    $days     = (int) ( $settings['log_retention_d'] ?? 0 );
    if ( $days <= 0 ) {
        // A zero retention setting means no retained diagnostic rows.
        // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
        $wpdb->query( "DELETE FROM {$table_name}" );
        return;
    }
    $cutoff     = gmdate( 'Y-m-d H:i:s', time() - ( $days * DAY_IN_SECONDS ) );
    // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
    $wpdb->query( $wpdb->prepare( "DELETE FROM {$table_name} WHERE time < %s", $cutoff ) );
}

add_action(
    'plugins_loaded',
    function () {
        load_plugin_textdomain(
            REKURENCJA_ANTISPAM_TEXT_DOMAIN,
            false,
            dirname( plugin_basename( __FILE__ ) ) . '/languages'
        );
    }
);

// Enqueue lightweight admin styles for the settings page (bento grid layout).
add_action(
    'admin_enqueue_scripts',
    function ( $hook ) {
        if ( 'settings_page_antispam-lite' !== $hook ) {
            return;
        }
        wp_enqueue_style(
            'asl-admin',
            plugins_url( 'assets/admin.css', __FILE__ ),
            array(),
            REKURENCJA_ANTISPAM_VERSION
        );
        wp_enqueue_script(
            'asl-admin',
            plugins_url( 'assets/admin.js', __FILE__ ),
            array(),
            REKURENCJA_ANTISPAM_VERSION,
            true
        );
    }
);

add_action(
    'admin_init',
    function () {
        if ( function_exists( 'wp_add_privacy_policy_content' ) ) {
            wp_add_privacy_policy_content(
                __( 'AntiSpam Lite', REKURENCJA_ANTISPAM_TEXT_DOMAIN ),
                wp_kses_post( __( 'Ta strona używa AntiSpam Lite do ochrony przed spamem. Wtyczka nie zapisuje treści formularzy ani adresów IP w logach diagnostycznych. Krótkotrwałe, pseudonimowe liczniki prób mogą być przechowywane zgodnie z ustawionym oknem limitu.', REKURENCJA_ANTISPAM_TEXT_DOMAIN ) )
            );
        }
    }
);

require_once REKURENCJA_ANTISPAM_DIR . 'inc/rules.php';
require_once REKURENCJA_ANTISPAM_DIR . 'inc/hooks.php';
