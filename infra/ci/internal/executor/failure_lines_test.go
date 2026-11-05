package executor

import (
	"bytes"
	"strings"
	"testing"
)

func TestSummaryStreamKeepsLateFailingTAPLinesWithinTheLogLimit(t *testing.T) {
	passing := strings.Repeat("ok 1 - passing receiver\n  ---\n  duration_ms: 1\n  ...\n", LogLimit/40)
	failing := "# Subtest: late receiver\nnot ok 900 - late receiver fails\n  ---\n  error: 'Expected values to be strictly equal: 1 !== 2'\n  ...\n"
	tail := strings.Repeat("ok 901 - after\n", 64) + "1..901\n# tests 901\n# pass 900\n# fail 1\n"
	text := passing + failing + tail
	if len(text) <= LogLimit {
		t.Fatal("fixture must exceed the log limit")
	}
	var log bytes.Buffer
	s := &summaryStream{out: &log, prefix: []byte("RESULT=")}
	for start := 0; start < len(text); start += 4093 {
		end := min(start+4093, len(text))
		if _, err := s.Write([]byte(text[start:end])); err != nil {
			t.Fatal(err)
		}
	}
	s.finish()
	got := log.String()
	if log.Len() > LogLimit {
		t.Fatalf("log exceeded limit: %d", log.Len())
	}
	for _, want := range []string{"not ok 900 - late receiver fails", "Expected values to be strictly equal", "# fail 1", "gate output omitted"} {
		if !strings.Contains(got, want) {
			t.Fatalf("log lost %q", want)
		}
	}
	if strings.Contains(got[len(got)-4096:], "ok 901 - after") {
		t.Fatal("passing lines after the cap were kept")
	}
	var unterminated bytes.Buffer
	u := &summaryStream{out: &unterminated, prefix: []byte("RESULT=")}
	if _, err := u.Write([]byte(passing + "not ok 902 - unterminated late failure")); err != nil {
		t.Fatal(err)
	}
	u.finish()
	if unterminated.Len() > LogLimit || !strings.Contains(unterminated.String(), "not ok 902 - unterminated late failure") {
		t.Fatal("unterminated final failure line was lost")
	}
}

func TestSummaryStreamFailureLinesStayBoundedUnderManyFailures(t *testing.T) {
	var log bytes.Buffer
	s := &summaryStream{out: &log, prefix: []byte("RESULT=")}
	line := "not ok 1 - " + strings.Repeat("f", 200) + "\n  ---\n  error: " + strings.Repeat("e", 400) + "\n  ...\n"
	for i := 0; i < 4*LogLimit/len(line); i++ {
		if _, err := s.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	s.finish()
	if log.Len() > LogLimit {
		t.Fatalf("log exceeded limit: %d", log.Len())
	}
}
