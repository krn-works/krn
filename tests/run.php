<?php
/** Focused runtime contract checks without booting WordPress. */

define( 'ABSPATH', __DIR__ . '/' );
define( 'REKURENCJA_ANTISPAM_LOG_TABLE', 'asl_logs' );
define( 'REKURENCJA_ANTISPAM_TEXT_DOMAIN', 'lightweight-rekurencja-antyspam' );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );
define( 'MINUTE_IN_SECONDS', 60 );
define( 'REKURENCJA_ANTISPAM_TURNSTILE_SITE_KEY', 'test-site-key' );
define( 'REKURENCJA_ANTISPAM_TURNSTILE_SECRET_KEY', 'test-secret-key' );

$GLOBALS['asl_test_settings'] = array(
	'threshold_soft'  => 30,
	'threshold_block' => 70,
	'safe_mode'       => false,
	'allow_urls'      => false,
	'log_retention_d' => 0,
	'cf7_min_completion_s' => 3,
	'cf7_attempt_limit'     => 0,
	'cf7_attempt_window_m'  => 15,
	'cf7_ip_limit'         => 10,
	'cf7_ip_window_m'      => 15,
	'cf7_identity_limit'   => 3,
	'cf7_identity_window_h' => 24,
	'diagnostic_bcc'       => '',
	'diagnostic_domain'    => '',
);
$GLOBALS['asl_test_transients'] = array();
$GLOBALS['asl_test_transient_expirations'] = array();
$GLOBALS['asl_test_filters'] = array();
$GLOBALS['asl_test_actions'] = array();
$GLOBALS['asl_test_remote_response'] = array(
	'code' => 200,
	'body' => '{"success":true}',
);

function get_option( $name, $default = array() ) { return 'asl_settings' === $name ? $GLOBALS['asl_test_settings'] : $default; }
function apply_filters( $hook, $value ) { return $value; }
function add_filter( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	$GLOBALS['asl_test_filters'][] = compact( 'hook', 'callback', 'priority', 'accepted_args' );
}
function add_action( $hook, $callback, $priority = 10, $accepted_args = 1 ) {
	$GLOBALS['asl_test_actions'][] = compact( 'hook', 'callback', 'priority', 'accepted_args' );
}
function get_transient( $key ) { return $GLOBALS['asl_test_transients'][ $key ] ?? false; }
function set_transient( $key, $value, $expiration = 0 ) {
	$GLOBALS['asl_test_transients'][ $key ] = $value;
	$GLOBALS['asl_test_transient_expirations'][ $key ] = $expiration;
	return true;
}
function is_wp_error() { return false; }
function wp_remote_get() { return array(); }
function wp_remote_post() { return $GLOBALS['asl_test_remote_response']; }
function wp_remote_retrieve_response_code( $response = array() ) { return (int) ( $response['code'] ?? 500 ); }
function wp_remote_retrieve_body( $response = array() ) { return (string) ( $response['body'] ?? '' ); }
function wp_json_encode( $value ) { return json_encode( $value ); }
function current_time() { return gmdate( 'Y-m-d H:i:s' ); }
function wp_salt( $scheme ) { return 'test-' . $scheme; }
function sanitize_text_field( $value ) { return trim( strip_tags( (string) $value ) ); }
function sanitize_email( $value ) { return filter_var( (string) $value, FILTER_SANITIZE_EMAIL ); }
function is_email( $value ) { return false !== filter_var( $value, FILTER_VALIDATE_EMAIL ); }
function wp_unslash( $value ) { return is_string( $value ) ? stripslashes( $value ) : $value; }
function esc_attr( $value ) { return htmlspecialchars( (string) $value, ENT_QUOTES ); }
function get_locale() { return 'pl_PL'; }
function __( $text ) { return $text; }

class WPCF7_ContactForm {
	private static ?self $current = null;

	public function __construct( private int $form_id ) {}
	public static function get_current(): ?self { return self::$current; }
	public static function set_current( ?self $form ): void { self::$current = $form; }
	public function id(): int { return $this->form_id; }
}

require dirname( __DIR__ ) . '/inc/rules.php';
require dirname( __DIR__ ) . '/inc/hooks.php';

function expect( bool $condition, string $message ): void {
	if ( ! $condition ) {
		fwrite( STDERR, "FAIL: {$message}\n" );
		exit( 1 );
	}
}

function score( string $text ): array {
	$result = asl_score_text( $text, true );
	return array( (int) $result[0], (array) $result[1] );
}

