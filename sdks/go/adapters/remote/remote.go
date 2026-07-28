// Package remote implements FireweaveRemoteAdapter (ADR-0005): HTTP client for
// fw-server POST /v1/flags/evaluate and POST /v1/capture. No PostHog dependency.
package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
)

const (
	evaluatePath = "/v1/flags/evaluate"
	capturePath  = "/v1/capture"
)

// Config configures the remote adapter.
type Config struct {
	// APIURL is the fw-server base URL (env: FW_API_URL).
	APIURL string
	// APIKey is the Fireweave project/runtime key (env: FW_PROJECT_API_KEY).
	APIKey string
	// AllowedHosts overrides the egress allowlist (default: APIURL hostname + loopback).
	AllowedHosts []string
	// RequestTimeout bounds evaluate/capture (default 3s).
	RequestTimeout time.Duration
	// CloseTimeout bounds Close flush (default 10s).
	CloseTimeout time.Duration
	// HTTPClient overrides the HTTP client (tests).
	HTTPClient *http.Client
}

// Adapter speaks the Fireweave remote protocol.
type Adapter struct {
	cfg     Config
	client  *http.Client
	baseURL string
	apiKey  string
	mu      sync.Mutex
	pending []captureEvent
	closed  bool
	ready   bool
}

type evaluateRequest struct {
	TargetingKey    string                 `json:"targetingKey"`
	Attributes      map[string]any         `json:"attributes,omitempty"`
	Groups          map[string]string      `json:"groups,omitempty"`
	GroupProperties map[string]any         `json:"groupProperties,omitempty"`
	FlagKeys        []string               `json:"flagKeys,omitempty"`
}

type decisionItem struct {
	FlagKey      string         `json:"flagKey"`
	Value        any            `json:"value"`
	Variant      *string        `json:"variant"`
	Reason       string         `json:"reason"`
	Found        bool           `json:"found"`
	Enabled      *bool          `json:"enabled"`
	Payload      any            `json:"payload"`
	FlagMetadata map[string]any `json:"flagMetadata"`
}

type evaluateResponse struct {
	Decisions    []decisionItem `json:"decisions"`
	RequestID    string         `json:"requestId"`
	QuotaLimited bool           `json:"quotaLimited"`
}

type captureEvent struct {
	Type         string         `json:"type"`
	TargetingKey string         `json:"targetingKey"`
	Name         string         `json:"name,omitempty"`
	FlagKey      string         `json:"flagKey,omitempty"`
	Value        any            `json:"value,omitempty"`
	Variant      string         `json:"variant,omitempty"`
	Properties   map[string]any `json:"properties,omitempty"`
}

// New builds a remote adapter.
func New(cfg Config) *Adapter {
	return &Adapter{cfg: cfg}
}

// Initialize implements fireweave.BackendAdapter.
func (a *Adapter) Initialize(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fireweave.NewError(fireweave.KindTimeout, "", err)
	}
	apiURL := strings.TrimRight(firstNonEmpty(a.cfg.APIURL, os.Getenv("FW_API_URL")), "/")
	apiKey := firstNonEmpty(a.cfg.APIKey, os.Getenv("FW_PROJECT_API_KEY"))
	if apiURL == "" || apiKey == "" {
		return fireweave.NewError(fireweave.KindConfiguration, "", nil)
	}
	u, err := url.Parse(apiURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return fireweave.NewError(fireweave.KindConfiguration, "", nil)
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme == "http" && !isLoopback(host) {
		return fireweave.NewError(fireweave.KindConfiguration, "", nil)
	}
	allow := a.cfg.AllowedHosts
	if len(allow) == 0 {
		allow = []string{host, "localhost", "127.0.0.1", "::1"}
	}
	if !hostAllowed(host, allow) {
		return fireweave.NewError(fireweave.KindConfiguration, "", nil)
	}
	timeout := a.cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	client := a.cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	a.client = client
	a.baseURL = apiURL
	a.apiKey = apiKey
	a.ready = true
	return nil
}

