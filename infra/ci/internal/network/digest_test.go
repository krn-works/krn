package network

import (
	"encoding/json"
	"strings"
	"testing"
)

// Synthetic nft JSON schema fixture, not a claim of a host/kernel capture.
const policyJSON = `{"nftables":[
 {"metainfo":{"version":"1.1.7","release_name":"test","json_schema_version":1}},
 {"table":{"family":"inet","name":"ci_test","handle":1}},
 {"chain":{"family":"inet","table":"ci_test","name":"forward","handle":2,"type":"filter","hook":"forward","prio":0,"policy":"accept"}},
 {"set":{"family":"inet","table":"ci_test","name":"denied_ipv4","handle":3,"type":"ipv4_addr","flags":["interval"],"elem":["203.0.113.200",{"prefix":{"addr":"203.0.113.208","len":28}}]}},
 {"rule":{"family":"inet","table":"ci_test","chain":"forward","handle":4,"expr":[{"match":{"op":"==","left":{"payload":{"protocol":"tcp","field":"dport"}},"right":22}},{"counter":{"packets":0,"bytes":0}},{"accept":null}]}},
 {"rule":{"family":"inet","table":"ci_test","chain":"forward","handle":5,"expr":[{"counter":{"packets":8,"bytes":512}},{"drop":null}]}},
 {"counter":{"family":"inet","table":"ci_test","name":"drops","handle":6,"packets":20,"bytes":1024}},
 {"table":{"family":"ip","name":"unrelated","handle":10}},
 {"rule":{"family":"ip","table":"unrelated","chain":"input","handle":11,"expr":[{"accept":null}]}},
 {"table":{"family":"bridge","name":"ci_test_l2","handle":12}},
 {"chain":{"family":"bridge","table":"ci_test_l2","name":"input","handle":13,"type":"filter","hook":"input","prio":-300,"policy":"accept"}},
 {"rule":{"family":"bridge","table":"ci_test_l2","chain":"input","handle":14,"expr":[{"counter":{"packets":7,"bytes":9007199254740993}},{"drop":null}]}}
]}`

func policyObject(t *testing.T) map[string]any {
	t.Helper()
	d := json.NewDecoder(strings.NewReader(policyJSON))
	d.UseNumber()
	var object map[string]any
	if err := d.Decode(&object); err != nil {
		t.Fatal(err)
	}
	return object
}

func policyEntry(object map[string]any, index int, kind string) map[string]any {
	return object["nftables"].([]any)[index].(map[string]any)[kind].(map[string]any)
}

