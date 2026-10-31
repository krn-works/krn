package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"
)

type fixture struct {
	t       *testing.T
	profile Profile
	spec    JobSpec
	options Options
	plan    *ExecutionPlan
	results map[string]ProcessResult
	calls   []Command
	hook    func(context.Context, Command)
	remote  CommandReceipt
}

func TestRawIncusReadsStayInEnrolledProjectWithoutGlobalFlag(t *testing.T) {
	f := newFixture(t)
	seen := map[string]bool{}
	for _, c := range f.plan.Commands() {
		if c.Name != "image" && c.Name != "instance" && c.Name != "cleanup-owner" {
			continue
		}
		seen[c.Name] = true
		// Real Incus 6.0.4 rejected --project before any API request. Without
		// the URL parameter a successful query would instead read default.
		if len(c.Argv) != 4 || c.Argv[0] != "/usr/bin/incus" || c.Argv[1] != "--force-local" || c.Argv[2] != "query" {
			t.Fatalf("unsupported raw API command: %v", c.Argv)
		}
		u, err := url.Parse(c.Argv[3])
		if err != nil || len(u.Query()) != 1 || len(u.Query()["project"]) != 1 || u.Query().Get("project") != f.profile.Project {
			t.Fatalf("API read escaped enrolled project: %v", c.Argv)
		}
		wantPath := "/1.0/instances/" + f.spec.ContainerName()
		if c.Name == "image" {
			wantPath = "/1.0/images/" + f.spec.ImageFingerprint
		}
		if u.Path != wantPath || u.Host != "" || u.Fragment != "" {
			t.Fatalf("unexpected API target: %s", c.Argv[3])
		}
	}
	if len(seen) != 3 {
		t.Fatal("raw API coverage incomplete")
	}
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	f := &fixture{t: t, results: map[string]ProcessResult{}}
	f.spec = JobSpec{RepoID: "123", SourceSHA: strings.Repeat("a", 40), ConfigSHA: strings.Repeat("b", 40), ImageFingerprint: strings.Repeat("c", 64), AttemptID: "12345678-1234-4123-8123-123456789abc", Tier: Product, TimeoutSeconds: 30, MemoryMiB: 512, ProcessLimit: 128}
	manifest := []byte(`{"toolchain":"fixture"}`)
	f.profile = Profile{RepoID: f.spec.RepoID, ConfigSHA: f.spec.ConfigSHA, ImageFingerprint: f.spec.ImageFingerprint, ImageManifestSHA256: digest(manifest), IncusPackageRevision: "6.0.4-2+deb13u11", Project: "ci", StoragePool: "ci-pool", CPUCount: 2, RootGiB: 8, VMMemoryMiB: 8192, VMHeadroomMiB: 1536, MaxJobMemoryMiB: 6144, MaxJobProcesses: 512, GitName: "CI", GitEmail: "ci@invalid.example", Gates: []Gate{{Tier: Product, Argv: []string{"npm", "run", "gate"}, SummaryPrefix: "KRN_TEST_SUMMARY_JSON="}}}
	f.options = Options{BundlePath: filepath.Join(dir, "source.bundle"), BinaryPath: filepath.Join(dir, "ci-platform"), EvidenceRoot: filepath.Join(dir, "evidence"), Mode: GateMode}
	for path, body := range map[string]string{f.options.BundlePath: "bundle fixture", f.options.BinaryPath: "binary fixture"} {
		if err := os.WriteFile(path, []byte(body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	f.replan()
	put := func(name string, v any) { f.results[name] = ProcessResult{Stdout: jsonBytes(v)} }
	put("vm-memory", map[string]int{"MemTotal": 8192, "MemAvailable": 7500})
	f.results["incus-package"] = ProcessResult{Stdout: []byte(f.profile.IncusPackageRevision)}
	put("image", map[string]string{"fingerprint": f.spec.ImageFingerprint, "type": "container"})
	put("existing", []any{})
	inst := instance{Name: f.spec.ContainerName(), Type: "container", Profiles: []string{}, Config: f.plan.settings(), Devices: map[string]map[string]string{"root": {"type": "disk", "path": "/", "pool": f.profile.StoragePool, "size": "8GiB"}}}
	inst.Config["volatile.base_image"] = f.spec.ImageFingerprint
	put("instance", inst)
	put("cleanup-owner", inst)
	for _, name := range []string{"create", "start", "helper-directory", "helper-push", "bundle-push", "gate", "cleanup"} {
		f.results[name] = ProcessResult{}
	}
	put("tools", toolProbe{Versions: map[string]string{"systemd-run": "systemd 257", "bwrap": "bubblewrap fixture", "git": "git fixture"}, Options: true, ManifestSHA256: f.profile.ImageManifestSHA256, Manifest: manifest, MemoryMax: "536870912", PidsMax: "128", HelperSHA256: digest([]byte("binary fixture"))})
	put("session", sessionProbe{UID: 1000, Home: "/home/ci", Runtime: "/run/user/1000", Bus: "unix:path=/run/user/1000/bus", Session: "User=1000\nState=active", Manager: "257", Cwd: "/home/ci", Path: safePath, Cgroup: "0::/fixture", BwrapArgv: bwrapArgv(), Memory: memoryProbe{Limit: "67108864", Swap: "0", Touched: 32 * 1024 * 1024, Signal: 9, OOMKills: 1, Peak: 64 * 1024 * 1024}, Pids: pidsProbe{Limit: "16", Denied: true, Children: 8, Events: 1}})
	f.results["exit23"] = ProcessResult{ExitCode: 23}
	put("source", map[string]any{"actual_checkout": f.spec.SourceSHA, "shallow": false})
	zero := 0
	f.remote = CommandReceipt{Expected: f.spec, CommandID: commandID(f.plan.gate), ActualCheckout: f.spec.SourceSHA, FinalCheckout: f.spec.SourceSHA, Outcome: Outcome{Status: "exited", ExitCode: &zero, StartedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), FinishedAt: time.Date(2026, 1, 1, 0, 0, 1, 0, time.UTC)}, SummaryCount: 1, Summary: &Summary{Version: 1, Success: true, Counts: Counts{Tests: 2, Passed: 2}, Files: []FileCounts{{File: "test/gate.test.ts", Counts: Counts{Tests: 2, Passed: 2}}}}}
	f.saveRemote()
	return f
}
func (f *fixture) replan() {
	f.t.Helper()
	var err error
	f.plan, err = Plan(f.profile, f.spec, f.options)
	if err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) saveRemote() {
	f.results["command-receipt"] = ProcessResult{Stdout: jsonBytes(f.remote)}
}
func (f *fixture) Run(ctx context.Context, c Command) ProcessResult {
	f.t.Helper()
	if f.hook != nil {
		f.hook(ctx, c)
	}
	f.calls = append(f.calls, c)
	r, ok := f.results[c.Name]
	if !ok {
		f.t.Fatalf("unexpected command: %s", c.Name)
	}
	if (c.Name == "cleanup-owner" || c.Name == "cleanup") && ctx.Err() != nil {
		f.t.Fatal("cleanup reused cancelled context")
	}
	return r
}
func (f *fixture) called(name string) bool {
	for _, c := range f.calls {
		if c.Name == name {
			return true
		}
	}
	return false
}
func (f *fixture) execute() Receipt { return Execute(context.Background(), f.plan, f) }

func TestGateReceiptRequiresCompleteExecutionAndCleanup(t *testing.T) {
	f := newFixture(t)
	r := f.execute()
	if r.Status != "PASS" || r.ExitStatus() != 0 || r.Cleanup != "ok" || r.ActualCheckout != f.spec.SourceSHA || r.ActualImage != f.spec.ImageFingerprint || r.CommandID == "" || r.IncusPackageRevision != f.profile.IncusPackageRevision {
		t.Fatalf("receipt: %+v", r)
	}
	if !f.called("exit23") || !f.called("cleanup") {
		t.Fatal("preflight/cleanup missing")
	}
	for _, e := range r.Evidence {
		b, err := os.ReadFile(e.Path)
		if err != nil || digest(b) != e.SHA256 || len(b) != e.Bytes || len(b) > LogLimit {
			t.Fatalf("invalid evidence: %+v %v", e, err)
		}
	}
	b, err := os.ReadFile(filepath.Join(f.options.EvidenceRoot, f.spec.AttemptID, "receipt.json"))
	if err != nil || !json.Valid(b) {
		t.Fatalf("missing final JSON receipt: %v", err)
	}
	before := len(f.calls)
	replay := f.execute()
	if replay.Status != "FAIL" || len(f.calls) != before {
		t.Fatal("attempt replay ran commands")
	}
}

func TestInvalidAdmissionAndResourceBounds(t *testing.T) {
	cases := map[string]func(*fixture){
		"source injection":       func(f *fixture) { f.spec.SourceSHA = "a; touch /tmp/unsafe" },
		"short SHA":              func(f *fixture) { f.spec.SourceSHA = strings.Repeat("a", 39) },
		"uppercase SHA":          func(f *fixture) { f.spec.SourceSHA = strings.Repeat("A", 40) },
		"wrong config":           func(f *fixture) { f.spec.ConfigSHA = strings.Repeat("d", 40) },
		"wrong image":            func(f *fixture) { f.spec.ImageFingerprint = strings.Repeat("d", 64) },
		"repo URL":               func(f *fixture) { f.spec.RepoID = "https://invalid.example" },
		"unknown tier":           func(f *fixture) { f.spec.Tier = "invented" },
		"missing global mapping": func(f *fixture) { f.spec.Tier = GlobalFast },
		"UUID version":           func(f *fixture) { f.spec.AttemptID = "12345678-1234-1123-8123-123456789abc" },
		"memory low":             func(f *fixture) { f.spec.MemoryMiB = 255 },
		"memory high":            func(f *fixture) { f.spec.MemoryMiB = 6145 },
		"profile memory":         func(f *fixture) { f.profile.MaxJobMemoryMiB = 256 },
		"pids low":               func(f *fixture) { f.spec.ProcessLimit = 63 },
		"pids high":              func(f *fixture) { f.spec.ProcessLimit = 4097 },
		"profile pids":           func(f *fixture) { f.profile.MaxJobProcesses = 64 },
		"timeout low":            func(f *fixture) { f.spec.TimeoutSeconds = 29 },
		"timeout high":           func(f *fixture) { f.spec.TimeoutSeconds = 7201 },
		"CPU low":                func(f *fixture) { f.profile.CPUCount = 0 },
		"CPU high":               func(f *fixture) { f.profile.CPUCount = 5 },
		"root size":              func(f *fixture) { f.profile.RootGiB = 65 },
		"headroom low":           func(f *fixture) { f.profile.VMHeadroomMiB = 1535 },
		"headroom overcommit":    func(f *fixture) { f.profile.VMMemoryMiB = 6144 },
		"short package version":  func(f *fixture) { f.profile.IncusPackageRevision = "6.0.4" },
		"unsafe project":         func(f *fixture) { f.profile.Project = "ci:remote" },
		"arbitrary Product":      func(f *fixture) { f.profile.Gates[0].Argv = []string{"npm", "run", "gate:local"} },
		"duplicate tier":         func(f *fixture) { f.profile.Gates = append(f.profile.Gates, f.profile.Gates[0]) },
		"shell gate": func(f *fixture) {
			f.profile.Gates = []Gate{{Tier: GlobalFast, Argv: []string{"/bin/sh", "-c", "echo green"}, SummaryPrefix: "RESULT="}}
			f.spec.Tier = GlobalFast
		},
		"credentials":     func(f *fixture) { f.profile.Gates[0].Argv = append(f.profile.Gates[0].Argv, "--token=redacted") },
		"relative bundle": func(f *fixture) { f.options.BundlePath = "source.bundle" },
		"path traversal":  func(f *fixture) { f.options.EvidenceRoot = "/evidence/../other" },
		"unknown mode":    func(f *fixture) { f.options.Mode = "matrix" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			mutate(f)
			if _, err := Plan(f.profile, f.spec, f.options); err == nil {
				t.Fatal("unsafe admission accepted")
			}
			if len(f.calls) != 0 {
				t.Fatal("validation invoked transport")
			}
		})
	}
}

func TestBoundaryFailuresNeverGreenAndAlwaysCleanOwnedGuest(t *testing.T) {
	cases := map[string]struct {
		step    string
		value   any
		code    int
		gateRan bool
	}{
		"wrong checkout":                 {"source", map[string]any{"actual_checkout": strings.Repeat("d", 40), "shallow": false}, 0, false},
		"shallow checkout":               {"source", map[string]any{"actual_checkout": strings.Repeat("a", 40), "shallow": true}, 0, false},
		"missing full history assertion": {"source", map[string]any{"actual_checkout": strings.Repeat("a", 40)}, 0, false},
		"missing session probe":          {"session", map[string]any{}, 0, false},
		"missing tool probe":             {"tools", nil, 0, false},
		"missing command receipt":        {"command-receipt", nil, 0, true},
		"init failure":                   {"create", nil, 1, false},
		"setup failure":                  {"start", nil, 1, false},
		"exit23 swallowed":               {"exit23", nil, 0, false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.results[c.step] = ProcessResult{ExitCode: c.code, Stdout: jsonBytes(c.value)}
			r := f.execute()
			if r.Status != "FAIL" || r.ExitStatus() == 0 || !f.called("cleanup") || f.called("gate") != c.gateRan {
				t.Fatalf("failure escaped: %+v calls=%v", r, f.calls)
			}
		})
	}
}

