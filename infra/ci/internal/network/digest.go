package network

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
)

// PolicyDigest hashes the inet <prefix> and bridge <prefix>_l2 tables in an
// nft -j list ruleset response. Both declarations are mandatory. Unrelated
// tables, metainfo, object handles and counter packets/bytes are ignored.
// All other fields, array order (including rule order), sets, priorities and
// policies remain significant. No claim is made about packet enforcement.
func PolicyDigest(rawJSON []byte, tablePrefix string) (string, error) {
	if !tableName.MatchString(tablePrefix) {
		return "", fmt.Errorf("invalid table prefix")
	}
	d := json.NewDecoder(bytes.NewReader(rawJSON))
	d.UseNumber()
	value, err := readJSON(d)
	if err != nil {
		return "", fmt.Errorf("nft JSON: %w", err)
	}
	if _, err := d.Token(); err != io.EOF {
		return "", fmt.Errorf("nft JSON must contain exactly one object")
	}
	root, ok := value.(map[string]any)
	if !ok || len(root) != 1 {
		return "", fmt.Errorf("nft JSON must be an object containing nftables")
	}
	entries, ok := root["nftables"].([]any)
	if !ok {
		return "", fmt.Errorf("nftables must be an array")
	}
	found := make(map[string]bool)
	selected := make([]any, 0)
	for _, entry := range entries {
		object, ok := entry.(map[string]any)
		if !ok || len(object) != 1 {
			return "", fmt.Errorf("nftables entries must be single-key objects")
		}
		for kind, value := range object {
			if kind == "metainfo" {
				continue
			}
			attrs, ok := value.(map[string]any)
			if !ok {
				return "", fmt.Errorf("invalid nft %s object", kind)
			}
			family, _ := attrs["family"].(string)
			name, _ := attrs["table"].(string)
			if kind == "table" {
				name, _ = attrs["name"].(string)
			}
			if !(family == "inet" && name == tablePrefix || family == "bridge" && name == tablePrefix+"_l2") {
				continue
			}
			if kind == "table" {
				if found[family] {
					return "", fmt.Errorf("duplicate owned %s table", family)
				}
				found[family] = true
			}
			delete(attrs, "handle")
			if kind == "counter" {
				delete(attrs, "packets")
				delete(attrs, "bytes")
			}
			scrubCounters(attrs)
			selected = append(selected, object)
		}
	}
	if !found["inet"] || !found["bridge"] {
		return "", fmt.Errorf("both owned tables inet %s and bridge %s_l2 are required", tablePrefix, tablePrefix)
	}
	canonical, err := json.Marshal(selected)
	if err != nil {
		return "", fmt.Errorf("canonical nft JSON: %w", err)
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

// VerifyPolicy refuses malformed/missing tables and any digest mismatch.
func VerifyPolicy(rawJSON []byte, prefix, want string) error {
	expected, err := hex.DecodeString(want)
	if err != nil || len(expected) != sha256.Size {
		return fmt.Errorf("expected policy digest must be 64 hexadecimal characters")
	}
	got, err := PolicyDigest(rawJSON, prefix)
	if err != nil {
		return err
	}
	actual, _ := hex.DecodeString(got)
	if subtle.ConstantTimeCompare(expected, actual) != 1 {
		return fmt.Errorf("owned network policy digest mismatch")
	}
	return nil
}

// Only counter usage is volatile. For example, quota bytes and limit burst
// values are policy and must never be stripped by a recursive key blacklist.
func scrubCounters(value any) {
	switch value := value.(type) {
	case []any:
		for _, element := range value {
			scrubCounters(element)
		}
	case map[string]any:
		for key, element := range value {
			if key == "counter" {
				if counter, ok := element.(map[string]any); ok {
					delete(counter, "packets")
					delete(counter, "bytes")
				}
			}
			scrubCounters(element)
		}
	}
}

// Decode recursively to reject duplicate keys rather than silently hashing the
// last value of an ambiguous JSON document. Numbers retain their full precision.
func readJSON(d *json.Decoder) (any, error) {
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return token, nil
	}
	switch delim {
	case '{':
		object := make(map[string]any)
		for d.More() {
			keyToken, err := d.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("JSON object key must be a string")
			}
			if _, exists := object[key]; exists {
				return nil, fmt.Errorf("duplicate JSON key %q", key)
			}
			value, err := readJSON(d)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		if _, err := d.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		array := make([]any, 0)
		for d.More() {
			value, err := readJSON(d)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if _, err := d.Token(); err != nil {
			return nil, err
		}
		return array, nil
	default:
		return nil, fmt.Errorf("unexpected JSON delimiter")
	}
}
