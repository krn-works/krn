<?php
/**
 * AntiSpam Lite - Scoring Rules.
 *
 * Public functions for third-party forms:
 * - asl_score_text($text, $with_reasons) - returns score 0-100
 * - asl_risk_decision($score, $settings) - returns 'allow', 'moderate', 'block'
 *
 * @package AntiSpam Lite
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Normalize text by removing invisible characters and extra whitespace.
 *
 * @param string $t Text to normalize.
 * @return string Normalized text.
 */
function asl_normalize_text( string $t ): string {
	$t = preg_replace( '/[\x{200B}-\x{200D}\x{2060}\x{00AD}]/u', '', $t );
	$t = preg_replace( '/\s+/u', ' ', $t );
	return $t ?? '';
}

/**
 * Extract email addresses from text.
 *
 * @param string $text Input text.
 * @return array List of emails (lowercase).
 */
function asl_extract_emails_from_text( string $text ): array {
    $emails = array();
    if ( preg_match_all( '/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i', $text, $m ) ) {
        foreach ( $m[0] as $e ) {
            $emails[ strtolower( $e ) ] = true;
        }
    }
    return array_keys( $emails );
}

/**
 * Extract unique hostnames from text URLs.
 *
 * @param string $text Input text.
 * @return array List of hostnames (lowercase).
 */
function asl_extract_hosts_from_text( string $text ): array {
	$hosts = array();
	if ( preg_match_all( '~(?<![@\w])(?:https?://)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:/[^\s<]*)?~iu', $text, $m ) ) {
		foreach ( $m[1] as $h ) {
			$h           = strtolower( $h );
			$h           = preg_replace( '/:\d+$/', '', $h );
			$hosts[ $h ] = true;
		}
	}
	return array_keys( $hosts );
}

/**
 * DNS A record exists helper.
 *
 * @param string $query FQDN to query.
 * @return bool Whether any A record resolves.
 */
