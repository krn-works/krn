package executor

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

type Command struct {
	Name    string        `json:"name"`
	Argv    []string      `json:"argv"`
	Timeout time.Duration `json:"timeout_ns"`
}

type ProcessResult struct {
	ExitCode    int    `json:"exit_code"`
	Signal      int    `json:"signal"`
	TimedOut    bool   `json:"timed_out"`
	StartFailed bool   `json:"start_failed"`
	Truncated   bool   `json:"truncated"`
	Stdout      []byte `json:"-"`
	Stderr      []byte `json:"-"`
}

func (r ProcessResult) ok() bool {
	return r.ExitCode == 0 && r.Signal == 0 && !r.TimedOut && !r.StartFailed
}

// Transport must bound/drain output, honor cancellation and use an empty inherited
// environment. ProcessTransport is the production implementation. Tests inject it.
type Transport interface {
	Run(context.Context, Command) ProcessResult
}

// ExecutionPlan owns private copies of all admission data, including gate argv.
// A caller cannot alter a validated command mapping between Plan and Execute.
type ExecutionPlan struct {
	profile Profile
	spec    JobSpec
	options Options
	gate    Gate
	steps   []Command
}

type guestPayload struct {
	Spec     JobSpec `json:"spec"`
	Gate     Gate    `json:"gate"`
	GitName  string  `json:"git_name"`
	GitEmail string  `json:"git_email"`
}

func Plan(p Profile, s JobSpec, options Options) (*ExecutionPlan, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	if p.RepoID != s.RepoID || p.ConfigSHA != s.ConfigSHA || p.ImageFingerprint != s.ImageFingerprint {
		return nil, errors.New("job/profile identity mismatch")
	}
	if s.MemoryMiB > p.MaxJobMemoryMiB || s.ProcessLimit > p.MaxJobProcesses {
		return nil, errors.New("job exceeds profile resource limits")
	}
	if options.Mode == "" {
		options.Mode = Preflight
	}
	if options.Mode != Preflight && options.Mode != GateMode {
		return nil, errors.New("unknown execution mode")
	}
	if !canonicalPath(options.BundlePath) || !canonicalPath(options.BinaryPath) || !canonicalPath(options.EvidenceRoot) {
		return nil, errors.New("canonical absolute paths required")
	}
	var gate *Gate
	for _, g := range p.Gates {
		if g.Tier == s.Tier {
			copyGate := g
			copyGate.Argv = append([]string(nil), g.Argv...)
			gate = &copyGate
		}
	}
	if gate == nil {
		return nil, errors.New("tier has no reviewed command mapping")
	}
	p.Gates = nil // Only the admitted command survives in the immutable plan.
	plan := &ExecutionPlan{profile: p, spec: s, options: options, gate: *gate}
	plan.build()
	return plan, nil
}

func (p *ExecutionPlan) Commands() []Command {
	commands := make([]Command, len(p.steps))
	for i, c := range p.steps {
		c.Argv = append([]string(nil), c.Argv...)
		commands[i] = c
	}
	return commands
}

func (p *ExecutionPlan) incus(args ...string) []string {
	return append([]string{"/usr/bin/incus", "--force-local", "--project", p.profile.Project}, args...)
}

// Incus query rejects the global --project flag. Scope raw API reads through
// the REST query instead, including image reads which otherwise use default.
func (p *ExecutionPlan) query(path string) []string {
	return []string{"/usr/bin/incus", "--force-local", "query", path + "?" + url.Values{"project": {p.profile.Project}}.Encode()}
}
func (p *ExecutionPlan) settings() map[string]string {
	return map[string]string{
		"security.privileged": "false", "security.idmap.isolated": "true", "security.guestapi": "false", "security.nesting": strconv.FormatBool(p.profile.Nesting),
		"limits.cpu": strconv.Itoa(p.profile.CPUCount), "limits.memory": fmt.Sprintf("%dMiB", p.spec.MemoryMiB), "limits.memory.swap": "false",
		"limits.processes": strconv.Itoa(p.spec.ProcessLimit), "boot.autostart": "false", "user.ci.attempt": p.spec.AttemptID,
	}
}

