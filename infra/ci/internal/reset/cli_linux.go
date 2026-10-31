package reset

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func securePath(path string, directory bool) error {
	if !filepath.IsAbs(path) {
		return failure("ABSOLUTE_PATH_REQUIRED")
	}
	metadata, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if metadata.Mode()&os.ModeSymlink != 0 || metadata.IsDir() != directory {
		return failure("UNSAFE_FILE_TYPE")
	}
	stat, ok := metadata.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != 0 || metadata.Mode().Perm()&0022 != 0 {
		return failure("ROOT_OWNED_PATH_REQUIRED")
	}
	if directory && metadata.Mode().Perm()&0077 != 0 {
		return failure("PRIVATE_STATE_DIRECTORY_REQUIRED")
	}
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		m, e := os.Lstat(parent)
		if e != nil {
			return e
		}
		s, ok := m.Sys().(*syscall.Stat_t)
		if !ok || s.Uid != 0 || !m.IsDir() || m.Mode()&os.ModeSymlink != 0 || m.Mode().Perm()&0022 != 0 {
			return failure("UNSAFE_PARENT_DIRECTORY")
		}
		if parent == "/" {
			break
		}
	}
	return nil
}

// Main handles only validation by default. Real execution additionally needs
// --execute, root-owned non-symlink files, a private ledger, and a host identity.
func Main(args []string, in io.Reader, out, errOut io.Writer, verifier func([]byte, string, string) error) int {
	if len(args) == 0 {
		fmt.Fprintln(errOut, "reset validate|serve --manifest FILE [--state-dir DIR --execute]")
		return 2
	}
	command := args[0]
	if command != "validate" && command != "serve" {
		fmt.Fprintln(errOut, "unknown reset command")
		return 2
	}
	flags := flag.NewFlagSet("reset "+command, flag.ContinueOnError)
	flags.SetOutput(errOut)
	manifestPath := flags.String("manifest", "", "enrolled manifest; never supplied by a job")
	stateDir := flags.String("state-dir", "", "root-owned private ledger")
	execute := flags.Bool("execute", false, "explicit privileged operation")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 || *manifestPath == "" {
		return 2
	}
	emitError := func(err error, receipt Receipt) int {
		if receipt.SchemaVersion == 0 {
			receipt = Receipt{SchemaVersion: 1, OK: false, Phase: "blocked", Error: codeOf(err)}
		}
		_ = json.NewEncoder(out).Encode(receipt)
		switch codeOf(err) {
		case "RESET_BUSY", "STALE_GENERATION", "RESET_RATE_LIMIT":
			return 75
		default:
			return 78
		}
	}
	if command == "serve" {
		if !*execute || os.Geteuid() != 0 {
			return emitError(failure("EXPLICIT_ROOT_EXECUTION_REQUIRED"), Receipt{})
		}
		if os.Getenv("SSH_ORIGINAL_COMMAND") != "" {
			return emitError(failure("SSH_COMMAND_FORBIDDEN"), Receipt{})
		}
		if err := securePath(*manifestPath, false); err != nil {
			return emitError(err, Receipt{})
		}
		binary, err := os.Executable()
		if err != nil {
			return emitError(err, Receipt{})
		}
		if err = securePath(binary, false); err != nil {
			return emitError(err, Receipt{})
		}
		// Install creates this directory; a request may not create a new root path.
		if err = securePath(*stateDir, true); err != nil {
			return emitError(err, Receipt{})
		}
	}
	file, err := os.Open(*manifestPath)
	if err != nil {
		return emitError(err, Receipt{})
	}
	data, err := ReadBounded(file, 65536)
	_ = file.Close()
	if err != nil {
		return emitError(err, Receipt{})
	}
	manifest, err := DecodeManifest(data)
	if err != nil {
		return emitError(err, Receipt{})
	}
	if command == "validate" {
		_ = json.NewEncoder(out).Encode(map[string]any{"ok": true, "status": "validated-config-only", "manifest_sha256": manifest.Digest(), "vmid": manifest.VMID})
		return 0
	}
	payload, err := ReadBounded(in, 4096)
	if err != nil {
		return emitError(err, Receipt{})
	}
	request, err := DecodeRequest(payload)
	if err != nil {
		return emitError(err, Receipt{})
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(manifest.OperationTimeoutSeconds+manifest.BootTimeoutSeconds+30)*time.Second)
	defer cancel()
	service := Service{Manifest: manifest, Store: Store{Directory: *stateDir}, Backend: PVEBackend{Manifest: manifest, Runner: ExecRunner{}, VerifyNetwork: verifier}}
	receipt, err := service.Execute(ctx, request)
	if err != nil {
		return emitError(err, receipt)
	}
	_ = json.NewEncoder(out).Encode(receipt)
	return 0
}
