package control

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"krn.local/ci-platform/internal/executor"
)

func Main(args []string, in io.Reader, out, errOut io.Writer) int {
	if len(args) == 0 {
		return 2
	}
	command := args[0]
	if command != "prepare" && command != "finish" && command != "verify" && command != "status" {
		return 2
	}
	f := flag.NewFlagSet("control "+command, flag.ContinueOnError)
	f.SetOutput(errOut)
	configPath := f.String("config", "", "root-owned controller configuration")
	specPath := f.String("spec", "", "admitted job spec")
	bundle := f.String("bundle", "", "full source bundle")
	resultPath := f.String("receipt", "", "executor result JSON")
	attempt := f.String("attempt-id", "", "attempt to finish/reconcile")
	stateDir := f.String("state-dir", "", "existing private controller ledger")
	execute := f.Bool("execute", false, "explicit controller effects")
	if f.Parse(args[1:]) != nil || f.NArg() != 0 {
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(errOut, err)
		_ = json.NewEncoder(out).Encode(map[string]any{"ok": false, "error": err.Error()})
		return 1
	}
	if command == "status" {
		if !canonical(*stateDir) {
			return 2
		}
		state, err := (Store{*stateDir}).Read()
		if err != nil {
			return fail(err)
		}
		if err = json.NewEncoder(out).Encode(state); err != nil {
			return 1
		}
		return 0
	}
	if *configPath == "" {
		return 2
	}
	var c Config
	var configErr error
	if *execute || command == "verify" {
		var file *os.File
		file, configErr = openRootOwnedConfig(*configPath)
		if configErr == nil {
			configErr = executor.Decode(file, &c)
			_ = file.Close()
		}
	} else {
		configErr = readJSON(*configPath, &c)
	}
	if configErr != nil {
		return fail(configErr)
	}
	if err := c.Validate(); err != nil {
		return fail(err)
	}
	var spec executor.JobSpec
	if command == "prepare" || command == "verify" {
		if *specPath == "" {
			return 2
		}
		if err := readJSON(*specPath, &spec); err != nil {
			return fail(err)
		}
		if _, err := c.profile(spec); err != nil {
			return fail(err)
		}
	}
	if command == "verify" {
		if *resultPath == "" {
			return 2
		}
		var result executor.Receipt
		if err := readJSON(*resultPath, &result); err != nil {
			return fail(err)
		}
		if err := Verify(c, spec, result); err != nil {
			return fail(err)
		}
		_ = json.NewEncoder(out).Encode(map[string]any{"ok": true, "source_sha": spec.SourceSHA, "attempt_id": spec.AttemptID})
		return 0
	}
	if !canonical(*stateDir) || (command == "prepare" && !canonical(*bundle)) || (command == "finish" && !uuid.MatchString(*attempt)) {
		return 2
	}
	if !*execute {
		_ = json.NewEncoder(out).Encode(map[string]any{"execute": false, "operation": command})
		return 0
	}
	if err := validateSSHFiles(c.PVE); err != nil {
		return fail(err)
	}
	if err := validateSSHFiles(c.Runner); err != nil {
		return fail(err)
	}
	service := Service{Config: c, Store: Store{*stateDir}, Backend: SSHBackend{Config: c, StateDirectory: *stateDir, Runner: ProcessRunner{}}}
	ctx, cancel := operationContext()
	defer cancel()
	var result Receipt
	var err error
	if command == "prepare" {
		result, err = service.Prepare(ctx, spec, *bundle)
	} else {
		result, err = service.Finish(ctx, *attempt)
	}
	if err != nil {
		if result.Phase != "" {
			_ = json.NewEncoder(out).Encode(result)
			return 1
		}
		return fail(err)
	}
	if err = json.NewEncoder(out).Encode(result); err != nil {
		return 1
	}
	return 0
}
