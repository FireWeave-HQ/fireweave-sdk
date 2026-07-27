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

func TestConformanceFixtures(t *testing.T) {
	report, err := conformance.Run(contractsDir(t))
	if err != nil {
		t.Fatalf("conformance run: %v", err)
	}
	for _, r := range report.Results {
		r := r
		t.Run(r.FixtureID, func(t *testing.T) {
			switch r.Status {
			case "pass":
			case "skipped-with-documented-limitation":
				if r.Limitation != nil {
					t.Skipf("documented limitation: %s", *r.Limitation)
				}
				t.Skip("documented limitation")
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
