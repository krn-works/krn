//go:build linux

// Package globalgate reproduces the GLOBAL validate workflow at 58c46090.
// It is a trusted dispatcher, executed only inside the disposable CI guest.
package globalgate

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

type runner func(...string) (string, error)

var sha = regexp.MustCompile(`^[0-9a-f]{40}$`)

func workflow(tier, base, source, directory string, run runner) error {
	if !sha.MatchString(base) || !sha.MatchString(source) {
		return errors.New("full base/source SHA required")
	}
	actual, err := run("git", "rev-parse", "HEAD")
	if err != nil || strings.TrimSpace(actual) != source {
		return errors.New("source SHA mismatch")
	}
	if _, err = run("git", "cat-file", "-e", base+"^{commit}"); err != nil {
		return err
	}
	npm := func(names ...string) error {
		for _, name := range names {
			if _, err := run("npm", "run", name); err != nil {
				return err
			}
		}
		return nil
	}
	switch tier {
	case "fast":
		if err = npm("precheck", "validate:remaining", "test:repro"); err != nil {
			return err
		}
		merge, err := run("git", "merge-base", base, "HEAD")
		if err != nil {
			return err
		}
		merge = strings.TrimSpace(merge)
		if !sha.MatchString(merge) {
			return errors.New("invalid merge base")
		}
		if _, err = run("node", "scripts/krn.mjs", "changes", "check", "--root", ".", "--base", merge, "--head", "HEAD", "--before"); err != nil {
			return err
		}
		return npm("quality:audit", "test:lib")
	case "deep":
		if err = npm("test:bootstrap", "test:install", "test:hooks", "test:state", "test:skills", "lessons:verify", "test:lessons", "test:lessons-verify", "test:change-contract", "test:conformance"); err != nil {
			return err
		}
		if _, exists := run("git", "cat-file", "-e", base+":config/conformance.json"); exists == nil {
			parent := filepath.Join(directory, ".krn", "tmp")
			if err = os.MkdirAll(parent, 0700); err != nil {
				return err
			}
			dir, err := os.MkdirTemp(parent, "krn-conformance-")
			if err != nil {
				return err
			}
			defer os.RemoveAll(dir)
			if _, err = run("git", "worktree", "add", "--detach", dir, base); err != nil {
				return err
			}
			defer func() {
				_, _ = run("git", "worktree", "remove", "--force", dir)
				_, _ = run("git", "worktree", "prune")
			}()
			if _, err = run("node", filepath.Join(dir, "scripts/krn.mjs"), "conformance", "check", "--root", dir, "--candidate", directory, "--frozen"); err != nil {
				return err
			}
		} else {
			if _, err = run("node", "scripts/krn.mjs", "conformance", "check", "--root", ".", "--frozen"); err != nil {
				return err
			}
		}
		if err = npm("test:durable-pages", "test:setup", "test:skill-scripts"); err != nil {
			return err
		}
		for _, file := range []string{"scripts/install.sh", "skills/advisory/second-opinion/scripts/check-opinion.sh", "skills/advisory/second-opinion/scripts/run-opinion.sh"} {
			if _, err = run("bash", "-n", file); err != nil {
				return err
			}
		}
		_, err = run("git", "diff", "--check", base+"...HEAD")
		return err
	default:
		return errors.New("unknown GLOBAL tier")
	}
}

func subprocess(in io.Reader, out, errOut io.Writer) runner {
	return func(argv ...string) (string, error) {
		cmd := exec.Command(argv[0], argv[1:]...)
		// Inherit only the executor's already filtered guest environment.
		cmd.Env = os.Environ()
		cmd.Stdin = in
		cmd.Stderr = errOut
		var capture strings.Builder
		if argv[0] == "git" && (argv[1] == "rev-parse" || argv[1] == "merge-base") {
			cmd.Stdout = &capture
		} else {
			cmd.Stdout = out
		}
		err := cmd.Run()
		return capture.String(), err
	}
}

// Main must be routed from the root CLI's `global` command. No job-supplied
// command is accepted. Parent executor owns the timeout and process-group kill.
func Main(args []string, in io.Reader, out, errOut io.Writer) int {
	executable, _ := os.Executable()
	container, err := os.ReadFile("/run/systemd/container")
	directory, _ := os.Getwd()
	if err != nil || strings.TrimSpace(string(container)) != "lxc" || executable != "/opt/ci/executor" || os.Getuid() != 1000 || directory != "/home/ci/source" || len(args) != 1 || (args[0] != "fast" && args[0] != "deep") {
		fmt.Fprintln(errOut, "GLOBAL requires disposable CI guest")
		return 2
	}
	err = workflow(args[0], os.Getenv("KRN_CI_BASE_SHA"), os.Getenv("KRN_CI_SOURCE_SHA"), directory, subprocess(in, out, errOut))
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		status := exit.Sys().(syscall.WaitStatus)
		if status.Signaled() {
			sig := status.Signal()
			signal.Reset(sig)
			if syscall.Kill(os.Getpid(), sig) == nil {
				// Wait for delivery instead of racing the root CLI os.Exit.
				for {
					_ = syscall.Pause()
				}
			}
			return 128 + int(sig)
		}
		return exit.ExitCode()
	}
	fmt.Fprintln(errOut, "GLOBAL setup failed")
	return 2
}
