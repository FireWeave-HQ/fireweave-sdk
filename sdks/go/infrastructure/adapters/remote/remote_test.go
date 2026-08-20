package remote_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/infrastructure/adapters/remote"
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
