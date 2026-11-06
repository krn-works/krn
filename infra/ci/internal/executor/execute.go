package executor

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type instance struct {
	Name     string                       `json:"name"`
	Type     string                       `json:"type"`
	Profiles []string                     `json:"profiles"`
	Config   map[string]string            `json:"expanded_config"`
	Devices  map[string]map[string]string `json:"expanded_devices"`
}
type toolProbe struct {
	Versions       map[string]string `json:"versions"`
	Options        bool              `json:"options"`
	ManifestSHA256 string            `json:"manifest_sha256"`
	Manifest       json.RawMessage   `json:"manifest"`
	MemoryMax      string            `json:"memory_max"`
	PidsMax        string            `json:"pids_max"`
	HelperSHA256   string            `json:"helper_sha256"`
}
type memoryProbe struct {
	Limit    string `json:"limit"`
	Swap     string `json:"swap"`
	Touched  int    `json:"touched"`
	Signal   int    `json:"signal"`
	OOMKills int    `json:"oom_kills"`
	Peak     int    `json:"peak"`
}
type pidsProbe struct {
	Limit    string `json:"limit"`
	Denied   bool   `json:"denied"`
	Children int    `json:"children"`
	Events   int    `json:"events"`
}
type sessionProbe struct {
	UID       int         `json:"uid"`
	Home      string      `json:"home"`
	Runtime   string      `json:"runtime"`
	Bus       string      `json:"bus"`
	Session   string      `json:"session"`
	Manager   string      `json:"manager"`
	Cwd       string      `json:"cwd"`
	Path      string      `json:"path"`
	Cgroup    string      `json:"cgroup"`
	BwrapArgv []string    `json:"bwrap_argv"`
	Memory    memoryProbe `json:"memory"`
	Pids      pidsProbe   `json:"pids"`
}

func (s sessionProbe) validate() error {
	if s.UID != 1000 || s.Home != "/home/ci" || s.Runtime != "/run/user/1000" || s.Bus != "unix:path=/run/user/1000/bus" || s.Cwd != "/home/ci" || s.Path != safePath || s.Cgroup == "" || s.Manager == "" || !reflect.DeepEqual(s.BwrapArgv, bwrapArgv()) || !strings.Contains(s.Session, "User=1000") || !(strings.Contains(s.Session, "State=active") || strings.Contains(s.Session, "State=online")) {
		return errors.New("missing logind/bwrap/cgroup probe")
	}
	m, p := s.Memory, s.Pids
	if m.Limit != "67108864" || m.Swap != "0" || !bounded(m.Touched, 1024*1024, 128*1024*1024) || m.Signal != 9 || !bounded(m.OOMKills, 1, 10) || !bounded(m.Peak, 1, 80*1024*1024) {
		return errors.New("memory enforcement probe failed")
	}
	if p.Limit != "16" || !p.Denied || !bounded(p.Children, 1, 24) || !bounded(p.Events, 1, 100) {
		return errors.New("pids enforcement probe failed")
	}
	return nil
}

func (c CommandReceipt) validate(p *ExecutionPlan, result ProcessResult) error {
	if c.Expected != p.spec || c.CommandID != commandID(p.gate) || c.ActualCheckout != p.spec.SourceSHA || c.FinalCheckout != p.spec.SourceSHA {
		return errors.New("command receipt identity/checkout mismatch")
	}
	o := c.Outcome
	if o.StartedAt.IsZero() || o.FinishedAt.Before(o.StartedAt) || result.StartFailed || result.TimedOut {
		return errors.New("command receipt times/transport invalid")
	}
	switch o.Status {
	case "exited":
		if o.ExitCode == nil || !bounded(*o.ExitCode, 0, 255) || o.Signal != 0 || result.ExitCode != *o.ExitCode {
			return errors.New("gate exit code not preserved")
		}
	case "signaled":
		if o.ExitCode != nil || !bounded(o.Signal, 1, 64) || result.ExitCode != 128+o.Signal {
			return errors.New("gate signal not preserved")
		}
	case "timeout":
		if o.ExitCode != nil || result.ExitCode != 124 {
			return errors.New("gate timeout not preserved")
		}
	case "setup_failed":
		if o.ExitCode != nil || o.Signal != 0 || result.ExitCode != 2 {
			return errors.New("gate setup failure not preserved")
		}
	default:
		return errors.New("unknown command result")
	}
	return nil
}