func (p *ExecutionPlan) guest(mode string, session bool) []string {
	payload := guestPayload{p.spec, p.gate, p.profile.GitName, p.profile.GitEmail}
	args := []string{guestBinary, "executor", "__guest", mode, string(jsonBytes(payload))}
	if session {
		args = append([]string{"/usr/bin/systemd-run", "--wait", "--pipe", "--collect", "--service-type=exec", "--expand-environment=no",
			"--unit", p.spec.ContainerName() + "-" + mode,
			"-p", "PAMName=login", "-p", "User=ci", "-p", "Group=ci", "-p", "WorkingDirectory=/home/ci", "-p", "Delegate=yes",
			"-p", property("RuntimeMaxSec", p.spec.TimeoutSeconds+15, "s"), "-p", "TimeoutStopSec=5s", "-p", "KillMode=control-group",
			"--setenv", "PATH=" + safePath, "--setenv", "HOME=/home/ci", "--setenv", "KRN_LIVE=", "--setenv", "KRN_REQUIRE_ZERO_ISOLATION_SKIPS=1", "--"}, args...)
	}
	return p.incus(append([]string{"exec", p.spec.ContainerName(), "--disable-stdin", "--mode=non-interactive", "--"}, args...)...)
}

func (p *ExecutionPlan) add(name string, args []string, timeout time.Duration) {
	p.steps = append(p.steps, Command{name, args, timeout})
}
func (p *ExecutionPlan) build() {
	setup := 60 * time.Second
	name := p.spec.ContainerName()
	p.add("vm-memory", []string{p.options.BinaryPath, "executor", "__host-memory"}, setup)
	p.add("incus-package", []string{"/usr/bin/dpkg-query", "-W", "-f=${Version}", "incus"}, setup)
	p.add("image", p.query("/1.0/images/"+p.spec.ImageFingerprint), setup)
	p.add("existing", p.incus("list", name, "--format=json"), setup)
	init := p.incus("init", p.spec.ImageFingerprint, name, "--no-profiles", "--storage", p.profile.StoragePool, "--device", fmt.Sprintf("root,size=%dGiB", p.profile.RootGiB))
	// Fixed ordering makes the dry-run exactly reproducible.
	for _, key := range []string{"security.privileged", "security.idmap.isolated", "security.guestapi", "security.nesting", "limits.cpu", "limits.memory", "limits.memory.swap", "limits.processes", "boot.autostart", "user.ci.attempt"} {
		init = append(init, "--config", key+"="+p.settings()[key])
	}
	p.add("create", init, setup)
	p.add("instance", p.query("/1.0/instances/"+name), setup)
	p.add("start", p.incus("start", name), setup)
	p.add("helper-directory", p.incus("exec", name, "--disable-stdin", "--", "/usr/bin/install", "-d", "-m", "0755", "/opt/ci"), setup)
	p.add("helper-push", p.incus("file", "push", p.options.BinaryPath, name+guestBinary, "--mode=0555"), setup)
	p.add("tools", p.guest("tools", false), setup)
	p.add("session", p.guest("session", true), 60*time.Second)
	p.add("exit23", p.guest("exit23", true), setup)
	if p.options.Mode == GateMode {
		p.add("bundle-push", p.incus("file", "push", p.options.BundlePath, name+guestBundle, "--mode=0444"), setup)
		p.add("source", p.guest("source", true), setup)
		p.add("gate", p.guest("gate", true), time.Duration(p.spec.TimeoutSeconds+25)*time.Second)
		p.add("command-receipt", p.guest("read-receipt", false), setup)
	}
	// Cleanup first checks the ownership marker, even after an ambiguous init.
	p.add("cleanup-owner", p.query("/1.0/instances/"+name), 30*time.Second)
	p.add("cleanup", p.incus("delete", "--force", name), 30*time.Second)
}
