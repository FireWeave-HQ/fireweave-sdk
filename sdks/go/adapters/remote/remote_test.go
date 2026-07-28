package remote_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/remote"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
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
	d := a.Resolve(context.Background(), fireweave.ResolveRequest{
		FlagKey:      "checkout-v2",
		DefaultValue: false,
		Context:      fireweave.NewEvaluationContext("user-1", map[string]any{"plan": "pro"}),
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
	d := a.Resolve(context.Background(), fireweave.ResolveRequest{
		FlagKey:      "x",
		DefaultValue: false,
		Context:      fireweave.NewEvaluationContext("u", nil),
	})
	if d.Error == nil || d.Error.Kind != fireweave.KindAuthentication {
		t.Fatalf("want Authentication, got %+v", d.Error)
	}
}
