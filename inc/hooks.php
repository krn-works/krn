<?php
/**
 * Admin and front hooks for AntiSpam Lite.
 *
 * @package AntiSpam Lite
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Editor polyfill: WordPress defines this. Guarded to avoid redefining at runtime.
if ( ! defined( 'HOUR_IN_SECONDS' ) ) {
	define( 'HOUR_IN_SECONDS', 3600 );
}
if ( ! defined( 'DAY_IN_SECONDS' ) ) {
	define( 'DAY_IN_SECONDS', 86400 );
}

/**
 * Insert log entry into DB.
 *
 * @param string $type     Event type: comment|cf7.
 * @param string $decision Decision made: allow|moderate|block|spam.
 * @param int    $score    Calculated score.
 * @param string $content  Sample content/excerpt.
 * @param array  $reasons  Reasons array from scorer.
 * @param array  $extra    Extra context data.
 */
function asl_log_event( string $type, string $decision, int $score, string $content = '', array $reasons = array(), array $extra = array() ) : void {
	$settings = get_option( 'asl_settings', array() );
	if ( (int) ( $settings['log_retention_d'] ?? 0 ) <= 0 ) {
		return;
	}

	global $wpdb;
	$table = $wpdb->prefix . REKURENCJA_ANTISPAM_LOG_TABLE;
	$wpdb->insert(
		$table,
		array(
			'time'      => current_time( 'mysql', true ),
			'type'      => $type,
			'source_ip' => null,
			'score'     => $score,
			'decision'  => $decision,
			'content'   => '',
			'reasons'   => wp_json_encode( $reasons ),
			'extra'     => wp_json_encode( $extra ),
		),
		array( '%s', '%s', '%s', '%d', '%s', '%s', '%s', '%s' )
	);
}

add_filter( 'pre_comment_content', 'asl_filter_comment_content', 9 );
add_filter( 'pre_comment_approved', 'asl_gate_comment', 9, 2 );
add_action( 'admin_notices', 'asl_check_conflicts' );

/**
 * Return normalized CF7 protection settings.
 *
 * @return array{min_completion_s:int,attempt_limit:int,attempt_window_s:int,ip_limit:int,ip_window_s:int,identity_limit:int,identity_window_s:int}
 */
function asl_cf7_protection_settings(): array {
	$settings = (array) get_option( 'asl_settings', array() );

	return array(
		'min_completion_s'  => max( 1, (int) ( $settings['cf7_min_completion_s'] ?? 3 ) ),
		'attempt_limit'     => max( 0, (int) ( $settings['cf7_attempt_limit'] ?? 0 ) ),
		'attempt_window_s'  => max( 1, (int) ( $settings['cf7_attempt_window_m'] ?? 15 ) ) * MINUTE_IN_SECONDS,
		'ip_limit'          => max( 0, (int) ( $settings['cf7_ip_limit'] ?? 10 ) ),
		'ip_window_s'       => max( 1, (int) ( $settings['cf7_ip_window_m'] ?? 15 ) ) * MINUTE_IN_SECONDS,
		'identity_limit'    => max( 0, (int) ( $settings['cf7_identity_limit'] ?? 3 ) ),
		'identity_window_s' => max( 1, (int) ( $settings['cf7_identity_window_h'] ?? 24 ) ) * HOUR_IN_SECONDS,
	);
}

/**
 * Append privacy-safe CF7 traps to every rendered form.
 *
 * @param string $content Existing form markup.
 */
function asl_cf7_form_traps( string $content ): string {
	$started_at = (string) time();
	$signature  = hash_hmac( 'sha256', $started_at, wp_salt( 'nonce' ) );
	$turnstile  = asl_turnstile_enabled() && '' !== asl_turnstile_site_key()
		? '<div class="cf-turnstile" data-sitekey="' . esc_attr( asl_turnstile_site_key() ) . '"></div>'
		: '';

	if ( '' !== $turnstile && function_exists( 'wp_enqueue_script' ) ) {
		wp_enqueue_script(
			'asl-turnstile-api',
			'https://challenges.cloudflare.com/turnstile/v0/api.js',
			array(),
			null,
			false
		);
	}

	return $content . sprintf(
		'<div hidden aria-hidden="true"><label>Leave this field blank<input type="text" name="asl_website" value="" tabindex="-1" autocomplete="off"></label></div><input type="hidden" name="asl_started_at" value="%s.%s">%s',
		esc_attr( $started_at ),
		esc_attr( $signature ),
		$turnstile
	);
}
add_filter( 'wpcf7_form_elements', 'asl_cf7_form_traps', 15 );

/**
 * Return the configured public Turnstile site key.
 *
 * Keys are supplied as wp-config constants, never stored in form logs.
 */
function asl_turnstile_site_key(): string {
	return defined( 'REKURENCJA_ANTISPAM_TURNSTILE_SITE_KEY' )
		? trim( (string) constant( 'REKURENCJA_ANTISPAM_TURNSTILE_SITE_KEY' ) )
		: '';
}

/**
 * Return the configured private Turnstile secret key.
 */
function asl_turnstile_secret_key(): string {
	return defined( 'REKURENCJA_ANTISPAM_TURNSTILE_SECRET_KEY' )
		? trim( (string) constant( 'REKURENCJA_ANTISPAM_TURNSTILE_SECRET_KEY' ) )
		: '';
}

/**
 * Whether Turnstile is explicitly enabled for CF7.
 */
function asl_turnstile_enabled(): bool {
	$settings = (array) get_option( 'asl_settings', array() );
	return ! empty( $settings['turnstile_enabled'] );
}

/**
 * Verify the current CF7 Turnstile response.
 *
 * @return string|null Failure reason, or null when verified.
 */
function asl_turnstile_failure_reason(): ?string {
	if ( ! asl_turnstile_enabled() ) {
		return null;
	}

	$secret = asl_turnstile_secret_key();
	if ( '' === $secret || '' === asl_turnstile_site_key() ) {
		return 'turnstile-not-configured';
	}

	$response_token = sanitize_text_field( wp_unslash( $_POST['cf-turnstile-response'] ?? '' ) );
	if ( '' === $response_token ) {
		return 'turnstile';
	}

	$response = wp_remote_post(
		'https://challenges.cloudflare.com/turnstile/v0/siteverify',
		array(
			'timeout' => 3,
			'body'    => array(
				'secret'   => $secret,
				'response' => $response_token,
				'remoteip' => sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ?? '' ) ),
			),
		)
	);

	if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
		return 'turnstile';
	}

	$body = json_decode( (string) wp_remote_retrieve_body( $response ), true );
	return is_array( $body ) && ! empty( $body['success'] ) ? null : 'turnstile';
}