func TestImageAndNameChecksPrecedeCreate(t *testing.T) {
	for _, step := range []string{"image", "existing", "incus-package", "vm-memory"} {
		t.Run(step, func(t *testing.T) {
			f := newFixture(t)
			f.results[step] = ProcessResult{Stdout: []byte(`{}`)}
			r := f.execute()
			if r.Status != "FAIL" || f.called("create") || f.called("cleanup") {
				t.Fatalf("unexpected resource creation: %+v", r)
			}
		})
	}
	f := newFixture(t)
	f.results["image"] = ProcessResult{Stdout: jsonBytes(map[string]string{"fingerprint": strings.Repeat("d", 64), "type": "container"})}
	r := f.execute()
	if r.Status != "FAIL" || r.ActualImage != strings.Repeat("d", 64) || f.called("create") {
		t.Fatal("wrong fingerprint admitted")
	}
}

func TestNestingIsTrustedProfileOnlyAndReadBackExactly(t *testing.T) {
	for _, tc := range []struct {
		name            string
		profile, actual bool
		pass            bool
	}{{"default refuses nesting", false, true, false}, {"opt-in requires nesting", true, false, false}, {"reviewed opt-in", true, true, true}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.profile.Nesting = tc.profile
			f.replan()
			var inst instance
			if err := json.Unmarshal(f.results["instance"].Stdout, &inst); err != nil {
				t.Fatal(err)
			}
			inst.Config["security.nesting"] = fmt.Sprint(tc.actual)
			f.results["instance"] = ProcessResult{Stdout: jsonBytes(inst)}
			r := f.execute()
			if (r.Status == "PASS") != tc.pass || (!tc.pass && f.called("start")) {
				t.Fatalf("nesting policy mismatch: %+v", r)
			}
		})
	}
	f := newFixture(t)
	data := strings.TrimSuffix(string(jsonBytes(f.spec)), "}") + `,"nesting":true}`
	var spec JobSpec
	if Decode(strings.NewReader(data), &spec) == nil {
		t.Fatal("job selected trusted nesting policy")
	}
}

