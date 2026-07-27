package posthog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
)

// fakeTransport is a programmable transport; no live network is touched.
type fakeTransport struct {
	mu       sync.Mutex
	handler  func(*http.Request) (*http.Response, error)
	requests []*http.Request
}

func (f *fakeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	f.requests = append(f.requests, req)
	handler := f.handler
	f.mu.Unlock()
	if strings.Contains(req.URL.Path, "/batch") {
		return respond(req, 200, `{"status":1}`), nil
	}
	return handler(req)
}

func respond(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader([]byte(body))),
		Request:    req,
	}
}

func flagsBody(t *testing.T, flags map[string]any, quota []string) string {
	t.Helper()
	body := map[string]any{
		"flags":               flags,
		"featureFlags":        map[string]any{},
		"featureFlagPayloads": map[string]any{},
		"requestId":           "req-fixed",
	}
	if quota != nil {
		body["quota_limited"] = quota
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func flagDetail(enabled bool, variant string, version, id int, reasonCode string, condIndex *int, payload string) map[string]any {
	detail := map[string]any{
		"key":     "k",
		"enabled": enabled,
		"metadata": map[string]any{
			"id":      id,
			"version": version,
		},
	}
	if variant != "" {
		detail["variant"] = variant
	}
	if reasonCode != "" {
		reason := map[string]any{"code": reasonCode, "description": "d"}
		if condIndex != nil {
			reason["condition_index"] = *condIndex
		}
		detail["reason"] = reason
	}
	if payload != "" {
		detail["metadata"].(map[string]any)["payload"] = json.RawMessage(payload)
	}
	return detail
}

func newReadyAdapter(t *testing.T, transport http.RoundTripper, mutate ...func(*Config)) *Adapter {
	t.Helper()
	cfg := Config{
		ProjectAPIKey:      "phc_test0000000000000000000000001",
		Endpoint:           "http://127.0.0.1:3901",
		Transport:          transport,
		FlagRequestTimeout: 2 * time.Second,
		CloseTimeout:       2 * time.Second,
	}
	for _, m := range mutate {
		m(&cfg)
	}
	a := New(cfg)
	if err := a.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = a.Close(ctx)
	})
	return a
}

func resolveBool(t *testing.T, a *Adapter, flagKey string) fireweave.Decision {
	t.Helper()
	return a.Resolve(context.Background(), fireweave.ResolveRequest{
		FlagKey: flagKey, Type: fireweave.FlagTypeBoolean, DefaultValue: false,
		Context: fireweave.NewEvaluationContext("user_1", nil),
	})
}

func TestResolveBooleanSuccessWithMetadata(t *testing.T) {
	idx := 0
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		return respond(req, 200, flagsBody(t, map[string]any{
			// PostHog boolean flags carry no variant; the value is enabled.
			"fw-bool": flagDetail(true, "", 7, 42, "condition_match", &idx, ""),
		}, nil)), nil
	}}
	a := newReadyAdapter(t, transport)
	d := resolveBool(t, a, "fw-bool")
	if d.Error != nil {
		t.Fatalf("error: %v", d.Error)
	}
	if d.Value != true || d.Variant != "" || d.Reason != fireweave.ReasonTargetingMatch {
		t.Fatalf("decision = %+v", d)
	}
	if d.Metadata[fireweave.MetaFlagVersion] != int64(7) {
		t.Errorf("flagVersion = %v", d.Metadata[fireweave.MetaFlagVersion])
	}
	if d.Metadata[fireweave.MetaVendorFlagID] != int64(42) || d.Metadata[fireweave.MetaReasonCode] != "condition_match" {
		t.Errorf("vendor metadata = %v", d.Metadata)
	}
}

func TestResolveFlagNotFound(t *testing.T) {
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		return respond(req, 200, flagsBody(t, map[string]any{}, nil)), nil
	}}
	a := newReadyAdapter(t, transport)
	d := resolveBool(t, a, "missing")
	if d.Error == nil || d.Error.Kind != fireweave.KindFlagNotFound {
		t.Fatalf("decision = %+v", d)
	}
	if d.Value != false || d.Reason != fireweave.ReasonError {
		t.Fatalf("decision = %+v", d)
	}
}

func TestResolveQuotaLimited(t *testing.T) {
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		return respond(req, 200, flagsBody(t, map[string]any{}, []string{"feature_flags"})), nil
	}}
	a := newReadyAdapter(t, transport)
	d := resolveBool(t, a, "fw-q")
	if d.Error == nil || d.Error.Kind != fireweave.KindFlagNotFound {
		t.Fatalf("decision = %+v", d)
	}
	if d.Metadata[fireweave.MetaQuotaLimited] != true {
		t.Fatalf("metadata = %v, want fireweave.quotaLimited=true", d.Metadata)
	}
}

