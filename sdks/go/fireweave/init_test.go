package fireweave

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/domain"
)

// Init — the single entry point (spec/modes.md).
//
// Covers every row of the initialisation-validation table, both modes'
// adapter selection, and the "does nothing else conditional on mode"
// property: Init and Client/ControlPoints themselves never branch on mode
// past adapter selection — any behavioural difference between modes lives
// entirely in the adapter seam (spec/modes.md "Behaviour per mode"). That
// table has one deliberately DIVERGENT row — an unknown control point
// resolves default/DEFAULT in local mode but default/ERROR/FlagNotFound in
// remote — asserted per-mode below, not as a shared shape. registerTarget
// genuinely IS shape-identical across modes (resolves ok:true, never
// panics), asserted below too.

// ------------------------------------------------------------------ initialisation-validation table

func TestModeAbsentIsConfiguration(t *testing.T) {
	_, err := Init(Options{})
	if err == nil {
		t.Fatal("expected an error")
	}
	fwErr, ok := err.(*Error)
	if !ok || fwErr.Kind != KindConfiguration {
		t.Fatalf("err = %v (%T), want *Error{Kind: Configuration}", err, err)
	}
}

func TestRemoteModeWithApiKeyMissingIsConfiguration(t *testing.T) {
	_, err := Init(Options{Mode: ModeRemote, APIURL: "https://app-server.fireweave.ai"})
	assertConfigurationError(t, err)
}

func TestRemoteModeWithApiUrlMissingIsConfiguration(t *testing.T) {
	_, err := Init(Options{Mode: ModeRemote, APIKey: "project-api-key_test"})
	assertConfigurationError(t, err)
}

func TestRemoteModeWithBlankApiKeyOrApiUrlIsConfiguration(t *testing.T) {
	_, err := Init(Options{Mode: ModeRemote, APIKey: "   ", APIURL: "https://app-server.fireweave.ai"})
	assertConfigurationError(t, err)
	_, err = Init(Options{Mode: ModeRemote, APIKey: "project-api-key_test", APIURL: "   "})
	assertConfigurationError(t, err)
}

func TestApiUrlFailingTheHostAllowlistIsConfiguration(t *testing.T) {
	_, err := Init(Options{Mode: ModeRemote, APIKey: "project-api-key_test", APIURL: "https://evil.example.com"})
	assertConfigurationError(t, err)
}

func TestLocalModeWithCredentialsSuppliedIsConfiguration(t *testing.T) {
	_, err := Init(Options{Mode: ModeLocal, APIKey: "project-api-key_test"})
	assertConfigurationError(t, err)
	_, err = Init(Options{Mode: ModeLocal, APIURL: "https://app-server.fireweave.ai"})
	assertConfigurationError(t, err)
	_, err = Init(Options{
		Mode: ModeLocal, APIKey: "project-api-key_test", APIURL: "https://app-server.fireweave.ai",
		Local: &LocalOptions{ControlPoints: map[string]bool{}},
	})
	assertConfigurationError(t, err)
}

func TestLocalModeWithBlankApiKeyApiUrlIsNotTreatedAsSupplied(t *testing.T) {
	client, err := Init(Options{Mode: ModeLocal, APIKey: "", APIURL: "   ", Local: &LocalOptions{ControlPoints: map[string]bool{}}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if client == nil {
		t.Fatal("expected a client")
	}
}

func assertConfigurationError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	fwErr, ok := err.(*Error)
	if !ok || fwErr.Kind != KindConfiguration {
		t.Fatalf("err = %v (%T), want *Error{Kind: Configuration}", err, err)
	}
}

// ------------------------------------------------------------------ adapter selection

func TestLocalModeSelectsLocalAdapterSeedsTheMapAndReachesReady(t *testing.T) {
	client, err := Init(Options{Mode: ModeLocal, Local: &LocalOptions{ControlPoints: map[string]bool{"checkout-v2": true}}})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if client.Runtime().State() != StateReady {
		t.Fatalf("state = %s, want READY", client.Runtime().State())
	}

	if on := client.ControlPoints().GetBooleanValue("checkout-v2", false, nil); !on {
		t.Error("expected the seeded control point to resolve true")
	}
	details := client.ControlPoints().GetBooleanDetails("checkout-v2", false, nil)
	if details.Reason != ReasonStatic {
		t.Errorf("reason = %s, want STATIC", details.Reason)
	}
}

func TestLocalModeAllowsEmptyOrOmittedControlPointsMap(t *testing.T) {
	empty, err := Init(Options{Mode: ModeLocal, Local: &LocalOptions{ControlPoints: map[string]bool{}}})
	if err != nil || empty.Runtime().State() != StateReady {
		t.Fatalf("empty map: client=%v err=%v", empty, err)
	}
	omitted, err := Init(Options{Mode: ModeLocal})
	if err != nil || omitted.Runtime().State() != StateReady {
		t.Fatalf("omitted local options: client=%v err=%v", omitted, err)
	}
}

func TestRemoteModeSelectsRemoteAdapterAndEvaluatesOverEvaluatePath(t *testing.T) {
	var lastAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"decisions": []map[string]any{{
				"flagKey": "checkout-v2", "value": true, "reason": "TARGETING_MATCH", "found": true, "enabled": true,
			}},
		})
	}))
	defer srv.Close()

	client, err := Init(Options{Mode: ModeRemote, APIKey: "project-api-key_test", APIURL: srv.URL})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if client.Runtime().State() != StateReady {
		t.Fatalf("state = %s, want READY", client.Runtime().State())
	}

	ctx := domain.NewEvaluationContext("user-1", nil)
	on := client.ControlPoints().GetBooleanValue("checkout-v2", false, &ctx)
	if !on {
		t.Error("expected the remote decision to resolve true")
	}
	if lastAuth != "Bearer project-api-key_test" {
		t.Fatalf("auth header = %q", lastAuth)
	}
}

