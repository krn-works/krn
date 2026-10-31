package reset

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const installation = "11111111-1111-4111-8111-111111111111"
const firstAttempt = "22222222-2222-4222-8222-222222222222"
const nextAttempt = "33333333-3333-4333-8333-333333333333"
const firstBoot = "44444444-4444-4444-8444-444444444444"
const nextBoot = "55555555-5555-4555-8555-555555555555"

func fixture() (Manifest, map[string]string) {
	m := Manifest{SchemaVersion: 1, InstallationID: installation, ExpectedPVEHostname: "pve-fixture", VMID: 990001, VMName: "ci-runner", SMBIOSUUID: installation, Snapshot: "clean", SnapshotSHA256: strings.Repeat("a", 64), MemoryMiB: 8192, Cores: 4, Volumes: map[string]string{"scsi0": "ci-store:vm-990001-disk-0", "scsi1": "ci-store:vm-990001-disk-1", "efidisk0": "ci-store:vm-990001-disk-2", "tpmstate0": "ci-store:vm-990001-disk-3"}, ReadOnlyVolumes: map[string]string{}, Net0: NetworkBinding{"vmbr-ci-run", "02:11:22:33:44:55"}, NFT: PolicyBinding{"ci_fixture", strings.Repeat("b", 64)}, OperationTimeoutSeconds: 10, BootTimeoutSeconds: 10}
	c := map[string]string{"name": m.VMName, "smbios1": "uuid=" + m.SMBIOSUUID, "tags": "ci-platform;ci-" + installation, "onboot": "0", "memory": "8192", "cores": "4", "balloon": "0", "net0": "virtio=02:11:22:33:44:55,bridge=vmbr-ci-run,firewall=1", "vmgenid": nextBoot}
	for k, v := range m.Volumes {
		c[k] = v + ",size=8G"
	}
	m.SnapshotSHA256 = SnapshotDigest(c)
	return m, c
}

type fakeBackend struct {
	config               map[string]string
	calls                []string
	fail                 string
	failOrdinal          int
	panicAt              string
	boot                 string
	runningAfterRollback bool
}