/**
 * Validate a signed form-render timestamp.
 *
 * @param string $token Signed timestamp from the form.
 */
function asl_cf7_started_token_is_valid( string $token ): bool {
	if ( 1 !== preg_match( '/^(\d{10})\.([a-f0-9]{64})$/', $token, $matches ) ) {
		return false;
	}

	$expected = hash_hmac( 'sha256', $matches[1], wp_salt( 'nonce' ) );
	$settings = asl_cf7_protection_settings();

	return hash_equals( $expected, $matches[2] )
		&& time() - (int) $matches[1] >= $settings['min_completion_s'];
}

/**
 * Return the active CF7 form ID when available.
 */
function asl_cf7_current_form_id(): int {
	if ( ! class_exists( 'WPCF7_ContactForm' ) ) {
		return 0;
	}

	$form = WPCF7_ContactForm::get_current();
	return $form instanceof WPCF7_ContactForm ? (int) $form->id() : 0;
}

/**
 * Build a pseudonymous rate-limit key for the current IP and form.
 *
 * @param string   $prefix  Transient-key namespace.
 * @param int|null $form_id Explicit CF7 form ID.
 */
function asl_cf7_form_ip_rate_key( string $prefix, ?int $form_id = null ): string {
	$form_id ??= asl_cf7_current_form_id();
	$address   = sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ?? '' ) );
	if ( '' === $address ) {
		return '';
	}

	$identity = $form_id . '|' . $address;
	return $prefix . substr( hash_hmac( 'sha256', $identity, wp_salt( 'auth' ) ), 0, 32 );
}

/**
 * Build the accepted-submission counter key for the current IP and form.
 *
 * @param int|null $form_id Explicit CF7 form ID.
 */
function asl_cf7_ip_rate_key( ?int $form_id = null ): string {
	return asl_cf7_form_ip_rate_key( 'asl_cf7_ip_', $form_id );
}

/**
 * Build the attempted-submission counter key for the current IP and form.
 *
 * @param int|null $form_id Explicit CF7 form ID.
 */
function asl_cf7_attempt_rate_key( ?int $form_id = null ): string {
	return asl_cf7_form_ip_rate_key( 'asl_cf7_attempt_', $form_id );
}

/**
 * Find common identity fields while keeping an integration filter for custom forms.
 *
 * @param array<string, mixed> $posted_data Submitted values.
 * @return list<string>
 */
function asl_cf7_identity_field_names( array $posted_data ): array {
	$fields = array();
	foreach ( array_keys( $posted_data ) as $name ) {
		$field = strtolower( (string) $name );
		if ( 1 === preg_match( '/(?:^|[-_])(name|email|e-?mail|phone|telephone|telefon|tel|mobile|imie|imię|nazwisko)(?:$|[-_])/u', $field ) ) {
			$fields[] = (string) $name;
		}
	}

	/**
	 * Customize fields used for pseudonymous CF7 identity limits.
	 *
	 * @param list<string>        $fields      Detected identity field names.
	 * @param array<string,mixed> $posted_data Current submitted values.
	 */
	$filtered = apply_filters( 'rekurencja_antispam_cf7_identity_fields', $fields, $posted_data );
	if ( ! is_array( $filtered ) ) {
		return $fields;
	}

	return array_values( array_unique( array_map( 'strval', $filtered ) ) );
}

/**
 * Normalize an identity without persisting its raw value.
 *
 * @param string $field Field name.
 * @param string $value Submitted value.
 */
function asl_cf7_normalize_identity( string $field, string $value ): string {
	$value = trim( (string) preg_replace( '/\s+/u', ' ', sanitize_text_field( wp_unslash( $value ) ) ) );
	if ( 1 === preg_match( '/(?:phone|telephone|telefon|tel|mobile)/i', $field ) ) {
		return (string) preg_replace( '/\D+/', '', $value );
	}

	return function_exists( 'mb_strtolower' ) ? mb_strtolower( $value, 'UTF-8' ) : strtolower( $value );
}

/**
 * Build HMAC-only counters for stable submitted identities.
 *
 * @param int|null $form_id Explicit CF7 form ID.
 * @return list<string>
 */
function asl_cf7_identity_rate_keys( ?int $form_id = null ): array {
	$form_id ??= asl_cf7_current_form_id();
	$keys      = array();
	$posted    = (array) $_POST;

	foreach ( asl_cf7_identity_field_names( $posted ) as $field ) {
		$raw_value = $posted[ $field ] ?? '';
		if ( ! is_scalar( $raw_value ) ) {
			continue;
		}

		$value = asl_cf7_normalize_identity( $field, (string) $raw_value );
		if ( '' === $value ) {
			continue;
		}

		$identity = $form_id . '|' . $field . '|' . $value;
		$keys[]   = 'asl_cf7_identity_' . substr( hash_hmac( 'sha256', $identity, wp_salt( 'auth' ) ), 0, 32 );
	}

	return array_values( array_unique( $keys ) );
}

/**
 * Return the first request-guard reason, or null when the request may proceed.
 */
function asl_cf7_request_guard_reason(): ?string {
	$settings = (array) get_option( 'asl_settings', array() );
	if ( ! empty( $settings['safe_mode'] ) ) {
		return null;
	}

	$honeypot = sanitize_text_field(
		wp_unslash( $_POST['asl_website'] ?? $_POST['sawaryn_website'] ?? '' )
	);
	$token = sanitize_text_field(
		wp_unslash( $_POST['asl_started_at'] ?? $_POST['sawaryn_started_at'] ?? '' )
	);

	if ( '' !== trim( $honeypot ) ) {
		return 'honeypot';
	}
	if ( ! asl_cf7_started_token_is_valid( $token ) ) {
		return 'completion-time';
	}
	$turnstile_failure = asl_turnstile_failure_reason();
	if ( null !== $turnstile_failure ) {
		return $turnstile_failure;
	}

	$protection = asl_cf7_protection_settings();
	$ip_key     = asl_cf7_ip_rate_key();
	if ( $protection['ip_limit'] > 0 && '' !== $ip_key && (int) get_transient( $ip_key ) >= $protection['ip_limit'] ) {
		return 'ip-rate';
	}

	if ( $protection['identity_limit'] > 0 ) {
		foreach ( asl_cf7_identity_rate_keys() as $key ) {
			if ( (int) get_transient( $key ) >= $protection['identity_limit'] ) {
				return 'identity-rate';
			}
		}
	}

	return null;
}