func TestReadbackRejectsWeakenedIsolation(t *testing.T) {
	for _, field := range []string{"volatile.base_image", "security.guestapi", "security.privileged", "security.idmap.isolated", "security.nesting", "limits.memory", "limits.cpu", "limits.processes", "limits.memory.swap", "raw.lxc", "environment.TOKEN", "device", "profile"} {
		t.Run(field, func(t *testing.T) {
			f := newFixture(t)
			var inst instance
			if err := json.Unmarshal(f.results["instance"].Stdout, &inst); err != nil {
				t.Fatal(err)
			}
			switch field {
			case "device":
				inst.Devices["host"] = map[string]string{"type": "disk", "source": "/", "path": "/host"}
			case "profile":
				inst.Profiles = []string{"default"}
			default:
				inst.Config[field] = "unsafe"
			}
			f.results["instance"] = ProcessResult{Stdout: jsonBytes(inst)}
			r := f.execute()
			if r.Status != "FAIL" || f.called("start") || !f.called("cleanup") {
				t.Fatalf("weakened readback: %+v", r)
			}
		})
	}
}

func TestGateExitSignalTimeoutAndSetupPropagate(t *testing.T) {
	for _, c := range []struct {
		status                        string
		code, signal, transport, want int
	}{{"exited", 23, 0, 23, 23}, {"signaled", 0, 15, 143, 143}, {"timeout", 0, 9, 124, 124}, {"setup_failed", 0, 0, 2, 1}} {
		t.Run(c.status, func(t *testing.T) {
			f := newFixture(t)
			f.remote.Outcome.Status = c.status
			f.remote.Outcome.Signal = c.signal
			f.remote.Outcome.ExitCode = nil
			if c.status == "exited" {
				f.remote.Outcome.ExitCode = &c.code
			}
			f.saveRemote()
			f.results["gate"] = ProcessResult{ExitCode: c.transport}
			r := f.execute()
			if r.Status != "FAIL" || r.ExitStatus() != c.want || r.Command.Status != c.status || !f.called("cleanup") {
				t.Fatalf("result not propagated: %+v", r)
			}
		})
	}
}

