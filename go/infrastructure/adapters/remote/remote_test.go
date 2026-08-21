package remote_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/go/domain"
	"github.com/FireWeave-HQ/fireweave-sdk/go/infrastructure/adapters/remote"
)

func TestRemoteEvaluate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/flags/evaluate" {
			t.Fatalf("path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer project-api-key_test" {
			t.Fatalf("auth %q", r.Header.Get("Authorization"))
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["targetingKey"] != "user-1" {
			t.Fatalf("targetingKey %v", body["targetingKey"])
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"decisions": []map[string]any{{
				"flagKey": "checkout-v2",
				"value":   true,
				"reason":  "TARGETING_MATCH",
				"found":   true,
				"enabled": true,
			}},
		})
	}))
	defer srv.Close()

	a := remote.New(remote.Config{
		APIURL: srv.URL,
		APIKey: "project-api-key_test",
	})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey:      "checkout-v2",
		DefaultValue: false,
		Context:      domain.NewEvaluationContext("user-1", map[string]any{"plan": "pro"}),
	})
	if d.Error != nil {
		t.Fatalf("error decision: %+v", d.Error)
	}
	if d.Value != true {
		t.Fatalf("value %v", d.Value)
	}
	_ = a.Close(context.Background())
}

func TestRemoteAuthFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = io.WriteString(w, `{"ok":false}`)
	}))
	defer srv.Close()

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "bad"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey:      "x",
		DefaultValue: false,
		Context:      domain.NewEvaluationContext("u", nil),
	})
	if d.Error == nil || d.Error.Kind != domain.KindAuthentication {
		t.Fatalf("want Authentication, got %+v", d.Error)
	}
}

// modes.md: remote's unknown-key row is default/ERROR/FlagNotFound —
// deliberately NOT the local adapter's default/DEFAULT seam.
func TestRemoteUnknownKeyIsErrorFlagNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"decisions": []map[string]any{}})
	}))
	defer srv.Close()

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "does-not-exist", DefaultValue: false,
		Context: domain.NewEvaluationContext("u", nil),
	})
	if d.Error == nil || d.Error.Kind != domain.KindFlagNotFound || d.Reason != domain.ReasonError {
		t.Fatalf("got %+v, want ERROR/FlagNotFound", d)
	}
}

// TestRemoteResolveAttachesPayloadOnlyWhenRequested is the remote-adapter
// half of task-10b item 5 (contracts/evaluation/eval-payload-attached.json):
// mirrors python's and node's remote adapters, which already read an
// item-level "payload" wire field and gate exposing it locally on
// EvaluateOptions.includePayload.
func TestRemoteResolveAttachesPayloadOnlyWhenRequested(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"decisions":[{"flagKey":"fw-payload","value":true,"reason":"TARGETING_MATCH","found":true,"payload":{"rolloutId":"rollout_1","maxRetries":2}}]}`)
	}))
	defer srv.Close()

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}

	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-payload", DefaultValue: false,
		Context: domain.NewEvaluationContext("u", nil), IncludePayload: true,
	})
	want := `{"maxRetries":2,"rolloutId":"rollout_1"}`
	if got, _ := d.Metadata["fireweave.payload"].(string); got != want {
		t.Fatalf("payload metadata = %q, want %q", got, want)
	}

	d = a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-payload", DefaultValue: false,
		Context: domain.NewEvaluationContext("u", nil), IncludePayload: false,
	})
	if _, ok := d.Metadata["fireweave.payload"]; ok {
		t.Fatalf("payload metadata must be absent when IncludePayload is false, got %+v", d.Metadata)
	}
}

// TestRemoteResolvePassesThroughRawStringPayloadVerbatim is the remote-adapter
// regression test for the task-10b review-round finding: a wire payload that
// arrives as a raw JSON string (spec/remote-evaluate.schema.json's payload
// field is unconstrained jsonValue) must pass through verbatim rather than
// being re-serialized/double-encoded, mirroring node's and python's remote
// adapters.
func TestRemoteResolvePassesThroughRawStringPayloadVerbatim(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"decisions":[{"flagKey":"fw-payload","value":true,"reason":"TARGETING_MATCH","found":true,"payload":"{\"already\":\"serialized\"}"}]}`)
	}))
	defer srv.Close()

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}

	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey: "fw-payload", DefaultValue: false,
		Context: domain.NewEvaluationContext("u", nil), IncludePayload: true,
	})
	want := `{"already":"serialized"}`
	if got, _ := d.Metadata["fireweave.payload"].(string); got != want {
		t.Fatalf("payload metadata = %q, want verbatim %q (must not be re-serialized/double-encoded)", got, want)
	}
}

