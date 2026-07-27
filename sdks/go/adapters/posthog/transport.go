package posthog

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
)

// capturedFlagDetail mirrors the v4 /flags per-flag detail the vendor SDK
// keeps unexported.
type capturedFlagDetail struct {
	Key     string  `json:"key"`
	Enabled bool    `json:"enabled"`
	Variant *string `json:"variant"`
	Reason  *struct {
		Code           string `json:"code"`
		ConditionIndex *int   `json:"condition_index"`
	} `json:"reason"`
	Metadata struct {
		ID      int             `json:"id"`
		Version int             `json:"version"`
		Payload json.RawMessage `json:"payload"`
	} `json:"metadata"`
}

// capturedResponse is one parsed /flags response.
type capturedResponse struct {
	quotaLimited bool
	flags        map[string]*capturedFlagDetail
}

// interceptTransport wraps the real transport, parsing /flags request and
// response bodies to recover fields posthog-go does not export
// (quota_limited, per-flag metadata). Entries are keyed by distinct_id and
// consumed by the next Resolve for that key (best effort under concurrent
// same-key evaluations).
type interceptTransport struct {
	base http.RoundTripper

	mu         sync.Mutex
	byDistinct map[string]*capturedResponse

	flagsCalls atomic.Int64
}

// FlagsCalls reports how many /flags HTTP requests went through (used by
// no-network assertions).
func (t *interceptTransport) FlagsCalls() int64 { return t.flagsCalls.Load() }

func (t *interceptTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !strings.Contains(req.URL.Path, "/flags") {
		return t.base.RoundTrip(req)
	}
	t.flagsCalls.Add(1)

	distinctID := ""
	if req.Body != nil {
		body, err := io.ReadAll(req.Body)
		req.Body.Close()
		if err == nil {
			req.Body = io.NopCloser(bytes.NewReader(body))
			var parsed struct {
				DistinctID string `json:"distinct_id"`
			}
			if json.Unmarshal(body, &parsed) == nil {
				distinctID = parsed.DistinctID
			}
		}
	}

	resp, err := t.base.RoundTrip(req)
	if err != nil || resp == nil || resp.StatusCode != http.StatusOK || distinctID == "" {
		return resp, err
	}

	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if readErr != nil {
		return nil, readErr
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))

	var parsed struct {
		QuotaLimited []string                       `json:"quota_limited"`
		Flags        map[string]*capturedFlagDetail `json:"flags"`
	}
	if json.Unmarshal(body, &parsed) == nil {
		cap := &capturedResponse{flags: parsed.Flags}
		for _, q := range parsed.QuotaLimited {
			if q == "feature_flags" {
				cap.quotaLimited = true
			}
		}
		t.mu.Lock()
		if t.byDistinct == nil {
			t.byDistinct = map[string]*capturedResponse{}
		}
		t.byDistinct[distinctID] = cap
		t.mu.Unlock()
	}
	return resp, nil
}

// take removes and returns the captured response for a distinct_id.
func (t *interceptTransport) take(distinctID string) *capturedResponse {
	t.mu.Lock()
	defer t.mu.Unlock()
	c := t.byDistinct[distinctID]
	delete(t.byDistinct, distinctID)
	return c
}