// Resolve implements fireweave.BackendAdapter.
func (a *Adapter) Resolve(ctx context.Context, req fireweave.ResolveRequest) fireweave.Decision {
	if a.closed {
		return fireweave.ErrorDecision(req.DefaultValue, fireweave.NewError(fireweave.KindAlreadyClosed, "", nil), nil)
	}
	if !a.ready {
		return fireweave.ErrorDecision(req.DefaultValue, fireweave.NewError(fireweave.KindNotReady, "", nil), nil)
	}
	targeting := req.Context.TargetingKey
	if targeting == "" {
		return fireweave.ErrorDecision(req.DefaultValue, fireweave.NewError(fireweave.KindInvalidContext, "targeting key missing", nil), nil)
	}

	attrs := map[string]any{}
	for k, v := range req.Context.Attributes {
		if k == "groups" || k == "groupProperties" || k == fireweave.AttrGroups || k == fireweave.AttrGroupProperties || strings.HasPrefix(k, "$") || strings.HasPrefix(k, "fireweave.") {
			continue
		}
		attrs[k] = v
	}
	body := evaluateRequest{
		TargetingKey: targeting,
		FlagKeys:     []string{req.FlagKey},
	}
	if len(attrs) > 0 {
		body.Attributes = attrs
	}
	if g := req.Context.Groups(); len(g) > 0 {
		groups := map[string]string{}
		for k, v := range g {
			if s, ok := v.(string); ok {
				groups[k] = s
			}
		}
		if len(groups) > 0 {
			body.Groups = groups
		}
	}

	var resp evaluateResponse
	if err := a.postJSON(ctx, evaluatePath, body, &resp); err != nil {
		return fireweave.ErrorDecision(req.DefaultValue, err, nil)
	}
	var item *decisionItem
	for i := range resp.Decisions {
		if resp.Decisions[i].FlagKey == req.FlagKey {
			item = &resp.Decisions[i]
			break
		}
	}
	if item == nil || !item.Found {
		extra := map[string]any{}
		if resp.QuotaLimited {
			extra[fireweave.MetaQuotaLimited] = true
		}
		return fireweave.ErrorDecision(req.DefaultValue, fireweave.NewError(fireweave.KindFlagNotFound, "", nil), extra)
	}
	meta := map[string]any{}
	for k, v := range item.FlagMetadata {
		meta[k] = v
	}
	if resp.QuotaLimited {
		meta[fireweave.MetaQuotaLimited] = true
	}
	reason := fireweave.Reason(item.Reason)
	if reason == "" {
		reason = fireweave.ReasonTargetingMatch
	}
	variant := ""
	if item.Variant != nil {
		variant = *item.Variant
	}
	return fireweave.Decision{
		Value:    item.Value,
		Variant:  variant,
		Reason:   reason,
		Metadata: meta,
	}
}

// EnqueueTelemetry implements fireweave.TelemetrySink.
func (a *Adapter) EnqueueTelemetry(ctx context.Context, ev fireweave.TelemetryEvent) error {
	_ = ctx
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || !a.ready {
		return nil
	}
	typ := "event"
	name := ev.Name
	if strings.HasPrefix(ev.Name, "$fw_signal_") || strings.Contains(strings.ToLower(ev.Name), "signal") {
		typ = "signal"
	}
	if props, ok := ev.Properties["fireweave.exposure"].(bool); ok && props {
		typ = "exposure"
	}
	flagKey, _ := ev.Properties["$feature_flag"].(string)
	if flagKey == "" {
		flagKey, _ = ev.Properties["flagKey"].(string)
	}
	a.pending = append(a.pending, captureEvent{
		Type:         typ,
		TargetingKey: ev.DistinctID,
		Name:         name,
		FlagKey:      flagKey,
		Value:        ev.Properties["$feature_flag_response"],
		Properties:   ev.Properties,
	})
	return nil
}

// FlushTelemetry implements fireweave.TelemetrySink.
func (a *Adapter) FlushTelemetry(ctx context.Context) error {
	a.mu.Lock()
	batch := a.pending
	a.pending = nil
	a.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	payload := map[string]any{"events": batch}
	return a.postJSON(ctx, capturePath, payload, &map[string]any{})
}

// Close implements fireweave.BackendAdapter.
func (a *Adapter) Close(ctx context.Context) error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	a.mu.Unlock()
	timeout := a.cfg.CloseTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_ = a.FlushTelemetry(cctx)
	a.ready = false
	return nil
}

func (a *Adapter) postJSON(ctx context.Context, path string, body any, out any) *fireweave.Error {
	raw, err := json.Marshal(body)
	if err != nil {
		return fireweave.NewError(fireweave.KindInternal, "", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return fireweave.NewError(fireweave.KindNetwork, "", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.apiKey)
	resp, err := a.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fireweave.NewError(fireweave.KindTimeout, "", err)
		}
		return fireweave.NewError(fireweave.KindNetwork, "", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	switch {
	case resp.StatusCode == 401:
		return fireweave.NewError(fireweave.KindAuthentication, "", nil)
	case resp.StatusCode == 403:
		return fireweave.NewError(fireweave.KindAuthorization, "", nil)
	case resp.StatusCode == 429:
		return fireweave.NewError(fireweave.KindRateLimited, "", nil)
	case resp.StatusCode >= 500:
		return fireweave.NewError(fireweave.KindBackendUnavailable, "", nil)
	case resp.StatusCode >= 400:
		return fireweave.NewError(fireweave.KindBackendUnavailable, "", nil)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fireweave.NewError(fireweave.KindMalformedResponse, "", err)
		}
	}
	return nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func hostAllowed(host string, allow []string) bool {
	for _, h := range allow {
		if h == "*" || strings.EqualFold(h, host) {
			return true
		}
	}
	return isLoopback(host)
}
