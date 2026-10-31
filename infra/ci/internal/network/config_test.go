package network

import (
	"encoding/json"
	"net/netip"
	"reflect"
	"strings"
	"testing"
)

// All address fixtures use RFC5737 documentation networks, never allocations.
const configJSON = `{
  "table_prefix": "ci_test",
  "runner_bridge": "br-runner",
  "controller_bridge": "br-controller",
  "runner_tap": "tap-runner",
  "controller_tap": "tap-controller",
  "uplink": "wan-test",
  "runner_subnet": "192.0.2.0/24",
  "controller_subnet": "198.51.100.0/24",
  "runner_ip": "192.0.2.2",
  "controller_ip": "198.51.100.2",
  "pve_runner_ip": "192.0.2.1",
  "pve_controller_ip": "198.51.100.1",
  "runner_mac": "02:00:00:00:00:02",
  "controller_mac": "02:00:00:00:00:04",
  "dns_servers": ["203.0.113.53", "203.0.113.54"],
  "controller_https_cidrs": ["203.0.113.0/27", "203.0.113.64/27"],
  "protected_public_ipv4": ["203.0.113.200", "203.0.113.208/28"]
}`

func exampleConfig(t *testing.T) Config {
	t.Helper()
	c, err := Decode([]byte(configJSON))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestDecodeStrictFields(t *testing.T) {
	c := exampleConfig(t)
	if c.AllowHTTP || c.RunnerIP != netip.MustParseAddr("192.0.2.2") {
		t.Fatalf("unexpected decoded defaults/addresses: %+v", c)
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	roundtrip, err := Decode(raw)
	if err != nil || !reflect.DeepEqual(c, roundtrip) {
		t.Fatalf("typed JSON roundtrip: %v", err)
	}
	for _, field := range configFields {
		t.Run("null_"+field, func(t *testing.T) {
			var object map[string]any
			if err := json.Unmarshal([]byte(configJSON), &object); err != nil {
				t.Fatal(err)
			}
			object[field] = nil
			raw, _ := json.Marshal(object)
			if _, err := Decode(raw); err == nil {
				t.Fatalf("accepted null %s", field)
			}
		})
		if field == "allow_http" {
			continue
		}
		t.Run("missing_"+field, func(t *testing.T) {
			var object map[string]any
			if err := json.Unmarshal([]byte(configJSON), &object); err != nil {
				t.Fatal(err)
			}
			delete(object, field)
			raw, _ := json.Marshal(object)
			if _, err := Decode(raw); err == nil {
				t.Fatalf("accepted missing %s", field)
			}
		})
	}
	for _, tc := range []struct{ name, raw string }{
		{"empty", ""}, {"null", "null"}, {"array", "[]"}, {"truncated", "{"},
		{"trailing_object", configJSON + " {}"}, {"trailing_garbage", configJSON + " garbage"},
		{"duplicate", strings.Replace(configJSON, `"table_prefix":`, `"table_prefix":"other", "table_prefix":`, 1)},
		{"unknown", strings.Replace(configJSON, `"table_prefix":`, `"unexpected": false, "table_prefix":`, 1)},
		{"case_alias", strings.Replace(configJSON, `"table_prefix"`, `"TABLE_PREFIX"`, 1)},
		{"null_element", strings.Replace(configJSON, `"203.0.113.53"`, `null`, 1)},
		{"wrong_boolean", strings.Replace(configJSON, `"table_prefix":`, `"allow_http": "false", "table_prefix":`, 1)},
		{"wrong_list", strings.Replace(configJSON, `["203.0.113.53", "203.0.113.54"]`, `"203.0.113.53"`, 1)},
		{"ipv6", strings.Replace(configJSON, `"192.0.2.2"`, `"::ffff:192.0.2.2"`, 1)},
		{"malformed_ip", strings.Replace(configJSON, `"192.0.2.2"`, `"192.0.2.999"`, 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Decode([]byte(tc.raw)); err == nil {
				t.Fatal("invalid input accepted")
			}
		})
	}
}

func TestValidateRejectsUnsafeAllocations(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Config)
	}{
		{"zero", func(c *Config) { *c = Config{} }},
		{"table_injection", func(c *Config) { c.TablePrefix = "ci; flush ruleset" }},
		{"table_long", func(c *Config) { c.TablePrefix = strings.Repeat("x", 49) }},
		{"interface_injection", func(c *Config) { c.RunnerTap = "tap\nup evil" }},
		{"interface_path", func(c *Config) { c.Uplink = "../wan" }},
		{"interface_long", func(c *Config) { c.RunnerBridge = strings.Repeat("x", 16) }},
		{"loopback", func(c *Config) { c.Uplink = "lo" }},
		{"duplicate_interface", func(c *Config) { c.RunnerTap = c.ControllerBridge }},
		{"empty_interface", func(c *Config) { c.ControllerBridge = "" }},
		{"overlap", func(c *Config) { c.ControllerSubnet = c.RunnerSubnet }},
		{"host_bits", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("192.0.2.1/24") }},
		{"ipv6_subnet", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("2001:db8::/64") }},
		{"small_subnet", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("192.0.2.0/31") }},
		{"lan", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("192.168.0.0/24") }},
		{"contains_lan", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("192.0.0.0/8") }},
		{"hotspot", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("172.20.10.0/24") }},
		{"cgnat", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("100.127.0.0/24") }},
		{"link_local", func(c *Config) { c.RunnerSubnet = netip.MustParsePrefix("169.254.0.0/24") }},
		{"wrong_role", func(c *Config) { c.RunnerIP = c.ControllerIP }},
		{"duplicate_address", func(c *Config) { c.PVERunnerIP = c.RunnerIP }},
		{"network_address", func(c *Config) { c.RunnerIP = netip.MustParseAddr("192.0.2.0") }},
		{"broadcast_address", func(c *Config) { c.RunnerIP = netip.MustParseAddr("192.0.2.255") }},
		{"mapped_ipv6", func(c *Config) { c.RunnerIP = netip.MustParseAddr("::ffff:192.0.2.2") }},
		{"missing_address", func(c *Config) { c.PVEControllerIP = netip.Addr{} }},
		{"multicast_mac", func(c *Config) { c.RunnerMAC = "01:00:00:00:00:02" }},
		{"zero_mac", func(c *Config) { c.RunnerMAC = "00:00:00:00:00:00" }},
		{"long_mac", func(c *Config) { c.RunnerMAC = "02:00:00:00:00:00:00:02" }},
		{"mac_injection", func(c *Config) { c.RunnerMAC = "02:00:00:00:00:02;accept" }},
		{"duplicate_mac", func(c *Config) { c.ControllerMAC = c.RunnerMAC }},
		{"nil_dns", func(c *Config) { c.DNSServers = nil }},
		{"private_dns", func(c *Config) { c.DNSServers[0] = netip.MustParseAddr("192.168.0.1") }},
		{"protected_dns", func(c *Config) { c.DNSServers[0] = netip.MustParseAddr("203.0.113.200") }},
		{"guest_dns", func(c *Config) { c.DNSServers[0] = c.RunnerIP }},
		{"duplicate_dns", func(c *Config) { c.DNSServers[1] = c.DNSServers[0] }},
		{"empty_https", func(c *Config) { c.ControllerHTTPSCIDRs = []netip.Prefix{} }},
		{"https_world", func(c *Config) { c.ControllerHTTPSCIDRs[0] = netip.MustParsePrefix("0.0.0.0/0") }},
		{"https_private", func(c *Config) { c.ControllerHTTPSCIDRs[0] = netip.MustParsePrefix("10.0.0.0/24") }},
		{"https_protected_overlap", func(c *Config) { c.ControllerHTTPSCIDRs[0] = netip.MustParsePrefix("203.0.113.0/24") }},
		{"https_duplicate", func(c *Config) { c.ControllerHTTPSCIDRs[1] = c.ControllerHTTPSCIDRs[0] }},
		{"https_host_bits", func(c *Config) { c.ControllerHTTPSCIDRs[0] = netip.MustParsePrefix("203.0.113.1/27") }},
		{"missing_protected", func(c *Config) { c.ProtectedPublicIPv4 = nil }},
		{"protected_private", func(c *Config) { c.ProtectedPublicIPv4[0] = "10.0.0.1" }},
		{"protected_ipv6", func(c *Config) { c.ProtectedPublicIPv4[0] = "2001:db8::1" }},
		{"protected_injection", func(c *Config) { c.ProtectedPublicIPv4[0] = "203.0.113.200; accept" }},
		{"protected_host_bits", func(c *Config) { c.ProtectedPublicIPv4[0] = "203.0.113.200/24" }},
		{"protected_duplicate", func(c *Config) { c.ProtectedPublicIPv4[1] = "203.0.113.200/32" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := exampleConfig(t)
			tc.change(&c)
			if err := Validate(c); err == nil {
				t.Fatal("unsafe configuration accepted")
			}
			if b, err := Render(c); err == nil || b != (Bundle{}) {
				t.Fatal("unsafe configuration rendered")
			}
		})
	}
}