type execution struct {
	plan      *ExecutionPlan
	transport Transport
	ctx       context.Context
	directory string
	receipt   *Receipt
	created   bool
}

func noSymlinks(path string) error {
	if !canonicalPath(path) {
		return errors.New("noncanonical local path")
	}
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("symlink/unreadable local path")
		}
	}
	return nil
}
func fileDigest(path string, max int64) (string, error) {
	if err := noSymlinks(path); err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", errors.New("input file unavailable")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > max {
		return "", errors.New("invalid input file size/type")
	}
	h := sha256.New()
	if _, err = io.Copy(h, io.LimitReader(f, max+1)); err != nil {
		return "", errors.New("input read failed")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (e *execution) record(name string, data []byte, truncated bool) error {
	if len(data) > LogLimit {
		data = data[:LogLimit]
		truncated = true
	}
	path := filepath.Join(e.directory, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("evidence create failed")
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.New("evidence write failed")
	}
	e.receipt.Evidence[name] = Evidence{path, digest(data), len(data), truncated}
	return nil
}
func (e *execution) command(name string) Command {
	for _, c := range e.plan.steps {
		if c.Name == name {
			c.Argv = append([]string(nil), c.Argv...)
			return c
		}
	}
	panic("unknown internal command")
}
func (e *execution) call(name string, check bool, ctx context.Context) (ProcessResult, error) {
	result := e.transport.Run(ctx, e.command(name))
	for _, log := range []struct {
		name string
		data []byte
	}{{"stdout", result.Stdout}, {"stderr", result.Stderr}, {"process.json", jsonBytes(result)}} {
		if err := e.record(name+"."+log.name, log.data, result.Truncated); err != nil {
			return result, err
		}
	}
	if check && (!result.ok() || result.Truncated) {
		return result, fmt.Errorf("%s transport failed", name)
	}
	return result, nil
}
func (e *execution) query(name string, into any) error {
	r, err := e.call(name, true, e.ctx)
	if err != nil {
		return err
	}
	if json.Unmarshal(r.Stdout, into) != nil {
		return fmt.Errorf("%s invalid/missing JSON", name)
	}
	return nil
}
func (e *execution) run(helperDigest string) error {
	p, r := e.plan, e.receipt
	r.FailureOrigin = "setup"
	var memory struct {
		Total     int `json:"MemTotal"`
		Available int `json:"MemAvailable"`
	}
	if err := e.query("vm-memory", &memory); err != nil {
		return err
	}
	// Guest kernel and firmware overhead grows with VM memory (322 MiB at
	// 12 GiB), so the lower tolerance is max(256 MiB, 4%) of the profile.
	low, high := p.profile.VMMemoryMiB-max(256, p.profile.VMMemoryMiB/25), p.profile.VMMemoryMiB+256
	need := p.spec.MemoryMiB + p.profile.VMHeadroomMiB
	if !bounded(memory.Total, low, high) || memory.Available < need {
		return fmt.Errorf("VM memory/headroom unavailable: total %d MiB (want %d..%d), available %d MiB (need %d)", memory.Total, low, high, memory.Available, need)
	}
	version, err := e.call("incus-package", true, e.ctx)
	if err != nil {
		return err
	}
	r.IncusPackageRevision = strings.TrimSpace(string(version.Stdout))
	if r.IncusPackageRevision != p.profile.IncusPackageRevision {
		return errors.New("Incus package revision mismatch")
	}
	r.FailureOrigin = "image"
	var image struct {
		Fingerprint string `json:"fingerprint"`
		Type        string `json:"type"`
	}
	if err = e.query("image", &image); err != nil {
		return err
	}
	r.ActualImage = image.Fingerprint
	if image.Fingerprint != p.spec.ImageFingerprint || image.Type != "container" {
		return errors.New("image fingerprint/type mismatch")
	}
	r.FailureOrigin = "setup"
	var existing []json.RawMessage
	if err = e.query("existing", &existing); err != nil {
		return err
	}
	if existing == nil || len(existing) != 0 {
		return errors.New("container name unavailable")
	}
	e.created = true // init can time out after the server created the container.
	if _, err = e.call("create", true, e.ctx); err != nil {
		return err
	}
	var inst instance
	if err = e.query("instance", &inst); err != nil {
		return err
	}
	if inst.Name != p.spec.ContainerName() || inst.Type != "container" || inst.Profiles == nil || len(inst.Profiles) != 0 {
		return errors.New("instance identity/profile mismatch")
	}
	r.ActualImage = inst.Config["volatile.base_image"]
	if r.ActualImage != p.spec.ImageFingerprint {
		return errors.New("instance image fingerprint mismatch")
	}
	for key, value := range p.settings() {
		if inst.Config[key] != value {
			return errors.New("instance security/resource readback mismatch")
		}
	}
	for key := range inst.Config {
		if strings.HasPrefix(key, "raw.") || strings.HasPrefix(key, "environment.") {
			return errors.New("unsafe image configuration")
		}
	}
	wantDevices := map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": p.profile.StoragePool, "size": strconv.Itoa(p.profile.RootGiB) + "GiB"}}
	if !reflect.DeepEqual(inst.Devices, wantDevices) {
		return errors.New("unexpected instance devices/disk limit")
	}
	for _, step := range []string{"start", "helper-directory", "helper-push"} {
		if _, err = e.call(step, true, e.ctx); err != nil {
			return err
		}
	}
	r.FailureOrigin = "probe"
	var tools toolProbe
	if err = e.query("tools", &tools); err != nil {
		return err
	}
	var manifest map[string]any
	if !tools.Options || tools.ManifestSHA256 != p.profile.ImageManifestSHA256 || json.Unmarshal(tools.Manifest, &manifest) != nil || manifest == nil || tools.HelperSHA256 != helperDigest || tools.MemoryMax != strconv.Itoa(p.spec.MemoryMiB*1024*1024) || tools.PidsMax != strconv.Itoa(p.spec.ProcessLimit) {
		return errors.New("missing/mismatched image/tools/limits probe")
	}
	for _, tool := range []string{"systemd-run", "bwrap", "git"} {
		if tools.Versions[tool] == "" {
			return errors.New("missing tool version")
		}
	}
	var session sessionProbe
	if err = e.query("session", &session); err != nil {
		return err
	}
	if err = session.validate(); err != nil {
		return err
	}
	exit23, err := e.call("exit23", false, e.ctx)
	if err != nil {
		return err
	}
	if exit23.ExitCode != 23 || exit23.Signal != 0 || exit23.StartFailed || exit23.TimedOut {
		return errors.New("transport did not preserve deliberate exit23")
	}
	if p.options.Mode == Preflight {
		r.Status = "PREFLIGHT_PASS"
		r.FailureOrigin = ""
		return nil
	}
	r.FailureOrigin = "source"
	if _, err = e.call("bundle-push", true, e.ctx); err != nil {
		return err
	}
	var source struct {
		Actual  string `json:"actual_checkout"`
		Shallow *bool  `json:"shallow"`
	}
	if err = e.query("source", &source); err != nil {
		return err
	}
	r.ActualCheckout = source.Actual
	if source.Actual != p.spec.SourceSHA || source.Shallow == nil || *source.Shallow {
		return errors.New("source SHA/full-history assertion failed")
	}
	r.FailureOrigin = "gate"
	result, callErr := e.call("gate", false, e.ctx)
	r.Command.TransportExitCode = result.ExitCode
	if result.TimedOut {
		r.Command.Status = "timeout"
		return errors.New("gate transport timeout")
	}
	if callErr != nil {
		return callErr
	}
	r.FailureOrigin = "receipt"
	remoteResult, err := e.call("command-receipt", true, e.ctx)
	if err != nil {
		return err
	}
	var remote CommandReceipt
	if err = Decode(bytes.NewReader(remoteResult.Stdout), &remote); err != nil {
		return errors.New("missing/invalid command receipt")
	}
	if err = remote.validate(p, result); err != nil {
		return err
	}
	r.Command = remote.Outcome
	r.Command.TransportExitCode = result.ExitCode
	r.FailureOrigin = "gate"
	if remote.Outcome.Status != "exited" || remote.Outcome.ExitCode == nil || *remote.Outcome.ExitCode != 0 {
		return errors.New("gate failed")
	}
	r.FailureOrigin = "summary"
	if err = validateSummary(p.gate, remote); err != nil {
		return err
	}
	r.Summary, r.EvidenceKind = remote.Summary, remote.EvidenceKind
	r.FailureOrigin = ""
	r.Status = "PASS"
	return nil
}

// Execute always attempts bounded cleanup after init, even when the caller's
// context was cancelled. Evidence is captured before deletion. Cleanup failure
// blocks PASS and requires the external supervisor to quarantine/reset the VM.
func Execute(ctx context.Context, p *ExecutionPlan, transport Transport) (r Receipt) {
	r = Receipt{Status: "FAIL", FailureOrigin: "setup", Cleanup: "not_needed", Command: Outcome{Status: "not_run"}, StartedAt: time.Now().UTC(), Evidence: map[string]Evidence{}, Errors: []string{}}
	if p == nil || transport == nil {
		r.Errors = append(r.Errors, "validated plan and transport required")
		r.FinishedAt = time.Now().UTC()
		return
	}
	r.Expected, r.Mode, r.Argv, r.CommandID = p.spec, p.options.Mode, append([]string(nil), p.gate.Argv...), commandID(p.gate)
	e := &execution{plan: p, transport: transport, ctx: ctx, receipt: &r}
	defer func() {
		if e.created {
			// One total deadline bounds both ownership verification and deletion.
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			owner, recordErr := e.call("cleanup-owner", false, cleanupCtx)
			var inst instance
			var err error
			if !owner.ok() || owner.Truncated || json.Unmarshal(owner.Stdout, &inst) != nil || inst.Name != p.spec.ContainerName() || inst.Config["user.ci.attempt"] != p.spec.AttemptID {
				err = errors.New("cleanup owner mismatch/unavailable")
			}
			if err == nil {
				_, err = e.call("cleanup", true, cleanupCtx)
			}
			if err == nil && recordErr != nil {
				err = recordErr
			}
			if err != nil {
				r.Cleanup = "failed"
				r.Status = "FAIL"
				r.FailureOrigin = "cleanup"
				r.Errors = append(r.Errors, "cleanup failed; supervisor must quarantine VM")
			} else {
				r.Cleanup = "ok"
			}
		}
		r.FinishedAt = time.Now().UTC()
		if e.directory != "" {
			// The receipt deliberately excludes its own hash to avoid recursion.
			data := jsonBytes(r)
			if len(data) > LogLimit {
				r.Status = "FAIL"
				r.FailureOrigin = "evidence"
				r.Errors = append(r.Errors, "final receipt too large")
				data = jsonBytes(r)
			}
			if err := e.record("receipt.json", data, false); err != nil {
				r.Status = "FAIL"
				r.FailureOrigin = "evidence"
				r.Errors = append(r.Errors, "final receipt write failed")
			}
		}
	}()
	bundleDigest, err := fileDigest(p.options.BundlePath, 2*1024*1024*1024)
	if err != nil {
		r.Errors = append(r.Errors, err.Error())
		return
	}
	helperDigest, err := fileDigest(p.options.BinaryPath, 128*1024*1024)
	if err != nil {
		r.Errors = append(r.Errors, err.Error())
		return
	}
	if err = noSymlinks(p.options.EvidenceRoot); err != nil {
		r.Errors = append(r.Errors, err.Error())
		return
	}
	if err = os.MkdirAll(p.options.EvidenceRoot, 0700); err == nil {
		directory := filepath.Join(p.options.EvidenceRoot, p.spec.AttemptID)
		err = os.Mkdir(directory, 0700)
		if err == nil {
			e.directory = directory
		}
	}
	if err != nil {
		r.Errors = append(r.Errors, "evidence attempt directory unavailable/replayed")
		return
	}
	if err = e.record("inputs.json", jsonBytes(map[string]string{"bundle_sha256": bundleDigest, "executor_sha256": helperDigest}), false); err == nil {
		err = e.run(helperDigest)
	}
	if err != nil {
		r.Status = "FAIL"
		r.Errors = append(r.Errors, err.Error())
		if r.Command.Status == "not_run" {
			r.Command.Status = "setup_failed"
		}
	}
	return
}

func validateSummary(g Gate, remote CommandReceipt) error {
	if g.SummaryMode == "native-exit" {
		if remote.EvidenceKind != "native-exit" || remote.Summary != nil || remote.SummaryCount != 0 {
			return errors.New("invalid native-exit evidence")
		}
		return nil
	}
	if remote.EvidenceKind != "" || remote.SummaryCount != 1 {
		return errors.New("missing or duplicate summary")
	}
	return remote.Summary.Validate()
}

// ValidateResult binds a successful exported receipt to the admitted command and
// its evidence contract. It does not confer independent acceptance of test code.
func ValidateResult(profile Profile, spec JobSpec, receipt Receipt) error {
	if err := profile.Validate(); err != nil {
		return err
	}
	if err := spec.Validate(); err != nil {
		return err
	}
	if profile.RepoID != spec.RepoID || profile.ConfigSHA != spec.ConfigSHA || profile.ImageFingerprint != spec.ImageFingerprint || spec.MemoryMiB > profile.MaxJobMemoryMiB || spec.ProcessLimit > profile.MaxJobProcesses {
		return errors.New("profile identity mismatch")
	}
	var gate *Gate
	for _, g := range profile.Gates {
		if g.Tier == spec.Tier {
			v := g
			gate = &v
		}
	}
	if gate == nil || receipt.Expected != spec || receipt.CommandID != commandID(*gate) || strings.Join(receipt.Argv, "\x00") != strings.Join(gate.Argv, "\x00") || receipt.Mode != GateMode || receipt.Status != "PASS" || receipt.Cleanup != "ok" || receipt.ActualCheckout != spec.SourceSHA || receipt.Command.Status != "exited" || receipt.Command.ExitCode == nil || *receipt.Command.ExitCode != 0 || receipt.Command.Signal != 0 {
		return errors.New("receipt is not a bound successful gate")
	}
	if receipt.ActualImage != spec.ImageFingerprint || receipt.IncusPackageRevision != profile.IncusPackageRevision || receipt.FailureOrigin != "" || len(receipt.Errors) != 0 || receipt.Command.TransportExitCode != 0 || receipt.StartedAt.IsZero() || receipt.FinishedAt.Before(receipt.StartedAt) || receipt.Command.StartedAt.IsZero() || receipt.Command.FinishedAt.Before(receipt.Command.StartedAt) {
		return errors.New("receipt execution evidence invalid")
	}
	count := 0
	if receipt.Summary != nil {
		count = 1
	}
	return validateSummary(*gate, CommandReceipt{Summary: receipt.Summary, SummaryCount: count, EvidenceKind: receipt.EvidenceKind})
}
