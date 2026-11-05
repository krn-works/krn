// Package executor runs one admitted CI attempt in a disposable Incus container.
// Profiles and the binary are trusted controller inputs, never PR inputs. Receipts
// describe execution; they are not independent attestations of PR-authored tests.
package executor

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	LogLimit     = 262144
	safePath     = "/opt/ci/bin:/usr/local/bin:/usr/bin:/bin"
	guestBinary  = "/opt/ci/executor"
	guestBundle  = "/opt/ci/source.bundle"
	guestSource  = "/home/ci/source"
	guestReceipt = "/home/ci/command-receipt.json"
)

type Tier string

const (
	Product    Tier = "product"
	GlobalFast Tier = "global-fast"
	GlobalDeep Tier = "global-deep"
)

type Mode string

const (
	Preflight Mode = "preflight"
	GateMode  Mode = "gate"
)

type JobSpec struct {
	RepoID           string `json:"repo_id"`
	SourceSHA        string `json:"source_sha"`
	BaseSHA          string `json:"base_sha,omitempty"`
	ConfigSHA        string `json:"config_sha"`
	ImageFingerprint string `json:"image_fingerprint"`
	AttemptID        string `json:"attempt_id"`
	Tier             Tier   `json:"tier"`
	TimeoutSeconds   int    `json:"timeout_seconds"`
	MemoryMiB        int    `json:"memory_mib"`
	ProcessLimit     int    `json:"process_limit"`
}

func (s JobSpec) ContainerName() string { return "ci-" + s.AttemptID }

// Gate is an exact allowlist entry from the reviewed config. Global commands
// have no inferred defaults. Product always means the full npm gate.
type Gate struct {
	Tier          Tier     `json:"tier"`
	Argv          []string `json:"argv"`
	SummaryPrefix string   `json:"summary_prefix"`
	SummaryMode   string   `json:"summary_mode,omitempty"`
}

type Profile struct {
	RepoID               string `json:"repo_id"`
	ConfigSHA            string `json:"config_sha"`
	ImageFingerprint     string `json:"image_fingerprint"`
	ImageManifestSHA256  string `json:"image_manifest_sha256"`
	IncusPackageRevision string `json:"incus_package_revision"`
	Project              string `json:"project"`
	StoragePool          string `json:"storage_pool"`
	// Nesting is a trusted profile choice, never a job parameter. It relaxes
	// inner LXC mount restrictions and requires the outer VM reset boundary.
	Nesting         bool   `json:"nesting"`
	CPUCount        int    `json:"cpu_count"`
	RootGiB         int    `json:"root_gib"`
	VMMemoryMiB     int    `json:"vm_memory_mib"`
	VMHeadroomMiB   int    `json:"vm_headroom_mib"`
	MaxJobMemoryMiB int    `json:"max_job_memory_mib"`
	MaxJobProcesses int    `json:"max_job_processes"`
	Gates           []Gate `json:"gates"`
	GitName         string `json:"git_name"`
	GitEmail        string `json:"git_email"`
}

type Options struct {
	BundlePath string `json:"bundle_path"`
	// BinaryPath is the same statically built CLI that delegates `executor` to Main.
	BinaryPath   string `json:"binary_path"`
	EvidenceRoot string `json:"evidence_root"`
	Mode         Mode   `json:"mode"`
}

func match(pattern, value string) bool {
	return regexp.MustCompile("^(?:" + pattern + ")$").MatchString(value)
}
func bounded(n, low, high int) bool { return n >= low && n <= high }
func validTier(t Tier) bool         { return t == Product || t == GlobalFast || t == GlobalDeep }
func require(ok bool, message string) error {
	if !ok {
		return errors.New(message)
	}
	return nil
}

