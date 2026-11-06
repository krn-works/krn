// Package control fences one Jenkins-controlled VM slot. Jenkins owns the queue,
// SCM and publisher; this package only prepares and cleans an admitted attempt.
package control

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"krn.local/ci-platform/internal/executor"
	"krn.local/ci-platform/internal/reset"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var safeUser = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

const InputDirectory = "/var/lib/ci-input"

type Endpoint struct {
	Host           string `json:"host"`
	User           string `json:"user"`
	PrivateKeyFile string `json:"private_key_file"`
	KnownHostsFile string `json:"known_hosts_file"`
}
type Config struct {
	SchemaVersion int                `json:"schema_version"`
	ResetManifest reset.Manifest     `json:"reset_manifest"`
	PVE           Endpoint           `json:"pve"`
	Runner        Endpoint           `json:"runner"`
	Repositories  []executor.Profile `json:"repositories"`
}

func canonical(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && !strings.ContainsAny(path, "\n\r\x00")
}
func (e Endpoint) validate() error {
	a, err := netip.ParseAddr(e.Host)
	if err != nil || !a.Is4() || a.IsUnspecified() || a.IsLoopback() || a.IsMulticast() || !safeUser.MatchString(e.User) || !canonical(e.PrivateKeyFile) || !canonical(e.KnownHostsFile) || !strings.HasPrefix(e.KnownHostsFile, "/etc/ci-platform/") {
		return errors.New("invalid pinned SSH endpoint")
	}
	return nil
}
func (c Config) Validate() error {
	if c.SchemaVersion != 1 {
		return errors.New("unsupported controller schema")
	}
	if err := c.ResetManifest.Validate(); err != nil {
		return err
	}
	if err := c.PVE.validate(); err != nil {
		return err
	}
	if err := c.Runner.validate(); err != nil {
		return err
	}
	if c.PVE.Host == c.Runner.Host || c.PVE.User != "root" || c.Runner.User == "root" || c.PVE.PrivateKeyFile == c.Runner.PrivateKeyFile {
		return errors.New("control and runner authority must be distinct")
	}
	if len(c.Repositories) == 0 || len(c.Repositories) > 1000 {
		return errors.New("repository enrollment required")
	}
	seen := map[string]bool{}
	for _, p := range c.Repositories {
		if err := p.Validate(); err != nil {
			return err
		}
		if p.VMMemoryMiB != c.ResetManifest.MemoryMiB || p.CPUCount > c.ResetManifest.Cores {
			return errors.New("repository profile exceeds enrolled VM")
		}
		if seen[p.RepoID] {
			return errors.New("duplicate repository enrollment")
		}
		seen[p.RepoID] = true
	}
	return nil
}
func (c Config) profile(spec executor.JobSpec) (executor.Profile, error) {
	for _, p := range c.Repositories {
		if p.RepoID == spec.RepoID {
			_, err := executor.Plan(p, spec, executor.Options{BundlePath: InputDirectory + "/source.bundle", BinaryPath: "/usr/local/libexec/ci-platform", EvidenceRoot: "/var/lib/ci-evidence", Mode: executor.GateMode})
			return p, err
		}
	}
	return executor.Profile{}, errors.New("repository not enrolled")
}
func digest(v any) string {
	data, _ := json.Marshal(v)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func nonce() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

type State struct {
	SchemaVersion  int               `json:"schema_version"`
	Phase          string            `json:"phase"`
	AttemptID      string            `json:"attempt_id"`
	ConfigSHA256   string            `json:"config_sha256"`
	Spec           *executor.JobSpec `json:"spec"`
	BundleSHA256   string            `json:"bundle_sha256"`
	PVEGeneration  uint64            `json:"pve_generation"`
	LastBootID     string            `json:"last_boot_id"`
	ResetRequestID string            `json:"reset_request_id"`
	Before         *reset.Receipt    `json:"before"`
	After          *reset.Receipt    `json:"after"`
	CleanReady     bool              `json:"clean_ready"`
}
type Store struct{ Directory string }

func (s Store) lock() (func(), error) {
	if !canonical(s.Directory) {
		return nil, errors.New("absolute private state directory required")
	}
	info, err := os.Lstat(s.Directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("state directory must already exist and be private")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Uid != uint32(os.Geteuid()) {
		return nil, errors.New("state directory ownership mismatch")
	}
	fd, err := syscall.Open(filepath.Join(s.Directory, "control.lock"), syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = syscall.Close(fd)
		return nil, errors.New("controller slot busy")
	}
	return func() { _ = syscall.Close(fd) }, nil
}
func (s Store) Read() (State, error) {
	state := State{SchemaVersion: 1, Phase: "idle"}
	fd, err := syscall.Open(filepath.Join(s.Directory, "control.json"), syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return State{}, errors.New("unreadable control ledger")
	}
	f := os.NewFile(uintptr(fd), "control.json")
	defer f.Close()
	if info, e := f.Stat(); e != nil || !info.Mode().IsRegular() || info.Size() > executor.LogLimit {
		return State{}, errors.New("invalid control ledger file")
	}
	if err = executor.Decode(f, &state); err != nil {
		return State{}, errors.New("corrupt control ledger")
	}
	if state.SchemaVersion != 1 {
		return State{}, errors.New("corrupt control ledger")
	}
	switch state.Phase {
	case "idle", "preparing", "prepared", "finishing", "blocked":
	default:
		return State{}, errors.New("corrupt control ledger")
	}
	if state.Phase != "idle" && (state.Spec == nil || !uuid.MatchString(state.AttemptID) || state.Spec.AttemptID != state.AttemptID || state.ConfigSHA256 == "") {
		return State{}, errors.New("corrupt active control ledger")
	}
	return state, nil
}
func (s Store) save(state State) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(s.Directory, ".control-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(append(data, '\n'))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), filepath.Join(s.Directory, "control.json")); err != nil {
		return err
	}
	d, err := os.Open(s.Directory)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

type Backend interface {
	Bundle(context.Context, string, string) (string, error)
	Reset(context.Context, reset.Request) (reset.Receipt, error)
	Deliver(context.Context, string, executor.JobSpec, executor.Profile, string) error
}
type Service struct {
	Config  Config
	Store   Store
	Backend Backend
}
type Receipt struct {
	OK            bool   `json:"ok"`
	Phase         string `json:"phase"`
	AttemptID     string `json:"attempt_id"`
	PVEGeneration uint64 `json:"pve_generation"`
	BootID        string `json:"boot_id"`
	Error         string `json:"error,omitempty"`
}

func receipt(s State, err error) Receipt {
	r := Receipt{OK: err == nil, Phase: s.Phase, AttemptID: s.AttemptID, PVEGeneration: s.PVEGeneration, BootID: s.LastBootID}
	if err != nil {
		r.Error = err.Error()
	}
	return r
}
func (s Service) block(state State, cause error) (Receipt, error) {
	state.Phase = "blocked"
	state.CleanReady = false
	if err := s.Store.save(state); err != nil {
		return receipt(state, errors.New("control ledger write failed")), err
	}
	return receipt(state, cause), cause
}
func (s Service) coldReset(ctx context.Context, state *State) error {
	if state.PVEGeneration == math.MaxUint64 {
		return errors.New("reset generation exhausted")
	}
	id, err := nonce()
	if err != nil {
		return err
	}
	state.ResetRequestID = id
	if err = s.Store.save(*state); err != nil {
		return err
	}
	want := reset.Request{RequestID: id, ExpectedGeneration: state.PVEGeneration, ManifestSHA256: s.Config.ResetManifest.Digest()}
	r, transportErr := s.Backend.Reset(ctx, want)
	// A failed authenticated helper response may tell recovery its current
	// generation. It never authorizes admission; the slot stays blocked.
	if transportErr != nil {
		if r.Generation > state.PVEGeneration {
			state.PVEGeneration = r.Generation
		}
		return transportErr
	}
	m := s.Config.ResetManifest
	if !receiptIdentity(r, m) || r.RequestID != id || r.Generation != state.PVEGeneration+1 || r.BootID == state.LastBootID {
		return errors.New("reset receipt identity mismatch")
	}
	state.PVEGeneration = r.Generation
	state.LastBootID = r.BootID
	if state.Phase == "preparing" {
		state.Before = &r
	} else {
		state.After = &r
	}
	return s.Store.save(*state)
}

func receiptIdentity(r reset.Receipt, m reset.Manifest) bool {
	return r.OK && r.Phase == "ready" && r.SchemaVersion == 1 && r.InstallationID == m.InstallationID && r.VMID == m.VMID && r.ManifestSHA256 == m.Digest() && r.SnapshotSHA256 == m.SnapshotSHA256 && r.PolicySHA256 == m.NFT.SHA256 && uuid.MatchString(r.BootID)
}

// Prepare is intentionally not an idempotent admission token: a lost response
// leaves an uncertain slot, which Finish must reconcile before another job.
// The trusted Jenkins wrapper must fence/disconnect its agent before calling.
func (s Service) Prepare(ctx context.Context, spec executor.JobSpec, bundle string) (Receipt, error) {
	if err := s.Config.Validate(); err != nil {
		return Receipt{}, err
	}
	p, err := s.Config.profile(spec)
	if err != nil {
		return Receipt{}, err
	}
	unlock, err := s.Store.lock()
	if err != nil {
		return Receipt{}, err
	}
	defer unlock()
	state, err := s.Store.Read()
	if err != nil {
		return Receipt{}, err
	}
	if state.Phase != "idle" || state.AttemptID == spec.AttemptID {
		return receipt(state, errors.New("slot requires cleanup")), errors.New("slot requires cleanup")
	}
	hash, err := s.Backend.Bundle(ctx, bundle, spec.SourceSHA)
	if err != nil {
		return Receipt{}, err
	}
	trusted := state.Phase == "idle" && state.CleanReady && state.After != nil && state.ConfigSHA256 == digest(s.Config) && receiptIdentity(*state.After, s.Config.ResetManifest) && state.After.Generation == state.PVEGeneration && state.After.BootID == state.LastBootID && state.After.RequestID == state.ResetRequestID
	state.Phase = "preparing"
	state.AttemptID = spec.AttemptID
	state.Spec = &spec
	state.ConfigSHA256 = digest(s.Config)
	state.BundleSHA256 = hash
	state.CleanReady = false
	previousAfter := state.After
	state.Before = nil
	state.After = nil
	if trusted {
		before := *previousAfter
		state.Before = &before
	}
	if err = s.Store.save(state); err != nil {
		return Receipt{}, err
	}
	if !trusted {
		if err = s.coldReset(ctx, &state); err != nil {
			return s.block(state, err)
		}
	}
	if err = s.Backend.Deliver(ctx, bundle, spec, p, hash); err != nil {
		return s.block(state, err)
	}
	state.Phase = "prepared"
	if err = s.Store.save(state); err != nil {
		return s.block(state, err)
	}
	return receipt(state, nil), nil
}

// Finish never trusts a successful guest result as evidence of cleanup. It is
// also the explicit same-attempt recovery path after an interrupted Prepare.
func (s Service) Finish(ctx context.Context, attempt string) (Receipt, error) {
	if err := s.Config.Validate(); err != nil {
		return Receipt{}, err
	}
	if !uuid.MatchString(attempt) {
		return Receipt{}, errors.New("invalid attempt identity")
	}
	unlock, err := s.Store.lock()
	if err != nil {
		return Receipt{}, err
	}
	defer unlock()
	state, err := s.Store.Read()
	if err != nil {
		return Receipt{}, err
	}
	if state.AttemptID != attempt || state.ConfigSHA256 != digest(s.Config) {
		return receipt(state, errors.New("cleanup attempt/config mismatch")), errors.New("cleanup attempt/config mismatch")
	}
	if state.Phase == "idle" && state.After != nil {
		return receipt(state, nil), nil
	}
	state.Phase = "finishing"
	state.CleanReady = false
	if err = s.Store.save(state); err != nil {
		return Receipt{}, err
	}
	if err = s.coldReset(ctx, &state); err != nil {
		return s.block(state, err)
	}
	state.Phase = "idle"
	state.CleanReady = true
	if err = s.Store.save(state); err != nil {
		return s.block(state, err)
	}
	return receipt(state, nil), nil
}

func Verify(c Config, spec executor.JobSpec, r executor.Receipt) error {
	if err := c.Validate(); err != nil {
		return err
	}
	p, err := c.profile(spec)
	if err != nil {
		return err
	}
	if err := executor.ValidateResult(p, spec, r); err != nil {
		return err
	}
	o := r.Command
	if o.Status != "exited" || o.ExitCode == nil || *o.ExitCode != 0 || o.Signal != 0 || o.TransportExitCode != 0 || r.StartedAt.IsZero() || r.FinishedAt.Before(r.StartedAt) || o.StartedAt.Before(r.StartedAt) || o.FinishedAt.Before(o.StartedAt) || o.FinishedAt.After(r.FinishedAt) {
		return errors.New("executor result has no successful command")
	}
	return nil
}

func readJSON(path string, v any) error {
	if !canonical(path) {
		return errors.New("absolute JSON path required")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if info, e := f.Stat(); e != nil || !info.Mode().IsRegular() || info.Size() > executor.LogLimit {
		return errors.New("JSON input must be a bounded regular file")
	}
	return executor.Decode(f, v)
}
func hashFile(path string) (string, error) {
	if !canonical(path) {
		return "", errors.New("absolute bundle path required")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 2<<30 {
		return "", errors.New("invalid bundle file")
	}
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// A bounded controller operation; command-level limits are tighter.
func operationContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Minute)
}