/**
 * Record a verified CF7 attempt in a fixed window.
 *
 * This runs from the global CF7 validation seam, before CFDB7 and mail hooks.
 *
 * @return array{reason:?string,log:bool}
 */
function asl_cf7_attempt_guard(): array {
	$settings = (array) get_option( 'asl_settings', array() );
	if ( ! empty( $settings['safe_mode'] ) ) {
		return array(
			'reason' => null,
			'log'    => false,
		);
	}

	$protection = asl_cf7_protection_settings();
	$key        = asl_cf7_attempt_rate_key();
	if ( $protection['attempt_limit'] <= 0 || '' === $key ) {
		return array(
			'reason' => null,
			'log'    => false,
		);
	}

	$now   = time();
	$state = get_transient( $key );
	if ( ! is_array( $state ) || (int) ( $state['expires_at'] ?? 0 ) <= $now ) {
		$state = array(
			'count'          => 0,
			'expires_at'     => $now + $protection['attempt_window_s'],
			'blocked_logged' => false,
		);
	}

	$state['count'] = min( $protection['attempt_limit'] + 1, (int) ( $state['count'] ?? 0 ) + 1 );
	$blocked        = $state['count'] > $protection['attempt_limit'];
	$should_log     = $blocked && empty( $state['blocked_logged'] );
	if ( $blocked ) {
		$state['blocked_logged'] = true;
	}

	$ttl = max( 1, (int) $state['expires_at'] - $now );
	set_transient( $key, $state, $ttl );

	return array(
		'reason' => $blocked ? 'attempt-rate' : null,
		'log'    => $should_log,
	);
}

/**
 * Return a public CF7 verification message in the current language.
 */
function asl_cf7_verification_message(): string {
	$locale       = function_exists( 'determine_locale' ) ? determine_locale() : get_locale();
	$request_path = (string) ( $_SERVER['REQUEST_URI'] ?? '' );
	$is_english   = str_starts_with( strtolower( (string) $locale ), 'en' )
		|| str_starts_with( $request_path, '/en/' )
		|| str_starts_with( $request_path, '/publications/' );

	return $is_english
		? __( 'We could not verify the form. Refresh the page and try again.', 'lightweight-rekurencja-antyspam' )
		: __( 'Nie udało się zweryfikować formularza. Odśwież stronę i spróbuj ponownie.', 'lightweight-rekurencja-antyspam' );
}

/**
 * Contact Form 7: expose request-guard failures as field validation errors.
 *
 * @param mixed $result CF7 validation result.
 * @param array $tags   Form tags.
 * @return mixed
 */
function asl_cf7_validate_request( $result, array $tags ) {
	$reason     = asl_cf7_request_guard_reason();
	$should_log = null !== $reason;
	if ( null === $reason ) {
		$attempt_guard = asl_cf7_attempt_guard();
		$reason        = $attempt_guard['reason'];
		$should_log    = $attempt_guard['log'];
	}
	if ( null === $reason ) {
		return $result;
	}

	foreach ( $tags as $tag ) {
		$name = is_object( $tag ) && isset( $tag->name ) ? (string) $tag->name : '';
		if ( '' !== $name && ! in_array( $name, array( 'submit', 'acceptance' ), true ) ) {
			if ( is_object( $result ) && method_exists( $result, 'invalidate' ) ) {
				$result->invalidate( $tag, asl_cf7_verification_message() );
			}
			break;
		}
	}

	if ( $should_log ) {
		asl_log_event( 'cf7', 'spam', 0, '', array( $reason ), array( 'form_id' => asl_cf7_current_form_id() ) );
	}
	return $result;
}
add_filter( 'wpcf7_validate', 'asl_cf7_validate_request', 15, 2 );

/**
 * Record an accepted CF7 submission for short-lived IP and identity limits.
 *
 * @param mixed $form CF7 contact form.
 */
function asl_cf7_record_accepted_submission( $form ): void {
	$settings = (array) get_option( 'asl_settings', array() );
	if ( ! empty( $settings['safe_mode'] ) ) {
		return;
	}

	$form_id    = is_object( $form ) && method_exists( $form, 'id' ) ? (int) $form->id() : 0;
	$protection = asl_cf7_protection_settings();
	$ip_key     = asl_cf7_ip_rate_key( $form_id );

	if ( $protection['ip_limit'] > 0 && '' !== $ip_key ) {
		set_transient( $ip_key, (int) get_transient( $ip_key ) + 1, $protection['ip_window_s'] );
	}

	if ( $protection['identity_limit'] > 0 ) {
		foreach ( asl_cf7_identity_rate_keys( $form_id ) as $key ) {
			set_transient( $key, (int) get_transient( $key ) + 1, $protection['identity_window_s'] );
		}
	}
}
add_action( 'wpcf7_mail_sent', 'asl_cf7_record_accepted_submission', 10 );

/**
 * Return a configured diagnostic BCC address, or an empty string.
 */
function asl_diagnostic_bcc_address(): string {
	$settings = (array) get_option( 'asl_settings', array() );
	$mailbox  = sanitize_email( (string) ( $settings['diagnostic_bcc'] ?? '' ) );

	return is_email( $mailbox ) ? $mailbox : '';
}

/**
 * Append a BCC header once.
 *
 * @param string $headers Existing headers.
 * @param string $mailbox Diagnostic mailbox.
 */
function asl_append_diagnostic_bcc( string $headers, string $mailbox ): string {
	if ( '' === $mailbox || false !== stripos( $headers, $mailbox ) ) {
		return $headers;
	}

	return rtrim( $headers ) . "\r\nBcc: {$mailbox}\r\n";
}