func TestErrorMappingByHTTPStatus(t *testing.T) {
	cases := []struct {
		status int
		kind   fireweave.ErrorKind
	}{
		{401, fireweave.KindAuthentication},
		{403, fireweave.KindAuthorization},
		{429, fireweave.KindRateLimited},
		{500, fireweave.KindBackendUnavailable},
		{503, fireweave.KindBackendUnavailable},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
				return respond(req, tc.status, `{"error":"nope"}`), nil
			}}
			a := newReadyAdapter(t, transport)
			d := resolveBool(t, a, "fw-x")
			if d.Error == nil || d.Error.Kind != tc.kind {
				t.Fatalf("status %d → %+v, want kind %s", tc.status, d.Error, tc.kind)
			}
			if d.Error.Message != fireweave.DefaultMessage(tc.kind) {
				t.Errorf("message = %q", d.Error.Message)
			}
		})
	}
}

func TestErrorMappingNetworkAndMalformed(t *testing.T) {
	t.Run("network", func(t *testing.T) {
		transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
		}}
		a := newReadyAdapter(t, transport)
		d := resolveBool(t, a, "fw-x")
		if d.Error == nil || d.Error.Kind != fireweave.KindNetwork {
			t.Fatalf("decision = %+v", d)
		}
	})
	t.Run("malformed json", func(t *testing.T) {
		transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
			return respond(req, 200, `{not-json`), nil
		}}
		a := newReadyAdapter(t, transport)
		d := resolveBool(t, a, "fw-x")
		if d.Error == nil || d.Error.Kind != fireweave.KindMalformedResponse {
			t.Fatalf("decision = %+v", d)
		}
	})
}

func TestResolveHonorsContextDeadline(t *testing.T) {
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		select {
		case <-time.After(10 * time.Second):
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
		return respond(req, 200, "{}"), nil
	}}
	a := newReadyAdapter(t, transport, func(c *Config) { c.FlagRequestTimeout = 5 * time.Second })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	d := a.Resolve(ctx, fireweave.ResolveRequest{
		FlagKey: "fw-x", Type: fireweave.FlagTypeBoolean, DefaultValue: false,
		Context: fireweave.NewEvaluationContext("user_1", nil),
	})
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("resolve blocked %v past the caller deadline", elapsed)
	}
	if d.Error == nil || d.Error.Kind != fireweave.KindTimeout {
		t.Fatalf("decision = %+v", d)
	}
}

func TestSecretNeverInErrorMessages(t *testing.T) {
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		return respond(req, 401, `{"error":"invalid key phc_test0000000000000000000000001"}`), nil
	}}
	a := newReadyAdapter(t, transport)
	d := resolveBool(t, a, "fw-x")
	if strings.Contains(d.Error.Message, "phc_") {
		t.Fatalf("message leaked key: %q", d.Error.Message)
	}
	if strings.Contains(d.Error.Error(), "phc_") {
		t.Fatalf("Error() leaked key: %q", d.Error.Error())
	}
}

func TestConfigValidation(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
	}{
		{"missing key", Config{Endpoint: "http://127.0.0.1:3901"}},
		{"bad endpoint", Config{ProjectAPIKey: "phc_x", Endpoint: "not-a-uri"}},
		{"ssrf blocked", Config{ProjectAPIKey: "phc_x", Endpoint: "http://169.254.169.254",
			AllowedHosts: []string{"127.0.0.1", "us.i.posthog.com"}}},
		{"local-only without secret", Config{ProjectAPIKey: "phc_x", Endpoint: "http://127.0.0.1:3901",
			LocalEvaluationOnly: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := New(tc.cfg)
			err := a.Initialize(context.Background())
			if !errors.Is(err, fireweave.ErrConfiguration) {
				t.Fatalf("err = %v, want Configuration", err)
			}
			if strings.Contains(err.Error(), "phc_x") || strings.Contains(err.Error(), "169.254") {
				t.Errorf("configuration error leaked config values: %q", err.Error())
			}
		})
	}
}

func TestDefaultEndpointAllowlist(t *testing.T) {
	for _, host := range []string{"https://us.i.posthog.com", "https://eu.i.posthog.com", "http://localhost:3901"} {
		a := New(Config{ProjectAPIKey: "phc_x", Endpoint: host,
			Transport: &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
				return respond(req, 200, "{}"), nil
			}}})
		if err := a.Initialize(context.Background()); err != nil {
			t.Errorf("host %s should be allowed: %v", host, err)
		}
		_ = a.Close(context.Background())
	}
}

