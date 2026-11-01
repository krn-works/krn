package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

const evidenceAttempt = "11111111-1111-4111-8111-111111111111"

func evidenceFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, evidenceAttempt)
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"receipt.json": `{"status":"FAIL"}`, "gate.stdout": "failed test: receiver\n", "gate.stderr": "diagnostic\n", "gate.process.json": `{"exit_code":23}`} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return root, filepath.Join(t.TempDir(), "export")
}

func exportEvidence(root, attempt, output string) (int, string) {
	var out, errOut bytes.Buffer
	code := run([]string{"evidence", "export", "--root", root, "--attempt-id", attempt, "--output", output}, strings.NewReader(""), &out, &errOut)
	return code, errOut.String()
}

func TestEvidenceCLIExportsFailedGateAndUsefulBoundedSummary(t *testing.T) {
	root, output := evidenceFixture(t)
	if code, stderr := exportEvidence(root, evidenceAttempt, output); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr)
	}
	for _, name := range []string{"receipt.json", "gate.stdout", "gate.stderr", "gate.process.json", "export.json", "summary.txt"} {
		data, err := os.ReadFile(filepath.Join(output, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if name == "summary.txt" && !bytes.Contains(data, []byte("failed test: receiver")) {
			t.Fatal("missing failure diagnosis")
		}
	}
	if code, _ := exportEvidence(root, evidenceAttempt, output); code == 0 {
		t.Fatal("replayed export accepted")
	}
}

func TestEvidenceCLIRejectsUnsafeSelectedFilesButExportsRemainingDiagnosis(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "fifo", "directory", "oversize", "missing", "parent-symlink"} {
		t.Run(kind, func(t *testing.T) {
			root, output := evidenceFixture(t)
			path := filepath.Join(root, evidenceAttempt, "gate.stderr")
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "symlink", "hardlink":
				secret := filepath.Join(t.TempDir(), "private")
				if err := os.WriteFile(secret, []byte("DO-NOT-EXPORT"), 0600); err != nil {
					t.Fatal(err)
				}
				var err error
				if kind == "symlink" {
					err = os.Symlink(secret, path)
				} else {
					err = os.Link(secret, path)
				}
				if err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "oversize":
				if err := os.WriteFile(path, bytes.Repeat([]byte("a"), 262145), 0600); err != nil {
					t.Fatal(err)
				}
			case "parent-symlink":
				alias := filepath.Join(t.TempDir(), "alias")
				if err := os.Symlink(root, alias); err != nil {
					t.Fatal(err)
				}
				root = alias
			}
			if code, _ := exportEvidence(root, evidenceAttempt, output); code == 0 {
				t.Fatal("unsafe/incomplete export succeeded")
			}
			data, err := os.ReadFile(filepath.Join(output, "export.json"))
			if err != nil || !json.Valid(data) {
				t.Fatalf("missing explicit unavailability manifest: %v", err)
			}
			if bytes.Contains(data, []byte("DO-NOT-EXPORT")) {
				t.Fatal("secret exported")
			}
			if _, err := os.Stat(filepath.Join(output, "gate.stderr")); !os.IsNotExist(err) {
				t.Fatal("unsafe selected file copied")
			}
			if kind != "parent-symlink" {
				if _, err := os.Stat(filepath.Join(output, "gate.stdout")); err != nil {
					t.Fatal("lost available diagnostic")
				}
			}
		})
	}
}

func TestEvidenceCLINeverWalksUnselectedFilesOrAllowsTraversal(t *testing.T) {
	root, output := evidenceFixture(t)
	if err := os.WriteFile(filepath.Join(root, evidenceAttempt, "payload.tar.gz"), []byte("unselected"), 0600); err != nil {
		t.Fatal(err)
	}
	if code, _ := exportEvidence(root, evidenceAttempt, output); code != 0 {
		t.Fatal("valid export failed")
	}
	if _, err := os.Stat(filepath.Join(output, "payload.tar.gz")); !os.IsNotExist(err) {
		t.Fatal("unselected archive exported")
	}
	if code, _ := exportEvidence(root, "../"+evidenceAttempt, filepath.Join(t.TempDir(), "out")); code == 0 {
		t.Fatal("attempt traversal accepted")
	}
}

func TestEvidenceCLIBoundsLogAndSummaryAndRejectsOutputSymlink(t *testing.T) {
	root, output := evidenceFixture(t)
	log := bytes.Repeat([]byte("a"), 262144)
	copy(log[len(log)-16:], []byte("failure-tail-end"))
	for _, name := range []string{"gate.stdout", "gate.stderr"} {
		if err := os.WriteFile(filepath.Join(root, evidenceAttempt, name), log, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if code, _ := exportEvidence(root, evidenceAttempt, output); code != 0 {
		t.Fatal("bounded log export failed")
	}
	summary, err := os.ReadFile(filepath.Join(output, "summary.txt"))
	if err != nil || len(summary) > 9000 || !bytes.Contains(summary, []byte("failure-tail-end")) {
		t.Fatalf("invalid bounded tail summary: %v size=%d", err, len(summary))
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(t.TempDir(), alias); err != nil {
		t.Fatal(err)
	}
	if code, _ := exportEvidence(root, evidenceAttempt, filepath.Join(alias, "out")); code == 0 {
		t.Fatal("output parent symlink accepted")
	}
}

func TestProductAdmissionUsesStrictTrustedNativePolicy(t *testing.T) {
	for _, fixture := range []struct {
		data string
		pass bool
	}{
		{`{"schemaVersion":1,"checkRunName":"krn/gate","appId":5548482}`, true},
		{`{"SchemaVersion":1,"checkRunName":"krn/gate","appId":5548482}`, false},
		{`{"schemaVersion":1,"CheckRunName":"krn/gate","appId":5548482}`, false},
		{`{"schemaVersion":1,"checkRunName":"krn/gate","AppID":5548482}`, false},
		{`{"schemaVersion":1,"SchemaVersion":1,"checkRunName":"krn/gate","appId":5548482}`, false},
		{`{"schemaVersion":1.0,"checkRunName":"krn/gate","appId":5548482e0}`, true},
		{`{"schemaVersion":true,"checkRunName":"krn/gate","appId":5548482}`, false},
		{`{"schemaVersion":1,"checkRunName":{},"appId":5548482}`, false},
		{`{"schemaVersion":1,"checkRunName":"krn/gate","appId":[5548482]}`, false},
		{`{}`, false},
		{`{"schemaVersion":1,"checkRunName":"krn/gate","appId":1}`, false},
		{`{"schemaVersion":1,"checkRunName":"gate","appId":5548482}`, false},
		{`{"schemaVersion":1,"checkRunName":"krn/gate","appId":5548482,"command":"echo pass"}`, false},
		{`{"schemaVersion":1,"schemaVersion":1,"checkRunName":"krn/gate","appId":5548482}`, false},
		{`{"schemaVersion":1,"checkRunName":"krn/gate","appId":"5548482"}`, false},
		{`{"schemaVersion":1,"checkRunName":"krn/gate","appId":5548482}` + strings.Repeat(" ", 4096), false},
	} {
		var out, stderr bytes.Buffer
		code := run([]string{"admission", "product-base"}, strings.NewReader(fixture.data), &out, &stderr)
		if (code == 0) != fixture.pass {
			t.Fatalf("policy=%s exit=%d stderr=%s", fixture.data, code, stderr.String())
		}
		if !fixture.pass && !strings.Contains(stderr.String(), "update branch from main or reconcile") {
			t.Fatal("missing actionable refusal")
		}
	}
}