/**
 * Add the diagnostic copy to internal CF7 notifications, excluding autoresponders.
 *
 * @param array $components CF7 mail components.
 * @param mixed $form       CF7 contact form.
 * @param mixed $mail       CF7 mail template.
 * @return array
 */
function asl_cf7_diagnostic_copy( array $components, $form, $mail ): array {
	unset( $form );
	if ( is_object( $mail ) && method_exists( $mail, 'name' ) && 'mail_2' === $mail->name() ) {
		return $components;
	}

	$components['additional_headers'] = asl_append_diagnostic_bcc(
		(string) ( $components['additional_headers'] ?? '' ),
		asl_diagnostic_bcc_address()
	);

	return $components;
}
add_filter( 'wpcf7_mail_components', 'asl_cf7_diagnostic_copy', 20, 3 );

/**
 * Add the diagnostic copy to WPForms notifications sent to an internal domain.
 *
 * @param array $data WPForms email data.
 * @return array
 */
function asl_wpforms_diagnostic_copy( array $data ): array {
	$settings = (array) get_option( 'asl_settings', array() );
	$mailbox  = asl_diagnostic_bcc_address();
	$domain   = strtolower( ltrim( sanitize_text_field( (string) ( $settings['diagnostic_domain'] ?? '' ) ), '@' ) );
	$domain   = (string) preg_replace( '/[^a-z0-9.-]/', '', $domain );
	if ( '' === $mailbox || '' === $domain ) {
		return $data;
	}

	$raw_recipients = $data['to'] ?? '';
	if ( is_array( $raw_recipients ) ) {
		$recipients = array_map( 'strval', $raw_recipients );
	} else {
		$split_recipients = preg_split( '/\s*,\s*/', (string) $raw_recipients, -1, PREG_SPLIT_NO_EMPTY );
		$recipients       = is_array( $split_recipients ) ? $split_recipients : array();
	}
	$is_internal = array_filter(
		$recipients,
		static fn( string $recipient ): bool => str_ends_with( strtolower( trim( $recipient ) ), '@' . $domain )
	);

	if ( ! empty( $is_internal ) ) {
		$data['headers'] = asl_append_diagnostic_bcc( (string) ( $data['headers'] ?? '' ), $mailbox );
	}

	return $data;
}
add_filter( 'wpforms_emails_send_email_data', 'asl_wpforms_diagnostic_copy', 20 );

/**
 * Build the scoring text without technical, consent, or phone fields.
 *
 * @param array<string, mixed> $posted_data Submitted CF7 values.
 */
function asl_cf7_scoring_text( array $posted_data ): string {
	$text_parts = array();
	foreach ( $posted_data as $name => $value ) {
		$field = strtolower( (string) $name );
		if ( preg_match( '/(?:^_|turnstile|token|started|honeypot|website|privacy|accept|consent|newsletter|submit|phone|telefon|\btel\b)/', $field ) ) {
			continue;
		}

		if ( is_scalar( $value ) ) {
			$text_parts[] = (string) $value;
		} elseif ( is_array( $value ) ) {
			$text_parts[] = implode( ' ', array_map( 'strval', $value ) );
		}
	}

	return implode( "\n", $text_parts );
}

/**
 * Contact Form 7: mark submission as spam if score exceeds thresholds.
 *
 * @param bool                  $is_spam    Existing spam flag.
 * @param WPCF7_Submission|null $submission Submission context.
 * @return bool Whether the submission is spam.
 */
function asl_cf7_spam_check( $is_spam, $submission = null ) {
	// Honor previous decision.
	if ( $is_spam ) {
		return true;
	}

	// Obtain submission data.
	if ( ! $submission && class_exists( 'WPCF7_Submission' ) ) {
		$submission = WPCF7_Submission::get_instance();
	}
	if ( ! $submission || ! method_exists( $submission, 'get_posted_data' ) ) {
		return false;
	}

	$posted_data = (array) $submission->get_posted_data();
	$joined_text = asl_cf7_scoring_text( $posted_data );

	$score_and = asl_score_text( $joined_text, true );
	$score     = is_array( $score_and ) ? (int) $score_and[0] : (int) $score_and;
	$reasons   = is_array( $score_and ) ? (array) $score_and[1] : array();
	$settings  = get_option( 'asl_settings', array() );

	$threshold_soft = (int) ( $settings['threshold_soft'] ?? 30 );
	$threshold_hard = (int) ( $settings['threshold_block'] ?? 70 );
	$safe_mode      = (bool) ( $settings['safe_mode'] ?? false );

	$form  = method_exists( $submission, 'get_contact_form' ) ? $submission->get_contact_form() : null;
	$extra = array( 'form_id' => is_object( $form ) && method_exists( $form, 'id' ) ? (int) $form->id() : 0 );
	if ( $safe_mode ) {
		asl_log_event( 'cf7', 'observe', $score, '', $reasons, $extra );
		return false;
	}

	if ( $score >= $threshold_hard ) {
		asl_log_event( 'cf7', 'spam', $score, '', $reasons, $extra );
		return true;
	}
	if ( $score >= $threshold_soft ) {
		asl_log_event( 'cf7', 'spam', $score, '', $reasons, $extra );
		return true;
	}

	asl_log_event( 'cf7', 'allow', $score, '', $reasons, $extra );
	return false;
}
add_filter( 'wpcf7_spam', 'asl_cf7_spam_check', 10, 2 );

add_action(
	'admin_menu',
	function () {
		add_options_page(
			__( 'Rekurencja Antyspam', 'antispam-lite' ),
			__( 'Rekurencja Antyspam', 'antispam-lite' ),
			'manage_options',
			'antispam-lite',
			'asl_render_settings_page'
		);
	}
);
add_action(
	'admin_init',
	function () {
		register_setting( 'asl_group', 'asl_settings', 'asl_sanitize_settings' );
	}
);

/**
 * Sanitize settings from the options form.
 *
 * @param array $input Raw input.
 * @return array Sanitized settings.
 */
