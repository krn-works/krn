// Package admission checks policy bytes from the exact admitted Product base.
// It never loads commands or admission decisions from PR-head policy.
package admission

import (
	"bytes"
	"fmt"
	"io"

	"krn.local/ci-platform/internal/executor"
)

func Main(args []string, in io.Reader, out, errOut io.Writer) int {
	if len(args) != 1 || args[0] != "product-base" {
		return 2
	}
	// Map lookup preserves exact JSON key spelling, unlike encoding/json's
	// case-insensitive struct matching. Numbers use the same JSON-number value
	// semantics as the authoritative JavaScript policy consumer.
	var policy map[string]any
	data, err := io.ReadAll(io.LimitReader(in, 4097))
	if err != nil || len(data) > 4096 || executor.Decode(bytes.NewReader(data), &policy) != nil || len(policy) != 3 || policy["schemaVersion"] != float64(1) || policy["checkRunName"] != "krn/gate" || policy["appId"] != float64(5548482) {
		fmt.Fprintln(errOut, "Product base CI policy is missing or incompatible; update branch from main or reconcile base CI policy")
		return 1
	}
	fmt.Fprintln(out, "exact Product base selects native CI")
	return 0
}