func (s JobSpec) Validate() error {
	checks := []struct {
		ok      bool
		message string
	}{
		{match(`[1-9][0-9]{0,19}`, s.RepoID), "invalid repo_id"},
		{match(`[0-9a-f]{40}`, s.SourceSHA), "invalid source_sha"},
		{match(`[0-9a-f]{40}`, s.ConfigSHA), "invalid config_sha"},
		{match(`[0-9a-f]{64}`, s.ImageFingerprint), "invalid image fingerprint"},
		{match(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`, s.AttemptID), "canonical UUIDv4 required"},
		{validTier(s.Tier), "unknown tier"},
		{s.BaseSHA == "" && s.Tier == Product || match(`[0-9a-f]{40}`, s.BaseSHA), "GLOBAL requires full base_sha"},
		{bounded(s.TimeoutSeconds, 30, 7200), "timeout out of bounds"},
		{bounded(s.MemoryMiB, 256, 14336), "memory out of bounds"},
		{bounded(s.ProcessLimit, 64, 4096), "process limit out of bounds"},
	}
	for _, c := range checks {
		if !c.ok {
			return errors.New(c.message)
		}
	}
	return nil
}

func (g Gate) validate() error {
	if !validTier(g.Tier) || len(g.Argv) == 0 || len(g.Argv) > 32 || (g.SummaryMode != "native-exit" && !match(`[A-Z][A-Z0-9_]{0,63}=`, g.SummaryPrefix)) {
		return errors.New("invalid gate mapping")
	}
	for _, arg := range g.Argv {
		if !match(`[ -~]{1,256}`, arg) {
			return errors.New("unsafe gate argument")
		}
		lower := strings.ToLower(arg)
		for _, forbidden := range []string{"://", "token", "password", "private_key", "credential"} {
			if strings.Contains(lower, forbidden) {
				return errors.New("gate arguments must be credential-free")
			}
		}
	}
	if !match(`(/[a-zA-Z0-9_./-]+|[a-zA-Z0-9_-]+)`, g.Argv[0]) {
		return errors.New("invalid gate executable")
	}
	for _, forbidden := range []string{"sh", "bash", "dash", "zsh", "env", "sudo", "su", "curl", "wget", "ssh"} {
		if filepath.Base(g.Argv[0]) == forbidden {
			return errors.New("unsupported gate entrypoint")
		}
	}
	if g.SummaryMode != "" && g.SummaryMode != "native-exit" {
		return errors.New("unknown summary mode")
	}
	if g.Tier != Product {
		tier := "fast"
		if g.Tier == GlobalDeep {
			tier = "deep"
		}
		if strings.Join(g.Argv, "\x00") != guestBinary+"\x00global\x00"+tier || g.SummaryMode != "native-exit" || g.SummaryPrefix != "" {
			return errors.New("GLOBAL requires fixed wrapper and native-exit evidence")
		}
	}
	if g.Tier == Product && (g.SummaryMode != "" || strings.Join(g.Argv, "\x00") != "npm\x00run\x00gate" || g.SummaryPrefix != "KRN_TEST_SUMMARY_JSON=") {
		return errors.New("Product requires the full gate and its summary")
	}
	return nil
}

func (p Profile) Validate() error {
	if !match(`[1-9][0-9]{0,19}`, p.RepoID) || !match(`[0-9a-f]{40}`, p.ConfigSHA) || !match(`[0-9a-f]{64}`, p.ImageFingerprint) || !match(`[0-9a-f]{64}`, p.ImageManifestSHA256) {
		return errors.New("invalid profile identity")
	}
	if !match(`[0-9][a-zA-Z0-9.+:~_-]{0,79}`, p.IncusPackageRevision) || !strings.Contains(p.IncusPackageRevision, "-") {
		return errors.New("full Incus package revision required")
	}
	if !match(`[a-z][a-z0-9-]{0,47}`, p.Project) || !match(`[a-z][a-z0-9-]{0,47}`, p.StoragePool) {
		return errors.New("invalid Incus name")
	}
	if !bounded(p.CPUCount, 1, 8) || !bounded(p.RootGiB, 8, 64) || !bounded(p.VMMemoryMiB, 2048, 65536) || !bounded(p.VMHeadroomMiB, 1536, 32768) || !bounded(p.MaxJobMemoryMiB, 256, 14336) || !bounded(p.MaxJobProcesses, 64, 4096) || p.MaxJobMemoryMiB+p.VMHeadroomMiB > p.VMMemoryMiB {
		return errors.New("profile resource bounds/headroom invalid")
	}
	if !match(`[A-Za-z0-9 ._-]{1,80}`, p.GitName) || !match(`[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+`, p.GitEmail) {
		return errors.New("invalid nonsecret git identity")
	}
	if len(p.Gates) == 0 || len(p.Gates) > 3 {
		return errors.New("reviewed gate mapping required")
	}
	seen := map[Tier]bool{}
	for _, g := range p.Gates {
		if err := g.validate(); err != nil {
			return err
		}
		if seen[g.Tier] {
			return errors.New("duplicate gate tier")
		}
		seen[g.Tier] = true
	}
	return nil
}

func canonicalPath(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && len(path) <= 4096 && match(`[/A-Za-z0-9_. -]+`, path)
}

// Decode rejects unknown fields, oversized input and trailing values.
func Decode(r io.Reader, into any) error {
	b, err := io.ReadAll(io.LimitReader(r, LogLimit+1))
	if err != nil {
		return err
	}
	if len(b) > LogLimit {
		return errors.New("JSON input too large")
	}
	if err = uniqueJSONKeys(b); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err = d.Decode(into); err != nil {
		return errors.New("invalid JSON schema")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON input")
	}
	return nil
}

func uniqueJSONKeys(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	var value func(int) error
	value = func(depth int) error {
		if depth > 32 {
			return errors.New("JSON nesting too deep")
		}
		token, err := d.Token()
		if err != nil {
			return errors.New("invalid JSON")
		}
		switch token {
		case json.Delim('{'):
			seen := map[string]bool{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return errors.New("invalid JSON key")
				}
				name, ok := key.(string)
				if !ok || seen[name] {
					return errors.New("duplicate/invalid JSON key")
				}
				seen[name] = true
				if err = value(depth + 1); err != nil {
					return err
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return errors.New("invalid JSON object")
			}
		case json.Delim('['):
			for d.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("invalid JSON array")
			}
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON input")
	}
	return nil
}

type Counts struct {
	Tests     int `json:"tests"`
	Passed    int `json:"passed"`
	Failed    int `json:"failed"`
	Skipped   int `json:"skipped"`
	Todo      int `json:"todo"`
	Cancelled int `json:"cancelled"`
}
type FileCounts struct {
	File string `json:"file"`
	Counts
}
type Summary struct {
	Version int          `json:"version"`
	Success bool         `json:"success"`
	Counts  Counts       `json:"counts"`
	Files   []FileCounts `json:"files"`
}

// Missing/null counters must not silently become passing zero values.
func (s *Summary) UnmarshalJSON(b []byte) error {
	type plain Summary
	if err := Decode(bytes.NewReader(b), (*plain)(s)); err != nil {
		return err
	}
	var raw struct {
		Version *int                         `json:"version"`
		Success *bool                        `json:"success"`
		Counts  map[string]json.RawMessage   `json:"counts"`
		Files   []map[string]json.RawMessage `json:"files"`
	}
	if json.Unmarshal(b, &raw) != nil || raw.Version == nil || raw.Success == nil {
		return errors.New("missing summary fields")
	}
	countsPresent := func(fields map[string]json.RawMessage, expected int) bool {
		if len(fields) != expected {
			return false
		}
		for _, key := range []string{"tests", "passed", "failed", "skipped", "todo", "cancelled"} {
			v, ok := fields[key]
			if !ok || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
				return false
			}
		}
		return true
	}
	if !countsPresent(raw.Counts, 6) {
		return errors.New("missing summary counters")
	}
	for _, file := range raw.Files {
		if !countsPresent(file, 7) {
			return errors.New("missing file counters")
		}
	}
	return nil
}
func (c Counts) passing() bool {
	return bounded(c.Tests, 1, 1000000000) && c.Passed == c.Tests && c.Failed == 0 && c.Skipped == 0 && c.Todo == 0 && c.Cancelled == 0
}
func (s *Summary) Validate() error {
	if s == nil || s.Version != 1 || !s.Success || !s.Counts.passing() || len(s.Files) == 0 || len(s.Files) > 10000 {
		return errors.New("missing or nonpassing summary")
	}
	total := 0
	seen := map[string]bool{}
	for _, f := range s.Files {
		if len(f.File) > 1024 || !match(`[ -~]+`, f.File) || seen[f.File] || !f.Counts.passing() {
			return errors.New("invalid summary file coverage")
		}
		seen[f.File] = true
		total += f.Tests
		if total > 1000000000 {
			return errors.New("summary counts overflow")
		}
	}
	return require(total == s.Counts.Tests, "summary totals differ")
}

type Outcome struct {
	Status            string    `json:"status"`
	ExitCode          *int      `json:"exit_code"`
	Signal            int       `json:"signal"`
	TransportExitCode int       `json:"transport_exit_code"`
	StartedAt         time.Time `json:"started_at"`
	FinishedAt        time.Time `json:"finished_at"`
}

type CommandReceipt struct {
	Expected       JobSpec  `json:"expected"`
	CommandID      string   `json:"command_id"`
	ActualCheckout string   `json:"actual_checkout"`
	FinalCheckout  string   `json:"final_checkout"`
	Outcome        Outcome  `json:"outcome"`
	EvidenceKind   string   `json:"evidence_kind,omitempty"`
	SummaryCount   int      `json:"summary_count"`
	Summary        *Summary `json:"summary"`
}

type Evidence struct {
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	Bytes     int    `json:"bytes"`
	Truncated bool   `json:"truncated"`
}

type Receipt struct {
	Expected             JobSpec             `json:"expected"`
	Mode                 Mode                `json:"mode"`
	Argv                 []string            `json:"argv"`
	CommandID            string              `json:"command_id"`
	ActualImage          string              `json:"actual_image"`
	ActualCheckout       string              `json:"actual_checkout"`
	IncusPackageRevision string              `json:"incus_package_revision"`
	Status               string              `json:"status"`
	FailureOrigin        string              `json:"failure_origin"`
	Cleanup              string              `json:"cleanup"`
	Command              Outcome             `json:"command"`
	Summary              *Summary            `json:"summary"`
	EvidenceKind         string              `json:"evidence_kind,omitempty"`
	StartedAt            time.Time           `json:"started_at"`
	FinishedAt           time.Time           `json:"finished_at"`
	Evidence             map[string]Evidence `json:"evidence"`
	Errors               []string            `json:"errors"`
}

func (r Receipt) ExitStatus() int {
	if r.Status == "PASS" || r.Status == "PREFLIGHT_PASS" {
		return 0
	}
	if r.Command.Status == "timeout" {
		return 124
	}
	if r.Command.Status == "signaled" && bounded(r.Command.Signal, 1, 64) {
		return 128 + r.Command.Signal
	}
	if r.Command.Status == "exited" && r.Command.ExitCode != nil && *r.Command.ExitCode != 0 {
		return *r.Command.ExitCode
	}
	return 1
}

func digest(b []byte) string                         { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func commandID(g Gate) string                        { b, _ := json.Marshal(g); return digest(b) }
func jsonBytes(v any) []byte                         { b, _ := json.Marshal(v); return b }
func property(k string, n int, suffix string) string { return fmt.Sprintf("%s=%d%s", k, n, suffix) }
