package executor

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSystemdReadinessRetriesTransientBootFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	calls := 0
	err := waitSystemd(ctx, func(context.Context) bool { calls++; return calls == 2 })
	if err != nil || calls != 2 {
		t.Fatalf("boot readiness did not recover: calls=%d error=%v", calls, err)
	}
}

func TestSystemdReadinessStopsAtDeadlineAndCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := waitSystemd(ctx, func(context.Context) bool { return false }); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unready service did not respect deadline: %v", err)
	}
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	calls := 0
	err := waitSystemd(cancelled, func(context.Context) bool { calls++; return true })
	if !errors.Is(err, context.Canceled) || calls != 0 {
		t.Fatalf("cancelled readiness ran a probe: calls=%d error=%v", calls, err)
	}
}