func encodePolicy(t *testing.T, object map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPolicyDigestIgnoresOnlyVolatileAndUnrelatedData(t *testing.T) {
	want, err := PolicyDigest([]byte(policyJSON), "ci_test")
	if err != nil || len(want) != 64 {
		t.Fatalf("initial digest %q: %v", want, err)
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"metainfo", func(o map[string]any) { policyEntry(o, 0, "metainfo")["version"] = "other" }},
		{"handles", func(o map[string]any) {
			for _, entry := range o["nftables"].([]any) {
				for _, attrs := range entry.(map[string]any) {
					attrs.(map[string]any)["handle"] = json.Number("9007199254740993")
				}
			}
		}},
		{"anonymous_counters", func(o map[string]any) {
			expr := policyEntry(o, 4, "rule")["expr"].([]any)
			counter := expr[1].(map[string]any)["counter"].(map[string]any)
			counter["packets"] = json.Number("9007199254740993")
			counter["bytes"] = json.Number("18446744073709551615")
		}},
		{"named_counters", func(o map[string]any) {
			counter := policyEntry(o, 6, "counter")
			counter["packets"], counter["bytes"] = 1234, 123456
		}},
		{"unrelated_policy", func(o map[string]any) {
			policyEntry(o, 8, "rule")["expr"] = []any{map[string]any{"drop": nil}}
		}},
		{"unrelated_deleted", func(o map[string]any) {
			entries := o["nftables"].([]any)
			o["nftables"] = append(entries[:7], entries[9:]...)
		}},
		{"json_key_order_whitespace", func(o map[string]any) {}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := policyObject(t)
			tc.change(o)
			raw := encodePolicy(t, o)
			got, err := PolicyDigest(raw, "ci_test")
			if err != nil || got != want {
				t.Fatalf("benign change altered digest %s -> %s: %v", want, got, err)
			}
			if err := VerifyPolicy(raw, "ci_test", want); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestPolicyDigestDetectsPolicyChanges(t *testing.T) {
	want, err := PolicyDigest([]byte(policyJSON), "ci_test")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"rule_order", func(o map[string]any) {
			entries := o["nftables"].([]any)
			entries[4], entries[5] = entries[5], entries[4]
		}},
		{"set_contents", func(o map[string]any) { policyEntry(o, 3, "set")["elem"].([]any)[0] = "203.0.113.201" }},
		{"set_flags", func(o map[string]any) { policyEntry(o, 3, "set")["flags"] = []any{"interval", "constant"} }},
		{"priority", func(o map[string]any) { policyEntry(o, 2, "chain")["prio"] = -1 }},
		{"base_policy", func(o map[string]any) { policyEntry(o, 2, "chain")["policy"] = "drop" }},
		{"expression", func(o map[string]any) {
			expr := policyEntry(o, 4, "rule")["expr"].([]any)
			expr[0].(map[string]any)["match"].(map[string]any)["right"] = 443
		}},
		{"bridge_rule", func(o map[string]any) {
			policyEntry(o, 11, "rule")["expr"].([]any)[1] = map[string]any{"accept": nil}
		}},
		{"deleted_rule", func(o map[string]any) {
			entries := o["nftables"].([]any)
			o["nftables"] = append(entries[:4], entries[5:]...)
		}},
		{"counter_removed", func(o map[string]any) {
			expr := policyEntry(o, 4, "rule")["expr"].([]any)
			policyEntry(o, 4, "rule")["expr"] = append(expr[:1], expr[2:]...)
		}},
		{"quota_bytes", func(o map[string]any) {
			policyEntry(o, 4, "rule")["expr"].([]any)[1] = map[string]any{"quota": map[string]any{"bytes": 1024}}
		}},
		{"future_object", func(o map[string]any) {
			o["nftables"] = append(o["nftables"].([]any), map[string]any{"future": map[string]any{"family": "inet", "table": "ci_test", "policy": "reject"}})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := policyObject(t)
			tc.change(o)
			raw := encodePolicy(t, o)
			got, err := PolicyDigest(raw, "ci_test")
			if err != nil || got == want {
				t.Fatalf("policy change not hashed: %s: %v", got, err)
			}
			if err := VerifyPolicy(raw, "ci_test", want); err == nil {
				t.Fatal("changed policy verified")
			}
		})
	}
}

func TestPolicyDigestRetainsBytePoliciesAndNumericPrecision(t *testing.T) {
	o := policyObject(t)
	quota := map[string]any{"bytes": json.Number("9007199254740992")}
	policyEntry(o, 4, "rule")["expr"].([]any)[1] = map[string]any{"quota": quota}
	before, err := PolicyDigest(encodePolicy(t, o), "ci_test")
	if err != nil {
		t.Fatal(err)
	}
	quota["bytes"] = json.Number("9007199254740993")
	after, err := PolicyDigest(encodePolicy(t, o), "ci_test")
	if err != nil || before == after {
		t.Fatalf("quota or numeric precision lost: %v", err)
	}
}

func TestPolicyDigestRejectsMissingTablesAndAmbiguousJSON(t *testing.T) {
	for _, index := range []int{1, 9} {
		o := policyObject(t)
		entries := o["nftables"].([]any)
		o["nftables"] = append(entries[:index], entries[index+1:]...)
		if _, err := PolicyDigest(encodePolicy(t, o), "ci_test"); err == nil {
			t.Fatalf("missing table at %d accepted while its rules remain", index)
		}
	}
	duplicate := policyObject(t)
	duplicate["nftables"] = append(duplicate["nftables"].([]any), map[string]any{"table": map[string]any{"family": "inet", "name": "ci_test"}})
	for _, tc := range []struct{ name, raw string }{
		{"null", "null"}, {"empty_object", "{}"}, {"empty_array", `{"nftables":[]}`},
		{"bad_array", `{"nftables":null}`}, {"bad_entry", `{"nftables":[null]}`},
		{"bad_attrs", `{"nftables":[{"rule":null}]}`},
		{"trailing", policyJSON + " {}"}, {"truncated", policyJSON[:len(policyJSON)-2]},
		{"root_duplicate", `{"nftables":[],"nftables":[]}`},
		{"nested_duplicate", strings.Replace(policyJSON, `"dport"`, `"dport","field":"sport"`, 1)},
		{"duplicate_table", string(encodePolicy(t, duplicate))},
		{"wrong_family", strings.Replace(policyJSON, `"family":"bridge"`, `"family":"ip"`, 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := PolicyDigest([]byte(tc.raw), "ci_test"); err == nil {
				t.Fatal("incomplete/ambiguous policy accepted")
			}
		})
	}
	if _, err := PolicyDigest([]byte(policyJSON), "ci;bad"); err == nil {
		t.Fatal("unsafe prefix accepted")
	}
	if _, err := PolicyDigest([]byte(policyJSON), "ci_other"); err == nil {
		t.Fatal("wrong prefix accepted")
	}
	for _, want := range []string{"", "zz", strings.Repeat("0", 63), strings.Repeat("0", 64), strings.Repeat("0", 66)} {
		if err := VerifyPolicy([]byte(policyJSON), "ci_test", want); err == nil {
			t.Fatalf("invalid/mismatched expected digest %q accepted", want)
		}
	}
}
