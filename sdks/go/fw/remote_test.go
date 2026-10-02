package fw

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/v2/fireweave"
)

// The start profile in remote mode against a real HTTP server speaking the
// Fireweave remote protocol (node: test/integration/start-remote.test.ts).
// Every request goes over the wire through the unchanged core remote
// adapter.

type stubServer struct {
	*httptest.Server
	mu       sync.Mutex
	register []map[string]any
}

func newStub(t *testing.T, key string) *stubServer {
	t.Helper()
	s := &stubServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/v1/flags/evaluate":
			values := map[string]any{"fw-bool-on": true, "fw-string-theme": "dark"}
			var decisions []map[string]any
			for _, k := range body["flagKeys"].([]any) {
				key := k.(string)
				v, found := values[key]
				decisions = append(decisions, map[string]any{"flagKey": key, "value": v, "found": found, "reason": "TARGETING_MATCH"})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"decisions": decisions})
		case "/v1/targets/register":
			s.mu.Lock()
			s.register = append(s.register, body)
			s.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func TestRemoteStartEvaluatesOverTheWireAndIgnoresFlagValues(t *testing.T) {
	rec, log := fresh(t)
	key := "project-api-key_integration"
	srv := newStub(t, key)

	mustStart(t, Options{
		Key:   key,
		URL:   srv.URL,
		Env:   envMap(map[string]string{"APP_ENV": "production"}),
		Flags: Flags{"fw-bool-on": {Local: false}},
		Log:   log,
	})
	if !ControlPoints().GetBooleanValue("fw-bool-on", false, For("user-1")) {
		t.Fatal("remote value must win over the flags' local value")
	}
	if got := ControlPoints().GetStringValue("fw-string-theme", "light", For("user-1")); got != "dark" {
		t.Fatalf("string = %q, want dark", got)
	}
	d := ControlPoints().GetBooleanDetails("not-there", false, For("user-1"))
	if d.Error == nil || d.Error.Kind != fireweave.KindFlagNotFound {
		t.Fatalf("unknown key in remote mode: %+v, want FlagNotFound", d)
	}
	if rec.count(`"not-there" is not in your flags`) != 0 {
		t.Fatal("the missing-from-flags warning is local mode only")
	}

	if err := Identify(context.Background(), "user-1", map[string]any{"plan": "pro"}); err != nil {
		t.Fatalf("Identify: %v", err)
	}
	srv.mu.Lock()
	reg := srv.register
	srv.mu.Unlock()
	if len(reg) != 1 || reg[0]["targetingKey"] != "user-1" || reg[0]["kind"] != "user" ||
		reg[0]["properties"].(map[string]any)["plan"] != "pro" {
		t.Fatalf("register body = %v", reg)
	}

	u, _ := url.Parse(srv.URL)
	s := Status()
	if s.Mode != ModeRemote || s.EndpointSource != "Options.URL" || s.Host != u.Hostname() || s.KeySource != "Options.Key" {
		t.Fatalf("status = %+v", s)
	}
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRemoteStartFromTheEnvironmentWithALegacyKey(t *testing.T) {
	rec, log := fresh(t)
	key := "project-api-key_legacy"
	srv := newStub(t, key)
	vars := envMap(map[string]string{"FW_PROJECT_API_KEY": key, "FIREWEAVE_URL": srv.URL + "/"})

	mustStart(t, Options{Env: vars, Log: log})
	if !ControlPoints().GetBooleanValue("fw-bool-on", false, For("user-1")) {
		t.Fatal("the legacy key must still work")
	}
	if s := Status(); s.KeySource != "FW_PROJECT_API_KEY" || s.EndpointSource != "FIREWEAVE_URL" {
		t.Fatalf("status = %+v", s)
	}
	// The warning is logged once per process, even across a restart.
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	mustStart(t, Options{Env: vars, Log: log})
	if n := rec.count("FW_PROJECT_API_KEY is a legacy name"); n != 1 {
		t.Fatalf("legacy warning logged %d times:\n%s", n, rec.all())
	}
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestARejectedKeyNeverFailsARead(t *testing.T) {
	_, log := fresh(t)
	srv := newStub(t, "project-api-key_right")
	mustStart(t, Options{Key: "project-api-key_wrong", URL: srv.URL, Env: noVars, Log: log})
	d := ControlPoints().GetBooleanDetails("fw-bool-on", false, For("user-1"))
	if d.Value != false || d.Reason != fireweave.ReasonError || d.Error == nil || d.Error.Kind != fireweave.KindAuthentication {
		t.Fatalf("decision = %+v, want the default with ERROR/Authentication", d)
	}
	if err := Identify(context.Background(), "user-1", nil); !errorsIsKind(err, fireweave.KindAuthentication) {
		t.Fatalf("Identify err = %v, want Authentication", err)
	}
	if err := Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func errorsIsKind(err error, kind fireweave.ErrorKind) bool {
	fwErr, ok := err.(*fireweave.Error)
	return ok && fwErr.Kind == kind
}
