package conformance

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// stubBaseURL returns a live test-server stub base URL when fault fixtures
// should run over real HTTP (test-server/implementation/server.mjs) instead
// of the injected fake Transport below. Unset (the default — in particular
// inside the canonical dockerized `golang:1.25-alpine` run, which has no
// `node` binary to spawn the stub with) => hermetic fake-transport mode. This
// is an optional LOCAL-dev enhancement path, not the baseline: unlike node
// and python, go's conformance suite must work with no `node` available at
// all, so the fake transport (not a spawned subprocess) is this package's
// real baseline for the faults suite.
func stubBaseURL() string {
	for _, key := range []string{"FIREWEAVE_TEST_SERVER_URL", "FW_TEST_SERVER_URL"} {
		if v := strings.TrimRight(strings.TrimSpace(os.Getenv(key)), "/"); v != "" {
			return v
		}
	}
	return ""
}

// stubFaultBody maps a fixture given.fault block onto the test-server
// control-plane body (POST /_test/fault). applyTo is "evaluate": the remote
// adapter speaks POST /v1/flags/evaluate (the Fireweave-native route), not
// the legacy PostHog /flags this used to target. Returns nil for fault modes
// the stub cannot produce over a live connection (networkError, offline),
// which stay on the injected fake Transport regardless of stub availability.
func stubFaultBody(fault map[string]any) map[string]any {
	mode, _ := fault["mode"].(string)
	switch mode {
	case "httpStatus":
		status, ok := fault["status"].(json.Number)
		if !ok {
			return nil
		}
		switch status.String() {
		case "401", "429", "500":
			return map[string]any{"mode": status.String(), "applyTo": "evaluate"}
		}
		return nil
	case "invalidJson":
		body := map[string]any{"mode": "invalid_json", "applyTo": "evaluate"}
		if b, ok := fault["body"].(string); ok && b != "" {
			body["body"] = b
		}
		return body
	case "delay":
		delayMs := json.Number("1000")
		if d, ok := fault["delayMs"].(json.Number); ok {
			delayMs = d
		}
		return map[string]any{"mode": "delay", "delayMs": delayMs, "applyTo": "evaluate"}
	case "quotaLimited":
		return map[string]any{"mode": "quota_limited", "applyTo": "evaluate"}
	}
	return nil
}

var stubHTTPClient = &http.Client{Timeout: 5 * time.Second}

func stubPost(baseURL, path string, body map[string]any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	resp, err := stubHTTPClient.Post(baseURL+path, "application/json", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// stubSetFault arms the stub's fault injection for the next requests.
func stubSetFault(baseURL string, body map[string]any) error {
	return stubPost(baseURL, "/_test/fault", body)
}

// stubResetState clears faults/events and restores fixture defaults.
func stubResetState(baseURL string) error {
	return stubPost(baseURL, "/_test/reset", map[string]any{})
}

// faultTransport is the injected fake http.RoundTripper used for fault
// fixtures — the hermetic baseline this package actually runs on (see
// stubBaseURL). It reproduces the Fireweave-native /v1/flags/evaluate
// response shape (decisions[] + quotaLimited, not the legacy PostHog
// /flags?v=2 shape this used to emit) deterministically, in-process, with no
// external process.
type faultTransport struct {
	mode         string // httpStatus | invalidJson | networkError | offline | quotaLimited | delay | ""
	status       int    // for httpStatus
	body         string // for invalidJson
	delay        time.Duration
	quotaLimited []string
}

func newFaultTransport(fault map[string]any) *faultTransport {
	t := &faultTransport{}
	if fault == nil {
		return t
	}
	t.mode, _ = fault["mode"].(string)
	if s, ok := fault["status"].(json.Number); ok {
		v, _ := s.Int64()
		t.status = int(v)
	}
	t.body, _ = fault["body"].(string)
	if d, ok := fault["delayMs"].(json.Number); ok {
		v, _ := d.Int64()
		t.delay = time.Duration(v) * time.Millisecond
	}
	if ql, ok := fault["quotaLimited"].([]any); ok {
		for _, q := range ql {
			if s, ok := q.(string); ok {
				t.quotaLimited = append(t.quotaLimited, s)
			}
		}
	}
	return t
}

func (t *faultTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Non-evaluate traffic (capture batches on shutdown flush) always succeeds.
	if !strings.Contains(req.URL.Path, "/flags/evaluate") {
		return jsonResponse(req, http.StatusOK, `{"ok":true}`), nil
	}

	switch t.mode {
	case "delay":
		select {
		case <-time.After(t.delay):
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
		return jsonResponse(req, http.StatusOK, `{"decisions":[]}`), nil
	case "httpStatus":
		return jsonResponse(req, t.status, `{"error":"fault"}`), nil
	case "invalidJson":
		return jsonResponse(req, http.StatusOK, t.body), nil
	case "networkError":
		return nil, &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset by peer")}
	case "offline":
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: connection refused")}
	case "quotaLimited":
		payload := map[string]any{"decisions": []any{}, "quotaLimited": true}
		b, _ := json.Marshal(payload)
		return jsonResponse(req, http.StatusOK, string(b)), nil
	default:
		return jsonResponse(req, http.StatusOK, `{"decisions":[]}`), nil
	}
}

func jsonResponse(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader([]byte(body))),
		Request:    req,
	}
}
