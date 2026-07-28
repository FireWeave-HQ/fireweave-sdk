package conformance

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// stubBaseURL returns the live test-server stub base URL when fault
// fixtures should run over real HTTP (test-server/implementation/server.mjs)
// instead of the injected fake Transport. Unset ⇒ hermetic fake mode.
func stubBaseURL() string {
	for _, key := range []string{"FIREWEAVE_TEST_SERVER_URL", "FW_TEST_SERVER_URL"} {
		if v := strings.TrimRight(strings.TrimSpace(os.Getenv(key)), "/"); v != "" {
			return v
		}
	}
	return ""
}

// stubFaultBody maps a fixture given.fault block onto the test-server
// control-plane body (POST /_test/fault). It returns nil for fault modes
// the stub cannot produce over a live connection (networkError, offline),
// which stay on the injected fake Transport.
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
			return map[string]any{"mode": status.String(), "applyTo": "flags"}
		}
		return nil
	case "invalidJson":
		body := map[string]any{"mode": "invalid_json", "applyTo": "flags"}
		if b, ok := fault["body"].(string); ok && b != "" {
			body["body"] = b
		}
		return body
	case "delay":
		delayMs := json.Number("1000")
		if d, ok := fault["delayMs"].(json.Number); ok {
			delayMs = d
		}
		return map[string]any{"mode": "delay", "delayMs": delayMs, "applyTo": "flags"}
	case "quotaLimited":
		return map[string]any{"mode": "quota_limited", "applyTo": "flags"}
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
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("stub %s: status %d", path, resp.StatusCode)
	}
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
// fixtures when the runner does not target the live test-server stub. It
// reproduces the test-server fault semantics deterministically in-process.
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
	// Non-flags traffic (event batches on Close) always succeeds.
	if !strings.Contains(req.URL.Path, "/flags") {
		return jsonResponse(req, http.StatusOK, `{"status":1}`), nil
	}

	switch t.mode {
	case "delay":
		select {
		case <-time.After(t.delay):
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
		return jsonResponse(req, http.StatusOK, `{"flags":{},"featureFlags":{},"featureFlagPayloads":{}}`), nil
	case "httpStatus":
		return jsonResponse(req, t.status, `{"error":"fault"}`), nil
	case "invalidJson":
		return jsonResponse(req, http.StatusOK, t.body), nil
	case "networkError":
		return nil, &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset by peer")}
	case "offline":
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: connection refused")}
	case "quotaLimited":
		payload := map[string]any{
			"quota_limited":       t.quotaLimited,
			"flags":               map[string]any{},
			"featureFlags":        map[string]any{},
			"featureFlagPayloads": map[string]any{},
		}
		b, _ := json.Marshal(payload)
		return jsonResponse(req, http.StatusOK, string(b)), nil
	default:
		return jsonResponse(req, http.StatusOK, `{"flags":{},"featureFlags":{},"featureFlagPayloads":{}}`), nil
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