func TestCloseIsIdempotentAndBounded(t *testing.T) {
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		return respond(req, 200, flagsBody(t, map[string]any{}, nil)), nil
	}}
	a := newReadyAdapter(t, transport)

	start := time.Now()
	for i := 0; i < 3; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := a.Close(ctx); err != nil {
			t.Fatalf("close %d: %v", i, err)
		}
		cancel()
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("close took %v; posthog-go's indefinite wait leaked", elapsed)
	}

	// Post-close resolution degrades to AlreadyClosed, never panics.
	d := resolveBool(t, a, "fw-x")
	if d.Error == nil || d.Error.Kind != fireweave.KindAlreadyClosed {
		t.Fatalf("post-close decision = %+v", d)
	}
}

func TestConcurrentResolveAndClose(t *testing.T) {
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		return respond(req, 200, flagsBody(t, map[string]any{
			"fw-x": flagDetail(true, "", 1, 1, "", nil, ""),
		}, nil)), nil
	}}
	a := newReadyAdapter(t, transport)

	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = resolveBool(t, a, "fw-x")
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = a.Close(ctx)
	}()
	wg.Wait()
}

func TestTypedValueCoercion(t *testing.T) {
	idx := 0
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		return respond(req, 200, flagsBody(t, map[string]any{
			"fw-mv":  flagDetail(true, "treatment-b", 3, 9, "condition_match", &idx, ""),
			"fw-int": flagDetail(true, "huge", 1, 2, "", nil, `"9007199254740993"`),
			"fw-obj": flagDetail(true, "v1", 1, 3, "", nil, `"{\"mode\":\"safe\"}"`),
		}, nil)), nil
	}}
	a := newReadyAdapter(t, transport)
	ctx := context.Background()
	ec := fireweave.NewEvaluationContext("user_1", nil)

	str := a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-mv", Type: fireweave.FlagTypeString, DefaultValue: "control", Context: ec})
	if str.Error != nil || str.Value != "treatment-b" || str.Variant != "treatment-b" {
		t.Fatalf("string decision = %+v", str)
	}

	i := a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-int", Type: fireweave.FlagTypeInteger, DefaultValue: int64(0), Context: ec})
	if i.Error != nil || i.Value != int64(9007199254740993) {
		t.Fatalf("integer decision = %+v (precision must survive)", i)
	}

	obj := a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-obj", Type: fireweave.FlagTypeObject, DefaultValue: nil, Context: ec})
	if obj.Error != nil {
		t.Fatalf("object decision = %+v", obj)
	}
	if m, ok := obj.Value.(map[string]any); !ok || m["mode"] != "safe" {
		t.Fatalf("object value = %#v", obj.Value)
	}

	// Boolean flag requested as string → TypeMismatch (no coercion).
	mm := a.Resolve(ctx, fireweave.ResolveRequest{FlagKey: "fw-mv", Type: fireweave.FlagTypeBoolean, DefaultValue: false, Context: ec})
	if mm.Error == nil || mm.Error.Kind != fireweave.KindTypeMismatch {
		t.Fatalf("mismatch decision = %+v", mm)
	}
}

func TestContextMappingToVendorPayload(t *testing.T) {
	var captured []byte
	transport := &fakeTransport{handler: func(req *http.Request) (*http.Response, error) {
		captured, _ = io.ReadAll(req.Body)
		req.Body = io.NopCloser(bytes.NewReader(captured))
		return respond(req, 200, flagsBody(t, map[string]any{}, nil)), nil
	}}
	a := newReadyAdapter(t, transport)
	_ = a.Resolve(context.Background(), fireweave.ResolveRequest{
		FlagKey: "fw-g", Type: fireweave.FlagTypeBoolean, DefaultValue: false,
		Context: fireweave.NewEvaluationContext("user_42", map[string]any{
			"email_domain":            "example.com",
			"groups":                  map[string]any{"organization": "org_1"},
			"groupProperties":         map[string]any{"organization": map[string]any{"plan": "enterprise"}},
			"$process_person_profile": false,
		}),
	})

	var body struct {
		DistinctID       string                    `json:"distinct_id"`
		Groups           map[string]any            `json:"groups"`
		PersonProperties map[string]any            `json:"person_properties"`
		GroupProperties  map[string]map[string]any `json:"group_properties"`
	}
	if err := json.Unmarshal(captured, &body); err != nil {
		t.Fatalf("unmarshal request: %v (%s)", err, captured)
	}
	if body.DistinctID != "user_42" {
		t.Errorf("distinct_id = %q (targetingKey must map)", body.DistinctID)
	}
	if body.Groups["organization"] != "org_1" {
		t.Errorf("groups = %v", body.Groups)
	}
	if body.PersonProperties["email_domain"] != "example.com" {
		t.Errorf("person properties = %v", body.PersonProperties)
	}
	if _, leaked := body.PersonProperties["$process_person_profile"]; leaked {
		t.Error("$-prefixed directives must not become person properties")
	}
	if body.GroupProperties["organization"]["plan"] != "enterprise" {
		t.Errorf("group properties = %v", body.GroupProperties)
	}
}
