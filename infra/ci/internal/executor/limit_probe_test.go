package executor

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestLimitProbeArgvPinsOneProcessor(t *testing.T) {
	for _, kind := range []string{"memory", "pids"} {
		argv := limitProbeArgv(kind, guestPayload{})
		separator := slices.Index(argv, "--")
		if separator < 0 || !slices.Contains(argv[:separator], "--setenv=GOMAXPROCS=1") {
			t.Fatalf("%s probe must pin GOMAXPROCS=1 before the command: %q", kind, argv)
		}
		if !slices.Contains(argv[:separator], "TasksMax=16") || argv[separator+4] != "limit-"+kind {
			t.Fatalf("%s probe lost its limit or mode: %q", kind, argv)
		}
		if kind == "memory" != slices.Contains(argv, "OOMPolicy=continue") {
			t.Fatalf("OOMPolicy belongs only to the memory probe: %q", argv)
		}
	}
}

func TestGuestFailureLineKeepsOnlyRuntimeLines(t *testing.T) {
	stderr := "secret=abc\nruntime: failed to create new OS thread (have 9 already; errno=11)\nruntime: may need to increase max user processes (ulimit -u)\nfatal error: newosproc\n"
	if got := guestFailureLine([]byte(stderr)); got != "runtime: failed to create new OS thread (have 9 already; errno=11)" {
		t.Fatalf("got %q", got)
	}
	if got := guestFailureLine([]byte("guest operation failed: limit-pids pids probe spawn failed\n")); got != "guest operation failed: limit-pids pids probe spawn failed" {
		t.Fatalf("got %q", got)
	}
	for _, other := range []string{"", "token=abc\n", "  runtime: indented\n"} {
		if got := guestFailureLine([]byte(other)); got != "" {
			t.Fatalf("command output leaked: %q", got)
		}
	}
	if got := guestFailureLine([]byte("fatal error: " + strings.Repeat("x", 500))); len(got) != 200 {
		t.Fatalf("failure line not bounded: %d bytes", len(got))
	}
}

func TestLimitProbeRetriesOnceThenFailsClosed(t *testing.T) {
	calls := 0
	out, err := retryLimitProbe(func() (string, error) {
		calls++
		if calls == 1 {
			return "", errors.New("first")
		}
		return "ok", nil
	})
	if err != nil || out != "ok" || calls != 2 {
		t.Fatalf("transient failure: out=%q err=%v calls=%d", out, err, calls)
	}
	calls = 0
	_, err = retryLimitProbe(func() (string, error) {
		calls++
		return "", errors.New("again")
	})
	if err == nil || calls != 2 || !strings.Contains(err.Error(), "again") {
		t.Fatalf("must fail closed after two attempts: err=%v calls=%d", err, calls)
	}
}
