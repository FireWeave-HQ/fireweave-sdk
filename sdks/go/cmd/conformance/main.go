// Command conformance runs the contracts/ fixtures against the Fireweave Go
// SDK's v1 control-points surface (fireweave.Client.ControlPoints — no
// OpenFeature bridge, retired by ADR-0010; in-memory / remote-adapter
// backends) and writes the compatibility report JSON.
//
// Usage:
//
//	go run ./cmd/conformance -contracts ../../contracts -out compatibility-report.go.json
//
// Exit status is non-zero when any fixture fails.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/internal/conformance"
)

func main() {
	contractsDir := flag.String("contracts", "../../contracts", "path to the contracts/ directory")
	outPath := flag.String("out", "compatibility-report.go.json", "report output path ('-' for stdout)")
	flag.Parse()

	report, err := conformance.Run(*contractsDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "conformance: %v\n", err)
		os.Exit(2)
	}

	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "conformance: encode report: %v\n", err)
		os.Exit(2)
	}
	if *outPath == "-" {
		fmt.Println(string(encoded))
	} else {
		if err := os.WriteFile(*outPath, append(encoded, '\n'), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "conformance: write report: %v\n", err)
			os.Exit(2)
		}
	}

	for _, r := range report.Results {
		if r.Status == "fail" {
			msg := ""
			if r.Message != nil {
				msg = *r.Message
			}
			fmt.Fprintf(os.Stderr, "FAIL %s (%s): %s\n", r.FixtureID, r.Suite, msg)
		}
	}
	// Written to stderr (not stdout) so `-out -` leaves stdout as pure JSON.
	fmt.Fprintf(os.Stderr, "conformance: pass=%d fail=%d skipped-with-documented-limitation=%d skipped-v1-out-of-scope=%d\n",
		report.Summary["pass"], report.Summary["fail"],
		report.Summary["skipped-with-documented-limitation"], report.Summary["skipped-v1-out-of-scope"])
	if report.Summary["fail"] > 0 {
		os.Exit(1)
	}
}