func TestRemoteModeExplicitAllowedHostsOverridePermitsASelfHostedApiUrl(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"decisions": []map[string]any{}})
	}))
	defer srv.Close()

	client, err := Init(Options{
		Mode: ModeRemote, APIKey: "project-api-key_test", APIURL: srv.URL,
		AllowedHosts: []string{"127.0.0.1", "localhost"},
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if client.Runtime().State() != StateReady {
		t.Fatalf("state = %s, want READY", client.Runtime().State())
	}
}

// ------------------------------------------------------------------ nothing else conditional on mode

func TestReadsNeverThrowInEitherModeButTheUnknownKeyRowIsDeliberatelyDivergent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"decisions": []map[string]any{}})
	}))
	defer srv.Close()

	local, err := Init(Options{Mode: ModeLocal})
	if err != nil {
		t.Fatalf("local init: %v", err)
	}
	remote, err := Init(Options{Mode: ModeRemote, APIKey: "project-api-key_test", APIURL: srv.URL})
	if err != nil {
		t.Fatalf("remote init: %v", err)
	}

	ctx := domain.NewEvaluationContext("user-1", nil)
	localDecision := local.ControlPoints().GetBooleanDetails("does-not-exist", false, &ctx)
	if localDecision.Value != false || localDecision.Reason != ReasonDefault || localDecision.Error != nil {
		t.Fatalf("local miss = %+v, want default/DEFAULT/no-error", localDecision)
	}

	remoteDecision := remote.ControlPoints().GetBooleanDetails("does-not-exist", false, &ctx)
	if remoteDecision.Value != false || remoteDecision.Reason != ReasonError {
		t.Fatalf("remote miss = %+v, want default/ERROR", remoteDecision)
	}
	if remoteDecision.Error == nil || remoteDecision.Error.Kind != KindFlagNotFound {
		t.Fatalf("remote miss error = %v, want FlagNotFound", remoteDecision.Error)
	}
}

func TestRegisterTargetResolvesRatherThanRaisingInBothModes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer srv.Close()

	local, err := Init(Options{Mode: ModeLocal})
	if err != nil {
		t.Fatalf("local init: %v", err)
	}
	remote, err := Init(Options{Mode: ModeRemote, APIKey: "project-api-key_test", APIURL: srv.URL})
	if err != nil {
		t.Fatalf("remote init: %v", err)
	}

	if res := local.RegisterTarget("user-1", nil); !res.OK {
		t.Fatalf("local registerTarget: %+v", res)
	}
	if res := remote.RegisterTarget("user-1", nil); !res.OK {
		t.Fatalf("remote registerTarget: %+v", res)
	}
}

// ------------------------------------------------------------------ local registerTarget wiring

func TestLocalRegisterTargetRecordsInProcessAndTracesViaTheInjectedLogSink(t *testing.T) {
	var lines []string
	client, err := Init(Options{
		Mode: ModeLocal,
		Local: &LocalOptions{
			ControlPoints: map[string]bool{},
			Log:           func(msg string) { lines = append(lines, msg) },
		},
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}

	res := client.RegisterTarget("user-1", &RegisterTargetOptions{Properties: map[string]any{"plan": "pro"}})
	if !res.OK {
		t.Fatalf("registerTarget: %+v", res)
	}
	if len(lines) != 1 {
		t.Fatalf("expected exactly one trace line, got %d: %v", len(lines), lines)
	}
	if !strings.Contains(lines[0], "[fireweave:local]") || !strings.Contains(lines[0], "NOT sent to fw-server") {
		t.Errorf("trace line = %q", lines[0])
	}
}