func TestRemoteRegisterTargetPostsToRegisterPath(t *testing.T) {
	var gotPath string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	defer srv.Close()

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	res := a.RegisterTarget(context.Background(), "user-1", domain.RegisterTargetOptions{
		Kind:       domain.TargetKindUser,
		Properties: map[string]any{"plan": "pro"},
	})
	if !res.OK {
		t.Fatalf("expected ok:true, got %+v", res)
	}
	if gotPath != "/v1/targets/register" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotBody["targetingKey"] != "user-1" {
		t.Fatalf("body = %v", gotBody)
	}
}

// TestRemoteResolveTimeoutClassifiesAsTimeout is the regression test for
// task-10b item 3 (contracts/faults/fault-timeout.json): ControlPoints.Evaluate
// hardcodes context.Background() for its public API (no-public-ctx ruling,
// Task 9) with no per-call deadline, so a stalling backend previously always
// classified as Network — postJSON.Err() was checking the ORIGINAL ctx
// (never cancelled) rather than a context tied to the adapter's own
// RequestTimeout. The fix derives that timeout INSIDE the adapter; this
// drives Resolve with a plain context.Background(), exactly like the public
// API does, against a stub server that stalls well past RequestTimeout.
func TestRemoteResolveTimeoutClassifiesAsTimeout(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block // stall far longer than RequestTimeout below
	}))
	// Registration order matters: defers run LIFO, and httptest.Server.Close
	// blocks until in-flight handlers return — so `block` must close BEFORE
	// Close() runs, or Close() deadlocks waiting on a handler that can never
	// unblock itself. Deferring Close() first (so close(block) runs first)
	// gets that order right.
	defer srv.Close()
	defer close(block)

	a := remote.New(remote.Config{
		APIURL:         srv.URL,
		APIKey:         "project-api-key_test",
		RequestTimeout: 50 * time.Millisecond,
	})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey:      "fw-t",
		DefaultValue: false,
		Context:      domain.NewEvaluationContext("u", nil),
	})
	if d.Error == nil || d.Error.Kind != domain.KindTimeout {
		t.Fatalf("want Timeout, got %+v", d.Error)
	}
}

// TestRemoteResolvePreservesIntegerBeyondSafeInteger is the remote-adapter
// half of task-10b item 2 (contracts/evaluation/eval-int-beyond-safe-integer.json):
// the brief calls out checking the remote adapter for the same float64
// coercion inmemory's convertValue had. postJSON previously decoded wire
// responses with plain json.Unmarshal, which turns every JSON number into a
// lossy float64 before numberValue ever sees it — this asserts the exact
// int64 value round-trips over real HTTP.
func TestRemoteResolvePreservesIntegerBeyondSafeInteger(t *testing.T) {
	const huge = 9007199254740993 // 2^53 + 1
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"decisions":[{"flagKey":"fw-big-int","value":9007199254740993,"variant":"huge","reason":"TARGETING_MATCH","found":true}]}`)
	}))
	defer srv.Close()

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := a.Resolve(context.Background(), domain.ResolveRequest{
		FlagKey:      "fw-big-int",
		Type:         domain.FlagTypeNumber,
		DefaultValue: 0,
		Context:      domain.NewEvaluationContext("u", nil),
	})
	if d.Error != nil {
		t.Fatalf("error decision: %+v", d.Error)
	}
	if got, ok := d.Value.(int64); !ok || got != huge {
		t.Fatalf("want int64(%d), got %T(%v)", huge, d.Value, d.Value)
	}
}

func TestRemoteRegisterTargetResolvesRatherThanPanickingOnFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()

	a := remote.New(remote.Config{APIURL: srv.URL, APIKey: "project-api-key_test"})
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	res := a.RegisterTarget(context.Background(), "user-1", domain.RegisterTargetOptions{})
	if res.OK || res.Error == nil || res.Error.Kind != domain.KindBackendUnavailable {
		t.Fatalf("got %+v, want a failed-but-resolved result", res)
	}
}
