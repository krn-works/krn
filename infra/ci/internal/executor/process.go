//go:build linux

package executor

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// ProcessTransport never invokes a shell or inherits controller credentials.
// The remote cancellation fence remains container deletion in Execute's defer.
type ProcessTransport struct{}

type limitedBuffer struct {
	mu        sync.Mutex
	bytes     []byte
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	room := LogLimit - len(b.bytes)
	if len(p) > room {
		p = p[:room]
		b.truncated = true
	}
	b.bytes = append(b.bytes, p...)
	return n, nil
}

func hostEnvironment() []string {
	return []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/nonexistent", "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
}

func (ProcessTransport) Run(ctx context.Context, command Command) ProcessResult {
	return runProcess(ctx, command, hostEnvironment(), "", nil)
}

func runProcess(ctx context.Context, command Command, env []string, directory string, merged io.Writer) ProcessResult {
	if len(command.Argv) == 0 || command.Timeout <= 0 {
		return ProcessResult{ExitCode: -1, StartFailed: true}
	}
	ctx, cancel := context.WithTimeout(ctx, command.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command.Argv[0], command.Argv[1:]...)
	cmd.Env = env
	cmd.Dir = directory
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	stdout, stderr := &limitedBuffer{}, &limitedBuffer{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if merged != nil {
		cmd.Stdout, cmd.Stderr = merged, merged
	}
	err := cmd.Run()
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	r := ProcessResult{ExitCode: 0, Stdout: stdout.bytes, Stderr: stderr.bytes, Truncated: stdout.truncated || stderr.truncated, TimedOut: ctx.Err() != nil}
	if err != nil {
		r.ExitCode = -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			status := exit.Sys().(syscall.WaitStatus)
			if status.Signaled() {
				r.Signal = int(status.Signal())
				r.ExitCode = 128 + r.Signal
			} else {
				r.ExitCode = exit.ExitCode()
			}
		} else {
			r.StartFailed = true
		}
	}
	return r
}
