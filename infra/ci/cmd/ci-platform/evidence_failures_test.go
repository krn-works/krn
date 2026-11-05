package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEvidenceSummaryNamesFailingTAPLinesBeyondTheTail(t *testing.T) {
	root, output := evidenceFixture(t)
	stdout := "not ok 6 - " + strings.Repeat("long ", 1200) + "\n# Subtest: early\nnot ok 7 - early receiver fails\n  ---\n  error: 'boom'\n  ...\n" + strings.Repeat("ok 8 - filler\n", 1024) + "# fail 1\n"
	if err := os.WriteFile(filepath.Join(root, evidenceAttempt, "gate.stdout"), []byte(stdout), 0600); err != nil {
		t.Fatal(err)
	}
	if code, stderr := exportEvidence(root, evidenceAttempt, output); code != 0 {
		t.Fatalf("exit=%d stderr=%s", code, stderr)
	}
	data, err := os.ReadFile(filepath.Join(output, "summary.txt"))
	if err != nil {
		t.Fatal(err)
	}
	head := string(data)
	if len(head) > 12000 {
		head = head[:12000]
	}
	if !strings.Contains(head, "not ok 7 - early receiver fails") {
		t.Fatalf("summary does not name the failing test:\n%s", head)
	}
}
