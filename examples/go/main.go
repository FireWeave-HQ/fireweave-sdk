// Command example demonstrates the Fireweave Go SDK's v1 surface:
//
//  1. fireweave.Init — the single entry point (spec/modes.md): local
//     (offline, default) or remote (--remote / FW_API_URL set),
//  2. a boolean control-point read + detailed resolution, with a targeting
//     context,
//  3. RegisterTarget — durable targeting facts, once per login,
//  4. clean, deadline-bounded shutdown.
//
// Stub: node test-server/implementation/server.mjs  (127.0.0.1:3901)
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"slices"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/fireweave"
)

func main() {
	useRemote := slices.Contains(os.Args[1:], "--remote")
	apiURL := os.Getenv("FW_API_URL")
	if apiURL != "" {
		useRemote = true
	}

	// 1. fireweave.Init is the single entry point (spec/modes.md) — it
	// validates the mode, builds the matching adapter, and brings the
	// client to READY.
	var (
		client *fireweave.Client
		err    error
	)
	if useRemote {
		if apiURL == "" {
			apiURL = "http://127.0.0.1:3901"
		}
		apiKey := os.Getenv("FW_PROJECT_API_KEY")
		if apiKey == "" {
			apiKey = "project-api-key_dev"
		}
		client, err = fireweave.Init(fireweave.Options{
			Mode:   fireweave.ModeRemote,
			APIURL: apiURL,
			APIKey: apiKey,
		})
	} else {
		// Local mode seeds a deterministic in-process map — no network, no
		// credentials. Great for tests and offline dev.
		client, err = fireweave.Init(fireweave.Options{
			Mode:  fireweave.ModeLocal,
			Local: &fireweave.LocalOptions{ControlPoints: map[string]bool{"new-checkout": true}},
		})
	}
	if err != nil {
		log.Fatalf("init failed: %v", err)
	}

	// Stub fixture key when talking to the Fireweave remote protocol.
	boolFlag := "new-checkout"
	if useRemote {
		boolFlag = "fw-bool-on"
	}

	// 2. Evaluate a boolean control point with a targeting context.
	evalCtx := fireweave.NewEvaluationContext("user_01HZXEXAMPLE0000000000001", map[string]any{
		"plan": "pro",
	})
	enabled := client.ControlPoints().GetBooleanValue(boolFlag, false, &evalCtx)
	fmt.Printf("%s enabled: %v\n", boolFlag, enabled)

	// 3. Detailed resolution: value + variant + reason (upgrades from
	// GetBooleanValue without restructuring the call).
	details := client.ControlPoints().GetBooleanDetails(boolFlag, false, &evalCtx)
	fmt.Printf("%s details: value=%v variant=%q reason=%s\n", boolFlag, details.Value, details.Variant, details.Reason)

	// 4. Register the durable targeting facts for this user — once per
	// login, not on every evaluation. Resolves OK: false rather than
	// erroring (it runs in sign-in paths); the offline default and the
	// --remote stub (which has no /v1/targets/register route) both degrade
	// the same, honest way.
	registered := client.RegisterTarget(evalCtx.TargetingKey, &fireweave.RegisterTargetOptions{
		Kind:       fireweave.TargetKindUser,
		Properties: map[string]any{"plan": "pro"},
	})
	if registered.OK {
		fmt.Println("registerTarget ok: true")
	} else {
		fmt.Printf("registerTarget ok: false (%s)\n", registered.Error.Kind)
	}

	// 5. Clean shutdown, bounded by context.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Runtime().Shutdown(shutdownCtx); err != nil {
		log.Fatalf("shutdown: %v", err)
	}
	fmt.Println("shut down cleanly")
}
