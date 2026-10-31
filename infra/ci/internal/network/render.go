package network

import (
	"fmt"
	"net/netip"
	"slices"
	"strings"
)

// Bundle contains configuration text only. Loading/replacing the two owned
// tables atomically and controlling guest admission belong to the caller.
type Bundle struct {
	NFTables   string
	Interfaces string
}

// Render produces deterministic configuration without mutating Config or the
// host. Base policies accept unrelated traffic; scoped chains end in drop.
// Separate bridges must contain only their allocated tap, with no uplink port.
func Render(c Config) (Bundle, error) {
	if err := Validate(c); err != nil {
		return Bundle{}, err
	}
	var b strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	owned := interfaceSet(c.RunnerBridge, c.RunnerTap, c.ControllerBridge, c.ControllerTap)
	runner := interfaceSet(c.RunnerBridge, c.RunnerTap)
	controller := interfaceSet(c.ControllerBridge, c.ControllerTap)
	denied := append(slices.Clone(reservedIPv4), c.RunnerSubnet, c.ControllerSubnet)
	for _, s := range c.ProtectedPublicIPv4 {
		p, _ := parseProtected(s) // Validate has checked every allocation.
		denied = append(denied, p)
	}
	line("# Inert CI configuration; no global flush, forwarding or host changes.")
	line("# Policy checks detect drift after observation, not instantaneously.")
	line("# HTTPS permits data/tunnels; this is not an exfiltration guarantee.")
	line("table inet %s {", c.TablePrefix)
	line("  set denied_ipv4 {")
	line("    type ipv4_addr; flags interval;")
	line("    elements = { %s }", prefixList(denied))
	line("  }")
	line("  set dns_ipv4 {")
	line("    type ipv4_addr;")
	dns := slices.Clone(c.DNSServers)
	slices.SortFunc(dns, netip.Addr.Compare)
	values := make([]string, len(dns))
	for i, a := range dns {
		values[i] = a.String()
	}
	line("    elements = { %s }", strings.Join(values, ", "))
	line("  }")
	line("  set controller_https_ipv4 {")
	line("    type ipv4_addr; flags interval;")
	line("    elements = { %s }", prefixList(c.ControllerHTTPSCIDRs))
	line("  }")
	line("  chain input {")
	line("    type filter hook input priority filter; policy accept;")
	line("    iifname %s jump guest_input", owned)
	line("  }")
	line("  chain guest_input {")
	line("    ct state invalid counter drop")
	line("    iifname %s ip saddr %s ip daddr %s tcp dport 22 ct direction original ct state { new, established } counter accept", controller, c.ControllerIP, c.PVEControllerIP)
	line("    iifname %s ip saddr %s ip daddr %s tcp sport 8080 ct direction reply ct state established counter accept", controller, c.ControllerIP, c.PVEControllerIP)
	line("    counter drop")
	line("  }")
	line("  chain output {")
	line("    type filter hook output priority filter; policy accept;")
	line("    oifname %s jump guest_output", owned)
	line("  }")
	line("  chain guest_output {")
	line("    ct state invalid counter drop")
	line("    oifname %s ip saddr %s ip daddr %s tcp sport 22 ct direction reply ct state established counter accept", controller, c.PVEControllerIP, c.ControllerIP)
	line("    oifname %s ip saddr %s ip daddr %s tcp dport 8080 ct direction original ct state { new, established } counter accept", controller, c.PVEControllerIP, c.ControllerIP)
	line("    counter drop")
	line("  }")
	line("  chain forward {")
	line("    type filter hook forward priority filter; policy accept;")
	line("    iifname %s jump guest_forward", owned)
	line("    oifname %s jump guest_forward", owned)
	line("  }")
	line("  chain guest_forward {")
	line("    ct state invalid counter drop")
	line("    iifname %s oifname %s ip saddr %s ip daddr %s tcp dport 22 ct direction original ct state { new, established } counter accept", controller, runner, c.ControllerIP, c.RunnerIP)
	line("    iifname %s oifname %s ip saddr %s ip daddr %s tcp sport 22 ct direction reply ct state established counter accept", runner, controller, c.RunnerIP, c.ControllerIP)
	line("    iifname %s ip daddr @denied_ipv4 counter drop", owned)
	line("    iifname %q ip saddr @denied_ipv4 counter drop", c.Uplink)
	// Every WAN exception binds both interfaces, the guest IP, protocol, port
	// and conntrack direction. No general established/related accept exists.
	for _, role := range []struct {
		interfaces string
		ip         netip.Addr
		https      string
		http       bool
	}{
		{runner, c.RunnerIP, "", c.AllowHTTP},
		{controller, c.ControllerIP, "@controller_https_ipv4", false},
	} {
		out := fmt.Sprintf("iifname %s oifname %q ip saddr %s", role.interfaces, c.Uplink, role.ip)
		in := fmt.Sprintf("iifname %q oifname %s ip daddr %s", c.Uplink, role.interfaces, role.ip)
		for _, service := range []struct {
			protocol string
			port     int
			target   string
		}{
			{"udp", 53, "@dns_ipv4"}, {"tcp", 53, "@dns_ipv4"}, {"tcp", 443, role.https},
			{"tcp", 80, ""},
		} {
			if service.port == 80 && !role.http {
				continue
			}
			destination, source, original := "", "", ""
			if service.target != "" {
				destination = " ip daddr " + service.target
				source = " ip saddr " + service.target
				original = " ct original ip daddr " + service.target
			}
			line("    %s%s %s dport %d ct direction original ct state { new, established } counter accept", out, destination, service.protocol, service.port)
			line("    %s%s %s sport %d ct direction reply ct state established counter accept", in, source, service.protocol, service.port)
			// ICMP errors have no TCP/UDP ports in their outer header. Check
			// the original tuple instead, retaining path and destination scope.
			line("    %s meta l4proto icmp icmp type { destination-unreachable, time-exceeded, parameter-problem } ct direction reply ct state related ct original ip saddr %s ct original ip daddr != @denied_ipv4%s ct original protocol %s ct original proto-dst %d counter accept", in, role.ip, original, service.protocol, service.port)
		}
	}
	line("    counter drop")
	line("  }")
	line("  chain postrouting {")
	line("    type nat hook postrouting priority srcnat; policy accept;")
	line("    iifname %s oifname %q ip saddr %s counter masquerade", runner, c.Uplink, c.RunnerIP)
	line("    iifname %s oifname %q ip saddr %s counter masquerade", controller, c.Uplink, c.ControllerIP)
	line("  }")
	line("}")
	line("table bridge %s_l2 {", c.TablePrefix)
	line("  chain prerouting {")
	line("    type filter hook prerouting priority -300; policy accept;")
	line("    iifname %q jump runner_source", c.RunnerTap)
	line("    iifname %q jump controller_source", c.ControllerTap)
	line("  }")
	line("  chain input {")
	line("    type filter hook input priority filter; policy accept;")
	line("    iifname %q jump runner_source", c.RunnerTap)
	line("    iifname %q jump controller_source", c.ControllerTap)
	line("  }")
	line("  chain forward {")
	line("    type filter hook forward priority filter; policy accept;")
	line("    iifname %s counter drop", interfaceSet(c.RunnerTap, c.ControllerTap))
	line("    oifname %s counter drop", interfaceSet(c.RunnerTap, c.ControllerTap))
	line("  }")
	for _, role := range []struct {
		name    string
		mac     string
		ip      netip.Addr
		gateway netip.Addr
	}{
		{"runner", strings.ToLower(c.RunnerMAC), c.RunnerIP, c.PVERunnerIP},
		{"controller", strings.ToLower(c.ControllerMAC), c.ControllerIP, c.PVEControllerIP},
	} {
		line("  chain %s_source {", role.name)
		line("    ether saddr != %s counter drop", role.mac)
		line("    ether type { 0x8100, 0x88a8 } counter drop")
		line("    ether type arp jump %s_arp", role.name)
		line("    ether type ip ip saddr %s counter accept", role.ip)
		line("    counter drop")
		line("  }")
		line("  chain %s_arp {", role.name)
		line("    arp saddr ether != %s counter drop", role.mac)
		line("    arp saddr ip != %s counter drop", role.ip)
		line("    arp daddr ip != %s counter drop", role.gateway)
		line("    arp operation { request, reply } counter accept")
		line("    counter drop")
		line("  }")
	}
	line("}")
	var interfaces strings.Builder
	fmt.Fprintln(&interfaces, "# Separate CI bridges: no physical uplink and no forwarding mutation.")
	for _, role := range []struct {
		bridge string
		ip     netip.Addr
		subnet netip.Prefix
	}{
		{c.RunnerBridge, c.PVERunnerIP, c.RunnerSubnet},
		{c.ControllerBridge, c.PVEControllerIP, c.ControllerSubnet},
	} {
		fmt.Fprintf(&interfaces, "auto %s\niface %s inet static\n    address %s/%d\n    bridge-ports none\n    bridge-stp off\n    bridge-fd 0\n\n", role.bridge, role.bridge, role.ip, role.subnet.Bits())
	}
	return Bundle{NFTables: b.String(), Interfaces: interfaces.String()}, nil
}

func interfaceSet(names ...string) string {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = fmt.Sprintf("%q", name)
	}
	return "{ " + strings.Join(quoted, ", ") + " }"
}

// CIDR overlaps imply containment. Remove contained prefixes so interval sets
// are valid even when an allocated private subnet is already in the deny set.
func prefixList(prefixes []netip.Prefix) string {
	ordered := slices.Clone(prefixes)
	slices.SortFunc(ordered, func(a, b netip.Prefix) int {
		if n := a.Addr().Compare(b.Addr()); n != 0 {
			return n
		}
		return a.Bits() - b.Bits()
	})
	var kept []netip.Prefix
	var values []string
	for _, p := range ordered {
		if overlapsAny(p, kept) {
			continue
		}
		kept = append(kept, p)
		values = append(values, p.String())
	}
	return strings.Join(values, ", ")
}
