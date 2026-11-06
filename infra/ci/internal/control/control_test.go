package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"krn.local/ci-platform/internal/executor"
	"krn.local/ci-platform/internal/reset"
)

const attemptA = "22222222-2222-4222-8222-222222222222"
const attemptB = "33333333-3333-4333-8333-333333333333"
const installationID = "11111111-1111-4111-8111-111111111111"

func fixture(t *testing.T) (Service, *fakeBackend, executor.JobSpec) {
	t.Helper()
	spec := executor.JobSpec{RepoID: "123", SourceSHA: strings.Repeat("a", 40), ConfigSHA: strings.Repeat("b", 40), ImageFingerprint: strings.Repeat("c", 64), AttemptID: attemptA, Tier: executor.Product, TimeoutSeconds: 300, MemoryMiB: 4096, ProcessLimit: 256}
	p := executor.Profile{RepoID: spec.RepoID, ConfigSHA: spec.ConfigSHA, ImageFingerprint: spec.ImageFingerprint, ImageManifestSHA256: strings.Repeat("d", 64), IncusPackageRevision: "6.0.4-2+deb13u11", Project: "ci", StoragePool: "ci", CPUCount: 4, RootGiB: 16, VMMemoryMiB: 8192, VMHeadroomMiB: 2048, MaxJobMemoryMiB: 6144, MaxJobProcesses: 1024, GitName: "CI", GitEmail: "ci@example.invalid", Gates: []executor.Gate{{Tier: executor.Product, Argv: []string{"npm", "run", "gate"}, SummaryPrefix: "KRN_TEST_SUMMARY_JSON="}}}
	m := reset.Manifest{SchemaVersion: 1, InstallationID: installationID, ExpectedPVEHostname: "pve-fixture", VMID: 108, VMName: "ci-runner", SMBIOSUUID: installationID, Snapshot: "clean", SnapshotSHA256: strings.Repeat("e", 64), MemoryMiB: 8192, Cores: 4, Volumes: map[string]string{"scsi0": "ci-store:vm-108-disk-0"}, ReadOnlyVolumes: map[string]string{}, Net0: reset.NetworkBinding{Bridge: "vmbrCI", MAC: "02:00:00:00:01:08"}, NFT: reset.PolicyBinding{TablePrefix: "ci_platform", SHA256: strings.Repeat("f", 64)}, OperationTimeoutSeconds: 60, BootTimeoutSeconds: 120}
	c := Config{SchemaVersion: 1, ResetManifest: m, PVE: Endpoint{Host: "10.254.254.5", User: "root", PrivateKeyFile: "/etc/ci/pve-key", KnownHostsFile: "/etc/ci-platform/pve-hosts"}, Runner: Endpoint{Host: "10.254.254.2", User: "jenkins", PrivateKeyFile: "/etc/ci/runner-key", KnownHostsFile: "/etc/ci-platform/runner-hosts"}, Repositories: []executor.Profile{p}}
	f := &fakeBackend{config: c}
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	s := Service{Config: c, Store: Store{directory}, Backend: f}
	return s, f, spec
}

type fakeBackend struct {
	config         Config
	calls          []string
	generation     uint64
	fail           string
	panicReset     bool
	invalidReceipt bool
}

