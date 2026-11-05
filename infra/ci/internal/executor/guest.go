//go:build linux

package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func guestEnvironment(data guestPayload) []string {
	// Only PAM session coordinates survive; never copy the inherited environment.
	return []string{"PATH=" + safePath, "HOME=/home/ci", "USER=ci", "LOGNAME=ci", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "CI=true",
		"KRN_CI_BASE_SHA=" + data.Spec.BaseSHA, "KRN_CI_SOURCE_SHA=" + data.Spec.SourceSHA,
		"KRN_LIVE=", "KRN_REQUIRE_ZERO_ISOLATION_SKIPS=1", "XDG_RUNTIME_DIR=" + os.Getenv("XDG_RUNTIME_DIR"),
		"DBUS_SESSION_BUS_ADDRESS=" + os.Getenv("DBUS_SESSION_BUS_ADDRESS"), "XDG_SESSION_ID=" + os.Getenv("XDG_SESSION_ID"),
		"XDG_CACHE_HOME=/home/ci/.cache", "XDG_CONFIG_HOME=/home/ci/.config", "XDG_DATA_HOME=/home/ci/.local/share", "XDG_STATE_HOME=/home/ci/.local/state",
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=" + data.GitName, "GIT_COMMITTER_NAME=" + data.GitName, "GIT_AUTHOR_EMAIL=" + data.GitEmail, "GIT_COMMITTER_EMAIL=" + data.GitEmail}
}

func invokeGuest(data guestPayload, dir string, argv ...string) (string, error) {
	r := runProcess(context.Background(), Command{Argv: argv, Timeout: 30 * time.Second}, guestEnvironment(data), dir, nil)
	if !r.ok() || r.Truncated {
		return "", fmt.Errorf("guest command failed (exit=%d signal=%d timeout=%t start_failed=%t truncated=%t)", r.ExitCode, r.Signal, r.TimedOut, r.StartFailed, r.Truncated)
	}
	return strings.TrimSpace(string(r.Stdout)), nil
}

func readGuestFile(path string) ([]byte, error) {
	// Evidence paths are fixed; reject symlinks, devices and oversized files.
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, errors.New("guest evidence unavailable")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > LogLimit {
		return nil, errors.New("invalid guest evidence file")
	}
	b, err := io.ReadAll(io.LimitReader(f, LogLimit+1))
	if err != nil || len(b) > LogLimit {
		return nil, errors.New("guest evidence read failed")
	}
	return b, nil
}

func waitSystemd(ctx context.Context, probe func(context.Context) bool) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if probe(ctx) {
			return nil
		}
		timer := time.NewTimer(250 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func tools(data guestPayload) (toolProbe, error) {
	p := toolProbe{Versions: map[string]string{}}
	// incus start returns before PID1 has created its system bus. Wait for a
	// real ready condition; otherwise the first PAM/systemd-run races boot.
	readyCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := waitSystemd(readyCtx, func(ctx context.Context) bool {
		r := runProcess(ctx, Command{Argv: []string{"/usr/bin/systemctl", "is-active", "--quiet", "systemd-logind.service"}, Timeout: 2 * time.Second}, guestEnvironment(data), "", nil)
		return r.ok() && !r.Truncated
	}); err != nil {
		return p, errors.New("systemd/logind not ready within deadline")
	}
	help, err := invokeGuest(data, "", "/usr/bin/systemd-run", "--help")
	if err != nil {
		return p, err
	}
	p.Options = true
	for _, option := range []string{"--wait", "--pipe", "--collect", "--service-type", "--expand-environment"} {
		p.Options = p.Options && strings.Contains(help, option)
	}
	for _, tool := range []string{"systemd-run", "bwrap", "git"} {
		version, err := invokeGuest(data, "", "/usr/bin/"+tool, "--version")
		if err != nil {
			return p, err
		}
		p.Versions[tool] = strings.SplitN(version, "\n", 2)[0]
	}
	manifest, err := readGuestFile("/opt/ci/image-manifest.json")
	if err != nil {
		return p, err
	}
	var object map[string]any
	if json.Unmarshal(manifest, &object) != nil || object == nil {
		return p, errors.New("invalid image manifest")
	}
	p.Manifest, p.ManifestSHA256 = manifest, digest(manifest)
	p.HelperSHA256, err = fileDigest(guestBinary, 128*1024*1024)
	if err != nil {
		return p, err
	}
	for path, target := range map[string]*string{"/sys/fs/cgroup/memory.max": &p.MemoryMax, "/sys/fs/cgroup/pids.max": &p.PidsMax} {
		b, err := readGuestFile(path)
		if err != nil {
			return p, err
		}
		*target = strings.TrimSpace(string(b))
	}
	return p, nil
}

func bwrapArgv() []string {
	return []string{"/usr/bin/bwrap", "--die-with-parent", "--ro-bind", "/", "/", "--clearenv", "--unshare-net", "--unshare-pid", "--as-pid-1", "--tmpfs", "/tmp", "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true"}
}

func session(data guestPayload) (sessionProbe, error) {
	p := sessionProbe{UID: os.Getuid(), Home: os.Getenv("HOME"), Runtime: os.Getenv("XDG_RUNTIME_DIR"), Bus: os.Getenv("DBUS_SESSION_BUS_ADDRESS"), Path: os.Getenv("PATH"), BwrapArgv: bwrapArgv()}
	p.Cwd, _ = os.Getwd()
	if p.UID != 1000 || p.Home != "/home/ci" || p.Runtime != "/run/user/1000" || p.Bus != "unix:path=/run/user/1000/bus" {
		return p, errors.New("PAM session coordinates missing")
	}
	runtimeInfo, err := os.Stat(p.Runtime)
	if err != nil || runtimeInfo.Sys().(*syscall.Stat_t).Uid != 1000 {
		return p, errors.New("invalid runtime directory owner")
	}
	bus, err := os.Stat(filepath.Join(p.Runtime, "bus"))
	if err != nil || bus.Mode()&os.ModeSocket == 0 {
		return p, errors.New("user bus missing")
	}
	sid := os.Getenv("XDG_SESSION_ID")
	if !match(`[A-Za-z0-9_-]{1,64}`, sid) {
		return p, errors.New("logind session missing")
	}
	p.Session, err = invokeGuest(data, "", "/usr/bin/loginctl", "show-session", sid, "-p", "User", "-p", "State")
	if err != nil {
		return p, fmt.Errorf("logind session probe: %w", err)
	}
	p.Manager, err = invokeGuest(data, "", "/usr/bin/systemctl", "--user", "show", "-p", "Version", "--value")
	if err != nil {
		return p, fmt.Errorf("user manager probe: %w", err)
	}
	if _, err = invokeGuest(data, "", "/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--", "/usr/bin/true"); err != nil {
		return p, fmt.Errorf("user scope probe: %w", err)
	}
	if _, err = invokeGuest(data, "", p.BwrapArgv...); err != nil {
		return p, fmt.Errorf("bwrap probe: %w", err)
	}
	cgroup, err := readGuestFile("/proc/self/cgroup")
	if err != nil {
		return p, err
	}
	p.Cgroup = strings.TrimSpace(string(cgroup))
	for _, kind := range []string{"memory", "pids"} {
		argv := []string{"/usr/bin/systemd-run", "--user", "--wait", "--pipe", "--collect", "--service-type=exec", "--expand-environment=no", "-p", "RuntimeMaxSec=20s", "-p", "TimeoutStopSec=3s", "-p", "MemoryMax=64M", "-p", "MemorySwapMax=0", "-p", "TasksMax=16"}
		if kind == "memory" {
			// The deliberate OOM must kill its child while the observer stays
			// alive to read memory.events. The 64MiB limit remains enforced.
			argv = append(argv, "-p", "OOMPolicy=continue")
		}
		argv = append(argv, "--", guestBinary, "executor", "__guest", "limit-"+kind, string(jsonBytes(data)))
		output, err := invokeGuest(data, "", argv...)
		if err != nil {
			return p, fmt.Errorf("%s limit probe: %w", kind, err)
		}
		if kind == "memory" {
			err = Decode(strings.NewReader(output), &p.Memory)
		} else {
			err = Decode(strings.NewReader(output), &p.Pids)
		}
		if err != nil {
			return p, err
		}
	}
	return p, p.validate()
}

func cgroupPath() (string, error) {
	b, err := readGuestFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(b))
	if !strings.HasPrefix(line, "0::/") || strings.Contains(line, "\n") {
		return "", errors.New("cgroup v2 required")
	}
	path := filepath.Clean("/sys/fs/cgroup/" + strings.TrimPrefix(line, "0::/"))
	if path != "/sys/fs/cgroup" && !strings.HasPrefix(path, "/sys/fs/cgroup/") {
		return "", errors.New("invalid cgroup path")
	}
	return path, nil
}
func cgroupValue(root, name string) (string, error) {
	b, err := readGuestFile(filepath.Join(root, name))
	return strings.TrimSpace(string(b)), err
}
func cgroupEvent(root, name, key string) (int, error) {
	v, err := cgroupValue(root, name)
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(v, "\n") {
		parts := strings.Fields(line)
		if len(parts) == 2 && parts[0] == key {
			return strconv.Atoi(parts[1])
		}
	}
	return 0, errors.New("cgroup event missing")
}

type progressCounter struct{ n int }

func (p *progressCounter) Write(b []byte) (int, error) { p.n += len(b); return len(b), nil }
func probeMemory() (memoryProbe, error) {
	p := memoryProbe{}
	root, err := cgroupPath()
	if err != nil {
		return p, err
	}
	p.Limit, err = cgroupValue(root, "memory.max")
	if err != nil {
		return p, err
	}
	p.Swap, err = cgroupValue(root, "memory.swap.max")
	if err != nil {
		return p, err
	}
	if p.Limit != "67108864" || p.Swap != "0" {
		return p, errors.New("refusing memory probe without its small cgroup limit")
	}
	before, err := cgroupEvent(root, "memory.events", "oom_kill")
	if err != nil {
		return p, err
	}
	progress := &progressCounter{}
	cmd := exec.Command(guestBinary, "executor", "__guest", "touch-memory")
	cmd.Env, cmd.Stdout, cmd.Stderr = hostEnvironment(), progress, io.Discard
	err = cmd.Run()
	if cmd.ProcessState != nil {
		status := cmd.ProcessState.Sys().(syscall.WaitStatus)
		if status.Signaled() {
			p.Signal = int(status.Signal())
		}
	}
	if err == nil || p.Signal != int(syscall.SIGKILL) {
		return p, errors.New("bounded memory probe did not OOM kill its child")
	}
	p.Touched = progress.n * 1024 * 1024
	after, err := cgroupEvent(root, "memory.events", "oom_kill")
	if err != nil {
		return p, err
	}
	p.OOMKills = after - before
	peak, err := cgroupValue(root, "memory.peak")
	if err != nil {
		return p, err
	}
	p.Peak, err = strconv.Atoi(peak)
	return p, err
}
func touchMemory() int {
	root, err := cgroupPath()
	if err != nil {
		return 2
	}
	limit, err := cgroupValue(root, "memory.max")
	if err != nil || limit != "67108864" {
		return 2
	}
	if os.WriteFile("/proc/self/oom_score_adj", []byte("1000"), 0600) != nil {
		return 2
	}
	pages, err := syscall.Mmap(-1, 0, 128*1024*1024, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_PRIVATE|syscall.MAP_ANON)
	if err != nil {
		return 2
	}
	defer syscall.Munmap(pages)
	for i := 0; i < len(pages); i += 4096 {
		pages[i] = 1
		if i%(1024*1024) == 0 {
			if _, err = os.Stdout.Write([]byte{'.'}); err != nil {
				return 2
			}
		}
	}
	runtime.KeepAlive(pages)
	return 0
}
func probePids() (pidsProbe, error) {
	p := pidsProbe{}
	root, err := cgroupPath()
	if err != nil {
		return p, err
	}
	p.Limit, err = cgroupValue(root, "pids.max")
	if err != nil || p.Limit != "16" {
		return p, errors.New("refusing pids probe without its small cgroup limit")
	}
	before, err := cgroupEvent(root, "pids.events", "max")
	if err != nil {
		return p, err
	}
	var children []*exec.Cmd
	var pipes []io.WriteCloser
	defer func() {
		for _, pipe := range pipes {
			_ = pipe.Close()
		}
		for _, child := range children {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	}()
	for i := 0; i < 24; i++ {
		// cat blocks on a private pipe, without a sleep or a thread-heavy Go child.
		child := exec.Command("/usr/bin/cat")
		child.Env = hostEnvironment()
		child.Stdout, child.Stderr = io.Discard, io.Discard
		pipe, err := child.StdinPipe()
		if err != nil {
			return p, errors.New("pids probe pipe failed")
		}
		if err = child.Start(); err != nil {
			_ = pipe.Close()
			if errors.Is(err, syscall.EAGAIN) {
				p.Denied = true
				break
			}
			return p, errors.New("pids probe spawn failed")
		}
		children, pipes = append(children, child), append(pipes, pipe)
	}
	p.Children = len(children)
	after, err := cgroupEvent(root, "pids.events", "max")
	p.Events = after - before
	return p, err
}

func git(data guestPayload, args ...string) (string, error) {
	return gitAt(data, guestSource, args...)
}
func gitAt(data guestPayload, directory string, args ...string) (string, error) {
	argv := append([]string{"/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", directory}, args...)
	return invokeGuest(data, "", argv...)
}
func source(data guestPayload) (any, error) {
	return checkoutSource(data, guestSource, guestBundle)
}
func checkoutSource(data guestPayload, directory, bundle string) (any, error) {
	if err := os.Mkdir(directory, 0700); err != nil {
		return nil, errors.New("source directory already exists/unavailable")
	}
	for _, args := range [][]string{{"init"}, {"bundle", "verify", bundle}, {"fetch", "--tags", bundle, "+refs/*:refs/bundle/*"}} {
		if _, err := gitAt(data, directory, args...); err != nil {
			return nil, err
		}
	}
	shallow, err := gitAt(data, directory, "rev-parse", "--is-shallow-repository")
	if err != nil || shallow != "false" {
		return nil, errors.New("full history required")
	}
	kind, err := gitAt(data, directory, "cat-file", "-t", data.Spec.SourceSHA)
	if err != nil || kind != "commit" {
		return nil, errors.New("requested commit missing")
	}
	if data.Spec.Tier != Product {
		baseKind, baseErr := gitAt(data, directory, "cat-file", "-t", data.Spec.BaseSHA)
		if baseErr != nil || baseKind != "commit" {
			return nil, errors.New("requested base commit missing")
		}
	}
	if _, err = gitAt(data, directory, "checkout", "--detach", data.Spec.SourceSHA); err != nil {
		return nil, err
	}
	actual, err := gitAt(data, directory, "rev-parse", "HEAD")
	if err != nil || actual != data.Spec.SourceSHA {
		return nil, errors.New("actual source SHA mismatch")
	}
	return map[string]any{"actual_checkout": actual, "shallow": false}, nil
}

type summaryStream struct {
	mu      sync.Mutex
	out     io.Writer
	prefix  []byte
	pending []byte
	logged  int
	count   int
	summary *Summary
	invalid bool
	// After the head budget the log keeps only failing TAP lines, so a late
	// failure stays visible in bounded evidence.
	omitted  bool
	failing  int
	retained int
}

const failureReserve = 32768

var omittedMarker = []byte("\n[ci-platform: gate output omitted beyond the log limit; failing TAP lines follow]\n")

func tapIndent(line []byte) int { return len(line) - len(bytes.TrimLeft(line, " ")) }

// retain writes one complete line past the head budget when it is part of a
// failure: a "not ok" line, its deeper-indented YAML block, or a "# fail" count.
func (s *summaryStream) retain(line []byte) error {
	trimmed := bytes.TrimLeft(line, " ")
	keep := false
	switch {
	case bytes.HasPrefix(trimmed, []byte("not ok ")):
		s.failing, keep = tapIndent(line), true
	case s.failing >= 0 && len(trimmed) > 0 && tapIndent(line) > s.failing:
		keep = s.retained < failureReserve/2
	case bytes.HasPrefix(trimmed, []byte("# fail ")):
		s.failing, keep = -1, true
	default:
		s.failing = -1
	}
	if !keep || s.retained+len(line)+1 > failureReserve-len(omittedMarker) {
		return nil
	}
	s.retained += len(line) + 1
	_, err := s.out.Write(append(append([]byte{}, line...), '\n'))
	return err
}

func (s *summaryStream) line(line []byte) {
	if bytes.HasPrefix(line, s.prefix) {
		s.count++
		var summary Summary
		if Decode(bytes.NewReader(line[len(s.prefix):]), &summary) == nil {
			s.summary = &summary
		} else {
			s.invalid = true
		}
	}
}
func (s *summaryStream) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := len(b)
	// headEnd counts the bytes of b that went to the head; a line ending
	// beyond it is past the head budget.
	headEnd := 0
	if room := LogLimit - failureReserve - s.logged; room > 0 {
		part := b
		if len(part) > room {
			part = part[:room]
		}
		if _, err := s.out.Write(part); err != nil {
			return 0, err
		}
		s.logged += len(part)
		headEnd = len(part)
	}
	offset := 0
	for len(b) > 0 {
		index := bytes.IndexByte(b, '\n')
		take := len(b)
		if index >= 0 {
			take = index
		}
		if len(s.pending)+take > LogLimit {
			s.invalid = true
			s.pending = nil
		} else {
			s.pending = append(s.pending, b[:take]...)
		}
		if index < 0 {
			break
		}
		if !s.invalid {
			s.line(s.pending)
		}
		offset += index + 1
		if offset > headEnd {
			if !s.omitted {
				s.omitted, s.failing = true, -1
				if _, err := s.out.Write(omittedMarker); err != nil {
					return 0, err
				}
			}
			if err := s.retain(s.pending); err != nil {
				return 0, err
			}
		}
		s.pending = nil
		b = b[index+1:]
	}
	return n, nil
}
func (s *summaryStream) finish() {
	if len(s.pending) > 0 && !s.invalid {
		s.line(s.pending)
	}
	// An unterminated final line past the head budget can still be a failure.
	if len(s.pending) > 0 && s.logged >= LogLimit-failureReserve {
		if !s.omitted {
			s.omitted, s.failing = true, -1
			_, _ = s.out.Write(omittedMarker)
		}
		_ = s.retain(s.pending)
	}
	if s.invalid {
		s.summary = nil
	}
}

func runGate(data guestPayload, out io.Writer) (code int) {
	r := CommandReceipt{Expected: data.Spec, CommandID: commandID(data.Gate), Outcome: Outcome{Status: "setup_failed", StartedAt: time.Now().UTC()}}
	code = 2
	defer func() {
		r.Outcome.FinishedAt = time.Now().UTC()
		f, err := os.OpenFile(guestReceipt, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			code = 2
			return
		}
		b := jsonBytes(r)
		if len(b) > LogLimit {
			_ = f.Close()
			code = 2
			return
		}
		_, err = f.Write(b)
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			code = 2
		}
	}()
	actual, err := git(data, "rev-parse", "HEAD")
	r.ActualCheckout = actual
	if err != nil || actual != data.Spec.SourceSHA {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(data.Spec.TimeoutSeconds)*time.Second)
	defer cancel()
	stream := &summaryStream{out: out, prefix: []byte(data.Gate.SummaryPrefix)}
	if data.Gate.SummaryMode == "native-exit" {
		stream.prefix = []byte{0}
	}
	result := runGateCommands(ctx, data, guestSource, stream, out)
	if data.Gate.SummaryMode == "native-exit" && result.ok() {
		r.EvidenceKind = "native-exit"
	}
	stream.finish()
	r.SummaryCount, r.Summary = stream.count, stream.summary
	r.FinalCheckout, err = git(data, "rev-parse", "HEAD")
	if err != nil {
		return
	}
	if result.TimedOut {
		r.Outcome.Status = "timeout"
		code = 124
	} else if result.StartFailed {
		return
	} else if result.Signal != 0 {
		r.Outcome.Status = "signaled"
		r.Outcome.Signal = result.Signal
		code = 128 + result.Signal
	} else {
		r.Outcome.Status = "exited"
		r.Outcome.ExitCode = &result.ExitCode
		code = result.ExitCode
	}
	return
}

