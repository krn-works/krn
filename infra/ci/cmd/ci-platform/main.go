// ci-platform is a Linux-only tool. It has no installer or automatic deployment.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"krn.local/ci-platform/internal/evidence"
	"krn.local/ci-platform/internal/executor"
	"krn.local/ci-platform/internal/globalgate"
	"krn.local/ci-platform/internal/network"
	"krn.local/ci-platform/internal/reset"
)

func run(args []string, in io.Reader, out, errOut io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(errOut, "ci-platform reset|network|executor (read infra/ci/README.md before enrollment)")
		return 2
	}
	switch args[0] {
	case "evidence":
		return evidence.Main(args[1:], out, errOut)
	case "global":
		return globalgate.Main(args[1:], in, out, errOut)
	case "reset":
		return reset.Main(args[1:], in, out, errOut, network.VerifyPolicy)
	case "executor":
		return executor.Main(args[1:], in, out, errOut)
	case "network":
		return networkCommand(args[1:], in, out, errOut)
	default:
		fmt.Fprintln(errOut, "unknown component")
		return 2
	}
}

func networkCommand(args []string, in io.Reader, out, errOut io.Writer) int {
	if len(args) == 0 {
		return 2
	}
	f := flag.NewFlagSet("network "+args[0], flag.ContinueOnError)
	f.SetOutput(errOut)
	configPath := f.String("config", "", "network manifest for render")
	format := f.String("format", "json", "json, nft or interfaces")
	prefix := f.String("prefix", "", "owned table prefix for digest/verify")
	want := f.String("sha256", "", "expected policy digest for verify")
	if f.Parse(args[1:]) != nil || f.NArg() != 0 {
		return 2
	}
	fail := func(err error) int { fmt.Fprintln(errOut, err); return 1 }
	switch args[0] {
	case "render":
		if *configPath == "" || (*format != "json" && *format != "nft" && *format != "interfaces") {
			return 2
		}
		file, err := os.Open(*configPath)
		if err != nil {
			return fail(err)
		}
		defer file.Close()
		data, err := reset.ReadBounded(file, 65536)
		if err != nil {
			return fail(err)
		}
		config, err := network.Decode(data)
		if err != nil {
			return fail(err)
		}
		bundle, err := network.Render(config)
		if err != nil {
			return fail(err)
		}
		switch *format {
		case "nft":
			_, err = io.WriteString(out, bundle.NFTables)
		case "interfaces":
			_, err = io.WriteString(out, bundle.Interfaces)
		default:
			err = json.NewEncoder(out).Encode(bundle)
		}
		if err != nil {
			return fail(err)
		}
		return 0
	case "digest", "verify":
		if *prefix == "" {
			return 2
		}
		data, err := reset.ReadBounded(in, 16<<20)
		if err != nil {
			return fail(err)
		}
		if args[0] == "verify" {
			if *want == "" {
				return 2
			}
			if err = network.VerifyPolicy(data, *prefix, *want); err != nil {
				return fail(err)
			}
			_, err = fmt.Fprintln(out, "policy-matches")
		} else {
			var digest string
			digest, err = network.PolicyDigest(data, *prefix)
			if err == nil {
				_, err = fmt.Fprintln(out, digest)
			}
		}
		if err != nil {
			return fail(err)
		}
		return 0
	default:
		return 2
	}
}

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