func (f *fakeBackend) Bundle(context.Context, string, string) (string, error) {
	f.calls = append(f.calls, "bundle")
	if f.fail == "bundle" {
		return "", errors.New("bundle failed")
	}
	return strings.Repeat("a", 64), nil
}
func (f *fakeBackend) Reset(_ context.Context, q reset.Request) (reset.Receipt, error) {
	f.calls = append(f.calls, "reset")
	if q.ExpectedGeneration != f.generation {
		return reset.Receipt{Generation: f.generation}, errors.New("stale generation")
	}
	f.generation++
	if f.panicReset {
		panic("simulated lost controller after remote commit")
	}
	m := f.config.ResetManifest
	r := reset.Receipt{SchemaVersion: 1, OK: true, Phase: "ready", InstallationID: m.InstallationID, VMID: m.VMID, RequestID: q.RequestID, Generation: f.generation, ManifestSHA256: m.Digest(), SnapshotSHA256: m.SnapshotSHA256, PolicySHA256: m.NFT.SHA256, BootID: fmt.Sprintf("44444444-4444-4444-8444-%012d", f.generation)}
	if f.fail == "reset" {
		return r, errors.New("reset failed")
	}
	if f.invalidReceipt {
		r.RequestID = attemptB
	}
	return r, nil
}
func (f *fakeBackend) Deliver(context.Context, string, executor.JobSpec, executor.Profile, string) error {
	f.calls = append(f.calls, "deliver")
	if f.fail == "deliver" {
		return errors.New("transfer failed")
	}
	return nil
}
func TestAttemptRequiresCleanupBeforeNextAdmission(t *testing.T) {
	s, f, spec := fixture(t)
	r, err := s.Prepare(context.Background(), spec, "/bundle")
	if err != nil || !r.OK || r.Phase != "prepared" || r.PVEGeneration != 1 {
		t.Fatalf("prepare %+v %v", r, err)
	}
	if got := strings.Join(f.calls, ","); got != "bundle,reset,deliver" {
		t.Fatal(got)
	}
	prior := len(f.calls)
	if _, err = s.Prepare(context.Background(), spec, "/bundle"); err == nil || len(f.calls) != prior {
		t.Fatal("same attempt admitted twice")
	}
	spec.AttemptID = attemptB
	if _, err = s.Prepare(context.Background(), spec, "/bundle"); err == nil || len(f.calls) != prior {
		t.Fatal("next attempt passed dirty slot")
	}
	if _, err = s.Finish(context.Background(), attemptB); err == nil || len(f.calls) != prior {
		t.Fatal("foreign cleanup accepted")
	}
	r, err = s.Finish(context.Background(), attemptA)
	if err != nil || !r.OK || r.Phase != "idle" || r.PVEGeneration != 2 {
		t.Fatalf("finish %+v %v", r, err)
	}
	prior = len(f.calls)
	if _, err = s.Finish(context.Background(), attemptA); err != nil || len(f.calls) != prior {
		t.Fatal("finish retry repeated effect")
	}
	if _, err = s.Prepare(context.Background(), spec, "/bundle"); err != nil {
		t.Fatal(err)
	}
}