func (f *fakeBackend) call(name string) error {
	f.calls = append(f.calls, name)
	if f.panicAt == name {
		panic("simulated lost process")
	}
	if f.fail == name || (f.failOrdinal != 0 && len(f.calls) == f.failOrdinal) {
		return failure("INJECTED_FAILURE")
	}
	return nil
}
func (f *fakeBackend) CheckHost(context.Context) error { return f.call("host") }
func (f *fakeBackend) Configuration(_ context.Context, snapshot bool) (map[string]string, error) {
	name := "config"
	if snapshot {
		name = "snapshot"
	}
	return f.config, f.call(name)
}
func (f *fakeBackend) CheckHA(context.Context) error     { return f.call("ha") }
func (f *fakeBackend) CheckPolicy(context.Context) error { return f.call("policy") }
func (f *fakeBackend) Rollback(context.Context) error    { return f.call("rollback") }
func (f *fakeBackend) Stopped(context.Context) (bool, error) {
	return !f.runningAfterRollback, f.call("stopped")
}
func (f *fakeBackend) Start(context.Context) error            { return f.call("start") }
func (f *fakeBackend) Stop(context.Context) error             { return f.call("stop") }
func (f *fakeBackend) BootID(context.Context) (string, error) { return f.boot, f.call("boot") }
func setup(t *testing.T) (Service, *fakeBackend, Request) {
	t.Helper()
	m, c := fixture()
	f := &fakeBackend{config: c, boot: firstBoot}
	s := Service{Manifest: m, Store: Store{Directory: t.TempDir()}, Backend: f, Now: func() time.Time { return time.Unix(10000, 0) }}
	return s, f, Request{firstAttempt, 0, m.Digest()}
}
func TestColdResetSequenceAndAttemptBinding(t *testing.T) {
	s, f, request := setup(t)
	r, err := s.Execute(context.Background(), request)
	if err != nil || !r.OK || r.Generation != 1 || r.BootID != firstBoot {
		t.Fatalf("receipt=%+v err=%v", r, err)
	}
	want := []string{"host", "config", "ha", "snapshot", "policy", "rollback", "stopped", "config", "policy", "start", "boot", "policy"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v", f.calls)
	}
	f.calls = nil
	r2, err := s.Execute(context.Background(), request)
	if err != nil || r2 != r || len(f.calls) != 0 {
		t.Fatalf("retry caused side effects: %v %+v %v", err, r2, f.calls)
	}
	request = Request{nextAttempt, 0, s.Manifest.Digest()}
	if _, err = s.Execute(context.Background(), request); codeOf(err) != "STALE_GENERATION" || len(f.calls) != 0 {
		t.Fatalf("stale generation: %v %v", err, f.calls)
	}
	request.ExpectedGeneration = 1
	f.boot = nextBoot
	r, err = s.Execute(context.Background(), request)
	if err != nil || r.Generation != 2 || r.BootID != nextBoot {
		t.Fatalf("next reset: %+v %v", r, err)
	}
}
func TestFailureQuarantinesOnlyEnrolledVM(t *testing.T) {
	for _, point := range []string{"host", "config", "ha", "snapshot", "policy", "rollback", "stopped", "start", "boot"} {
		t.Run(point, func(t *testing.T) {
			s, f, request := setup(t)
			f.fail = point
			r, err := s.Execute(context.Background(), request)
			if err == nil || r.OK {
				t.Fatalf("false pass: %+v %v", r, err)
			}
			state, err := s.Store.Load()
			if err != nil || state.Phase != "blocked" || state.Generation != 1 {
				t.Fatalf("state=%+v %v", state, err)
			}
			stopped := false
			for _, call := range f.calls {
				stopped = stopped || call == "stop"
			}
			if stopped != (point != "host" && point != "config") {
				t.Fatalf("unexpected stop: %v", f.calls)
			}
		})
	}
	for _, field := range []string{"name", "smbios1", "tags"} {
		t.Run("wrong-"+field, func(t *testing.T) {
			s, f, request := setup(t)
			f.config[field] = "some-client-value"
			_, err := s.Execute(context.Background(), request)
			if err == nil || !reflect.DeepEqual(f.calls, []string{"host", "config"}) {
				t.Fatalf("touched foreign VM: %v %v", f.calls, err)
			}
		})
	}
}
func TestDiskAndNetworkDriftRejectBeforeRollback(t *testing.T) {
	for name, mutate := range map[string]func(map[string]string){
		"extra-efi":           func(c map[string]string) { c["efidisk0"] = "other:foreign" },
		"extra-disk":          func(c map[string]string) { c["scsi2"] = "other:foreign" },
		"incus-disk-missing":  func(c map[string]string) { delete(c, "scsi1") },
		"tpm-missing":         func(c map[string]string) { delete(c, "tpmstate0") },
		"excluded-from-reset": func(c map[string]string) { c["scsi1"] += ",snapshot=0" },
		"shared":              func(c map[string]string) { c["scsi1"] += ",shared=1" },
		"passthrough":         func(c map[string]string) { c["hostpci0"] = "0000:00:01.0" },
		"extra-network":       func(c map[string]string) { c["net1"] = "virtio=02:11:22:33:44:66,bridge=vmbr0" },
		"wrong-bridge":        func(c map[string]string) { c["net0"] = "virtio=02:11:22:33:44:55,bridge=vmbr0" },
		"hookscript":          func(c map[string]string) { c["hookscript"] = "local:snippets/other.sh" },
		"memory-snapshot":     func(c map[string]string) { c["vmstate"] = "ci-store:state" },
		"cloudinit-secret":    func(c map[string]string) { c["cipassword"] = "fixture-not-a-secret" },
	} {
		t.Run(name, func(t *testing.T) {
			s, f, request := setup(t)
			mutate(f.config)
			if _, err := s.Execute(context.Background(), request); err == nil {
				t.Fatal("drift accepted")
			}
			for _, call := range f.calls {
				if call == "rollback" || call == "start" {
					t.Fatalf("unsafe effect: %v", f.calls)
				}
			}
		})
	}
}
func TestLostProcessRequiresNewResetAndFreshBoot(t *testing.T) {
	s, f, request := setup(t)
	f.panicAt = "rollback"
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("expected simulated crash")
			}
		}()
		_, _ = s.Execute(context.Background(), request)
	}()
	state, err := s.Store.Load()
	if err != nil || state.Phase != "resetting" || state.Generation != 1 {
		t.Fatalf("lost durable reservation: %+v %v", state, err)
	}
	f.panicAt = ""
	f.calls = nil
	if _, err = s.Execute(context.Background(), request); codeOf(err) != "REQUEST_NOT_COMMITTED" || len(f.calls) != 0 {
		t.Fatalf("uncertain replay accepted: %v %v", err, f.calls)
	}
	request = Request{nextAttempt, 1, s.Manifest.Digest()}
	if _, err = s.Execute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	request = Request{firstAttempt, 2, s.Manifest.Digest()}
	if r, err := s.Execute(context.Background(), request); codeOf(err) != "BOOT_ID_NOT_FRESH" || r.OK {
		t.Fatalf("reused boot: %+v %v", r, err)
	}
}

