package reset

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// CommandError retains bounded command results for the local caller. Error()
// intentionally does not put them in a remote receipt: config can contain
// cloud-init secrets. No credentials or arbitrary job command are arguments.
type CommandError struct {
	ExitCode       int
	TimedOut       bool
	Stdout, Stderr []byte
}

func (e *CommandError) Error() string { return "BACKEND_COMMAND_FAILED" }

type CommandRunner interface {
	Run(context.Context, []string) ([]byte, error)
}
type ExecRunner struct{}
type limitedBuffer struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.limit - b.Len()
	if remaining < n {
		b.exceeded = true
		if remaining > 0 {
			_, _ = b.Buffer.Write(p[:remaining])
		}
	} else {
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}
func (ExecRunner) Run(ctx context.Context, argv []string) ([]byte, error) {
	if len(argv) == 0 {
		return nil, failure("EMPTY_COMMAND")
	}
	command := exec.CommandContext(ctx, argv[0], argv[1:]...)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.WaitDelay = 2 * time.Second
	command.Cancel = func() error {
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	command.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	stdout, stderr := &limitedBuffer{limit: 4 << 20}, &limitedBuffer{limit: 64 << 10}
	command.Stdout, command.Stderr, command.Stdin = stdout, stderr, nil
	err := command.Run()
	if err != nil || stdout.exceeded || stderr.exceeded {
		code := -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
		return nil, &CommandError{ExitCode: code, TimedOut: ctx.Err() != nil, Stdout: append([]byte(nil), stdout.Bytes()...), Stderr: append([]byte(nil), stderr.Bytes()...)}
	}
	return stdout.Bytes(), nil
}

type PVEBackend struct {
	Manifest      Manifest
	Runner        CommandRunner
	VerifyNetwork func([]byte, string, string) error
}

func (p PVEBackend) run(ctx context.Context, argv ...string) ([]byte, error) {
	if p.Runner == nil {
		return nil, failure("COMMAND_RUNNER_MISSING")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(p.Manifest.OperationTimeoutSeconds)*time.Second)
	defer cancel()
	return p.Runner.Run(ctx, argv)
}
func (p PVEBackend) CheckHost(context.Context) error {
	host, err := os.Hostname()
	if err != nil || host != p.Manifest.ExpectedPVEHostname {
		return failure("HOST_IDENTITY_MISMATCH")
	}
	return nil
}
func (p PVEBackend) Configuration(ctx context.Context, snapshot bool) (map[string]string, error) {
	argv := []string{"/usr/sbin/qm", "config", strconv.Itoa(p.Manifest.VMID)}
	if snapshot {
		argv = append(argv, "--snapshot", p.Manifest.Snapshot)
	}
	data, err := p.run(ctx, argv...)
	if err != nil {
		return nil, err
	}
	return ParseConfig(string(data))
}
func (p PVEBackend) CheckHA(ctx context.Context) error {
	data, err := p.run(ctx, "/usr/sbin/ha-manager", "status")
	if err != nil {
		return err
	}
	if regexp.MustCompile(`\bservice\s+vm:` + strconv.Itoa(p.Manifest.VMID) + `\b`).Match(data) {
		return failure("HA_MANAGED_FORBIDDEN")
	}
	return nil
}
func (p PVEBackend) CheckPolicy(ctx context.Context) error {
	if p.VerifyNetwork == nil {
		return failure("POLICY_VERIFIER_MISSING")
	}
	data, err := p.run(ctx, "/usr/sbin/nft", "--json", "list", "ruleset")
	if err != nil {
		return err
	}
	if err = p.VerifyNetwork(data, p.Manifest.NFT.TablePrefix, p.Manifest.NFT.SHA256); err != nil {
		return failure("NETWORK_POLICY_MISMATCH")
	}
	return nil
}
func (p PVEBackend) Rollback(ctx context.Context) error {
	_, err := p.run(ctx, "/usr/sbin/qm", "rollback", strconv.Itoa(p.Manifest.VMID), p.Manifest.Snapshot)
	return err
}
func (p PVEBackend) Stopped(ctx context.Context) (bool, error) {
	data, err := p.run(ctx, "/usr/sbin/qm", "status", strconv.Itoa(p.Manifest.VMID))
	return strings.TrimSpace(string(data)) == "status: stopped", err
}
func (p PVEBackend) Start(ctx context.Context) error {
	_, err := p.run(ctx, "/usr/sbin/qm", "start", strconv.Itoa(p.Manifest.VMID))
	return err
}
func (p PVEBackend) Stop(ctx context.Context) error {
	_, err := p.run(ctx, "/usr/sbin/qm", "stop", strconv.Itoa(p.Manifest.VMID))
	return err
}
func (p PVEBackend) BootID(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(p.Manifest.BootTimeoutSeconds)*time.Second)
	defer cancel()
	for {
		commandCtx, commandCancel := context.WithTimeout(ctx, 7*time.Second)
		data, err := p.run(commandCtx, "/usr/sbin/qm", "guest", "exec", strconv.Itoa(p.Manifest.VMID), "--timeout", "5", "--", "/usr/bin/cat", "/proc/sys/kernel/random/boot_id")
		commandCancel()
		var result struct {
			Exited   *int    `json:"exited"`
			ExitCode *int    `json:"exitcode"`
			Output   *string `json:"out-data"`
		}
		if err == nil && uniqueJSONKeys(data) == nil && json.Unmarshal(data, &result) == nil && result.Exited != nil && *result.Exited == 1 && result.ExitCode != nil && *result.ExitCode == 0 && result.Output != nil {
			id := strings.TrimSpace(*result.Output)
			if uuidPattern.MatchString(id) {
				return id, nil
			}
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", failure("BOOT_HEALTH_TIMEOUT")
		case <-timer.C:
		}
	}
}

// ReadBounded never accepts a second JSON document or an unbounded SSH request.
func ReadBounded(reader io.Reader, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, failure("INPUT_TOO_LARGE")
	}
	return data, nil
}
