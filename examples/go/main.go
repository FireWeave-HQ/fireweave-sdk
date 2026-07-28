// Command example demonstrates the Fireweave Go SDK end to end:
//
//  1. provider construction (in-memory by default; PostHog-backed when
//     FW_PROJECT_API_KEY and FW_POSTHOG_HOST are set),
//  2. OpenFeature registration and boolean evaluation,
//  3. detailed resolution with variant/reason/metadata,
//  4. targeting context (targetingKey → distinct_id),
//  5. FireweaveClient extensions: Releases.SetContext + Signals.RecordHealth,
//  6. clean, deadline-bounded shutdown.
//
// The example is offline by default: without PostHog credentials it runs
// entirely against the deterministic in-memory adapter.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/inmemory"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/posthog"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	fwprovider "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/openfeature"
	of "github.com/open-feature/go-sdk/openfeature"
)

func buildAdapter() fireweave.BackendAdapter {
	apiKey := os.Getenv("FW_PROJECT_API_KEY")
	host := os.Getenv("FW_POSTHOG_HOST")
	if apiKey != "" && host != "" {
		fmt.Println("mode: PostHog-backed (live)")
		return posthog.New(posthog.Config{
			ProjectAPIKey:      apiKey,
			SecretKey:          os.Getenv("FW_SECRET_KEY"), // optional: enables local evaluation
			Endpoint:           host,
			FlagRequestTimeout: 3 * time.Second,
			CloseTimeout:       5 * time.Second,
		})
	}

	fmt.Println("mode: in-memory (offline by default)")
	version := int64(4)
	return inmemory.New(inmemory.WithFlags(map[string]inmemory.Flag{
		"checkout-redesign": {
			Type: fireweave.FlagTypeBoolean, Enabled: true, Variant: "on", Value: true,
			Version: &version, ReasonCode: "condition_match",
		},
		"theme": {
			Type: fireweave.FlagTypeString, Enabled: true, Variant: "dark", Value: "dark",
			// Only organizations on the "pro" tier get the dark theme.
			MatchAttributes: map[string]any{"tier": "pro"},
		},
	}))
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 1. Build the Fireweave runtime + client + provider.
	runtime := fireweave.NewRuntime(buildAdapter(), fireweave.Config{
		RequireTargetingKey: true,
	})
	client := fireweave.NewClient(runtime)
	provider := fwprovider.NewProvider(client)

	// 2. Register with OpenFeature and wait for READY.
	if err := of.SetProviderAndWait(provider); err != nil {
		log.Fatalf("provider initialization failed: %v", err)
	}
	ofClient := of.NewClient("example-app")

	// 4. Targeting context: targetingKey maps to the PostHog distinct_id.
	evalCtx := of.NewEvaluationContext("org_01HZXEXAMPLE0000000000001", map[string]any{
		"tier":   "pro",
		"region": "us",
	})

	// 2. Simple boolean evaluation (defaults are returned, never thrown).
	enabled := ofClient.Boolean(ctx, "checkout-redesign", false, evalCtx)
	fmt.Printf("checkout-redesign enabled: %v\n", enabled)

	// 3. Detailed resolution: variant, reason, and fireweave.* metadata.
	details, err := ofClient.StringValueDetails(ctx, "theme", "light", evalCtx)
	if err != nil {
		fmt.Printf("theme fell back to default %q (%s: %s)\n", details.Value, details.ErrorCode, details.ErrorMessage)
	} else {
		fmt.Printf("theme = %q variant=%q reason=%s metadata=%v\n",
			details.Value, details.Variant, details.Reason, details.FlagMetadata)
	}

	// 5. Fireweave extensions: bind the rollout and report health.
	// stampIds/changeId are typed 26-char Crockford ULIDs, validated
	// against spec/release-context.schema.json by SetContext.
	release := fireweave.ReleaseContext{
		RolloutID: "rollout_example_checkout_redesign",
		ChangeID:  "chg_01HZXEG0000000000000000001",
		StampIDs:  []string{"stmp_01HZXEG0000000000000000001"},
	}
	if err := client.Releases().SetContext(ctx, release); err != nil {
		log.Fatalf("release context: %v", err)
	}
	if err := client.Signals().RecordHealth(ctx, fireweave.HealthSignal{
		Name: "provider", Status: "ok", RolloutID: release.RolloutID,
	}); err != nil {
		log.Fatalf("health signal: %v", err)
	}
	caps := client.Capabilities().Get()
	fmt.Printf("release bound: %s (backend=%s lifecycle=%s operations=%v)\n",
		release.RolloutID, caps.Runtime.Backend, caps.Runtime.Lifecycle, client.Capabilities().Operations())

	// 6. Clean shutdown: bounded by context, idempotent.
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := of.ShutdownWithContext(shutdownCtx); err != nil {
		log.Fatalf("shutdown: %v", err)
	}
	fmt.Println("shut down cleanly")
}