function started_token( int $age ): string {
	$started_at = (string) ( time() - $age );
	return $started_at . '.' . hash_hmac( 'sha256', $started_at, wp_salt( 'nonce' ) );
}


$validation_result_prototype = new class() {
	/**
	 * Captured field invalidations.
	 *
	 * @var list<array{tag:mixed,message:string}>
	 */
	public array $invalidations = array();

	/**
	 * Record a field invalidation.
	 *
	 * @param mixed  $tag     Invalidated CF7 form tag.
	 * @param string $message Public validation message.
	 */
	public function invalidate( $tag, string $message ): void {
		$this->invalidations[] = array(
			'tag'     => $tag,
			'message' => $message,
		);
	}
};

WPCF7_ContactForm::set_current( new WPCF7_ContactForm( 769 ) );
$_SERVER['REQUEST_URI'] = '/contact/';
$_SERVER['REMOTE_ADDR'] = '198.51.100.10';
$_POST = array(
	'asl_website'       => '',
	'asl_started_at'    => started_token( 1 ),
	'contact-name'      => 'Runtime Sender',
	'contact-phone'     => '10000000001',
	'contact-email'     => 'runtime-a@example.test',
	'contact-message'   => 'Hello, I wanted to know your price.',
);
expect( 'completion-time' === asl_cf7_request_guard_reason(), 'one-second CF7 automation is rejected' );

$_POST['asl_started_at'] = started_token( 3 );
expect( null === asl_cf7_request_guard_reason(), 'three-second CF7 request passes the behavior guard' );

$_POST['sawaryn_started_at'] = $_POST['asl_started_at'];
unset( $_POST['asl_started_at'] );
expect( null === asl_cf7_request_guard_reason(), 'a cached legacy signed field remains valid during rollout' );

$trap_markup = asl_cf7_form_traps( '<input name="contact-name">' );
expect( str_contains( $trap_markup, 'name="asl_website"' ), 'CF7 markup contains a honeypot' );
expect( str_contains( $trap_markup, 'name="asl_started_at"' ), 'CF7 markup contains a signed timestamp' );

$GLOBALS['asl_test_transients']            = array();
$GLOBALS['asl_test_transient_expirations'] = array();
$attempt_guard = asl_cf7_attempt_guard();
expect( null === $attempt_guard['reason'], 'attempt limiting is disabled by default' );
expect( array() === $GLOBALS['asl_test_transients'], 'default-off attempt limiting writes no transient' );

$validate_registrations = array_values(
	array_filter(
		$GLOBALS['asl_test_filters'],
		static fn ( array $registration ): bool => 'wpcf7_validate' === $registration['hook']
			&& 'asl_cf7_validate_request' === $registration['callback']
	)
);
expect( 1 === count( $validate_registrations ), 'attempt protection has one owner on the global CF7 validation seam' );
expect( 15 === $validate_registrations[0]['priority'], 'attempt protection runs at the expected CF7 validation priority' );
$validate_callback = $validate_registrations[0]['callback'];

$GLOBALS['asl_test_settings']['cf7_attempt_limit']    = 6;
$GLOBALS['asl_test_settings']['cf7_attempt_window_m'] = 15;
$_SERVER['REQUEST_URI']                               = '/';
$_SERVER['REMOTE_ADDR']                               = '198.51.100.60';
$_POST = array(
	'asl_website'     => '',
	'asl_started_at'  => started_token( 3 ),
	'contact-name'    => 'Attempt Test',
	'contact-email'   => 'attempt@example.test',
	'contact-message' => 'A verified request.',
);
$form_tag = (object) array( 'name' => 'contact-name' );
$before_send_mail_spy = 0;
$mail_sent_spy        = 0;
for ( $attempt = 1; $attempt <= 6; ++$attempt ) {
	$result = clone $validation_result_prototype;
	$validate_callback( $result, array( $form_tag ) );
	expect( array() === $result->invalidations, 'verified attempt ' . $attempt . ' remains below the configured limit' );
	++$before_send_mail_spy;
	++$mail_sent_spy;
}
$blocked_result = clone $validation_result_prototype;
$validate_callback( $blocked_result, array( $form_tag ) );
expect( 1 === count( $blocked_result->invalidations ), 'the seventh verified CF7 attempt is invalidated before mail' );
expect( $form_tag === $blocked_result->invalidations[0]['tag'], 'CF7 receives the actual form-tag object for invalidation' );
expect( 6 === $before_send_mail_spy && 6 === $mail_sent_spy, 'a blocked validation never reaches CFDB7 or mail lifecycle spies' );

