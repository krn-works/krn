package main

import (
	"bytes"
	"testing"
)

func TestCLIRejectsUnconfiguredOrUnknownOperation(t *testing.T) {
	for _, args := range [][]string{nil, {"unknown"}, {"network"}, {"network", "apply"}, {"network", "render"}, {"network", "digest"}, {"network", "verify", "--prefix", "ci_fixture"}} {
		var in, out, errOut bytes.Buffer
		if code := run(args, &in, &out, &errOut); code != 2 {
			t.Fatalf("args=%v exit=%d", args, code)
		}
	}
	var in, out, errOut bytes.Buffer
	if code := run([]string{"reset", "serve", "--manifest", "/unopened"}, &in, &out, &errOut); code != 78 {
		t.Fatalf("unconfigured execution exit=%d", code)
	}
}
