package executor

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductOfflinePreparationUsesActualSubprocesses(t *testing.T) {
	for _, mode := range []string{"success", "exit", "signal", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			body := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> calls\n"
			switch mode {
			case "exit":
				body += "exit 23\n"
			case "signal":
				body += "kill -TERM $$\n"
			}
			if err := os.WriteFile(filepath.Join(dir, "pnpm"), []byte(body), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir)
			f := newFixture(t)
			f.plan.gate.Argv = []string{"/bin/sh", "-c", "printf 'gate\\n' >> calls"}
			data := guestPayload{Spec: f.spec, Gate: f.plan.gate, GitName: "CI", GitEmail: "ci@example.invalid"}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancel" {
				cancel()
			}
			r := runGateCommands(ctx, data, dir, io.Discard, io.Discard)
			calls, _ := os.ReadFile(filepath.Join(dir, "calls"))
			switch mode {
			case "success":
				if !r.ok() || string(calls) != "install --offline --frozen-lockfile\ngate\n" {
					t.Fatalf("%+v %q", r, calls)
				}
			case "exit":
				if r.ExitCode != 23 || strings.Contains(string(calls), "gate") {
					t.Fatalf("%+v %q", r, calls)
				}
			case "signal":
				if r.Signal != 15 || strings.Contains(string(calls), "gate") {
					t.Fatalf("%+v %q", r, calls)
				}
			case "cancel":
				if !r.TimedOut || len(calls) != 0 {
					t.Fatalf("%+v %q", r, calls)
				}
			}
		})
	}
}

func TestGlobalRequiresBoundBaseAndFixedNativeWrapper(t *testing.T) {
	f := newFixture(t)
	f.spec.Tier = GlobalFast
	f.profile.Gates = []Gate{{Tier: GlobalFast, Argv: []string{guestBinary, "global", "fast"}, SummaryMode: "native-exit"}}
	if _, err := Plan(f.profile, f.spec, f.options); err == nil {
		t.Fatal("missing base accepted")
	}
	f.spec.BaseSHA = strings.Repeat("d", 40)
	f.replan()
	f.remote.Expected = f.spec
	f.remote.CommandID = commandID(f.plan.gate)
	f.remote.Summary = nil
	f.remote.SummaryCount = 0
	f.remote.EvidenceKind = "native-exit"
	f.saveRemote()
	r := f.execute()
	if r.Status != "PASS" || r.Summary != nil || r.EvidenceKind != "native-exit" {
		t.Fatalf("%+v", r)
	}
	if err := ValidateResult(f.profile, f.spec, r); err != nil {
		t.Fatal(err)
	}
	r.Expected.BaseSHA = strings.Repeat("e", 40)
	if err := ValidateResult(f.profile, f.spec, r); err == nil {
		t.Fatal("unbound base accepted")
	}
	f.profile.Gates[0].Argv = []string{"npm", "run", "gate:fast"}
	if f.profile.Validate() == nil {
		t.Fatal("local gate accepted instead of workflow wrapper")
	}
}
func TestNativeEvidenceCannotReplaceProductSummary(t *testing.T) {
	f := newFixture(t)
	f.remote.Summary = nil
	f.remote.SummaryCount = 0
	f.remote.EvidenceKind = "native-exit"
	f.saveRemote()
	if r := f.execute(); r.Status == "PASS" {
		t.Fatal("Product accepted native evidence")
	}
	f.profile.Gates[0].SummaryMode = "native-exit"
	if f.profile.Validate() == nil {
		t.Fatal("Product native mode allowed")
	}
}
func TestNativeEvidenceRequiresCompletedZeroExit(t *testing.T) {
	for _, mode := range []string{"missing", "summary", "failed"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			f.spec.Tier = GlobalFast
			f.spec.BaseSHA = strings.Repeat("d", 40)
			f.profile.Gates = []Gate{{Tier: GlobalFast, Argv: []string{guestBinary, "global", "fast"}, SummaryMode: "native-exit"}}
			f.replan()
			f.remote.Expected = f.spec
			f.remote.CommandID = commandID(f.plan.gate)
			f.remote.EvidenceKind = "native-exit"
			if mode != "summary" {
				f.remote.Summary = nil
				f.remote.SummaryCount = 0
			}
			if mode == "missing" {
				f.remote.EvidenceKind = ""
			}
			if mode == "failed" {
				code := 23
				f.remote.Outcome.ExitCode = &code
				f.results["gate"] = ProcessResult{ExitCode: 23}
			}
			f.saveRemote()
			if r := f.execute(); r.Status == "PASS" {
				t.Fatal("incomplete evidence accepted")
			}
		})
	}
}
