// Package conformance_test runs the canonical contracts fixtures under
// `go test` (harness.md: sdks/go/conformance/harness_test.go).
package conformance_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/internal/conformance"
)

func contractsDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join("..", "..", "..", "contracts")
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("contracts directory not found at %s: %v", dir, err)
	}
	return dir
}

// knownGaps lists fixtures with a genuine, out-of-scope divergence between
// their frozen "pass" declaration and actual v1 SDK behavior — these are
// skipped here (not silently: t.Skip's reason names the concern), rather
// than left failing the whole suite. internal/conformance.Run's own report
// (compatibility-report.go.json, written by cmd/conformance) still carries
// their TRUE "fail" status — only this test wrapper softens the
// CI-blocking consequence. See
// .superpowers/sdd/IMPLEMENTATION-PLAN/task-10-report.md "Concerns" for the
// original writeup and task-10b-report.md for what since got fixed.
//
// task-10b fixed eval-int-beyond-safe-integer (convertValue/numberValue now
// preserve integral values exactly), fault-timeout (postJSON derives its own
// per-request context.WithTimeout), and eval-payload-attached (EvaluateOptions
// now carries a real IncludePayload field, threaded through ResolveRequest to
// both inmemory and remote adapters) — all removed below; their fixed status
// now flows through the ordinary pass path. eval-numeric-coercion-int-float's
// compatibility.go was flipped to skipped-with-documented-limitation
// (controller-ruled fixture edit) and is handled generically by
// internal/conformance's own declared-skip path — also removed below.
var knownGaps = map[string]string{}

func TestConformanceFixtures(t *testing.T) {
	report, err := conformance.Run(contractsDir(t))
	if err != nil {
		t.Fatalf("conformance run: %v", err)
	}
	for _, r := range report.Results {
		r := r
		t.Run(r.FixtureID, func(t *testing.T) {
			if reason, known := knownGaps[r.FixtureID]; known && r.Status == "fail" {
				t.Skipf("known gap (Task 10 scope limits): %s", reason)
			}
			switch r.Status {
			case "pass":
			case "skipped-with-documented-limitation", "skipped-v1-out-of-scope":
				if r.Limitation != nil {
					t.Skipf("%s: %s", r.Status, *r.Limitation)
				}
				t.Skip(r.Status)
			default:
				msg := ""
				if r.Message != nil {
					msg = *r.Message
				}
				t.Errorf("fixture failed: %s", msg)
			}
		})
	}
	if report.Summary["fail"] == 0 && report.Summary["pass"] == 0 {
		t.Fatal("no fixtures executed")
	}
}
