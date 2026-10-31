// Package reset implements the narrow protocol for one enrolled PVE VM.
package reset

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

var (
	uuidPattern   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hashPattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	namePattern   = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,62}$`)
	diskPattern   = regexp.MustCompile(`^((scsi|sata|virtio|ide)[0-9]+|efidisk0|tpmstate0)$`)
	volumePattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.-]{0,63}:[a-zA-Z0-9_./-]{1,180}$`)
	macPattern    = regexp.MustCompile(`^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$`)
	devicePattern = regexp.MustCompile(`^(net[1-9][0-9]*|hostpci[0-9]+|usb[0-9]+|virtiofs[0-9]+|unused[0-9]+)$`)
)

type Error struct{ Code string }

func (e *Error) Error() string  { return e.Code }
func failure(code string) error { return &Error{Code: code} }
func codeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "RESET_FAILED"
}

type NetworkBinding struct {
	Bridge string `json:"bridge"`
	MAC    string `json:"mac"`
}
type PolicyBinding struct {
	TablePrefix string `json:"table_prefix"`
	SHA256      string `json:"sha256"`
}
type Manifest struct {
	SchemaVersion           int               `json:"schema_version"`
	InstallationID          string            `json:"installation_id"`
	ExpectedPVEHostname     string            `json:"expected_pve_hostname"`
	VMID                    int               `json:"vmid"`
	VMName                  string            `json:"vm_name"`
	SMBIOSUUID              string            `json:"smbios_uuid"`
	Snapshot                string            `json:"snapshot"`
	SnapshotSHA256          string            `json:"snapshot_sha256"`
	MemoryMiB               int               `json:"memory_mib"`
	Cores                   int               `json:"cores"`
	Volumes                 map[string]string `json:"volumes"`
	ReadOnlyVolumes         map[string]string `json:"read_only_volumes"`
	Net0                    NetworkBinding    `json:"net0"`
	NFT                     PolicyBinding     `json:"nft"`
	OperationTimeoutSeconds int               `json:"operation_timeout_seconds"`
	BootTimeoutSeconds      int               `json:"boot_timeout_seconds"`
	MinResetIntervalSeconds int               `json:"min_reset_interval_seconds"`
}

func decodeStrict(data []byte, target any) error {
	if err := uniqueJSONKeys(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return failure("INVALID_JSON")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return failure("TRAILING_JSON")
	}
	return nil
}

// encoding/json otherwise silently accepts duplicate object keys, including
// contradictory generation numbers in the privileged reset protocol.
func uniqueJSONKeys(data []byte) error {
	d := json.NewDecoder(bytes.NewReader(data))
	var value func(int) error
	value = func(depth int) error {
		if depth > 64 {
			return failure("INVALID_JSON")
		}
		token, err := d.Token()
		if err != nil {
			return failure("INVALID_JSON")
		}
		delim, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				name, ok := key.(string)
				if err != nil || !ok || seen[strings.ToLower(name)] {
					return failure("DUPLICATE_JSON_KEY")
				}
				seen[strings.ToLower(name)] = true
				if err = value(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		default:
			return failure("INVALID_JSON")
		}
		_, err = d.Token()
		return err
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return failure("TRAILING_JSON")
	}
	return nil
}

func DecodeManifest(data []byte) (Manifest, error) {
	var m Manifest
	if len(data) > 65536 {
		return m, failure("MANIFEST_TOO_LARGE")
	}
	if err := decodeStrict(data, &m); err != nil {
		return m, err
	}
	return m, m.Validate()
}