func TestTransportMismatchOrMissingIdentityBlocksGreen(t *testing.T) {
	cases := map[string]func(*fixture){
		"exit mismatch":           func(f *fixture) { f.results["gate"] = ProcessResult{ExitCode: 23} },
		"attempt mismatch":        func(f *fixture) { f.remote.Expected.AttemptID = "12345678-1234-4123-8123-123456789abd"; f.saveRemote() },
		"command mismatch":        func(f *fixture) { f.remote.CommandID = strings.Repeat("d", 64); f.saveRemote() },
		"image mismatch":          func(f *fixture) { f.remote.Expected.ImageFingerprint = strings.Repeat("d", 64); f.saveRemote() },
		"final checkout mismatch": func(f *fixture) { f.remote.FinalCheckout = strings.Repeat("d", 40); f.saveRemote() },
		"missing times":           func(f *fixture) { f.remote.Outcome.StartedAt = time.Time{}; f.saveRemote() },
		"negative duration": func(f *fixture) {
			f.remote.Outcome.FinishedAt = f.remote.Outcome.StartedAt.Add(-time.Second)
			f.saveRemote()
		},
		"unknown status": func(f *fixture) { f.remote.Outcome.Status = "SUCCESS"; f.saveRemote() },
		"spawn failure":  func(f *fixture) { f.results["gate"] = ProcessResult{StartFailed: true} },
		"truncated receipt": func(f *fixture) {
			v := f.results["command-receipt"]
			v.Truncated = true
			f.results["command-receipt"] = v
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			change(f)
			r := f.execute()
			if r.Status != "FAIL" || r.ExitStatus() == 0 || !f.called("cleanup") {
				t.Fatalf("invalid receipt accepted: %+v", r)
			}
		})
	}
}

