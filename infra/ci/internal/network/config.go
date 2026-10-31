// Package network validates explicit CI allocations and renders inert configuration.
// It never executes commands or changes the host. A policy digest detects changes
// when checked; it cannot make loss of filtering instantaneously fail closed.
// Permitted HTTPS egress can carry data or tunnels and is not an exfiltration ban.
package network

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"regexp"
	"slices"
	"strings"
)

// Config is the network object, not the surrounding platform profile. All
// allocations are required; AllowHTTP alone defaults to false. ProtectedPublicIPv4
// accepts individual IPv4 addresses as well as canonical IPv4 prefixes.
type Config struct {
	TablePrefix          string         `json:"table_prefix"`
	RunnerBridge         string         `json:"runner_bridge"`
	ControllerBridge     string         `json:"controller_bridge"`
	RunnerTap            string         `json:"runner_tap"`
	ControllerTap        string         `json:"controller_tap"`
	Uplink               string         `json:"uplink"`
	RunnerSubnet         netip.Prefix   `json:"runner_subnet"`
	ControllerSubnet     netip.Prefix   `json:"controller_subnet"`
	RunnerIP             netip.Addr     `json:"runner_ip"`
	ControllerIP         netip.Addr     `json:"controller_ip"`
	PVERunnerIP          netip.Addr     `json:"pve_runner_ip"`
	PVEControllerIP      netip.Addr     `json:"pve_controller_ip"`
	RunnerMAC            string         `json:"runner_mac"`
	ControllerMAC        string         `json:"controller_mac"`
	DNSServers           []netip.Addr   `json:"dns_servers"`
	ControllerHTTPSCIDRs []netip.Prefix `json:"controller_https_cidrs"`
	ProtectedPublicIPv4  []string       `json:"protected_public_ipv4"`
	AllowHTTP            bool           `json:"allow_http"`
}

var configFields = []string{
	"table_prefix", "runner_bridge", "controller_bridge", "runner_tap", "controller_tap", "uplink",
	"runner_subnet", "controller_subnet", "runner_ip", "controller_ip", "pve_runner_ip", "pve_controller_ip",
	"runner_mac", "controller_mac", "dns_servers", "controller_https_cidrs", "protected_public_ipv4", "allow_http",
}

var tableName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,47}$`)
var interfaceName = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$`)
var macAddress = regexp.MustCompile(`^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$`)

// Decode rejects unknown (including differently cased), duplicate, missing and
// null fields, null list entries, trailing JSON and invalid allocations.
func Decode(raw []byte) (Config, error) {
	var c Config
	d := json.NewDecoder(bytes.NewReader(raw))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return c, fmt.Errorf("network config must be a JSON object")
	}
	seen := make(map[string]bool)
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return c, fmt.Errorf("network field: %w", err)
		}
		name, ok := token.(string)
		if !ok || !slices.Contains(configFields, name) {
			return c, fmt.Errorf("unknown network field %q", token)
		}
		if seen[name] {
			return c, fmt.Errorf("duplicate network field %q", name)
		}
		seen[name] = true
		var value any
		if err := d.Decode(&value); err != nil {
			return c, fmt.Errorf("%s: %w", name, err)
		}
		if containsNull(value) {
			return c, fmt.Errorf("%s must not contain null", name)
		}
	}
	if _, err := d.Token(); err != nil {
		return c, fmt.Errorf("network object: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return c, fmt.Errorf("network config must contain exactly one JSON object")
	}
	for _, name := range configFields {
		if name != "allow_http" && !seen[name] {
			return c, fmt.Errorf("missing network allocation %q", name)
		}
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return Config{}, fmt.Errorf("network config: %w", err)
	}
	if err := Validate(c); err != nil {
		return Config{}, err
	}
	return c, nil
}

func containsNull(v any) bool {
	switch v := v.(type) {
	case nil:
		return true
	case []any:
		for _, e := range v {
			if containsNull(e) {
				return true
			}
		}
	case map[string]any:
		for _, e := range v {
			if containsNull(e) {
				return true
			}
		}
	}
	return false
}

// These destinations are never general egress targets. Role-specific SSH/UI
// exceptions are emitted before this deny set; DNS must use public resolvers.
var reservedIPv4 = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("224.0.0.0/4"), netip.MustParsePrefix("240.0.0.0/4"),
}

var forbiddenAllocations = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.20.10.0/28"), netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

