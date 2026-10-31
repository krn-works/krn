package executor

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
)

func loadInput(path string, into any, stdin io.Reader, allowStdin bool) error {
	if path == "-" && allowStdin {
		return Decode(stdin, into)
	}
	if err := noSymlinks(path); err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return errors.New("JSON input unavailable")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("JSON input must be a regular file")
	}
	return Decode(f, into)
}

// Main is the root CLI delegation boundary. Root must route `executor` here;
// the same binary is copied into the guest for private helper operations.
// Default behavior only prints a plan. --execute requires an explicit profile.
func Main(args []string, in io.Reader, out, errOut io.Writer) int {
	if len(args) > 0 && args[0] == "__guest" {
		return guestMain(args[1:], out, errOut)
	}
	if len(args) == 1 && args[0] == "__host-memory" {
		return hostMemory(out)
	}
	flags := flag.NewFlagSet("executor", flag.ContinueOnError)
	flags.SetOutput(errOut)
	profilePath := flags.String("profile", "", "absolute path to reviewed controller-owned profile")
	specPath := flags.String("spec", "", "absolute JSON job spec path, or - for stdin")
	bundle := flags.String("bundle", "", "absolute full Git bundle path")
	evidence := flags.String("evidence-root", "", "absolute per-attempt evidence parent")
	mode := flags.String("mode", string(Preflight), "preflight or gate (gate always runs preflight first)")
	execute := flags.Bool("execute", false, "explicitly execute the validated plan")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 || *profilePath == "" || *specPath == "" || *bundle == "" || *evidence == "" {
		fmt.Fprintln(errOut, "--profile, --spec, --bundle and --evidence-root are required; no positional arguments")
		return 2
	}
	var profile Profile
	var spec JobSpec
	if err := loadInput(*profilePath, &profile, in, false); err != nil {
		fmt.Fprintln(errOut, "invalid profile:", err)
		return 2
	}
	if err := loadInput(*specPath, &spec, in, true); err != nil {
		fmt.Fprintln(errOut, "invalid job spec:", err)
		return 2
	}
	binary, err := os.Executable()
	if err != nil {
		fmt.Fprintln(errOut, "executor binary unavailable")
		return 2
	}
	plan, err := Plan(profile, spec, Options{BundlePath: *bundle, BinaryPath: binary, EvidenceRoot: *evidence, Mode: Mode(*mode)})
	if err != nil {
		fmt.Fprintln(errOut, err)
		return 2
	}
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	if !*execute {
		if encoder.Encode(struct {
			Execute   bool      `json:"execute"`
			Mode      Mode      `json:"mode"`
			Expected  JobSpec   `json:"expected"`
			CommandID string    `json:"command_id"`
			Commands  []Command `json:"commands"`
		}{false, plan.options.Mode, spec, commandID(plan.gate), plan.Commands()}) != nil {
			return 1
		}
		return 0
	}
	receipt := Execute(context.Background(), plan, ProcessTransport{})
	if encoder.Encode(receipt) != nil {
		return 1
	}
	return receipt.ExitStatus()
}
