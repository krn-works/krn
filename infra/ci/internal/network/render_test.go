package network

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func renderExample(t *testing.T) Bundle {
	t.Helper()
	b, err := Render(exampleConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Inspect individual chains and permissions, rather than snapshotting the
// whole renderer. This proves text contracts, not kernel/packet behavior.
func chain(t *testing.T, text, table, name string) string {
	t.Helper()
	_, body, ok := strings.Cut(text, table+" {")
	if !ok {
		t.Fatalf("missing table %s", table)
	}
	_, body, ok = strings.Cut(body, "  chain "+name+" {\n")
	if !ok {
		t.Fatalf("missing chain %s", name)
	}
	body, _, ok = strings.Cut(body, "\n  }")
	if !ok {
		t.Fatalf("unclosed chain %s", name)
	}
	return body
}

func requireText(t *testing.T, body string, parts ...string) {
	t.Helper()
	for _, part := range parts {
		if !strings.Contains(body, part) {
			t.Errorf("missing %q in:\n%s", part, body)
		}
	}
}

func acceptRules(body string) []string {
	var rules []string
	for line := range strings.SplitSeq(body, "\n") {
		if strings.HasSuffix(line, " accept") {
			rules = append(rules, strings.TrimSpace(line))
		}
	}
	return rules
}

func TestRenderHostDirections(t *testing.T) {
	b := renderExample(t)
	for _, tc := range []struct {
		chain string
		want  []string
	}{
		{"guest_input", []string{
			`iifname { "br-controller", "tap-controller" } ip saddr 198.51.100.2 ip daddr 198.51.100.1 tcp dport 22 ct direction original ct state { new, established } counter accept`,
			`iifname { "br-controller", "tap-controller" } ip saddr 198.51.100.2 ip daddr 198.51.100.1 tcp sport 8080 ct direction reply ct state established counter accept`,
		}},
		{"guest_output", []string{
			`oifname { "br-controller", "tap-controller" } ip saddr 198.51.100.1 ip daddr 198.51.100.2 tcp sport 22 ct direction reply ct state established counter accept`,
			`oifname { "br-controller", "tap-controller" } ip saddr 198.51.100.1 ip daddr 198.51.100.2 tcp dport 8080 ct direction original ct state { new, established } counter accept`,
		}},
	} {
		t.Run(tc.chain, func(t *testing.T) {
			body := chain(t, b.NFTables, `table inet ci_test`, tc.chain)
			if got := acceptRules(body); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("host permissions:\ngot %v\nwant %v", got, tc.want)
			}
			requireText(t, body, "ct state invalid counter drop")
			if !strings.HasSuffix(body, "counter drop") {
				t.Fatal("scoped host chain is not closed")
			}
		})
	}
}

func TestRenderSSHBeforePrivateDeny(t *testing.T) {
	body := chain(t, renderExample(t).NFTables, `table inet ci_test`, "guest_forward")
	ssh := []string{
		`iifname { "br-controller", "tap-controller" } oifname { "br-runner", "tap-runner" } ip saddr 198.51.100.2 ip daddr 192.0.2.2 tcp dport 22 ct direction original ct state { new, established } counter accept`,
		`iifname { "br-runner", "tap-runner" } oifname { "br-controller", "tap-controller" } ip saddr 192.0.2.2 ip daddr 198.51.100.2 tcp sport 22 ct direction reply ct state established counter accept`,
	}
	rules := acceptRules(body)
	if len(rules) < 2 || !reflect.DeepEqual(rules[:2], ssh) {
		t.Fatalf("controller must initiate SSH, runner must only reply: %v", rules)
	}
	denyIndex := strings.Index(body, "ip daddr @denied_ipv4 counter drop")
	for _, rule := range ssh {
		if strings.Index(body, rule) >= denyIndex {
			t.Fatal("inter-bridge SSH is blocked by private/guest deny")
		}
	}
	for _, rule := range rules[2:] {
		if !strings.Contains(rule, `"wan-test"`) || strings.Contains(rule, "port 22 ") {
			t.Fatalf("unscoped non-WAN or extra SSH exception: %s", rule)
		}
		if strings.Index(body, rule) < denyIndex {
			t.Fatalf("WAN exception bypasses private/own-public protection: %s", rule)
		}
	}
}

func TestRenderWANEgressAndReturns(t *testing.T) {
	body := chain(t, renderExample(t).NFTables, `table inet ci_test`, "guest_forward")
	for _, tc := range []struct {
		name, ip, interfaces, target string
	}{
		{"runner", "192.0.2.2", `{ "br-runner", "tap-runner" }`, ""},
		{"controller", "198.51.100.2", `{ "br-controller", "tap-controller" }`, " ip daddr @controller_https_ipv4"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := fmt.Sprintf(`iifname %s oifname "wan-test" ip saddr %s`, tc.interfaces, tc.ip)
			in := fmt.Sprintf(`iifname "wan-test" oifname %s ip daddr %s`, tc.interfaces, tc.ip)
			for _, protocol := range []string{"udp", "tcp"} {
				requireText(t, body,
					out+" ip daddr @dns_ipv4 "+protocol+" dport 53 ct direction original ct state { new, established } counter accept",
					in+" ip saddr @dns_ipv4 "+protocol+" sport 53 ct direction reply ct state established counter accept")
			}
			requireText(t, body, out+tc.target+" tcp dport 443 ct direction original ct state { new, established } counter accept")
			for _, rule := range acceptRules(body) {
				if !strings.HasPrefix(rule, in) {
					continue
				}
				requireText(t, rule, "ct direction reply")
				if strings.Contains(rule, "ct state related") {
					requireText(t, rule, "meta l4proto icmp", "ct original ip saddr "+tc.ip,
						"ct original ip daddr != @denied_ipv4", "ct original proto-dst ")
					if strings.Contains(rule, "proto-dst 443") && tc.name == "controller" {
						requireText(t, rule, "ct original ip daddr @controller_https_ipv4")
					}
				} else {
					requireText(t, rule, "ct state established")
					if strings.Contains(rule, "sport 443") && tc.name == "controller" {
						requireText(t, rule, "ip saddr @controller_https_ipv4")
					}
				}
			}
		})
	}
	if strings.Contains(body, "port 80 ") || strings.Contains(body, "ct state { established, related } counter accept") {
		t.Fatal("unexpected HTTP or general established/related permission")
	}
	c := exampleConfig(t)
	c.AllowHTTP = true
	b, err := Render(c)
	if err != nil {
		t.Fatal(err)
	}
	body = chain(t, b.NFTables, `table inet ci_test`, "guest_forward")
	var http int
	for _, rule := range acceptRules(body) {
		if strings.Contains(rule, "port 80 ") || strings.Contains(rule, "proto-dst 80 ") {
			http++
			if strings.Contains(rule, "198.51.100.2") || !strings.Contains(rule, "192.0.2.2") {
				t.Fatalf("HTTP enabled for controller or another source: %s", rule)
			}
		}
	}
	if http != 3 { // outgoing, established response, related ICMP error
		t.Fatalf("HTTP exception count = %d", http)
	}
}