$attempt_keys = array_values(
	array_filter(
		array_keys( $GLOBALS['asl_test_transients'] ),
		static fn ( string $key ): bool => str_starts_with( $key, 'asl_cf7_attempt_' )
	)
);
expect( 1 === count( $attempt_keys ), 'one attempt counter is kept for one form and IP' );
$attempt_state = $GLOBALS['asl_test_transients'][ $attempt_keys[0] ];
expect( 7 === $attempt_state['count'], 'blocked attempts are capped at limit plus one' );
expect( true === $attempt_state['blocked_logged'], 'the first blocked attempt reserves one diagnostic log for the window' );
expect( 15 * MINUTE_IN_SECONDS === $GLOBALS['asl_test_transient_expirations'][ $attempt_keys[0] ], 'attempt counter uses the configured fixed window' );
expect( ! str_contains( $attempt_keys[0], '198.51.100.60' ), 'attempt counter contains no raw IP address' );

$window_ends = $attempt_state['expires_at'];
$repeated_block = asl_cf7_attempt_guard();
expect( 'attempt-rate' === $repeated_block['reason'], 'later attempts remain blocked in the same fixed window' );
expect( false === $repeated_block['log'], 'later blocked attempts do not create unbounded diagnostic rows' );
expect( $window_ends === $GLOBALS['asl_test_transients'][ $attempt_keys[0] ]['expires_at'], 'blocked attempts do not extend the fixed window' );

$GLOBALS['asl_test_transients'][ $attempt_keys[0] ]['expires_at'] = time() - 1;
$reset_guard = asl_cf7_attempt_guard();
expect( null === $reset_guard['reason'], 'an expired attempt window starts cleanly' );
expect( 1 === $GLOBALS['asl_test_transients'][ $attempt_keys[0] ]['count'], 'the first attempt after expiry starts a new counter' );
expect( false === $GLOBALS['asl_test_transients'][ $attempt_keys[0] ]['blocked_logged'], 'a new window may emit one future block diagnostic' );

WPCF7_ContactForm::set_current( new WPCF7_ContactForm( 993 ) );
$form_guard = asl_cf7_attempt_guard();
expect( null === $form_guard['reason'], 'a different form has an independent attempt counter' );
WPCF7_ContactForm::set_current( new WPCF7_ContactForm( 769 ) );
$_SERVER['REMOTE_ADDR'] = '198.51.100.61';
$ip_guard = asl_cf7_attempt_guard();
expect( null === $ip_guard['reason'], 'a different IP has an independent attempt counter' );

$before_safe_mode = $GLOBALS['asl_test_transients'];
$GLOBALS['asl_test_settings']['safe_mode'] = true;
$safe_mode_guard = asl_cf7_attempt_guard();
expect( null === $safe_mode_guard['reason'], 'observe mode never blocks a verified attempt' );
expect( $before_safe_mode === $GLOBALS['asl_test_transients'], 'observe mode does not mutate attempt counters' );
$GLOBALS['asl_test_settings']['safe_mode'] = false;

$GLOBALS['asl_test_settings']['cf7_attempt_limit'] = 0;
$GLOBALS['asl_test_transients']                     = array();
WPCF7_ContactForm::set_current( new WPCF7_ContactForm( 769 ) );
$_SERVER['REQUEST_URI'] = '/contact/';

$GLOBALS['asl_test_transients'] = array();
$GLOBALS['asl_test_settings']['cf7_ip_limit'] = 3;
for ( $attempt = 1; $attempt <= 3; ++$attempt ) {
	$_SERVER['REMOTE_ADDR'] = '198.51.100.50';
	$_POST = array(
		'asl_website'     => '',
		'asl_started_at'  => started_token( 3 ),
		'contact-name'    => 'Distinct Person ' . $attempt,
		'contact-phone'   => '3000000000' . $attempt,
		'contact-email'   => 'distinct-' . $attempt . '@example.test',
		'contact-message' => 'A distinct test request.',
	);
	asl_cf7_record_accepted_submission( new WPCF7_ContactForm( 769 ) );
}
expect( 'ip-rate' === asl_cf7_request_guard_reason(), 'accepted CF7 submissions are limited per form and IP' );