func TestSummaryMustBeCompleteUniqueAndHaveZeroSkips(t *testing.T) {
	cases := map[string]func(*CommandReceipt){
		"missing":            func(r *CommandReceipt) { r.Summary = nil },
		"missing marker":     func(r *CommandReceipt) { r.SummaryCount = 0 },
		"duplicate marker":   func(r *CommandReceipt) { r.SummaryCount = 2 },
		"failure":            func(r *CommandReceipt) { r.Summary.Success = false },
		"skip":               func(r *CommandReceipt) { r.Summary.Counts.Skipped = 1 },
		"todo":               func(r *CommandReceipt) { r.Summary.Counts.Todo = 1 },
		"cancelled":          func(r *CommandReceipt) { r.Summary.Counts.Cancelled = 1 },
		"failed":             func(r *CommandReceipt) { r.Summary.Counts.Failed = 1 },
		"zero tests":         func(r *CommandReceipt) { r.Summary.Counts = Counts{} },
		"missing coverage":   func(r *CommandReceipt) { r.Summary.Files = nil },
		"mismatched totals":  func(r *CommandReceipt) { r.Summary.Files[0].Tests = 1; r.Summary.Files[0].Passed = 1 },
		"duplicate coverage": func(r *CommandReceipt) { r.Summary.Files = append(r.Summary.Files, r.Summary.Files[0]) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			change(&f.remote)
			f.saveRemote()
			r := f.execute()
			if r.Status != "FAIL" || r.FailureOrigin != "summary" || !f.called("cleanup") {
				t.Fatalf("bad summary accepted: %+v", r)
			}
		})
	}
}

func TestCleanupFailureBlocksPassAndOwnershipProtectsExistingGuests(t *testing.T) {
	for _, ownerMismatch := range []bool{false, true} {
		t.Run(fmt.Sprint(ownerMismatch), func(t *testing.T) {
			f := newFixture(t)
			if ownerMismatch {
				f.results["cleanup-owner"] = ProcessResult{Stdout: jsonBytes(instance{Name: f.spec.ContainerName(), Config: map[string]string{"user.ci.attempt": "other"}})}
			} else {
				f.results["cleanup"] = ProcessResult{ExitCode: 1}
			}
			r := f.execute()
			if r.Status != "FAIL" || r.ExitStatus() == 0 || r.Cleanup != "failed" || r.FailureOrigin != "cleanup" || f.called("cleanup") == ownerMismatch {
				t.Fatalf("cleanup did not block: %+v", r)
			}
		})
	}
}

func TestCancellationStillCleansWithIndependentDeadline(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.hook = func(_ context.Context, c Command) {
		if c.Name == "gate" {
			cancel()
		}
	}
	f.results["gate"] = ProcessResult{ExitCode: 137, TimedOut: true, Signal: 9}
	r := Execute(ctx, f.plan, f)
	if r.Status != "FAIL" || r.ExitStatus() != 124 || r.Command.Status != "timeout" || r.Cleanup != "ok" {
		t.Fatalf("cancel result: %+v", r)
	}
}

func TestEvidenceBoundedAndCapturedBeforeCleanup(t *testing.T) {
	f := newFixture(t)
	f.results["gate"] = ProcessResult{Stdout: bytes.Repeat([]byte("x"), 2*LogLimit), Stderr: bytes.Repeat([]byte("e"), 2*LogLimit), Truncated: true}
	f.hook = func(_ context.Context, c Command) {
		if c.Name == "cleanup" {
			if _, err := os.Stat(filepath.Join(f.options.EvidenceRoot, f.spec.AttemptID, "gate.stdout")); err != nil {
				t.Fatal("deletion preceded gate log capture")
			}
		}
	}
	r := f.execute()
	if r.Status != "PASS" {
		t.Fatalf("bounded logs lost valid separate receipt: %+v", r)
	}
	for _, name := range []string{"gate.stdout", "gate.stderr"} {
		e := r.Evidence[name]
		if !e.Truncated || e.Bytes != LogLimit {
			t.Fatalf("unbounded log: %+v", e)
		}
	}
}

func TestPreflightNeverRunsGateOrProducesGatePass(t *testing.T) {
	f := newFixture(t)
	f.options.Mode = Preflight
	f.replan()
	r := f.execute()
	if r.Status != "PREFLIGHT_PASS" || r.Summary != nil || f.called("gate") || f.called("bundle-push") || !f.called("cleanup") {
		t.Fatalf("preflight admitted full gate: %+v", r)
	}
}