function asl_sanitize_settings( $input ) {
	$output                         = array();
	$output['threshold_soft']       = intval( $input['threshold_soft'] ?? 30 );
	$output['threshold_block']      = intval( $input['threshold_block'] ?? 70 );
	$output['safe_mode']            = isset( $input['safe_mode'] );
	$output['allow_urls']           = isset( $input['allow_urls'] );
	$output['allowlist']            = array_filter( array_map( 'trim', explode( "\n", sanitize_textarea_field( $input['allowlist'] ?? '' ) ) ) );
	$output['denylist']             = array_filter( array_map( 'trim', explode( "\n", sanitize_textarea_field( $input['denylist'] ?? '' ) ) ) );
	$output['log_retention_d']      = intval( $input['log_retention_d'] ?? 0 );
	// Reputation settings.
	$output['enable_dnsbl']         = isset( $input['enable_dnsbl'] );
	$output['enable_surbl']         = isset( $input['enable_surbl'] );
	$output['enable_whois']         = isset( $input['enable_whois'] );
	$output['reputation_cache_ttl'] = max( 5, intval( $input['reputation_cache_ttl'] ?? 360 ) );
	$output['dns_timeout_ms']       = max( 100, intval( $input['dns_timeout_ms'] ?? 800 ) );
	$output['whois_timeout_ms']     = max( 200, intval( $input['whois_timeout_ms'] ?? 1200 ) );
	$output['whois_age_days']       = max( 1, intval( $input['whois_age_days'] ?? 90 ) );
	$output['weight_dnsbl']         = intval( $input['weight_dnsbl'] ?? 15 );
	$output['weight_surbl']         = intval( $input['weight_surbl'] ?? 12 );
	$output['weight_whois_young']   = intval( $input['weight_whois_young'] ?? 10 );
	// Custom spam keywords.
	$output['keywords_bonus']       = array_filter( array_map( 'trim', explode( "\n", sanitize_textarea_field( $input['keywords_bonus'] ?? '' ) ) ) );
	$output['weight_keyword']       = intval( $input['weight_keyword'] ?? 8 );
	$output['keywords_deny']        = array_filter( array_map( 'trim', explode( "\n", sanitize_textarea_field( $input['keywords_deny'] ?? '' ) ) ) );
	$output['keyword_min_len']      = max( 2, intval( $input['keyword_min_len'] ?? 3 ) );
	// Contact Form 7 request protection.
	$output['cf7_min_completion_s']  = min( 60, max( 1, intval( $input['cf7_min_completion_s'] ?? 3 ) ) );
	$output['cf7_attempt_limit']     = min( 100, max( 0, intval( $input['cf7_attempt_limit'] ?? 0 ) ) );
	$output['cf7_attempt_window_m']  = min( 1440, max( 1, intval( $input['cf7_attempt_window_m'] ?? 15 ) ) );
	$output['cf7_ip_limit']          = min( 100, max( 0, intval( $input['cf7_ip_limit'] ?? 10 ) ) );
	$output['cf7_ip_window_m']       = min( 1440, max( 1, intval( $input['cf7_ip_window_m'] ?? 15 ) ) );
	$output['cf7_identity_limit']    = min( 100, max( 0, intval( $input['cf7_identity_limit'] ?? 3 ) ) );
	$output['cf7_identity_window_h'] = min( 720, max( 1, intval( $input['cf7_identity_window_h'] ?? 24 ) ) );
	// Optional diagnostic copies.
	$output['diagnostic_bcc']       = sanitize_email( (string) ( $input['diagnostic_bcc'] ?? '' ) );
	$output['diagnostic_domain']    = strtolower( ltrim( sanitize_text_field( (string) ( $input['diagnostic_domain'] ?? '' ) ), '@' ) );
	// Per-language keyword buckets are not edited via form; preserve existing arrays.
	$existing                      = get_option( 'asl_settings', array() );
	$output['kw_lang_bonus']       = ( isset( $existing['kw_lang_bonus'] ) && is_array( $existing['kw_lang_bonus'] ) ) ? $existing['kw_lang_bonus'] : array();
	$output['kw_lang_deny']        = ( isset( $existing['kw_lang_deny'] ) && is_array( $existing['kw_lang_deny'] ) ) ? $existing['kw_lang_deny'] : array();
	return $output;
}

/**
 * Normalize comment content before processing.
 *
 * @param string $content Comment content.
 * @return string Normalized content.
 */
function asl_filter_comment_content( string $content ): string {
	return asl_normalize_text( $content );
}

/**
 * Decide comment moderation/approval based on spam score.
 *
 * @param mixed $approved    Current approval value.
 * @param array $commentdata Comment data.
 * @return mixed New approval value.
 */
function asl_gate_comment( $approved, array $commentdata ) {
	$settings  = get_option( 'asl_settings', array() );
	$score_and = asl_score_text( $commentdata['comment_content'] ?? '', true );
	$score     = is_array( $score_and ) ? (int) $score_and[0] : (int) $score_and;
	$reasons   = is_array( $score_and ) ? (array) $score_and[1] : array();

	$ip            = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
	$transient_key = 'asl_rate_' . md5( $ip );
	$attempts      = get_transient( $transient_key );
	$attempts      = false !== $attempts ? $attempts : 0;
	if ( $attempts >= 5 ) {
		$score += 20;
	}
	set_transient( $transient_key, $attempts + 1, HOUR_IN_SECONDS );

	if ( $settings['safe_mode'] ?? false ) {
		asl_log_event( 'comment', 'observe', $score, '', $reasons );
		return $approved;
	}

	if ( $score >= (int) ( $settings['threshold_block'] ?? 70 ) ) {
		do_action( 'asl_blocked_comment', $score, $commentdata );
		asl_log_event( 'comment', 'spam', $score, '', $reasons );
		return 'spam';
	}
	if ( $score >= (int) ( $settings['threshold_soft'] ?? 30 ) ) {
		asl_log_event( 'comment', 'moderate', $score, '', $reasons );
		return 0;
	}
	asl_log_event( 'comment', 'allow', $score, '', $reasons );
	return $approved;
}

/**
 * Render the plugin settings page.
 */