// Validate checks typed callers as well as decoded JSON. It cannot detect
// collisions with live host/VPN routes: the allocator must check those separately.
func Validate(c Config) error {
	if !tableName.MatchString(c.TablePrefix) {
		return fmt.Errorf("table_prefix must be a safe identifier of 1 to 48 characters")
	}
	interfaces := []string{c.RunnerBridge, c.ControllerBridge, c.RunnerTap, c.ControllerTap, c.Uplink}
	seenInterfaces := make(map[string]bool)
	for _, name := range interfaces {
		if !interfaceName.MatchString(name) || name == "lo" || seenInterfaces[name] {
			return fmt.Errorf("interfaces must be distinct safe Linux names, excluding lo")
		}
		seenInterfaces[name] = true
	}
	subnets := []netip.Prefix{c.RunnerSubnet, c.ControllerSubnet}
	for _, p := range subnets {
		if !ipv4Prefix(p) || p.Bits() > 30 {
			return fmt.Errorf("guest subnets must be canonical IPv4 CIDRs with usable guest and gateway addresses")
		}
		for _, blocked := range forbiddenAllocations {
			if p.Overlaps(blocked) {
				return fmt.Errorf("guest subnet %s overlaps a forbidden allocation range %s", p, blocked)
			}
		}
	}
	if c.RunnerSubnet.Overlaps(c.ControllerSubnet) {
		return fmt.Errorf("guest subnets must not overlap")
	}
	addresses := []netip.Addr{c.RunnerIP, c.PVERunnerIP, c.ControllerIP, c.PVEControllerIP}
	seenAddresses := make(map[netip.Addr]bool)
	for i, a := range addresses {
		if !usableHost(subnets[i/2], a) || seenAddresses[a] {
			return fmt.Errorf("role addresses must be distinct usable IPv4 hosts in their own subnet")
		}
		seenAddresses[a] = true
	}
	for _, m := range []string{c.RunnerMAC, c.ControllerMAC} {
		mac, err := net.ParseMAC(m)
		if !macAddress.MatchString(m) || err != nil || len(mac) != 6 || mac[0]&1 != 0 || m == "00:00:00:00:00:00" {
			return fmt.Errorf("guest MACs must be nonzero unicast Ethernet addresses")
		}
	}
	if strings.EqualFold(c.RunnerMAC, c.ControllerMAC) {
		return fmt.Errorf("guest MACs must be distinct")
	}
	if len(c.ProtectedPublicIPv4) == 0 || len(c.DNSServers) == 0 || len(c.ControllerHTTPSCIDRs) == 0 {
		return fmt.Errorf("protected_public_ipv4, dns_servers and controller_https_cidrs require explicit nonempty allocations")
	}
	protected := make([]netip.Prefix, 0, len(c.ProtectedPublicIPv4))
	for _, value := range c.ProtectedPublicIPv4 {
		p, err := parseProtected(value)
		if err != nil || overlapsAny(p, reservedIPv4) || overlapsAny(p, subnets) || slices.Contains(protected, p) {
			return fmt.Errorf("protected_public_ipv4 requires distinct public IPv4 addresses or canonical CIDRs")
		}
		protected = append(protected, p)
	}
	denied := append(slices.Clone(reservedIPv4), subnets...)
	denied = append(denied, protected...)
	seenDNS := make(map[netip.Addr]bool)
	for _, a := range c.DNSServers {
		if !a.Is4() || overlapsAny(netip.PrefixFrom(a, 32), denied) || seenDNS[a] {
			return fmt.Errorf("dns_servers requires distinct public IPv4 resolvers outside protected/guest ranges")
		}
		seenDNS[a] = true
	}
	seenHTTPS := make(map[netip.Prefix]bool)
	for _, p := range c.ControllerHTTPSCIDRs {
		if !ipv4Prefix(p) || p.Bits() == 0 || overlapsAny(p, denied) || seenHTTPS[p] {
			return fmt.Errorf("controller_https_cidrs requires distinct explicit public IPv4 CIDRs outside protected/guest ranges")
		}
		seenHTTPS[p] = true
	}
	return nil
}

func ipv4Prefix(p netip.Prefix) bool {
	return p.IsValid() && p.Addr().Is4() && p == p.Masked()
}

func usableHost(p netip.Prefix, a netip.Addr) bool {
	if !a.Is4() || !p.Contains(a) || a == p.Addr() {
		return false
	}
	addr := a.As4()
	mask := uint32(1)<<(32-p.Bits()) - 1
	return binary.BigEndian.Uint32(addr[:])&mask != mask
}

func parseProtected(s string) (netip.Prefix, error) {
	if a, err := netip.ParseAddr(s); err == nil && a.Is4() {
		return netip.PrefixFrom(a, 32), nil
	}
	p, err := netip.ParsePrefix(s)
	if err != nil || !ipv4Prefix(p) {
		return netip.Prefix{}, fmt.Errorf("invalid protected IPv4 allocation")
	}
	return p, nil
}

func overlapsAny(p netip.Prefix, prefixes []netip.Prefix) bool {
	for _, q := range prefixes {
		if p.Overlaps(q) {
			return true
		}
	}
	return false
}