func (m Manifest) Validate() error {
	switch {
	case m.SchemaVersion != 1:
		return failure("SCHEMA_VERSION")
	case !uuidPattern.MatchString(m.InstallationID) || !uuidPattern.MatchString(m.SMBIOSUUID):
		return failure("UUID_REQUIRED")
	case !namePattern.MatchString(m.ExpectedPVEHostname) || !namePattern.MatchString(m.Snapshot):
		return failure("UNSAFE_NAME")
	case m.VMID < 100 || m.VMID > 999999999:
		return failure("VMID_REQUIRED")
	case !namePattern.MatchString(m.VMName) || !strings.HasPrefix(m.VMName, "ci-"):
		return failure("CI_NAME_REQUIRED")
	case !hashPattern.MatchString(m.SnapshotSHA256):
		return failure("SNAPSHOT_DIGEST_REQUIRED")
	case m.MemoryMiB < 1024 || m.MemoryMiB > 65536 || m.Cores < 1 || m.Cores > 64:
		return failure("RESOURCE_LIMIT")
	case m.OperationTimeoutSeconds < 1 || m.OperationTimeoutSeconds > 600 || m.BootTimeoutSeconds < 1 || m.BootTimeoutSeconds > 600:
		return failure("TIMEOUT_LIMIT")
	case m.MinResetIntervalSeconds < 0 || m.MinResetIntervalSeconds > 3600:
		return failure("RESET_RATE_LIMIT")
	case len(m.Volumes) == 0 || m.ReadOnlyVolumes == nil:
		return failure("VOLUME_MANIFEST_REQUIRED")
	case !namePattern.MatchString(m.Net0.Bridge) || len(m.Net0.Bridge) > 15 || !macPattern.MatchString(m.Net0.MAC):
		return failure("NETWORK_BINDING_REQUIRED")
	case !namePattern.MatchString(m.NFT.TablePrefix) || !hashPattern.MatchString(m.NFT.SHA256):
		return failure("POLICY_DIGEST_REQUIRED")
	}
	for slot, volume := range m.Volumes {
		if !diskPattern.MatchString(slot) || !volumePattern.MatchString(volume) || strings.Contains(volume, "..") {
			return failure("UNMANAGED_VOLUME")
		}
		if _, duplicate := m.ReadOnlyVolumes[slot]; duplicate {
			return failure("DUPLICATE_VOLUME")
		}
	}
	for slot, volume := range m.ReadOnlyVolumes {
		if !diskPattern.MatchString(slot) || (volume != "none" && !volumePattern.MatchString(volume)) || strings.Contains(volume, "..") {
			return failure("UNMANAGED_VOLUME")
		}
	}
	return nil
}

func (m Manifest) Digest() string {
	data, _ := json.Marshal(m)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type Request struct {
	RequestID          string `json:"request_id"`
	ExpectedGeneration uint64 `json:"expected_generation"`
	ManifestSHA256     string `json:"manifest_sha256"`
}

func DecodeRequest(data []byte) (Request, error) {
	var r Request
	if len(data) > 4096 {
		return r, failure("REQUEST_TOO_LARGE")
	}
	// A pointer distinguishes missing/null expected_generation from generation0.
	var wire struct {
		RequestID          string  `json:"request_id"`
		ExpectedGeneration *uint64 `json:"expected_generation"`
		ManifestSHA256     string  `json:"manifest_sha256"`
	}
	if err := decodeStrict(data, &wire); err != nil {
		return r, err
	}
	if wire.ExpectedGeneration == nil || !uuidPattern.MatchString(wire.RequestID) || !hashPattern.MatchString(wire.ManifestSHA256) {
		return r, failure("INVALID_REQUEST")
	}
	r = Request{wire.RequestID, *wire.ExpectedGeneration, wire.ManifestSHA256}
	return r, nil
}

func ParseConfig(text string) (map[string]string, error) {
	config := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok || !namePattern.MatchString(key) {
			return nil, failure("MALFORMED_QM_CONFIG")
		}
		if _, duplicate := config[key]; duplicate {
			return nil, failure("DUPLICATE_QM_FIELD")
		}
		config[key] = strings.TrimSpace(value)
	}
	if len(config) == 0 {
		return nil, failure("EMPTY_QM_CONFIG")
	}
	return config, nil
}

