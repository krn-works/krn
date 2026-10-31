package globalgate

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestWorkflowMatchesCapturedReceiver(t *testing.T) {
	capture, err := os.ReadFile("testdata/validate.yml")
	if err != nil {
		t.Fatal(err)
	}
	for _, tier := range []string{"fast", "deep"} {
		t.Run(tier, func(t *testing.T) {
			var calls [][]string
			base, source := strings.Repeat("a", 40), strings.Repeat("b", 40)
			run := func(argv ...string) (string, error) {
				calls = append(calls, argv)
				if argv[1] == "rev-parse" {
					return source, nil
				}
				if argv[1] == "merge-base" {
					return base, nil
				}
				return "", nil
			}
			dir := t.TempDir()
			if err := workflow(tier, base, source, dir, run); err != nil {
				t.Fatal(err)
			}
			var actual []string
			for _, argv := range calls {
				if argv[0] == "npm" {
					actual = append(actual, "run: npm run "+argv[2])
				}
			}
			var expected []string
			current := ""
			for _, line := range strings.Split(string(capture), "\n") {
				if strings.Contains(line, "if: matrix.tier ==") {
					current = strings.TrimSpace(strings.Split(line, "==")[1])
				}
				if strings.Contains(line, "run: npm run") && current == "'"+tier+"'" {
					expected = append(expected, strings.TrimSpace(line))
				}
			}
			if !reflect.DeepEqual(actual, expected) {
				t.Fatalf("workflow drift actual %v expected %v", actual, expected)
			}
			if tier == "fast" {
				if !reflect.DeepEqual(calls[6], []string{"node", "scripts/krn.mjs", "changes", "check", "--root", ".", "--base", base, "--head", "HEAD", "--before"}) {
					t.Fatal(calls)
				}
			} else {
				frozen := false
				for _, argv := range calls {
					if argv[0] == "node" && strings.HasSuffix(argv[1], "scripts/krn.mjs") {
						frozen = strings.Join(argv[2:], " ") == "conformance check --root "+strings.TrimSuffix(argv[1], "/scripts/krn.mjs")+" --candidate "+dir+" --frozen"
					}
				}
				if !frozen {
					t.Fatal("base frozen observer missing")
				}
				found := false
				for _, argv := range calls {
					if reflect.DeepEqual(argv, []string{"git", "diff", "--check", base + "...HEAD"}) {
						found = true
					}
				}
				if !found {
					t.Fatal("event base hygiene missing")
				}
			}
		})
	}
}
func TestEveryStageFailureStopsWorkflow(t *testing.T) {
	for _, tier := range []string{"fast", "deep"} {
		var count int
		ok := func(argv ...string) (string, error) {
			count++
			if argv[1] == "rev-parse" {
				return strings.Repeat("b", 40), nil
			}
			if argv[1] == "merge-base" {
				return strings.Repeat("a", 40), nil
			}
			if argv[1] == "cat-file" && strings.Contains(argv[3], ":") {
				return "", errors.New("old base")
			}
			return "", nil
		}
		if err := workflow(tier, strings.Repeat("a", 40), strings.Repeat("b", 40), t.TempDir(), ok); err != nil {
			t.Fatal(err)
		}
		stages := count
		for fail := 1; fail <= stages; fail++ {
			count = 0
			sentinel := errors.New("stage failed")
			run := func(argv ...string) (string, error) {
				if count+1 == fail {
					count++
					return "", sentinel
				}
				return ok(argv...)
			}
			err := workflow(tier, strings.Repeat("a", 40), strings.Repeat("b", 40), t.TempDir(), run)
			// cat-file for optional frozen config deliberately falls back, as workflow does.
			if err == nil && count != stages {
				t.Fatalf("incomplete success %s %d/%d", tier, count, stages)
			}
		}
	}
}
func TestNativeSubprocessExit(t *testing.T) {
	run := subprocess(nil, io.Discard, io.Discard)
	_, err := run("/bin/sh", "-c", "exit 23")
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 23 {
		t.Fatalf("exit lost: %v", err)
	}
	_, err = run("/bin/sh", "-c", "kill -TERM $$")
	if !errors.As(err, &exit) || !exit.Sys().(syscall.WaitStatus).Signaled() || exit.Sys().(syscall.WaitStatus).Signal() != syscall.SIGTERM {
		t.Fatalf("signal lost: %v", err)
	}
}
func TestMainRefusesHost(t *testing.T) {
	if Main([]string{"fast"}, nil, io.Discard, io.Discard) != 2 {
		t.Fatal("host execution allowed")
	}
}