func TestPrepareSkipsResetAfterVerifiedFinish(t *testing.T) {
	s, f, spec := fixture(t)
	if _, err := s.Prepare(context.Background(), spec, "/bundle"); err != nil {
		t.Fatal(err)
	}
	finished, err := s.Finish(context.Background(), attemptA)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		spec.AttemptID = []string{attemptB, "44444444-4444-4444-8444-444444444444"}[i]
		prior := len(f.calls)
		r, err := s.Prepare(context.Background(), spec, "/bundle")
		if err != nil || r.PVEGeneration != finished.PVEGeneration || r.BootID != finished.BootID {
			t.Fatalf("prepare %+v %v", r, err)
		}
		if got := strings.Join(f.calls[prior:], ","); got != "bundle,deliver" {
			t.Fatal(got)
		}
		state, err := s.Store.Read()
		if err != nil || state.Before == nil || state.Before.BootID != finished.BootID || state.After != nil {
			t.Fatalf("trusted prepare state=%+v err=%v", state, err)
		}
		finished, err = s.Finish(context.Background(), spec.AttemptID)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestPrepareResetsWithoutTrustedCleanReady(t *testing.T) {
	for name, tamper := range map[string]func(*State){
		"old-ledger": func(s *State) { s.CleanReady = false },
		"config":     func(s *State) { _ = s },
		"snapshot":   func(s *State) { s.After.SnapshotSHA256 = strings.Repeat("0", 64) },
		"policy":     func(s *State) { s.After.PolicySHA256 = strings.Repeat("0", 64) },
		"manifest":   func(s *State) { s.After.ManifestSHA256 = strings.Repeat("0", 64) },
		"boot":       func(s *State) { s.After.BootID = attemptB },
		"generation": func(s *State) { s.After.Generation++ },
		"request":    func(s *State) { s.After.RequestID = attemptB },
	} {
		t.Run(name, func(t *testing.T) {
			s, f, spec := fixture(t)
			if _, err := s.Prepare(context.Background(), spec, "/bundle"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Finish(context.Background(), attemptA); err != nil {
				t.Fatal(err)
			}
			state, err := s.Store.Read()
			if err != nil {
				t.Fatal(err)
			}
			tamper(&state)
			if name == "config" {
				s.Config.Runner.Host = "10.254.254.3"
			}
			if name == "old-ledger" {
				raw := []byte(`{"schema_version":1,"phase":"idle","attempt_id":"` + attemptA + `","config_sha256":"` + digest(s.Config) + `","pve_generation":2,"last_boot_id":"` + state.LastBootID + `","reset_request_id":"` + state.ResetRequestID + `","after":`)
				receipt, _ := json.Marshal(state.After)
				raw = append(raw, receipt...)
				raw = append(raw, '}')
				if err := os.WriteFile(filepath.Join(s.Store.Directory, "control.json"), raw, 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := s.Store.save(state); err != nil {
				t.Fatal(err)
			}
			prior := len(f.calls)
			spec.AttemptID = attemptB
			if _, err := s.Prepare(context.Background(), spec, "/bundle"); err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(f.calls[prior:], ","); got != "bundle,reset,deliver" {
				t.Fatal(got)
			}
		})
	}
}

func TestTrustedPrepareFailureRequiresFinish(t *testing.T) {
	s, f, spec := fixture(t)
	if _, err := s.Prepare(context.Background(), spec, "/bundle"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finish(context.Background(), attemptA); err != nil {
		t.Fatal(err)
	}
	f.fail = "deliver"
	spec.AttemptID = attemptB
	if _, err := s.Prepare(context.Background(), spec, "/bundle"); err == nil {
		t.Fatal("delivery failure passed")
	}
	state, err := s.Store.Read()
	if err != nil || state.CleanReady || state.Phase != "blocked" {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	f.fail = ""
	if _, err = s.Finish(context.Background(), attemptB); err != nil {
		t.Fatal(err)
	}
	prior := len(f.calls)
	spec.AttemptID = "44444444-4444-4444-8444-444444444444"
	if _, err = s.Prepare(context.Background(), spec, "/bundle"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls[prior:], ","); got != "bundle,deliver" {
		t.Fatal(got)
	}
}
func TestFailureAndInterruptedPrepareRemainQuarantined(t *testing.T) {
	for _, point := range []string{"reset", "deliver"} {
		t.Run(point, func(t *testing.T) {
			s, f, spec := fixture(t)
			f.fail = point
			if _, err := s.Prepare(context.Background(), spec, "/bundle"); err == nil {
				t.Fatal("failure passed")
			}
			state, err := s.Store.Read()
			if err != nil || state.Phase != "blocked" {
				t.Fatalf("state=%+v %v", state, err)
			}
			n := len(f.calls)
			spec.AttemptID = attemptB
			if _, err = s.Prepare(context.Background(), spec, "/bundle"); err == nil || len(f.calls) != n {
				t.Fatal("quarantine bypassed")
			}
			f.fail = ""
			if _, err = s.Finish(context.Background(), attemptA); err != nil {
				t.Fatal(err)
			}
		})
	}
	s, f, spec := fixture(t)
	f.panicReset = true
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("expected simulated process loss")
			}
		}()
		_, _ = s.Prepare(context.Background(), spec, "/bundle")
	}()
	state, err := s.Store.Read()
	if err != nil || state.Phase != "preparing" || state.PVEGeneration != 0 {
		t.Fatalf("reservation lost: %+v %v", state, err)
	}
	f.panicReset = false
	// First recovery learns the authenticated helper's newer generation but
	// remains blocked; no new job is admitted during reconciliation.
	if _, err = s.Finish(context.Background(), attemptA); err == nil {
		t.Fatal("uncertain generation released")
	}
	if _, err = s.Finish(context.Background(), attemptA); err != nil {
		t.Fatal(err)
	}
	state, err = s.Store.Read()
	if err != nil || state.Phase != "idle" || state.PVEGeneration != 2 {
		t.Fatalf("recovery %+v %v", state, err)
	}
}
func TestResetReceiptAndConfigBinding(t *testing.T) {
	s, f, spec := fixture(t)
	f.invalidReceipt = true
	if _, err := s.Prepare(context.Background(), spec, "/bundle"); err == nil {
		t.Fatal("foreign reset receipt accepted")
	}
	for _, call := range f.calls {
		if call == "deliver" {
			t.Fatal("delivered after bad reset")
		}
	}
	f.invalidReceipt = false
	s.Config.ResetManifest.Cores = 3
	if _, err := s.Finish(context.Background(), attemptA); err == nil {
		t.Fatal("changed enrollment accepted")
	}
}
func TestLockAndCorruptLedgerHaveNoEffects(t *testing.T) {
	s, f, spec := fixture(t)
	unlock, err := s.Store.lock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Prepare(context.Background(), spec, "/bundle"); err == nil || len(f.calls) != 0 {
		t.Fatal("concurrent access")
	}
	unlock()
	if err = os.WriteFile(filepath.Join(s.Store.Directory, "control.json"), []byte(`{"schema_version":1,"phase":"prepared"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Prepare(context.Background(), spec, "/bundle"); err == nil || len(f.calls) != 0 {
		t.Fatal("corrupt ledger accepted")
	}
}
func passingResult(s Service, spec executor.JobSpec) executor.Receipt {
	p := s.Config.Repositories[0]
	now := time.Unix(1000, 0)
	zero := 0
	return executor.Receipt{Expected: spec, Mode: executor.GateMode, Argv: p.Gates[0].Argv, CommandID: digest(p.Gates[0]), ActualImage: spec.ImageFingerprint, ActualCheckout: spec.SourceSHA, IncusPackageRevision: p.IncusPackageRevision, Status: "PASS", Cleanup: "ok", Command: executor.Outcome{Status: "exited", ExitCode: &zero, StartedAt: now.Add(time.Second), FinishedAt: now.Add(2 * time.Second)}, StartedAt: now, FinishedAt: now.Add(3 * time.Second), Summary: &executor.Summary{Version: 1, Success: true, Counts: executor.Counts{Tests: 1, Passed: 1}, Files: []executor.FileCounts{{File: "test/example.test.ts", Counts: executor.Counts{Tests: 1, Passed: 1}}}}}
}
func TestActualExecutorReceiptSchemaAndNegativeOutcomes(t *testing.T) {
	s, _, spec := fixture(t)
	r := passingResult(s, spec)
	raw, _ := json.Marshal(r)
	var decoded executor.Receipt
	if err := executor.Decode(bytes.NewReader(raw), &decoded); err != nil {
		t.Fatal(err)
	}
	if err := Verify(s.Config, spec, decoded); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*executor.Receipt){"cleanup": func(r *executor.Receipt) { r.Cleanup = "failed" }, "source": func(r *executor.Receipt) { r.ActualCheckout = strings.Repeat("f", 40) }, "attempt": func(r *executor.Receipt) { r.Expected.AttemptID = attemptB }, "mode": func(r *executor.Receipt) { r.Mode = executor.Preflight }, "image": func(r *executor.Receipt) { r.ActualImage = strings.Repeat("f", 64) }, "gate": func(r *executor.Receipt) { r.Argv = []string{"true"} }, "summary": func(r *executor.Receipt) { r.Summary = nil }, "signal": func(r *executor.Receipt) { r.Command.Signal = 9 }, "infra": func(r *executor.Receipt) { r.Errors = []string{"failed"} }} {
		t.Run(name, func(t *testing.T) {
			r := passingResult(s, spec)
			change(&r)
			if err := Verify(s.Config, spec, r); err == nil {
				t.Fatal("invalid receipt accepted")
			}
		})
	}
}
func TestCLIIsInertWithoutExecute(t *testing.T) {
	s, _, spec := fixture(t)
	directory := t.TempDir()
	c := filepath.Join(directory, "config.json")
	job := filepath.Join(directory, "spec.json")
	data, _ := json.Marshal(s.Config)
	if err := os.WriteFile(c, data, 0600); err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(spec)
	if err := os.WriteFile(job, data, 0600); err != nil {
		t.Fatal(err)
	}
	var in, out, errOut bytes.Buffer
	code := Main([]string{"prepare", "--config", c, "--spec", job, "--bundle", "/unopened", "--state-dir", filepath.Join(directory, "not-created")}, &in, &out, &errOut)
	if code != 0 || !strings.Contains(out.String(), `"execute":false`) {
		t.Fatalf("default %d %s %s", code, out.String(), errOut.String())
	}
	if _, err := os.Stat(filepath.Join(directory, "not-created")); !os.IsNotExist(err) {
		t.Fatal("dry run wrote ledger")
	}
	code = Main([]string{"prepare", "--config", c, "--spec", job, "--bundle", "/unopened", "--state-dir", filepath.Join(directory, "not-created"), "--execute"}, &in, &out, &errOut)
	if code == 0 || !strings.Contains(errOut.String(), "untrusted") {
		t.Fatalf("execute accepted untrusted config: code=%d stderr=%s", code, errOut.String())
	}
	if _, err := os.Stat(filepath.Join(directory, "not-created")); !os.IsNotExist(err) {
		t.Fatal("rejected config created ledger")
	}
	code = Main([]string{"verify", "--config", c, "--spec", job, "--receipt", filepath.Join(directory, "missing-receipt")}, &in, &out, &errOut)
	if code == 0 || !strings.Contains(errOut.String(), "untrusted") {
		t.Fatalf("verify accepted untrusted config: code=%d stderr=%s", code, errOut.String())
	}
}

func TestEndpointRequiresHostPinsInTrustedDirectory(t *testing.T) {
	s, _, _ := fixture(t)
	if err := s.Config.Validate(); err != nil {
		t.Fatal(err)
	}
	s.Config.Runner.KnownHostsFile = "/tmp/runner-hosts"
	if err := s.Config.Validate(); err == nil {
		t.Fatal("known-hosts outside /etc/ci-platform accepted")
	}
}

func TestSecureOpenFileChecksOwnersParentsAndModes(t *testing.T) {
	dir, err := os.MkdirTemp(".", ".control-files-")
	if err != nil {
		t.Fatal(err)
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "key")
	if err := os.WriteFile(path, []byte("not-a-secret"), 0400); err != nil {
		t.Fatal(err)
	}
	uid := uint32(os.Geteuid())
	f, err := secureOpenFile(path, []uint32{uid}, []uint32{uid, 0}, []os.FileMode{0400, 0600})
	if err != nil {
		t.Fatalf("private key owner should be readable: %v", err)
	}
	_ = f.Close()

	if err = os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if f, err = secureOpenFile(path, []uint32{uid}, []uint32{uid, 0}, []os.FileMode{0400, 0600}); err == nil {
		_ = f.Close()
		t.Fatal("readable-by-others key mode accepted")
	}
	if f, err = openRootOwnedConfig(path); err == nil {
		_ = f.Close()
		if uid != 0 {
			t.Fatal("non-root-owned config accepted")
		}
	}

	link := filepath.Join(dir, "linked")
	if err = os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	if f, err = secureOpenFile(filepath.Join(link, "key"), []uint32{uid}, []uint32{uid, 0}, []os.FileMode{0400, 0600}); err == nil {
		_ = f.Close()
		t.Fatal("symlinked parent accepted")
	}
	if err = os.Chmod(dir, 0777); err != nil {
		t.Fatal(err)
	}
	if f, err = secureOpenFile(path, []uint32{uid}, []uint32{uid, 0}, nil); err == nil {
		_ = f.Close()
		t.Fatal("group/world writable parent accepted")
	}
}