function asl_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}

	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Viewing admin page state.
	$active_tab = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'settings';
	$tabs       = array(
		'settings' => __( 'Settings', 'antispam-lite' ),
		'logs'     => __( 'Logs', 'antispam-lite' ),
	);
	echo '<div class="wrap">';
	echo '<h1>' . esc_html__( 'Rekurencja Antyspam', 'antispam-lite' ) . '</h1>';
	echo '<h2 class="nav-tab-wrapper">';
	foreach ( $tabs as $tab_key => $tab_label ) {
		$url = add_query_arg( 'tab', $tab_key, admin_url( 'options-general.php?page=antispam-lite' ) );
		$cls = 'nav-tab' . ( $active_tab === $tab_key ? ' nav-tab-active' : '' );
		echo '<a class="' . esc_attr( $cls ) . '" href="' . esc_url( $url ) . '">' . esc_html( $tab_label ) . '</a>';
	}
	echo '</h2>';

	if ( 'logs' === $active_tab ) {
		asl_render_logs_tab();
		echo '</div>';
		return;
	}

	echo '<form method="post" action="options.php">';
	settings_fields( 'asl_group' );
	$s = get_option( 'asl_settings', array() );

	echo '<div class="asl-grid">';

	// Card: Help / summary.
	echo '<div class="asl-card asl-theme-soft asl-span-12"><h2>' . esc_html__( 'Jak to działa', 'antispam-lite' ) . '</h2>';
		echo '<p>' . esc_html__( 'Soft‑deny: komentarze trafiają do moderacji, a CF7 oznacza zgłoszenie jako spam. Hard‑block oznacza komentarz jako spam. Tryb obserwacyjny nigdy nie zmienia dostarczenia CF7.', 'antispam-lite' ) . '</p>';
		echo '</div>';

	echo '<div class="asl-card asl-span-4"><h3 id="asl-sec-thresholds">' . esc_html__( 'Progi ryzyka', 'antispam-lite' ) . '</h3>';
		echo '<div class="asl-row"><label>' . esc_html__( 'Soft-deny (moderacja):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[threshold_soft]" value="' . esc_attr( $s['threshold_soft'] ?? 30 ) . '" min="0" max="100" /></label>';
		echo '<label>' . esc_html__( 'Hard-block (spam):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[threshold_block]" value="' . esc_attr( $s['threshold_block'] ?? 70 ) . '" min="0" max="100" /></label></div>';
		echo '</div>';

	echo '<div class="asl-card asl-span-8"><h3 id="asl-sec-reputation">' . esc_html__( 'Reputacja domen (DNS/WHOIS)', 'antispam-lite' ) . '</h3>';
		echo '<div class="asl-row"><label><input type="checkbox" name="asl_settings[enable_dnsbl]" ' . checked( $s['enable_dnsbl'] ?? false, true, false ) . ' /> ' . esc_html__( 'Włącz DNSBL/URIBL/SURBL', 'antispam-lite' ) . '</label>';
		echo '<label><input type="checkbox" name="asl_settings[enable_surbl]" ' . checked( $s['enable_surbl'] ?? false, true, false ) . ' /> ' . esc_html__( 'Włącz SURBL', 'antispam-lite' ) . '</label>';
		echo '<label><input type="checkbox" name="asl_settings[enable_whois]" ' . checked( $s['enable_whois'] ?? false, true, false ) . ' /> ' . esc_html__( 'Włącz WHOIS (RDAP) i karę dla młodych domen', 'antispam-lite' ) . '</label></div>';
		echo '<div class="asl-divider"></div>';
		echo '<div class="asl-row"><label>' . esc_html__( 'Cache TTL (minuty):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[reputation_cache_ttl]" value="' . esc_attr( $s['reputation_cache_ttl'] ?? 360 ) . '" min="5" /></label>';
		echo '<label>' . esc_html__( 'DNS timeout (ms):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[dns_timeout_ms]" value="' . esc_attr( $s['dns_timeout_ms'] ?? 800 ) . '" min="100" /></label>';
		echo '<label>' . esc_html__( 'WHOIS timeout (ms):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[whois_timeout_ms]" value="' . esc_attr( $s['whois_timeout_ms'] ?? 1200 ) . '" min="200" /></label>';
		echo '<label>' . esc_html__( 'WHOIS: wiek domeny < (dni):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[whois_age_days]" value="' . esc_attr( $s['whois_age_days'] ?? 90 ) . '" min="1" /></label></div>';
		echo '<div class="asl-divider"></div>';
		echo '<div class="asl-row"><label>' . esc_html__( 'Waga: DNSBL hit (+):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[weight_dnsbl]" value="' . esc_attr( $s['weight_dnsbl'] ?? 15 ) . '" /></label>';
		echo '<label>' . esc_html__( 'Waga: SURBL hit (+):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[weight_surbl]" value="' . esc_attr( $s['weight_surbl'] ?? 12 ) . '" /></label>';
		echo '<label>' . esc_html__( 'Waga: WHOIS młoda (+):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[weight_whois_young]" value="' . esc_attr( $s['weight_whois_young'] ?? 10 ) . '" /></label></div>';
		echo '</div>';

	echo '<div class="asl-card asl-span-4 asl-theme-light"><h3 id="asl-sec-keywords">' . esc_html__( 'Słowa kluczowe spamu', 'antispam-lite' ) . '</h3>';
		echo '<p><label>' . esc_html__( 'Słowa powodujące podbicie punktów:', 'antispam-lite' ) . '<br><textarea name="asl_settings[keywords_bonus]" rows="10" cols="80">' . esc_textarea( implode( "\n", $s['keywords_bonus'] ?? array() ) ) . '</textarea></label></p>';
		echo '</div>';
		echo '<div class="asl-card asl-span-4"><h3>' . esc_html__( 'Waga słów', 'antispam-lite' ) . '</h3>';
		echo '<p><label>' . esc_html__( 'Waga: słowo kluczowe (+):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[weight_keyword]" value="' . esc_attr( $s['weight_keyword'] ?? 8 ) . '" /></label></p>';
		echo '</div>';
		echo '<div class="asl-card asl-span-4"><h3>' . esc_html__( 'Natychmiastowy blok', 'antispam-lite' ) . '</h3>';
		echo '<p><label>' . esc_html__( 'Słowa powodujące natychmiastowy blok (deny):', 'antispam-lite' ) . '<br><textarea name="asl_settings[keywords_deny]" rows="10" cols="80">' . esc_textarea( implode( "\n", $s['keywords_deny'] ?? array() ) ) . '</textarea></label></p>';
		echo '<div class="asl-divider"></div>';
		echo '<p><label>' . esc_html__( 'Minimalna długość słowa (by uniknąć fałszywych trafień):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[keyword_min_len]" value="' . esc_attr( $s['keyword_min_len'] ?? 3 ) . '" min="2" max="16" /></label></p>';
		echo '</div>';

	echo '<div class="asl-card asl-span-4"><h3 id="asl-sec-links">' . esc_html__( 'Linki w wiadomościach', 'antispam-lite' ) . '</h3>';
		echo '<p><label><input type="checkbox" name="asl_settings[allow_urls]" ' . checked( $s['allow_urls'] ?? false, true, false ) . ' /> ' . esc_html__( 'Pozwól na linki bez kary (nie podbijaj wyniku za URL)', 'antispam-lite' ) . '</label></p>';
		echo '</div>';

	// Per-language keyword buckets (read-only display, user can paste into main boxes or upload files).
	$kw_lang_bonus = (array) ( $s['kw_lang_bonus'] ?? array() );
	$kw_lang_deny  = (array) ( $s['kw_lang_deny'] ?? array() );
	if ( ! empty( $kw_lang_bonus ) || ! empty( $kw_lang_deny ) ) {
		$lkeys = array_unique( array_merge( array_keys( $kw_lang_bonus ), array_keys( $kw_lang_deny ) ) );
		echo '<div class="asl-card asl-span-8 asl-collapsible collapsed">';
		echo '<div class="asl-collapsible-header"><h3 id="asl-sec-langwords">' . esc_html__( 'Słowa wg języka (z plików keywords/*.txt)', 'antispam-lite' ) . '</h3><span class="dashicons dashicons-arrow-down-alt2 asl-caret" aria-hidden="true"></span></div>';
		// Tabs
		echo '<div class="asl-tabs">';
		echo '<div class="asl-tab" data-lang="">' . esc_html__( 'Wszystkie', 'antispam-lite' ) . '</div>';
		foreach ( $lkeys as $lang ) {
			echo '<div class="asl-tab" data-lang="' . esc_attr( $lang ) . '">' . esc_html( $lang ) . '</div>';
		}
		echo '</div>';
		// Scrollbox + table
		echo '<div class="asl-collapsible-body asl-scrollbox">';
		echo '<table class="widefat fixed striped"><thead><tr>';
		echo '<th>' . esc_html__( 'Język', 'antispam-lite' ) . '</th>';
		echo '<th>' . esc_html__( 'Bonus (podnosi score)', 'antispam-lite' ) . '</th>';
		echo '<th>' . esc_html__( 'Deny (blokuje)', 'antispam-lite' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $lkeys as $lang ) {
			$bonus = implode( ', ', array_map( 'sanitize_text_field', (array) ( $kw_lang_bonus[ $lang ] ?? array() ) ) );
			$deny  = implode( ', ', array_map( 'sanitize_text_field', (array) ( $kw_lang_deny[ $lang ] ?? array() ) ) );
			echo '<tr>';
			echo '<td>' . esc_html( $lang ) . '</td>';
			echo '<td>' . esc_html( $bonus ) . '</td>';
			echo '<td>' . esc_html( $deny ) . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table></div>';
		echo '<p>' . esc_html__( 'Aby dodać nowy język, utwórz plik np. keywords/spam-words-XX.txt (lub ...-deny.txt). Po aktywacji wartości zostaną wczytane.', 'antispam-lite' ) . '</p>';
		echo '</div>';
	}

	echo '<div class="asl-card asl-span-6"><h3 id="asl-sec-lists">' . esc_html__( 'Allowlist', 'antispam-lite' ) . '</h3>';
		echo '<p><label>' . esc_html__( 'Allowlist (jedno na linię):', 'antispam-lite' ) . '<br><textarea name="asl_settings[allowlist]" rows="5" cols="50">' . esc_textarea( implode( "\n", $s['allowlist'] ?? array() ) ) . '</textarea></label></p>';
		echo '</div>';
		echo '<div class="asl-card asl-span-6"><h3>' . esc_html__( 'Denylist', 'antispam-lite' ) . '</h3>';
		echo '<p><label>' . esc_html__( 'Denylist (jedno na linię):', 'antispam-lite' ) . '<br><textarea name="asl_settings[denylist]" rows="5" cols="50">' . esc_textarea( implode( "\n", $s['denylist'] ?? array() ) ) . '</textarea></label></p>';
		echo '</div>';

	echo '<div class="asl-card asl-span-12"><h3 id="asl-sec-advanced">' . esc_html__( 'Zaawansowane', 'antispam-lite' ) . '</h3>';
		echo '<div class="asl-row"><label>' . esc_html__( 'Retencja tymczasowych logów (dni, 0 = brak):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[log_retention_d]" value="' . esc_attr( $s['log_retention_d'] ?? 0 ) . '" min="0" /></label>';
		echo '<label><input type="checkbox" name="asl_settings[safe_mode]" ' . checked( $s['safe_mode'] ?? false, true, false ) . ' /> ' . esc_html__( 'Tryb obserwacyjny (oceniaj i loguj, ale nie zmieniaj decyzji)', 'antispam-lite' ) . '</label></div>';
		echo '<div class="asl-divider"></div>';
		echo '<h4>' . esc_html__( 'Ochrona formularzy CF7', 'antispam-lite' ) . '</h4>';
		echo '<div class="asl-row"><label>' . esc_html__( 'Minimalny czas wypełnienia (sekundy):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[cf7_min_completion_s]" value="' . esc_attr( $s['cf7_min_completion_s'] ?? 3 ) . '" min="1" max="60" /></label>';
		echo '<label>' . esc_html__( 'Limit zweryfikowanych prób na IP (0 = wyłącz):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[cf7_attempt_limit]" value="' . esc_attr( $s['cf7_attempt_limit'] ?? 0 ) . '" min="0" max="100" /></label>';
		echo '<label>' . esc_html__( 'Okno limitu prób (minuty):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[cf7_attempt_window_m]" value="' . esc_attr( $s['cf7_attempt_window_m'] ?? 15 ) . '" min="1" max="1440" /></label></div>';
		echo '<div class="asl-row">';
		echo '<label>' . esc_html__( 'Limit przyjętych zgłoszeń na IP (0 = wyłącz):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[cf7_ip_limit]" value="' . esc_attr( $s['cf7_ip_limit'] ?? 10 ) . '" min="0" max="100" /></label>';
		echo '<label>' . esc_html__( 'Okno limitu IP (minuty):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[cf7_ip_window_m]" value="' . esc_attr( $s['cf7_ip_window_m'] ?? 15 ) . '" min="1" max="1440" /></label></div>';
		echo '<div class="asl-row"><label>' . esc_html__( 'Limit tej samej tożsamości (0 = wyłącz):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[cf7_identity_limit]" value="' . esc_attr( $s['cf7_identity_limit'] ?? 3 ) . '" min="0" max="100" /></label>';
		echo '<label>' . esc_html__( 'Okno limitu tożsamości (godziny):', 'antispam-lite' ) . ' <input type="number" name="asl_settings[cf7_identity_window_h]" value="' . esc_attr( $s['cf7_identity_window_h'] ?? 24 ) . '" min="1" max="720" /></label></div>';
		echo '<div class="asl-divider"></div>';
		echo '<h4>' . esc_html__( 'Kopie diagnostyczne powiadomień', 'antispam-lite' ) . '</h4>';
		echo '<div class="asl-row"><label>' . esc_html__( 'Adres BCC (pusty = wyłącz):', 'antispam-lite' ) . ' <input type="email" name="asl_settings[diagnostic_bcc]" value="' . esc_attr( $s['diagnostic_bcc'] ?? '' ) . '" /></label>';
		echo '<label>' . esc_html__( 'Wewnętrzna domena odbiorców WPForms:', 'antispam-lite' ) . ' <input type="text" name="asl_settings[diagnostic_domain]" value="' . esc_attr( $s['diagnostic_domain'] ?? '' ) . '" placeholder="example.com" /></label></div>';
		echo '</div>';

	submit_button();
	echo '</form></div>';
}

/**
 * Render logs tab content.
 */
function asl_render_logs_tab() {
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- Viewing admin page state.
	$paged  = max( 1, (int) ( $_GET['paged'] ?? 1 ) );
	$limit  = 50;
	$offset = ( $paged - 1 ) * $limit;

	global $wpdb;
	$table = $wpdb->prefix . REKURENCJA_ANTISPAM_LOG_TABLE;
	// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	$total = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" );
	// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	$rows  = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM {$table} ORDER BY time DESC LIMIT %d OFFSET %d", $limit, $offset ) );

	echo '<h2>' . esc_html__( 'Logs', 'antispam-lite' ) . '</h2>';
	echo '<table class="widefat fixed striped"><thead><tr>';
	echo '<th>' . esc_html__( 'Time (UTC)', 'antispam-lite' ) . '</th>';
	echo '<th>' . esc_html__( 'Type', 'antispam-lite' ) . '</th>';
	echo '<th>' . esc_html__( 'Score', 'antispam-lite' ) . '</th>';
	echo '<th>' . esc_html__( 'Decision', 'antispam-lite' ) . '</th>';
	echo '<th>' . esc_html__( 'Reasons', 'antispam-lite' ) . '</th>';
	echo '</tr></thead><tbody>';
	if ( $rows ) {
		foreach ( $rows as $r ) {
			$reasons = json_decode( (string) $r->reasons, true );
			$reasons = is_array( $reasons ) ? implode( ', ', array_map( 'sanitize_text_field', $reasons ) ) : '';
			echo '<tr>';
			echo '<td>' . esc_html( $r->time ) . '</td>';
			echo '<td>' . esc_html( $r->type ) . '</td>';
			echo '<td>' . esc_html( (string) $r->score ) . '</td>';
			echo '<td>' . esc_html( $r->decision ) . '</td>';
			echo '<td>' . esc_html( $reasons ) . '</td>';
			echo '</tr>';
		}
	} else {
		echo '<tr><td colspan="5">' . esc_html__( 'No logs.', 'antispam-lite' ) . '</td></tr>';
	}
	echo '</tbody></table>';

	$total_pages = (int) ceil( $total / $limit );
	if ( $total_pages > 1 ) {
		$base = add_query_arg( array( 'page' => 'antispam-lite', 'tab' => 'logs', 'paged' => '%#%' ), admin_url( 'options-general.php' ) );
		echo '<div class="tablenav"><div class="tablenav-pages">' . wp_kses_post( paginate_links(
			array(
				'base'      => $base,
				'format'    => '',
				'current'   => $paged,
				'total'     => $total_pages,
				'prev_text' => __( '&laquo;', 'antispam-lite' ),
				'next_text' => __( '&raquo;', 'antispam-lite' ),
			)
		) ) . '</div></div>';
	}
}

/**
 * Warn about potential conflicts with other anti-spam plugins.
 */
function asl_check_conflicts() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$conflicts      = array();
	$active_plugins = get_option( 'active_plugins', array() );
	$spam_plugins   = array(
		'akismet/akismet.php'             => 'Akismet',
		'antispam-bee/antispam_bee.php'   => 'Antispam Bee',
		'wp-spamshield/wp-spamshield.php' => 'WP SpamShield',
		'honeypot/honeypot.php'           => 'Honeypot',
	);
	foreach ( $spam_plugins as $plugin_file => $plugin_name ) {
		if ( in_array( $plugin_file, $active_plugins, true ) ) {
			$conflicts[] = $plugin_name;
		}
	}
	if ( ! empty( $conflicts ) ) {
		$conflict_list = implode( ', ', $conflicts );
		echo '<div class="notice notice-warning is-dismissible">';
		// translators: %s: Comma-separated list of plugin names.
		echo '<p><strong>' . esc_html__( 'AntiSpam Lite:', 'antispam-lite' ) . '</strong> ' . sprintf(
			/* translators: %s: Comma-separated list of plugin names. */
			esc_html__( 'Wykryto inne wtyczki anty-spam: %s. Może to powodować konflikty. Rozważ dezaktywację jednej z nich.', 'antispam-lite' ),
			esc_html( $conflict_list )
		) . '</p>';
		echo '</div>';
	}
}