func TestRenderScopedBaseChainsAndNAT(t *testing.T) {
	b := renderExample(t)
	for _, tc := range []struct{ name, scope string }{
		{"input", "iifname"}, {"output", "oifname"}, {"forward", "iifname"},
	} {
		body := chain(t, b.NFTables, `table inet ci_test`, tc.name)
		requireText(t, body, "policy accept;", tc.scope+` { "br-runner", "tap-runner", "br-controller", "tap-controller" } jump guest_`)
		if strings.Contains(body, "drop") || len(acceptRules(body)) != 0 {
			t.Fatal("base chain affects unrelated interfaces")
		}
	}
	body := chain(t, b.NFTables, `table inet ci_test`, "postrouting")
	requireText(t, body, "type nat hook postrouting priority srcnat; policy accept;",
		`iifname { "br-runner", "tap-runner" } oifname "wan-test" ip saddr 192.0.2.2 counter masquerade`,
		`iifname { "br-controller", "tap-controller" } oifname "wan-test" ip saddr 198.51.100.2 counter masquerade`)
	if strings.Count(body, "masquerade") != 2 {
		t.Fatal("unexpected NAT scope")
	}
	for _, forbidden := range []string{"flush ruleset", "delete table", "policy drop", "sysctl", "post-up", "pre-up"} {
		if strings.Contains(b.NFTables+b.Interfaces, forbidden) {
			t.Fatalf("global/apply operation %q present", forbidden)
		}
	}
	if strings.Count(b.NFTables, "table inet ") != 1 || strings.Count(b.NFTables, "table bridge ") != 1 {
		t.Fatal("renderer must own exactly two tables")
	}
	for _, allocation := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "127.0.0.0/8", "192.0.2.0/24", "198.51.100.0/24", "203.0.113.200/32", "203.0.113.208/28"} {
		requireText(t, b.NFTables, allocation)
	}
	requireText(t, b.Interfaces, "iface br-runner inet static\n    address 192.0.2.1/24", "iface br-controller inet static\n    address 198.51.100.1/24")
	if strings.Count(b.Interfaces, "bridge-ports none") != 2 || strings.Contains(b.Interfaces, "wan-test") {
		t.Fatal("bridges must have no uplink")
	}
}