func SnapshotDigest(config map[string]string) string {
	stable := map[string]string{}
	for key, value := range config {
		if key != "vmgenid" && key != "snaptime" && key != "parent" {
			stable[key] = value
		}
	}
	data, _ := json.Marshal(stable)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func properties(value string) (map[string]string, error) {
	result := map[string]string{}
	for _, part := range strings.Split(value, ",") {
		key, val, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		if _, duplicate := result[key]; duplicate {
			return nil, failure("DUPLICATE_PROPERTY")
		}
		result[key] = val
	}
	return result, nil
}

func VerifyIdentity(config map[string]string, m Manifest) error {
	smbios, err := properties(config["smbios1"])
	if err != nil {
		return err
	}
	if config["name"] != m.VMName {
		return failure("VM_NAME_MISMATCH")
	}
	if smbios["uuid"] != m.SMBIOSUUID {
		return failure("VM_UUID_MISMATCH")
	}
	tags := map[string]bool{}
	for _, t := range strings.Split(config["tags"], ";") {
		tags[t] = true
	}
	if !tags["ci-platform"] || !tags["ci-"+m.InstallationID] {
		return failure("VM_OWNER_MISMATCH")
	}
	return nil
}

func VerifyConfiguration(config map[string]string, m Manifest) error {
	if err := VerifyIdentity(config, m); err != nil {
		return err
	}
	if value := config["onboot"]; value != "" && value != "0" {
		return failure("AUTOSTART_FORBIDDEN")
	}
	if config["memory"] != strconv.Itoa(m.MemoryMiB) || config["cores"] != strconv.Itoa(m.Cores) {
		return failure("RESOURCE_DRIFT")
	}
	if value := config["balloon"]; value != "" && value != "0" {
		return failure("BALLOON_FORBIDDEN")
	}
	for key := range config {
		switch key {
		case "vmstate", "lock", "args", "hookscript", "ivshmem", "cicustom", "cipassword", "snapstate":
			return failure("UNMANAGED_STATE")
		}
		if devicePattern.MatchString(key) {
			return failure("UNMANAGED_DEVICE")
		}
	}
	net0, err := properties(config["net0"])
	if err != nil {
		return err
	}
	if net0["bridge"] != m.Net0.Bridge {
		return failure("BRIDGE_MISMATCH")
	}
	mac := ""
	count := 0
	for _, model := range []string{"virtio", "e1000", "e1000e", "vmxnet3"} {
		if value, ok := net0[model]; ok {
			mac = value
			count++
		}
	}
	if count != 1 || !strings.EqualFold(mac, m.Net0.MAC) {
		return failure("MAC_MISMATCH")
	}
	if value := net0["link_down"]; value != "" && value != "0" {
		return failure("NETWORK_DRIFT")
	}
	if _, ok := net0["tag"]; ok {
		return failure("NETWORK_DRIFT")
	}
	if _, ok := net0["trunks"]; ok {
		return failure("NETWORK_DRIFT")
	}
	writable, readonly := map[string]string{}, map[string]string{}
	for slot, value := range config {
		if !diskPattern.MatchString(slot) {
			continue
		}
		options, err := properties(value)
		if err != nil {
			return err
		}
		source := strings.SplitN(value, ",", 2)[0]
		if options["snapshot"] == "0" || options["shared"] == "1" {
			return failure("DISK_OUTSIDE_RESET")
		}
		if options["media"] == "cdrom" || options["ro"] == "1" {
			readonly[slot] = source
		} else {
			writable[slot] = source
		}
	}
	equal := func(a, b map[string]string) bool {
		if len(a) != len(b) {
			return false
		}
		for k, v := range a {
			if b[k] != v {
				return false
			}
		}
		return true
	}
	if !equal(writable, m.Volumes) || !equal(readonly, m.ReadOnlyVolumes) {
		return failure("VOLUME_MANIFEST_MISMATCH")
	}
	return nil
}

func SafeMessage(err error) string { return fmt.Sprintf("%s", codeOf(err)) }
