package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"krn.local/ci-platform/internal/executor"
	"krn.local/ci-platform/internal/reset"
)

type Runner interface {
	Run(context.Context, []string, []byte) ([]byte, error)
}
type ProcessRunner struct{}
type bounded struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (b *bounded) Write(p []byte) (int, error) {
	n := len(p)
	if n > b.limit-b.Len() {
		b.exceeded = true
		p = p[:b.limit-b.Len()]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}
func (ProcessRunner) Run(ctx context.Context, argv []string, input []byte) ([]byte, error) {
	if len(argv) == 0 {
		return nil, errors.New("empty controller command")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent", "LC_ALL=C"}
	cmd.Stdin = bytes.NewReader(input)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	out, diagnostic := &bounded{limit: 1 << 20}, &bounded{limit: 64 << 10}
	cmd.Stdout = out
	cmd.Stderr = diagnostic
	err := cmd.Run()
	if err != nil || out.exceeded || diagnostic.exceeded {
		return out.Bytes(), errors.New("controller subprocess failed or exceeded bounds")
	}
	return out.Bytes(), nil
}

type SSHBackend struct {
	Config         Config
	StateDirectory string
	Runner         Runner
}

func (b SSHBackend) run(ctx context.Context, timeout time.Duration, args []string, input []byte) ([]byte, error) {
	if b.Runner == nil {
		return nil, errors.New("controller transport missing")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return b.Runner.Run(ctx, args, input)
}
func (e Endpoint) options() []string {
	return []string{"-F", "/dev/null", "-i", e.PrivateKeyFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UserKnownHostsFile=" + e.KnownHostsFile, "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1"}
}
func (e Endpoint) ssh(command ...string) []string {
	a := append([]string{"/usr/bin/ssh"}, e.options()...)
	a = append(a, "--", e.User+"@"+e.Host)
	return append(a, command...)
}
func (b SSHBackend) Bundle(ctx context.Context, path, sha string) (string, error) {
	hash, err := hashFile(path)
	if err != nil {
		return "", errors.New("bundle file invalid")
	}
	out, err := b.run(ctx, 30*time.Second, []string{"/usr/bin/git", "-c", "core.hooksPath=/dev/null", "bundle", "list-heads", path}, nil)
	if err != nil {
		return "", errors.New("Git bundle inspection failed")
	}
	head := false
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return "", errors.New("invalid Git bundle refs")
		}
		if fields[1] == "HEAD" {
			if fields[0] != sha || head {
				return "", errors.New("bundle HEAD mismatch")
			}
			head = true
		}
	}
	if !head {
		return "", errors.New("full bundle must explicitly contain HEAD")
	}
	return hash, nil
}
func (b SSHBackend) Reset(ctx context.Context, request reset.Request) (reset.Receipt, error) {
	data, _ := json.Marshal(request)
	out, transportErr := b.run(ctx, 8*time.Minute, b.Config.PVE.ssh(), append(data, '\n'))
	var r reset.Receipt
	if err := executor.Decode(bytes.NewReader(out), &r); err != nil {
		return r, errors.New("invalid reset helper response")
	}
	if transportErr != nil || !r.OK {
		return r, errors.New("PVE reset not committed")
	}
	return r, nil
}
func (b SSHBackend) ready(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	for {
		if _, err := b.run(ctx, 15*time.Second, b.Config.Runner.ssh("/usr/bin/true"), nil); err == nil {
			return nil
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return errors.New("runner SSH readiness failed")
		case <-timer.C:
		}
	}
}
func (b SSHBackend) copy(ctx context.Context, path, name string) error {
	a := append([]string{"/usr/bin/scp"}, b.Config.Runner.options()...)
	a = append(a, "--", path, b.Config.Runner.User+"@"+b.Config.Runner.Host+":"+InputDirectory+"/"+name)
	_, err := b.run(ctx, 2*time.Minute, a, nil)
	return err
}
func (b SSHBackend) Deliver(ctx context.Context, bundle string, spec executor.JobSpec, profile executor.Profile, want string) error {
	if err := b.ready(ctx); err != nil {
		return err
	}
	// The image pre-creates this directory for its agent user. No mkdir on an
	// arbitrary path or parent, no controller credential files are transferred.
	if _, err := b.run(ctx, 15*time.Second, b.Config.Runner.ssh("/usr/bin/test", "-d", InputDirectory), nil); err != nil {
		return errors.New("runner input directory absent")
	}
	directory, err := os.MkdirTemp(b.StateDirectory, ".delivery-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	for _, item := range []struct {
		name  string
		value any
	}{{"job.json", spec}, {"profile.json", profile}} {
		data, _ := json.Marshal(item.value)
		path := filepath.Join(directory, item.name)
		if err = os.WriteFile(path, data, 0600); err != nil {
			return err
		}
		if err = b.copy(ctx, path, item.name); err != nil {
			return errors.New("runner input transfer failed")
		}
	}
	if err = b.copy(ctx, bundle, "source.bundle"); err != nil {
		return errors.New("bundle transfer failed")
	}
	// Bind all received inputs, not only the source bundle.
	wants := []string{want, digest(spec), digest(profile)}
	for i, name := range []string{"source.bundle", "job.json", "profile.json"} {
		out, err := b.run(ctx, 30*time.Second, b.Config.Runner.ssh("/usr/bin/sha256sum", InputDirectory+"/"+name), nil)
		if err != nil {
			return errors.New("runner input checksum failed")
		}
		fields := strings.Fields(string(out))
		if len(fields) != 2 || fields[0] != wants[i] || fields[1] != InputDirectory+"/"+name {
			return errors.New("runner input checksum mismatch")
		}
	}
	return nil
}

func validateSSHFiles(e Endpoint) error {
	uid := uint32(os.Geteuid())
	key, err := secureOpenFile(e.PrivateKeyFile, []uint32{uid, 0}, []uint32{uid, 0}, []os.FileMode{0400, 0600})
	if err != nil {
		return errors.New("SSH private key must be readable, private, and in trusted directories")
	}
	_ = key.Close()
	if !strings.HasPrefix(e.KnownHostsFile, "/etc/ci-platform/") {
		return errors.New("SSH host pins must be under /etc/ci-platform")
	}
	hosts, err := secureOpenFile(e.KnownHostsFile, []uint32{0}, []uint32{0}, nil)
	if err != nil {
		return errors.New("SSH host pins must be root-owned in trusted directories")
	}
	_ = hosts.Close()
	return nil
}

func uidAllowed(uid uint32, allowed []uint32) bool {
	for _, candidate := range allowed {
		if uid == candidate {
			return true
		}
	}
	return false
}

// secureOpenFile checks every path component without following symlinks, then
// opens and rechecks the final inode. Parent permissions make the remaining
// path walk stable against untrusted users replacing components.
func secureOpenFile(path string, fileOwners, parentOwners []uint32, exactModes []os.FileMode) (*os.File, error) {
	if !canonical(path) {
		return nil, errors.New("noncanonical secure file path")
	}
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("symlink or unavailable secure path")
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return nil, errors.New("secure path ownership unavailable")
		}
		if current == path {
			if !info.Mode().IsRegular() || !uidAllowed(stat.Uid, fileOwners) || info.Mode().Perm()&0022 != 0 {
				return nil, errors.New("untrusted secure file")
			}
			if len(exactModes) > 0 {
				valid := false
				for _, mode := range exactModes {
					valid = valid || info.Mode().Perm() == mode
				}
				if !valid {
					return nil, errors.New("invalid secure file mode")
				}
			}
		} else {
			if !info.IsDir() || !uidAllowed(stat.Uid, parentOwners) || info.Mode().Perm()&0022 != 0 {
				return nil, errors.New("untrusted secure parent directory")
			}
		}
		if current == string(filepath.Separator) {
			break
		}
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 {
		_ = file.Close()
		return nil, errors.New("secure file changed while opening")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !uidAllowed(stat.Uid, fileOwners) {
		_ = file.Close()
		return nil, errors.New("secure file owner changed while opening")
	}
	if len(exactModes) > 0 {
		valid := false
		for _, mode := range exactModes {
			valid = valid || info.Mode().Perm() == mode
		}
		if !valid {
			_ = file.Close()
			return nil, errors.New("secure file mode changed while opening")
		}
	}
	return file, nil
}

func openRootOwnedConfig(path string) (*os.File, error) {
	return secureOpenFile(path, []uint32{0}, []uint32{0}, nil)
}

var _ io.Writer = (*bounded)(nil)