func TestPostRollbackFailuresCannotReleaseSlot(t *testing.T) {
	// Restored config, second policy check, and final post-boot policy check.
	for _, ordinal := range []int{8, 9, 12} {
		t.Run(fmt.Sprint(ordinal), func(t *testing.T) {
			s, f, request := setup(t)
			f.failOrdinal = ordinal
			r, err := s.Execute(context.Background(), request)
			if err == nil || r.OK || !r.RunnerStopped {
				t.Fatalf("released after restore/boot failure: %+v %v", r, err)
			}
			state, err := s.Store.Load()
			if err != nil || state.Phase != "blocked" {
				t.Fatalf("ledger=%+v %v", state, err)
			}
		})
	}
	s, f, request := setup(t)
	f.runningAfterRollback = true
	if r, err := s.Execute(context.Background(), request); codeOf(err) != "ROLLBACK_NOT_STOPPED" || r.OK || r.RunnerStopped {
		t.Fatalf("running VM accepted: %+v %v", r, err)
	}
}
func TestLedgerLockCorruptionAndSymlink(t *testing.T) {
	s, f, request := setup(t)
	unlock, err := s.Store.Lock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Execute(context.Background(), request); codeOf(err) != "RESET_BUSY" || len(f.calls) != 0 {
		t.Fatalf("lock bypass: %v", err)
	}
	unlock()
	path := filepath.Join(s.Store.Directory, "state.json")
	if err = os.WriteFile(path, []byte(`{"phase":"ready","generation":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Execute(context.Background(), request); codeOf(err) != "CORRUPT_LEDGER" || len(f.calls) != 0 {
		t.Fatalf("corrupt ledger accepted: %v", err)
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "other.json")
	if err = os.WriteFile(target, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Execute(context.Background(), request); codeOf(err) != "UNREADABLE_LEDGER" || len(f.calls) != 0 {
		t.Fatalf("symlink accepted: %v", err)
	}
}
func TestRateLimitAndManifestBinding(t *testing.T) {
	s, f, request := setup(t)
	request.ManifestSHA256 = strings.Repeat("f", 64)
	if _, err := s.Execute(context.Background(), request); codeOf(err) != "REQUEST_MANIFEST_MISMATCH" || len(f.calls) != 0 {
		t.Fatalf("manifest bypass: %v", err)
	}
	s.Manifest.MinResetIntervalSeconds = 30
	request.ManifestSHA256 = s.Manifest.Digest()
	if _, err := s.Execute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	f.calls = nil
	request = Request{nextAttempt, 1, s.Manifest.Digest()}
	if _, err := s.Execute(context.Background(), request); codeOf(err) != "RESET_RATE_LIMIT" || len(f.calls) != 0 {
		t.Fatalf("rate bypass: %v", err)
	}
}
func TestStrictRequestAndManifest(t *testing.T) {
	good := `{"request_id":"` + firstAttempt + `","expected_generation":0,"manifest_sha256":"` + strings.Repeat("a", 64) + `"}`
	if _, err := DecodeRequest([]byte(good)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{good + `{}`, strings.Replace(good, `"expected_generation":0`, `"expected_generation":null`, 1), strings.Replace(good, `"expected_generation":0`, `"expected_generation":0,"expected_generation":1`, 1), strings.Replace(good, `"expected_generation":0`, `"expected_generation":0,"Expected_Generation":1`, 1), strings.Replace(good, `"expected_generation":0`, `"unknown":0`, 1), `null`} {
		if _, err := DecodeRequest([]byte(raw)); err == nil {
			t.Fatalf("accepted invalid request: %s", raw)
		}
	}
	m, _ := fixture()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = DecodeManifest(raw); err != nil {
		t.Fatal(err)
	}
	for _, raw := range [][]byte{[]byte(`null`), []byte(`{}`), append(raw, []byte(`{}`)...), bytes.Replace(raw, []byte(`"net0":{`), []byte(`"net0":{"bridge":"duplicated",`), 1)} {
		if _, err = DecodeManifest(raw); err == nil {
			t.Fatal("invalid manifest accepted")
		}
	}
}
func TestSnapshotDigestIgnoresOnlyGeneratedMetadata(t *testing.T) {
	_, c := fixture()
	want := SnapshotDigest(c)
	c["vmgenid"] = firstBoot
	c["snaptime"] = "1234"
	c["parent"] = "prior"
	if SnapshotDigest(c) != want {
		t.Fatal("generated metadata changed digest")
	}
	c["scsi1"] = "other:foreign"
	if SnapshotDigest(c) == want {
		t.Fatal("writable disk drift missed")
	}
}

type recordedRunner struct {
	calls  [][]string
	output []byte
	err    error
}

func (r *recordedRunner) Run(_ context.Context, argv []string) ([]byte, error) {
	r.calls = append(r.calls, append([]string(nil), argv...))
	return r.output, r.err
}
func TestPVETransportUsesFixedArgumentsAndRealExit(t *testing.T) {
	m, _ := fixture()
	r := &recordedRunner{}
	p := PVEBackend{Manifest: m, Runner: r}
	if err := p.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(r.calls, [][]string{{"/usr/sbin/qm", "rollback", "990001", "clean"}}) {
		t.Fatalf("argv=%v", r.calls)
	}
	r.err = &CommandError{ExitCode: 23, Stderr: []byte("private diagnostic")}
	err := p.Start(context.Background())
	var commandError *CommandError
	if !errors.As(err, &commandError) || commandError.ExitCode != 23 || strings.Contains(err.Error(), "private") {
		t.Fatalf("exit or confidentiality lost: %v", err)
	}
	r.err = nil
	r.output = []byte("service vm:990001 (pve-fixture, started)\n")
	if codeOf(p.CheckHA(context.Background())) != "HA_MANAGED_FORBIDDEN" {
		t.Fatal("HA service accepted")
	}
	r.output = []byte("service vm:9900010 (pve-fixture, started)\n")
	if err = p.CheckHA(context.Background()); err != nil {
		t.Fatal("wrong VM matched")
	}
	r.output = []byte(`{"exited":1,"exitcode":0,"out-data":"` + firstBoot + `\n"}`)
	if id, err := p.BootID(context.Background()); err != nil || id != firstBoot {
		t.Fatalf("QGA: %s %v", id, err)
	}
	for _, raw := range []string{
		`{"exited":1,"out-data":"` + firstBoot + `"}`,
		`{"exited":1,"exitcode":null,"out-data":"` + firstBoot + `"}`,
		`{"exited":1,"exitcode":23,"exitcode":0,"out-data":"` + firstBoot + `"}`,
	} {
		r.output = []byte(raw)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := p.BootID(ctx); codeOf(err) != "BOOT_HEALTH_TIMEOUT" {
			t.Fatalf("accepted incomplete/ambiguous health receipt: %s %v", raw, err)
		}
	}
}
func TestServeCannotExecuteByDefault(t *testing.T) {
	var out, errOut bytes.Buffer
	code := Main([]string{"serve", "--manifest", "/unopened"}, strings.NewReader(`{}`), &out, &errOut, nil)
	if code != 78 || !strings.Contains(out.String(), "EXPLICIT_ROOT_EXECUTION_REQUIRED") {
		t.Fatalf("unsafe default: %d %s", code, out.String())
	}
	if _, err := ReadBounded(strings.NewReader(strings.Repeat("x", 4097)), 4096); codeOf(err) != "INPUT_TOO_LARGE" {
		t.Fatal("unbounded input")
	}
}

func TestBackendProcessResult(t *testing.T) {
	if os.Getenv("CI_RESET_PROCESS_HELPER") != "" {
		t.Fatal("inherited helper environment")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, err = (ExecRunner{}).Run(context.Background(), []string{executable, "-test.run=^TestBackendProcessHelper$", "--", "exit23"})
	var result *CommandError
	if !errors.As(err, &result) || result.ExitCode != 23 || string(result.Stderr) != "bounded-diagnostic" {
		t.Fatalf("actual process exit: %+v %v", result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = (ExecRunner{}).Run(ctx, []string{executable, "-test.run=^TestBackendProcessHelper$", "--", "exit23"})
	if !errors.As(err, &result) || !result.TimedOut {
		t.Fatalf("cancel not preserved: %v", err)
	}
}

func TestBackendProcessHelper(t *testing.T) {
	if len(os.Args) < 2 || os.Args[len(os.Args)-2] != "--" || os.Args[len(os.Args)-1] != "exit23" {
		return
	}
	_, _ = os.Stderr.WriteString("bounded-diagnostic")
	os.Exit(23)
}
