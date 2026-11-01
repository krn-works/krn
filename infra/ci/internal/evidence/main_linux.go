//go:build linux

// Package evidence exports a fixed, bounded set of runner diagnostics. It never
// walks a PR workspace, parses archives, or treats evidence as executable input.
package evidence

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"unicode"
)

const FileLimit = 262144

// 50 files maximum, each <=256 KiB: <13 MiB including the manifest/summary.
// Missing setup files are expected after an early failure; required gate files
// must exist before an otherwise passing attempt can be accepted.
func selected() []string {
	names := []string{"receipt.json", "inputs.json"}
	for _, step := range []string{"vm-memory", "incus-package", "image", "existing", "create", "instance", "start", "tools", "session", "exit23", "source", "gate", "command-receipt", "cleanup-owner", "cleanup", "helper-push"} {
		for _, suffix := range []string{"stdout", "stderr", "process.json"} {
			names = append(names, step+"."+suffix)
		}
	}
	return names
}

type fileRecord struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Bytes  int    `json:"bytes,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}
type manifest struct {
	Version  int          `json:"version"`
	Attempt  string       `json:"attempt_id"`
	Complete bool         `json:"complete"`
	Files    []fileRecord `json:"files"`
}

// Pin every directory descriptor without following symlinks, including parents.
// Final file checks use fstat on that same opened descriptor (no stat/open race).
func openDirectory(path string) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("invalid directory")
	}
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(path, "/"), "/") {
		if part == "" {
			continue
		}
		next, e := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), path), nil
}

func readSelected(dir *os.File, name string) ([]byte, string) {
	if dir == nil {
		return nil, "source_unavailable"
	}
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ENOENT) {
		return nil, "missing"
	}
	if err != nil {
		return nil, "unsafe_or_unavailable"
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, "unsafe_or_unavailable"
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || stat.Nlink != 1 || info.Size() > FileLimit {
		return nil, "unsafe_type_links_or_size"
	}
	data, err := io.ReadAll(io.LimitReader(f, FileLimit+1))
	if err != nil || len(data) > FileLimit {
		return nil, "read_failed_or_oversized"
	}
	after, err := f.Stat()
	if err != nil {
		return nil, "changed_during_read"
	}
	final, ok := after.Sys().(*syscall.Stat_t)
	if !ok || final.Nlink != 1 || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) || len(data) != int(info.Size()) {
		return nil, "changed_during_read"
	}
	return data, "exported"
}

func writeSelected(dir *os.File, name string, data []byte) error {
	fd, err := syscall.Openat(int(dir.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), name)
	_, err = f.Write(data)
	closeErr := f.Close()
	return errors.Join(err, closeErr)
}

func tail(data []byte) string {
	if len(data) > 4096 {
		data = data[len(data)-4096:]
	}
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' || (!unicode.IsControl(r) && r != '\u007f') {
			return r
		}
		return -1
	}, string(data))
}

func export(root, attempt, output string) error {
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(attempt) {
		return errors.New("canonical attempt UUIDv4 required")
	}
	if !filepath.IsAbs(output) || filepath.Clean(output) != output {
		return errors.New("invalid output path")
	}
	parent, err := openDirectory(filepath.Dir(output))
	if err != nil {
		return errors.New("output parent unavailable")
	}
	defer parent.Close()
	if err = syscall.Mkdirat(int(parent.Fd()), filepath.Base(output), 0700); err != nil {
		return errors.New("fresh output directory required")
	}
	fd, err := syscall.Openat(int(parent.Fd()), filepath.Base(output), syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return errors.New("output unavailable")
	}
	dest := os.NewFile(uintptr(fd), output)
	defer dest.Close()
	var source *os.File
	if filepath.IsAbs(root) && filepath.Clean(root) == root {
		source, _ = openDirectory(filepath.Join(root, attempt))
	}
	if source != nil {
		defer source.Close()
	}
	m := manifest{Version: 1, Attempt: attempt, Complete: true}
	var stdout, stderr []byte
	for _, name := range selected() {
		data, status := readSelected(source, name)
		record := fileRecord{Name: name, Status: status}
		if status == "exported" {
			if err = writeSelected(dest, name, data); err != nil {
				return errors.New("evidence output failed")
			}
			hash := sha256.Sum256(data)
			record.Bytes, record.SHA256 = len(data), hex.EncodeToString(hash[:])
			if name == "gate.stdout" {
				stdout = data
			}
			if name == "gate.stderr" {
				stderr = data
			}
		} else if status != "missing" || name == "receipt.json" || strings.HasPrefix(name, "gate.") {
			m.Complete = false
		}
		m.Files = append(m.Files, record)
	}
	data, _ := json.MarshalIndent(m, "", "  ")
	if err = writeSelected(dest, "export.json", append(data, '\n')); err != nil {
		return errors.New("manifest output failed")
	}
	summary := fmt.Sprintf("Attempt %s; evidence complete=%t. Diagnostics are untrusted gate output.\n\nGate stderr (last 4096 bytes):\n%s\n\nGate stdout (last 4096 bytes):\n%s\n", attempt, m.Complete, tail(stderr), tail(stdout))
	if err = writeSelected(dest, "summary.txt", []byte(summary)); err != nil {
		return errors.New("summary output failed")
	}
	if !m.Complete {
		return errors.New("evidence incomplete; see export.json for unavailable files")
	}
	return nil
}

func Main(args []string, out, errOut io.Writer) int {
	if len(args) == 0 || args[0] != "export" {
		return 2
	}
	f := flag.NewFlagSet("evidence export", flag.ContinueOnError)
	f.SetOutput(errOut)
	root := f.String("root", "", "trusted evidence parent")
	attempt := f.String("attempt-id", "", "controller UUIDv4")
	output := f.String("output", "", "fresh export directory")
	if f.Parse(args[1:]) != nil || f.NArg() != 0 || *root == "" || *attempt == "" || *output == "" {
		return 2
	}
	if err := export(*root, *attempt, *output); err != nil {
		fmt.Fprintln(errOut, err)
		return 1
	}
	fmt.Fprintln(out, "bounded evidence exported")
	return 0
}