func TestRenderTapProtectionOnHostAndForward(t *testing.T) {
	b := renderExample(t)
	for _, hook := range []string{"prerouting", "input"} {
		body := chain(t, b.NFTables, `table bridge ci_test_l2`, hook)
		requireText(t, body, `iifname "tap-runner" jump runner_source`, `iifname "tap-controller" jump controller_source`, "policy accept;")
		if hook == "prerouting" {
			requireText(t, body, "priority -300;")
		}
	}
	body := chain(t, b.NFTables, `table bridge ci_test_l2`, "forward")
	requireText(t, body, `iifname { "tap-runner", "tap-controller" } counter drop`, `oifname { "tap-runner", "tap-controller" } counter drop`, "policy accept;")
	for _, tc := range []struct{ role, mac, ip, gateway string }{
		{"runner", "02:00:00:00:00:02", "192.0.2.2", "192.0.2.1"},
		{"controller", "02:00:00:00:00:04", "198.51.100.2", "198.51.100.1"},
	} {
		source := chain(t, b.NFTables, `table bridge ci_test_l2`, tc.role+"_source")
		requireText(t, source, "ether saddr != "+tc.mac+" counter drop", "ether type { 0x8100, 0x88a8 } counter drop", "ether type arp jump "+tc.role+"_arp")
		want := []string{"ether type ip ip saddr " + tc.ip + " counter accept"}
		if !reflect.DeepEqual(acceptRules(source), want) || !strings.HasSuffix(source, "counter drop") {
			t.Fatalf("IPv6/unknown types or unbound IPv4 permitted on %s", tc.role)
		}
		arp := chain(t, b.NFTables, `table bridge ci_test_l2`, tc.role+"_arp")
		requireText(t, arp, "arp saddr ether != "+tc.mac+" counter drop", "arp saddr ip != "+tc.ip+" counter drop", "arp daddr ip != "+tc.gateway+" counter drop")
		if !reflect.DeepEqual(acceptRules(arp), []string{"arp operation { request, reply } counter accept"}) || !strings.HasSuffix(arp, "counter drop") {
			t.Fatal("unexpected ARP permissions")
		}
	}
}

func TestRenderDeterministicAndPreservesConfig(t *testing.T) {
	c := exampleConfig(t)
	originalDNS := slices.Clone(c.DNSServers)
	originalHTTPS := slices.Clone(c.ControllerHTTPSCIDRs)
	originalProtected := slices.Clone(c.ProtectedPublicIPv4)
	a, err := Render(c)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.DNSServers, originalDNS) || !reflect.DeepEqual(c.ControllerHTTPSCIDRs, originalHTTPS) || !reflect.DeepEqual(c.ProtectedPublicIPv4, originalProtected) {
		t.Fatal("Render changed caller allocations")
	}
	slices.Reverse(c.DNSServers)
	slices.Reverse(c.ControllerHTTPSCIDRs)
	slices.Reverse(c.ProtectedPublicIPv4)
	c.RunnerMAC = strings.ToUpper(c.RunnerMAC)
	b, err := Render(c)
	if err != nil || a != b {
		t.Fatalf("equivalent unordered configuration changed output: %v", err)
	}
}

func TestNFTSyntax(t *testing.T) {
	nft, err := exec.LookPath("nft")
	if err != nil {
		t.Skip("nft unavailable; kernel/syntax NOT VERIFIED")
	}
	file := filepath.Join(t.TempDir(), "network.nft")
	if err := os.WriteFile(file, []byte(renderExample(t).NFTables), 0600); err != nil {
		t.Fatal(err)
	}
	// Check mode only; no sudo, namespace creation or privileged application.
	out, err := exec.Command(nft, "--check", "--file", file).CombinedOutput()
	if err != nil {
		message := string(out)
		if strings.Contains(message, "Operation not permitted") && !strings.Contains(message, "syntax error") {
			t.Skipf("unprivileged nft check unavailable; kernel/syntax NOT VERIFIED: %s", message)
		}
		t.Fatalf("nft --check: %v\n%s", err, out)
	}
}