func TestPlanCopiesTrustedCommandsAndPreservesArgumentBoundaries(t *testing.T) {
	f := newFixture(t)
	literal := "global"
	f.spec.Tier = GlobalFast
	f.spec.BaseSHA = strings.Repeat("d", 40)
	f.profile.Gates = []Gate{{Tier: GlobalFast, Argv: []string{guestBinary, literal, "fast"}, SummaryMode: "native-exit"}}
	f.replan()
	f.profile.Gates[0].Argv[1] = "mutated"
	commands := f.plan.Commands()
	commands[0].Argv[0] = "mutated"
	if f.plan.Commands()[0].Argv[0] == "mutated" {
		t.Fatal("public plan mutated private command")
	}
	for _, c := range f.plan.Commands() {
		for _, arg := range c.Argv {
			if arg == "/bin/sh" || arg == "-c" || strings.Contains(arg, "machinectl") {
				t.Fatalf("shell/lossy runner in plan: %v", c.Argv)
			}
		}
		if c.Name == "gate" {
			var payload guestPayload
			if err := Decode(strings.NewReader(c.Argv[len(c.Argv)-1]), &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Gate.Argv[1] != literal || payload.Spec != f.spec {
				t.Fatal("arguments not preserved as separate data")
			}
			for _, required := range []string{"--wait", "--pipe", "--collect", "--service-type=exec", "--expand-environment=no", "PAMName=login", "User=ci", "KRN_LIVE=", "KRN_REQUIRE_ZERO_ISOLATION_SKIPS=1"} {
				if !contains(c.Argv, required) {
					t.Fatalf("missing production option %s", required)
				}
			}
		}
	}
}
func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func TestMainDryRunUnknownInputsAndExplicitProfile(t *testing.T) {
	f := newFixture(t)
	profilePath := filepath.Join(filepath.Dir(f.options.BundlePath), "profile.json")
	if err := os.WriteFile(profilePath, jsonBytes(f.profile), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"--profile", profilePath, "--spec", "-", "--bundle", f.options.BundlePath, "--evidence-root", f.options.EvidenceRoot}
	var out, errOut bytes.Buffer
	if code := Main(args, bytes.NewReader(jsonBytes(f.spec)), &out, &errOut); code != 0 || !strings.Contains(out.String(), `"execute": false`) {
		t.Fatalf("dry run %d: %s", code, errOut.String())
	}
	if _, err := os.Stat(f.options.EvidenceRoot); !os.IsNotExist(err) {
		t.Fatal("dry run wrote evidence")
	}
	for _, extra := range [][]string{{"--unknown"}, {"unexpected"}, {"--mode", "matrix"}} {
		if code := Main(append(append([]string{}, args...), extra...), bytes.NewReader(jsonBytes(f.spec)), io.Discard, io.Discard); code != 2 {
			t.Fatalf("unknown input accepted: %v", extra)
		}
	}
	if code := Main([]string{"--execute"}, strings.NewReader("{}"), io.Discard, io.Discard); code != 2 {
		t.Fatal("execute without explicit profile accepted")
	}
	bad := append([]byte(nil), jsonBytes(f.spec)...)
	bad = append(bad[:len(bad)-1], []byte(`,"command":"echo green"}`)...)
	if code := Main(args, bytes.NewReader(bad), io.Discard, io.Discard); code != 2 {
		t.Fatal("unknown spec field accepted")
	}
	for _, bad := range []string{`{} {}`, `null`, `{"unknown":true}`, strings.Repeat(" ", LogLimit+1)} {
		var spec JobSpec
		if Decode(strings.NewReader(bad), &spec) == nil && spec.Validate() == nil {
			t.Fatalf("unknown JSON accepted: %.30s", bad)
		}
	}
}

func TestSymlinkInputsAndReplayDoNotExecute(t *testing.T) {
	f := newFixture(t)
	link := filepath.Join(filepath.Dir(f.options.BundlePath), "bundle-link")
	if err := os.Symlink(f.options.BundlePath, link); err != nil {
		t.Fatal(err)
	}
	f.options.BundlePath = link
	f.replan()
	r := f.execute()
	if r.Status != "FAIL" || len(f.calls) != 0 {
		t.Fatal("symlink input executed")
	}
}

func TestSummaryParserDrainsLongLogsAndRejectsDuplicateOrMalformedSummaries(t *testing.T) {
	summary := &Summary{Version: 1, Success: true, Counts: Counts{Tests: 1, Passed: 1}, Files: []FileCounts{{File: "own.test", Counts: Counts{Tests: 1, Passed: 1}}}}
	marker := "RESULT=" + string(jsonBytes(summary)) + "\n"
	for _, c := range []struct {
		name, text string
		count      int
		valid      bool
	}{
		{"after bounded log", strings.Repeat("bounded line\n", LogLimit/8) + marker, 1, true},
		{"duplicate", marker + marker, 2, true},
		{"malformed", "RESULT={broken}\n", 1, false},
		{"unbounded line", strings.Repeat("x", LogLimit+1) + "\n" + marker, 0, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			var log bytes.Buffer
			s := &summaryStream{out: &log, prefix: []byte("RESULT=")}
			for _, part := range []string{c.text[:len(c.text)/2], c.text[len(c.text)/2:]} {
				if _, err := s.Write([]byte(part)); err != nil {
					t.Fatal(err)
				}
			}
			s.finish()
			if log.Len() > LogLimit || s.count != c.count || (s.summary != nil) != c.valid {
				t.Fatalf("parser: %+v", s)
			}
		})
	}
}