$GLOBALS['asl_test_settings']['cf7_ip_limit'] = 10;
$GLOBALS['asl_test_transients']                = array();
for ( $attempt = 1; $attempt <= 3; ++$attempt ) {
	$_SERVER['REMOTE_ADDR'] = '198.51.100.' . $attempt;
	$_POST = array(
		'asl_website'     => '',
		'asl_started_at'  => started_token( 3 ),
		'contact-name'    => 'Robertguind',
		'contact-phone'   => '1000000000' . $attempt,
		'contact-email'   => 'rotated-' . $attempt . '@example.test',
		'contact-message' => 'Translated price request.',
	);
	asl_cf7_record_accepted_submission( new WPCF7_ContactForm( 769 ) );
}

$_SERVER['REMOTE_ADDR'] = '203.0.113.20';
$_POST['asl_started_at'] = started_token( 3 );
$_POST['contact-phone']  = '20000000001';
$_POST['contact-email']  = 'another@example.test';
expect( 'identity-rate' === asl_cf7_request_guard_reason(), 'repeated identity is blocked across rotating IPs' );
expect( ! str_contains( implode( '|', array_keys( $GLOBALS['asl_test_transients'] ) ), 'robertguind' ), 'identity counters contain no raw submitted identity' );

$_POST['contact-name']  = 'Legitimate Person';
$_POST['contact-phone'] = '+48 123 456 789';
$_POST['contact-email'] = 'person@example.com';
expect( null === asl_cf7_request_guard_reason(), 'a distinct identity is not rejected by another sender counter' );

$GLOBALS['asl_test_settings']['safe_mode'] = true;
$_POST['asl_started_at'] = started_token( 1 );
expect( null === asl_cf7_request_guard_reason(), 'observe mode never blocks the CF7 behavior guard' );
$GLOBALS['asl_test_settings']['safe_mode'] = false;

class ASL_Test_Mail {
	public function __construct( private string $mail_name ) {}
	public function name(): string { return $this->mail_name; }
}

$GLOBALS['asl_test_settings']['diagnostic_bcc']    = 'spam.filter@rekurencja.com';
$GLOBALS['asl_test_settings']['diagnostic_domain'] = 'sawaryn.com';
$internal_mail = asl_cf7_diagnostic_copy(
	array( 'additional_headers' => 'Reply-To: sender@example.test' ),
	null,
	new ASL_Test_Mail( 'mail' )
);
expect( str_contains( $internal_mail['additional_headers'], 'Bcc: spam.filter@rekurencja.com' ), 'CF7 internal notification receives one diagnostic copy' );
$autoresponder = asl_cf7_diagnostic_copy( array( 'additional_headers' => '' ), null, new ASL_Test_Mail( 'mail_2' ) );
expect( ! str_contains( $autoresponder['additional_headers'], 'spam.filter@rekurencja.com' ), 'CF7 autoresponder is excluded from diagnostic copies' );
$wpforms_internal = asl_wpforms_diagnostic_copy( array( 'to' => 'office@sawaryn.com', 'headers' => '' ) );
expect( str_contains( $wpforms_internal['headers'], 'Bcc: spam.filter@rekurencja.com' ), 'WPForms internal notification receives a diagnostic copy' );
$wpforms_external = asl_wpforms_diagnostic_copy( array( 'to' => 'visitor@example.com', 'headers' => '' ) );
expect( ! str_contains( $wpforms_external['headers'], 'spam.filter@rekurencja.com' ), 'WPForms external recipient is excluded from diagnostic copies' );

[$spam_score, $spam_reasons] = score(
	'kupit_rbkn fvccqpypdkn@moscowfocus.ru <a href=https://www.brilliant-rings.ru/>кольцо бриллиант груша</a> Приобретение бриллиантового кольца — особенный момент.'
);
expect( $spam_score >= 70, 'active HTML link spam reaches the hard threshold' );
expect( in_array( 'html-link', $spam_reasons, true ), 'active HTML link is an explicit reason' );

[$noise_score] = score( 'oGavrurJWKAFoiZEugC aud.i.n.e.c.ro.s.s.e@gmail.com aTQIuqKslWoYOjtnlwbrZ' );
expect( $noise_score >= 30, 'multiple long random tokens reach the spam threshold' );

foreach ( array(
	'Dzień dobry, potrzebuję konsultacji dotyczącej umowy spółki.',
	'Hello, I would like to arrange a consultation about establishing a company in Poland.',
	'Здравствуйте, мне нужна консультация по договору и регистрации компании.',
	'Please review the documents at https://example.com before our scheduled call.',
) as $legitimate ) {
	[$legitimate_score] = score( $legitimate );
	expect( $legitimate_score < 30, 'legitimate inquiry remains below threshold: ' . $legitimate );
}