// guestMain is reachable only from the copied binary in an Incus systemd guest.
// No host test invokes destructive probes. The public root CLI must delegate
// `executor` verbatim to Main, including these private helper arguments.
func guestMain(args []string, out, errOut io.Writer) int {
	container, err := readGuestFile("/run/systemd/container")
	executable, _ := os.Executable()
	if err != nil || strings.TrimSpace(string(container)) != "lxc" || executable != guestBinary || len(args) == 0 {
		fmt.Fprintln(errOut, "guest helper requires the disposable Incus guest")
		return 2
	}
	if args[0] == "touch-memory" {
		if len(args) != 1 || os.Getuid() != 1000 {
			return 2
		}
		return touchMemory()
	}
	if len(args) != 2 {
		return 2
	}
	var data guestPayload
	if Decode(strings.NewReader(args[1]), &data) != nil || data.Spec.Validate() != nil || data.Gate.validate() != nil || data.Gate.Tier != data.Spec.Tier || !match(`[A-Za-z0-9 ._-]{1,80}`, data.GitName) || !match(`[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+`, data.GitEmail) {
		return 2
	}
	mode := args[0]
	rootMode := mode == "tools" || mode == "read-receipt"
	if (rootMode && os.Getuid() != 0) || (!rootMode && os.Getuid() != 1000) {
		return 2
	}
	var value any
	switch mode {
	case "tools":
		value, err = tools(data)
	case "session":
		value, err = session(data)
	case "limit-memory":
		value, err = probeMemory()
	case "limit-pids":
		value, err = probePids()
	case "exit23":
		return 23
	case "source":
		value, err = source(data)
	case "gate":
		return runGate(data, out)
	case "read-receipt":
		var b []byte
		b, err = readGuestFile(guestReceipt)
		if err == nil {
			var receipt CommandReceipt
			err = Decode(bytes.NewReader(b), &receipt)
			value = receipt
		}
	default:
		return 2
	}
	if err != nil {
		// Errors contain fixed probe stages and numeric outcomes, never command
		// output or inherited environment. Preserve the failing boundary.
		fmt.Fprintln(errOut, "guest operation failed:", mode, err)
		return 2
	}
	if json.NewEncoder(out).Encode(value) != nil {
		return 2
	}
	return 0
}

func hostMemory(out io.Writer) int {
	b, err := readGuestFile("/proc/meminfo")
	if err != nil {
		return 2
	}
	values := map[string]int{}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && (f[0] == "MemTotal:" || f[0] == "MemAvailable:") {
			n, err := strconv.Atoi(f[1])
			if err != nil {
				return 2
			}
			values[strings.TrimSuffix(f[0], ":")] = n / 1024
		}
	}
	if len(values) != 2 || json.NewEncoder(out).Encode(values) != nil {
		return 2
	}
	return 0
}

// Preparation shares the gate deadline and uses the same bounded process group.
// Nothing here runs until checkout has been verified inside the guest.
func runGateCommands(ctx context.Context, data guestPayload, directory string, stream, out io.Writer) ProcessResult {
	timeout := time.Duration(data.Spec.TimeoutSeconds) * time.Second
	if data.Spec.Tier == Product {
		result := runProcess(ctx, Command{Argv: []string{"pnpm", "install", "--offline", "--frozen-lockfile"}, Timeout: timeout}, guestEnvironment(data), directory, out)
		if !result.ok() {
			return result
		}
	}
	return runProcess(ctx, Command{Argv: data.Gate.Argv, Timeout: timeout}, guestEnvironment(data), directory, stream)
}