func TestProcessTransportUsesArgvClearsEnvironmentAndPreservesResults(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("EXECUTOR_TEST_SECRET", "must-not-cross-boundary")
	for _, c := range []struct {
		mode         string
		want, signal int
	}{{"exit23", 23, 0}, {"signal", 143, 15}, {"argv", 0, 0}, {"logs", 0, 0}} {
		t.Run(c.mode, func(t *testing.T) {
			literal := "literal;$(touch never) 'quoted'"
			r := (ProcessTransport{}).Run(context.Background(), Command{Argv: []string{binary, "-test.run=^TestProcessHelper$", "--", c.mode, literal}, Timeout: 10 * time.Second})
			if r.ExitCode != c.want || r.Signal != c.signal || r.StartFailed || r.TimedOut {
				t.Fatalf("transport result: %+v", r)
			}
			if c.mode == "argv" && string(r.Stdout) != literal {
				t.Fatalf("argument boundary changed: %s", r.Stdout)
			}
			if c.mode == "logs" && (!r.Truncated || len(r.Stdout) != LogLimit || len(r.Stderr) != LogLimit) {
				t.Fatal("transport failed to bound and drain both streams")
			}
		})
	}
	r := (ProcessTransport{}).Run(context.Background(), Command{Argv: []string{binary, "-test.run=^TestProcessHelper$", "--", "wait"}, Timeout: 2 * time.Second})
	if !r.TimedOut || r.ExitCode != 137 || !strings.Contains(string(r.Stdout), "ready") {
		t.Fatalf("timeout not preserved after child started: %+v", r)
	}
}

