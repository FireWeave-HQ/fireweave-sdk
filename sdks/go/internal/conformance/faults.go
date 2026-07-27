package conformance

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

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