function asl_dns_a_exists( string $query ): bool {
	$query = rtrim( $query, '.' );
	$ip    = @gethostbyname( $query ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	return ( $ip && $ip !== $query );
}

/**
 * Fetch WHOIS (RDAP) info and return domain age in days or null on failure.
 *
 * @param string $domain Domain name.
 * @param int    $timeout_ms Timeout in milliseconds.
 * @return int|null Age in days, or null.
 */
function asl_fetch_whois_age_days( string $domain, int $timeout_ms ): ?int {
	$endpoint = 'https://rdap.org/domain/' . rawurlencode( $domain );
	$args     = array(
		'timeout' => max( 0.2, $timeout_ms / 1000 ),
		'headers' => array( 'accept' => 'application/rdap+json' ),
	);
	$resp     = wp_remote_get( $endpoint, $args );
	if ( is_wp_error( $resp ) ) {
		return null;
	}
	$code = (int) wp_remote_retrieve_response_code( $resp );
	$body = wp_remote_retrieve_body( $resp );
	if ( 200 > $code || 300 <= $code || ! $body ) {
		return null;
	}
	$data = json_decode( $body, true );
	if ( true !== is_array( $data ) ) {
		return null;
	}
	$created = null;
	if ( isset( $data['events'] ) && is_array( $data['events'] ) ) {
		foreach ( $data['events'] as $ev ) {
			if ( isset( $ev['eventAction'] ) && 'registration' === $ev['eventAction'] && ! empty( $ev['eventDate'] ) ) {
				$created = $ev['eventDate'];
				break;
			}
		}
	}
	if ( empty( $created ) && ! empty( $data['events'] ) && is_array( $data['events'] ) ) {
		foreach ( $data['events'] as $ev ) {
			if ( isset( $ev['eventAction'] ) && 'creation' === $ev['eventAction'] && ! empty( $ev['eventDate'] ) ) {
				$created = $ev['eventDate'];
				break;
			}
		}
	}
	if ( empty( $created ) ) {
		return null;
	}
	$ts = strtotime( $created );
	if ( ! $ts ) {
		return null;
	}
	$age_days = (int) floor( ( time() - $ts ) / DAY_IN_SECONDS );
	return max( 0, $age_days );
}

/**
 * Reputation check for a single host using DNSBL/SURBL/DBL and WHOIS RDAP.
 * Cached via transients.
 *
 * @param string $host Hostname.
 * @param array  $settings Settings array.
 * @return array Tuple [score_delta, reasons[]]
 */
function asl_check_host_reputation( string $host, array $settings ): array {
	$enable_dnsbl = (bool) ( $settings['enable_dnsbl'] ?? false );
	$enable_surbl = (bool) ( $settings['enable_surbl'] ?? false );
	$enable_whois = (bool) ( $settings['enable_whois'] ?? false );
	$ttl_minutes  = (int) ( $settings['reputation_cache_ttl'] ?? 360 );
	$dns_timeout  = (int) ( $settings['dns_timeout_ms'] ?? 800 );
	$whois_to     = (int) ( $settings['whois_timeout_ms'] ?? 1200 );
	$age_thresh   = (int) ( $settings['whois_age_days'] ?? 90 );
	$w_dnsbl      = (int) ( $settings['weight_dnsbl'] ?? 15 );
	$w_surbl      = (int) ( $settings['weight_surbl'] ?? 12 );
	$w_young      = (int) ( $settings['weight_whois_young'] ?? 10 );

	$cache_key = 'asl_rep_' . md5( strtolower( $host ) );
	$cached    = get_transient( $cache_key );
	if ( is_array( $cached ) ) {
		$delta   = (int) ( $cached['delta'] ?? 0 );
		$reasons = (array) ( $cached['reasons'] ?? array() );
		return array( $delta, $reasons );
	}

	$delta   = 0;
	$reasons = array();

	if ( $enable_dnsbl ) {
		// Spamhaus DBL (domains): <domain>.dbl.spamhaus.org.
		if ( asl_dns_a_exists( $host . '.dbl.spamhaus.org' ) ) {
			$delta    += $w_dnsbl;
			$reasons[] = 'dns:dbl';
		}
	}
	if ( $enable_surbl ) {
		// SURBL multi: <domain>.multi.surbl.org.
		if ( asl_dns_a_exists( $host . '.multi.surbl.org' ) ) {
			$delta    += $w_surbl;
			$reasons[] = 'dns:surbl';
		}
	}
	if ( $enable_whois ) {
		$age = asl_fetch_whois_age_days( $host, $whois_to );
		if ( is_int( $age ) && 0 <= $age && $age_thresh > $age ) {
			$delta    += $w_young;
			$reasons[] = 'whois:age<' . $age_thresh . 'd';
		}
	}

	set_transient(
        $cache_key,
        array(
			'delta'   => $delta,
			'reasons' => $reasons,
        ),
        max( 60, $ttl_minutes ) * MINUTE_IN_SECONDS
    );
	return array( $delta, $reasons );
}

/**
 * Calculate spam score for given text.
 *
 * @param string $t            Text to analyze.
 * @param bool   $with_reasons Whether to return reasons array.
 * @return int|array Score 0-100 or [score, reasons] array.
 */
function asl_score_text( string $t, bool $with_reasons = false ): int|array {
	$score   = 0;
	$reasons = array();

	$text = mb_strtolower( asl_normalize_text( $t ) );

	if ( preg_match( '/<\s*a\b[^>]*\bhref\s*=|\bhref\s*=\s*["\']?https?:/iu', $text ) ) {
		$score    += 60;
		$reasons[] = 'html-link';
	} elseif ( preg_match( '/<\/?[a-z][^>]*>/iu', $text ) ) {
		$score    += 25;
		$reasons[] = 'html';
	}

	if ( preg_match( '/\[url(?:=|\])/iu', $text ) ) {
		$score    += 40;
		$reasons[] = 'bbcode-link';
	}

	if ( preg_match( '/\b(btc|bitcoin|usdt|crypto)\b/u', $text ) ) {
		$score    += 25;
		$reasons[] = 'crypto';
	}

	if ( preg_match( '/\bapprove\??\b/u', $text ) ) {
		$score    += 10;
		$reasons[] = 'approve?';
	}

	$settings_urls = get_option( 'asl_settings', array() );
	$allow_urls = (bool) ( $settings_urls['allow_urls'] ?? false );
	// Match both absolute URLs and bare domains such as "is.gd/TQCY4N".
	// Email domains are excluded by the negative look-behind and word boundary.
	$url_count = preg_match_all( '~(?<![@\w])(?:https?://)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:/[^\s<]*)?~iu', $text );
	if ( false !== $url_count && $url_count > 0 ) {
		if ( ! $allow_urls ) {
			$score    += 15 + min( 20, max( 0, $url_count - 1 ) * 10 );
			$reasons[] = 'url';
		} else {
			$reasons[] = 'url:allowed';
		}
	}

	// Commercial outreach pitches paired with a link are a common CF7 spam shape.
	// Require two independent sales markers so ordinary linked inquiries stay below
	// the threshold while concise cold-pitch messages reach moderation/blocking.
	$commercial_markers = array(
		'/\bfree\s+(?:for|trial|week|month)\b/u',
		'/\bno\s+(?:contract|pressure|obligation)\b/u',
		'/\btarget\s+market\b/u',
		'/\bpartner\s+sites?\b/u',
		'/\bsend(?:ing)?\s+(?:them|visitors)\s+straight\s+to\s+you\b/u',
		'/\bsend(?:ing)?\s+(?:them|visitors)\s+(?:your\s+way)\b/u',
		'/\bnext\s+customer\b/u',
		'/\bvirtual\s+assistants?\b/u',
		'/\bdata\s+entry\b/u',
		'/\blead\s+generation\b/u',
		'/\becommerce\s+product\s+uploads?\b/u',
		'/\bspreadsheet\s+updates?\b/u',
		'/\b(?:part-time|full-time):?\s*\$?\d/u',
	);
	$commercial_matches = 0;
	foreach ( $commercial_markers as $marker ) {
		if ( preg_match( $marker, $text ) ) {
			$commercial_matches++;
		}
	}
	if ( $url_count > 0 && $commercial_matches >= 2 ) {
		$score    += 25;
		$reasons[] = 'commercial-pitch';
	} elseif ( 0 === $url_count && $commercial_matches >= 3 ) {
		// A multi-marker service pitch is still spam when it omits a link.
		$score    += 30;
		$reasons[] = 'commercial-pitch';
	}

	// Unsolicited Polish SEO pitches often omit links and therefore need
	// independent service markers before they affect the score.
	$seo_markers = array(
		'/zwi[eę]ksz(?:e|ę)\s+ruch/u',
		'/rentowno(?:ść|sc)/u',
		'/pozycj(?:e|i)\s+w\s+wynikach/u',
		'/promocj(?:a|ę)\s+w\s+wyszukiwarkach/u',
		'/tworzenie\s+stron/u',
		'/zarz[aą]dzanie\s+recenzjami/u',
	);
	$seo_matches = 0;
	foreach ( $seo_markers as $marker ) {
		if ( preg_match( $marker, $text ) ) {
			$seo_matches++;
		}
	}
	if ( $seo_matches >= 3 ) {
		$score    += 30;
		$reasons[] = 'seo-pitch';
	}

	if ( preg_match( '~(?<![@\w])(?:https?://)?(?:www\.)?(?:bit\.ly|goo\.gl|tinyurl\.com|t\.co|t\.me|is\.gd|cutt\.ly|rb\.gy|linktr\.ee)/\S+~iu', $text ) ) {
		$score    += 15;
		$reasons[] = 'shortener';
	}

	if ( preg_match( '~https?://[^/\s]*xn--~i', $text ) ) {
		$score    += 10;
		$reasons[] = 'punycode';
	}

	$has_lat = preg_match( '/[A-Za-z]/u', $text );
	$has_cyr = preg_match( '/[\x{0400}-\x{04FF}]/u', $text );
	if ( $has_lat && $has_cyr ) {
		$score    += 5;
		$reasons[] = 'mixed-scripts';
	}

	if ( preg_match_all( '/\b[a-z0-9]{16,}\b/i', $text, $matches ) ) {
		$noise_count = min( 3, count( $matches[0] ) );
		$score      += $noise_count >= 2 ? 30 : 5;
		$reasons[]   = 'noise';
	}

	// Additional noise heuristic: multiple short gibberish tokens (5-8 letters, no vowels).
	if ( preg_match_all( '/\b(?![aeiou])[a-z]{5,8}\b/u', $text, $m2 ) ) {
		$tokens = $m2[0];
		$cnt    = 0;
		foreach ( $tokens as $tok ) {
			if ( ! preg_match( '/[aeiou]/', $tok ) ) {
				$cnt++;
			}
			if ( $cnt >= 3 ) {
				break;
			}
		}
		if ( $cnt >= 3 ) {
			$score    += 10;
			$reasons[] = 'noise:consonant';
		}
	}

	// Giveaway/lottery bait phrases.
	if ( preg_match( '/\b(free\s*(spins|btc|iphone|gift)|cash\s*rewards?|gift\s*drop|your\s+new\s+iphone\s*16|apple\s+just\s+dropped)\b/u', $text ) ) {
		$score    += 15;
		$reasons[] = 'giveaway-bait';
	}

	$hosts = asl_extract_hosts_from_text( $text );
	foreach ( $hosts as $h ) {
		$host = strtolower( $h );
		if ( str_contains( $host, 'paypal' ) && ! str_ends_with( $host, '.paypal.com' ) ) {
			$score    += 10;
			$reasons[] = 'brand-mismatch';
		}
		if ( str_contains( $host, 'binance' ) && ! str_ends_with( $host, '.binance.com' ) ) {
			$score    += 10;
			$reasons[] = 'brand-mismatch';
		}
	}

	// Host reputation (DNS/WHOIS) with settings and caching.
	$settings = get_option( 'asl_settings', array() );
    // Custom keyword bonuses.
    $kw       = (array) ( $settings['keywords_bonus'] ?? array() );
    $kw_deny  = (array) ( $settings['keywords_deny'] ?? array() );
    $kw_w     = (int) ( $settings['weight_keyword'] ?? 8 );
    $kw_min   = (int) ( $settings['keyword_min_len'] ?? 3 );
    // Deny keywords first.
    foreach ( $kw_deny as $word ) {
        $word = trim( (string) $word );
        if ( '' === $word || strlen( $word ) < $kw_min ) {
            continue;
        }
        $match = stripos( $text, $word );
        if ( false !== $match ) {
            return $with_reasons ? array( 100, array_merge( $reasons, array( 'kw_deny:' . $word ) ) ) : 100;
        }
    }
    // Bonus keywords.
    foreach ( $kw as $word ) {
        $word = trim( (string) $word );
        if ( '' === $word || strlen( $word ) < $kw_min ) {
            continue;
        }
        $is_ascii = (bool) preg_match( '/^[\x20-\x7E]+$/', $word );
        if ( $is_ascii ) {
            // Whole-word match for ASCII tokens to reduce false positives.
            $pattern = '/\b' . preg_quote( $word, '/' ) . '\b/i';
            if ( preg_match( $pattern, $text ) ) {
                $score    += max( 1, $kw_w );
                $reasons[] = 'kw:' . $word;
            }
        } else {
            if ( false !== stripos( $text, $word ) ) {
                $score    += max( 1, $kw_w );
                $reasons[] = 'kw:' . $word;
            }
        }
    }
	if ( ! empty( $hosts ) && ( ( $settings['enable_dnsbl'] ?? false ) || ( $settings['enable_surbl'] ?? false ) || ( $settings['enable_whois'] ?? false ) ) ) {
		$checked = 0;
		foreach ( $hosts as $h ) {
			list( $delta, $r2 ) = asl_check_host_reputation( $h, $settings );
			if ( $delta > 0 ) {
				$score += $delta;
				$reasons = array_merge( $reasons, $r2 );
			}
			$checked++;
			if ( $checked >= 5 ) { // cap cost per text.
				break;
			}
		}
	}

	// Email domain risk: disposable/abusive domains.
	$emails = asl_extract_emails_from_text( $text );
	if ( ! empty( $emails ) ) {
		$risky_domains = (array) apply_filters( 'asl_risky_email_domains', array( 'mailbox.in.ua' ) );
		foreach ( $emails as $em ) {
			$parts = explode( '@', $em );
			$dom   = strtolower( end( $parts ) );
			if ( in_array( $dom, $risky_domains, true ) ) {
				$score    += 25;
				$reasons[] = 'email:domain';
				break;
			}
		}
	}

	$settings  = get_option( 'asl_settings', array() );
	$allowlist = $settings['allowlist'] ?? array();
	$denylist  = $settings['denylist'] ?? array();

	// IP heuristic: bump score for common abusive AS/Tor subnets (rough approximation via prefixes in text).
	if ( isset( $_SERVER['REMOTE_ADDR'] ) ) {
		$ip = (string) $_SERVER['REMOTE_ADDR'];
		$risky_prefixes = (array) apply_filters( 'asl_risky_ip_prefixes', array( '109.70.100.', '107.189.', '45.13.225.', '185.156.72.' ) );
		foreach ( $risky_prefixes as $pref ) {
			if ( str_starts_with( $ip, $pref ) ) {
				$score    += 15;
				$reasons[] = 'ip:prefix';
				break;
			}
		}
	}

	foreach ( $allowlist as $allowed ) {
		if ( stripos( $text, $allowed ) !== false ) {
			$score     = 0;
			$reasons[] = 'allowlisted';
			break;
		}
	}

	foreach ( $denylist as $denied ) {
		if ( stripos( $text, $denied ) !== false ) {
			$score     = 100;
			$reasons[] = 'denylisted';
			break;
		}
	}

	$score = min( 100, max( 0, (int) apply_filters( 'asl_risk_score', $score, $text, $reasons ) ) );

	return $with_reasons ? array( $score, $reasons ) : $score;
}

/**
 * Get risk decision based on score and thresholds.
 *
 * @param int   $score    Spam score to evaluate.
 * @param array $settings Plugin settings array.
 * @return string Decision: 'allow', 'moderate', or 'block'.
 */
function asl_risk_decision( int $score, array $settings = array() ): string {
	$settings       = ! empty( $settings ) ? $settings : get_option( 'asl_settings', array() );
	$threshold_soft = (int) ( $settings['threshold_soft'] ?? 30 );
	$threshold_hard = (int) ( $settings['threshold_block'] ?? 70 );

	$decision = 'allow';
	if ( $score >= $threshold_hard ) {
		$decision = 'block';
	} elseif ( $score >= $threshold_soft ) {
		$decision = 'moderate';
	}

	return apply_filters( 'asl_risk_decision', $decision, $score, $settings );
}