[$commercial_spam_score, $commercial_spam_reasons] = score(
	'Think of Vantovo as a scout working your target market nonstop: watching thousands of partner sites, spotting the visitors who match your keywords and location, then sending them straight to you. Free for a week, no contract, no pressure. https://blankslatelife.com'
);
expect( $commercial_spam_score >= 30, 'commercial pitch with a link reaches the spam threshold' );
expect( in_array( 'commercial-pitch', $commercial_spam_reasons, true ), 'commercial pitch is identified as a scoring reason' );

[$bare_shortener_score, $bare_shortener_reasons] = score(
	'To oferta SPECJALNA! Kliknij i przekonaj się, jak w kilka ruchów możesz zdobyć pół miliona złotych. Zagraj teraz tutaj -> is.gd/TQCY4N'
);
expect( $bare_shortener_score >= 30, 'a bare shortener domain reaches the spam threshold' );
expect( in_array( 'shortener', $bare_shortener_reasons, true ), 'a bare shortener is identified as a scoring reason' );

[$assistant_spam_score, $assistant_spam_reasons] = score(
	'Hello, Are you looking for a reliable Virtual Assistant? We provide dedicated virtual employees for data entry, lead generation, ecommerce product uploads, spreadsheet updates and website edits. Part-Time: $1200/month. Full-Time: $2000/month.'
);
expect( $assistant_spam_score >= 30, 'a multi-marker virtual assistant pitch without a link reaches the spam threshold' );
expect( in_array( 'commercial-pitch', $assistant_spam_reasons, true ), 'a no-link service pitch is identified as commercial spam' );

[$seo_spam_score, $seo_spam_reasons] = score(
	'Zwiększę ruch i rentowność Twojej strony. Poprawię pozycje w wynikach, zajmę się promocją w wyszukiwarkach, tworzeniem stron i zarządzaniem recenzjami.'
);
expect( $seo_spam_score >= 30, 'a multi-marker Polish SEO pitch reaches the spam threshold' );
expect( in_array( 'seo-pitch', $seo_spam_reasons, true ), 'a Polish SEO pitch is identified as a scoring reason' );

$scoring_text = asl_cf7_scoring_text(
	array(
		'contact-name'    => 'Jan Kowalski',
		'contact-phone'   => '12345678901234567890',
		'sawaryn-started' => '1784716206.signature-that-must-not-be-scored',
		'contact-message' => 'Proszę o kontakt.',
	)
);
expect( ! str_contains( $scoring_text, '123456789' ), 'phone is excluded from scoring text' );
expect( ! str_contains( $scoring_text, 'signature' ), 'technical token is excluded from scoring text' );

class ASL_Test_Form {
	public function id(): int { return 769; }
}
class ASL_Test_Submission {
	public function __construct( private array $data ) {}
	public function get_posted_data(): array { return $this->data; }
	public function get_contact_form(): ASL_Test_Form { return new ASL_Test_Form(); }
}

$submission = new ASL_Test_Submission(
	array( 'contact-message' => '<a href=https://spam.example/>spam</a>' )
);
expect( true === asl_cf7_spam_check( false, $submission ), 'CF7 blocks hard-threshold spam' );
expect( true === asl_cf7_spam_check( true, $submission ), 'CF7 preserves an upstream spam decision' );

$GLOBALS['asl_test_settings']['safe_mode'] = true;
expect( false === asl_cf7_spam_check( false, $submission ), 'observe mode never blocks CF7' );

[$clamped] = score( str_repeat( '<a href=https://spam.example/>bitcoin free btc</a> ', 10 ) );
expect( 100 === $clamped, 'score is clamped to 100' );

$GLOBALS['asl_test_settings']['turnstile_enabled'] = true;
$_POST['asl_started_at']                    = started_token( 3 );
unset( $_POST['cf-turnstile-response'] );
expect( 'turnstile' === asl_turnstile_failure_reason(), 'enabled Turnstile rejects a missing response' );
$_POST['cf-turnstile-response'] = 'test-response-token';
expect( null === asl_turnstile_failure_reason(), 'enabled Turnstile accepts a verified response' );
$GLOBALS['asl_test_remote_response'] = array( 'code' => 200, 'body' => '{"success":false}' );
expect( 'turnstile' === asl_turnstile_failure_reason(), 'Turnstile rejects an unsuccessful verification response' );

expect( 'free btc now' === asl_normalize_text( "free\u{200B}  btc\n\tno\u{00AD}w" ), 'normalization strips zero-width characters and collapses whitespace' );

echo "OK: focused anti-spam contracts passed\n";