func TestProcessHelper(t *testing.T) {
	index := -1
	for i, arg := range os.Args {
		if arg == "--" {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	if os.Getenv("EXECUTOR_TEST_SECRET") != "" {
		os.Exit(4)
	}
	switch os.Args[index+1] {
	case "exit23":
		os.Exit(23)
	case "signal":
		_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
		for {
			_ = syscall.Pause()
		}
	case "argv":
		fmt.Print(os.Args[index+2])
		os.Exit(0)
	case "logs":
		_, _ = os.Stdout.Write(bytes.Repeat([]byte("x"), 2*LogLimit))
		_, _ = os.Stderr.Write(bytes.Repeat([]byte("e"), 2*LogLimit))
		os.Exit(0)
	case "wait":
		fmt.Print("ready")
		for {
			_ = syscall.Pause()
		}
	default:
		os.Exit(3)
	}
}

func TestGuestHelpersRefuseHostExecution(t *testing.T) {
	if code := Main([]string{"__guest", "touch-memory"}, nil, io.Discard, io.Discard); code != 2 {
		t.Fatal("destructive guest probe admitted on host")
	}
}

func TestGuestEnvironmentHasOnlyReviewedFields(t *testing.T) {
	f := newFixture(t)
	t.Setenv("EXECUTOR_TEST_SECRET", "not-for-gate")
	env := guestEnvironment(guestPayload{Spec: f.spec, Gate: f.plan.gate, GitName: f.profile.GitName, GitEmail: f.profile.GitEmail})
	if !contains(env, "KRN_LIVE=") || !contains(env, "KRN_REQUIRE_ZERO_ISOLATION_SKIPS=1") {
		t.Fatal("gate skip/live policy missing")
	}
	for _, entry := range env {
		if strings.Contains(entry, "EXECUTOR_TEST_SECRET") {
			t.Fatal("inherited secret in guest")
		}
	}
	if reflect.DeepEqual(env, os.Environ()) {
		t.Fatal("inherited full environment")
	}
}

func TestRealGitBundleReceiverChecksFullHistoryAndDetachedExactSHA(t *testing.T) {
	f := newFixture(t)
	directory := filepath.Dir(f.options.BundlePath)
	upstream := filepath.Join(directory, "upstream")
	if err := os.Mkdir(upstream, 0700); err != nil {
		t.Fatal(err)
	}
	data := guestPayload{Spec: f.spec, Gate: f.plan.gate, GitName: f.profile.GitName, GitEmail: f.profile.GitEmail}
	gitRun := func(args ...string) string {
		t.Helper()
		v, err := gitAt(data, upstream, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return v
	}
	gitRun("init", "--initial-branch=main")
	for _, body := range []string{"first", "second"} {
		if err := os.WriteFile(filepath.Join(upstream, "source.txt"), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		gitRun("add", "source.txt")
		gitRun("commit", "-m", body)
	}
	data.Spec.SourceSHA = gitRun("rev-parse", "HEAD")
	if err := os.Remove(f.options.BundlePath); err != nil {
		t.Fatal(err)
	}
	gitRun("bundle", "create", f.options.BundlePath, "--all")
	checkout := filepath.Join(directory, "checkout")
	value, err := checkoutSource(data, checkout, f.options.BundlePath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(value, map[string]any{"actual_checkout": data.Spec.SourceSHA, "shallow": false}) {
		t.Fatalf("checkout: %+v", value)
	}
	if count, err := gitAt(data, checkout, "rev-list", "--count", "HEAD"); err != nil || count != "2" {
		t.Fatalf("history not imported: %q %v", count, err)
	}
	if _, err := gitAt(data, checkout, "symbolic-ref", "HEAD"); err == nil {
		t.Fatal("checkout is not detached")
	}
	partial := filepath.Join(directory, "partial.bundle")
	gitRun("bundle", "create", partial, "HEAD", "^HEAD~1")
	if _, err := checkoutSource(data, filepath.Join(directory, "incomplete"), partial); err == nil {
		t.Fatal("bundle with missing prerequisites admitted")
	}
	data.Spec.Tier = GlobalFast
	data.Spec.BaseSHA = gitRun("rev-parse", "HEAD~1")
	if _, err := checkoutSource(data, filepath.Join(directory, "global-base"), f.options.BundlePath); err != nil {
		t.Fatal(err)
	}
	data.Spec.BaseSHA = strings.Repeat("e", 40)
	if _, err := checkoutSource(data, filepath.Join(directory, "missing-base"), f.options.BundlePath); err == nil {
		t.Fatal("missing GLOBAL base admitted")
	}
	data.Spec.Tier = Product
	data.Spec.SourceSHA = strings.Repeat("d", 40)
	if _, err := checkoutSource(data, filepath.Join(directory, "wrong-sha"), f.options.BundlePath); err == nil {
		t.Fatal("unavailable SHA admitted by real Git receiver")
	}
}

func TestIncompleteLimitEnforcementEvidenceCannotQualify(t *testing.T) {
	for _, field := range []string{"memory touched", "memory OOM", "memory limit", "memory swap", "pids event", "pids denied", "bwrap"} {
		t.Run(field, func(t *testing.T) {
			f := newFixture(t)
			var probe sessionProbe
			if err := json.Unmarshal(f.results["session"].Stdout, &probe); err != nil {
				t.Fatal(err)
			}
			switch field {
			case "memory touched":
				probe.Memory.Touched = 0
			case "memory OOM":
				probe.Memory.OOMKills = 0
			case "memory limit":
				probe.Memory.Limit = "max"
			case "memory swap":
				probe.Memory.Swap = "max"
			case "pids event":
				probe.Pids.Events = 0
			case "pids denied":
				probe.Pids.Denied = false
			case "bwrap":
				probe.BwrapArgv = []string{"true"}
			}
			f.results["session"] = ProcessResult{Stdout: jsonBytes(probe)}
			r := f.execute()
			if r.Status != "FAIL" || r.FailureOrigin != "probe" || f.called("gate") || !f.called("cleanup") {
				t.Fatalf("unqualified probe admitted: %+v", r)
			}
		})
	}
}

func TestEvidenceWriteFailureStillAttemptsDeletionAndBlocksPass(t *testing.T) {
	for _, collision := range []string{"gate.stdout", "cleanup-owner.stdout", "receipt.json"} {
		t.Run(collision, func(t *testing.T) {
			f := newFixture(t)
			f.hook = func(_ context.Context, c Command) {
				trigger := "gate"
				if collision == "cleanup-owner.stdout" {
					trigger = "cleanup-owner"
				}
				if collision == "receipt.json" {
					trigger = "cleanup"
				}
				if c.Name == trigger {
					path := filepath.Join(f.options.EvidenceRoot, f.spec.AttemptID, collision)
					if err := os.WriteFile(path, []byte("existing evidence"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			r := f.execute()
			if r.Status != "FAIL" || r.ExitStatus() == 0 || !f.called("cleanup") {
				t.Fatalf("evidence error bypassed cleanup/result: %+v", r)
			}
		})
	}
}

func TestMissingNullAndDuplicateSummaryFieldsAreRejected(t *testing.T) {
	f := newFixture(t)
	raw := string(jsonBytes(f.remote.Summary))
	for _, value := range []string{
		strings.Replace(raw, `"failed":0,`, "", 1),
		strings.Replace(raw, `"skipped":0`, `"skipped":null`, 1),
		strings.Replace(raw, `"version":1`, `"version":1,"version":1`, 1),
		strings.Replace(raw, `"success":true`, `"success":true,"extra":true`, 1),
		`null`,
	} {
		var summary Summary
		if Decode(strings.NewReader(value), &summary) == nil && summary.Validate() == nil {
			t.Fatalf("incomplete summary accepted: %s", value)
		}
	}
}
