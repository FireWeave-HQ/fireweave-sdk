// Package remote implements the Fireweave remote protocol adapter
// (ADR-0005) — the default production path. It speaks only the
// vendor-neutral Fireweave remote protocol to fw-server:
//
//	POST /v1/flags/evaluate
//	POST /v1/targets/register
//
// Auth: Authorization: Bearer <apiKey> (project-api-key_…). Which backend
// fw-server forwards to is fw-server's concern: no vendor SDK, key, or host
// ever enters this process. See spec/remote-protocol.md.
//
// No os.Getenv anywhere in this file: credentials arrive as explicit
// Config fields only (spec/modes.md "The SDK reads no environment
// variables. Credentials arrive as explicit options.").
package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"
)

const (
	evaluatePath       = "/v1/flags/evaluate"
	registerTargetPath = "/v1/targets/register"
)

// DefaultAllowedHosts is the SSRF egress allowlist used when Config.AllowedHosts
// is not set: the canonical Fireweave production/staging hosts plus loopback
// (matches node's hosts.ts DEFAULT_ALLOWED_HOSTS and java's
// FireweaveConfig.DEFAULT_ALLOWED_HOSTS, minus the PostHog entries java
// still carries for its separate vendor-adapter seam, which Go's v1 has no
// equivalent of).
//
// This is deliberately NOT "the configured APIURL's own hostname" — that
// would make the default permissive-by-construction (any URL trivially
// satisfies an allowlist built from itself), which defeats the SSRF guard's
// purpose (spec/modes.md "apiUrl fails the host allowlist" is only
// reachable if some caller-configured hosts are genuinely NOT in the
// default set). A self-hosted fw-server must list its own host explicitly
// via Config.AllowedHosts; "*" opts out entirely.
var DefaultAllowedHosts = []string{
	"app-server.fireweave.ai", "staging-app-server.fireweave.ai",
	"localhost", "127.0.0.1", "::1",
}

// Config configures the remote adapter.
type Config struct {
	// APIURL is the fw-server base URL. Required.
	APIURL string
	// APIKey is the Fireweave project/runtime key. Required.
	APIKey string
	// AllowedHosts overrides the egress allowlist. Default: DefaultAllowedHosts
	// (the curated Fireweave production/staging hosts plus loopback) — NOT
	// the configured APIURL's own hostname, which would make the default
	// permissive by construction and defeat the SSRF guard. A self-hosted
	// fw-server must list its own host explicitly here, or pass ["*"] to
	// opt out of host pinning entirely.
	AllowedHosts []string
	// RequestTimeout bounds evaluate/registerTarget (default 3s).
	RequestTimeout time.Duration
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
	closed  bool
	ready   bool
}

type evaluateRequest struct {
	TargetingKey    string            `json:"targetingKey"`
	Attributes      map[string]any    `json:"attributes,omitempty"`
	Groups          map[string]string `json:"groups,omitempty"`
	GroupProperties map[string]any    `json:"groupProperties,omitempty"`
	FlagKeys        []string          `json:"flagKeys,omitempty"`
}

type decisionItem struct {
	FlagKey      string         `json:"flagKey"`
	Value        any            `json:"value"`
	Variant      *string        `json:"variant"`
	Reason       string         `json:"reason"`
	Found        bool           `json:"found"`
	Enabled      *bool          `json:"enabled"`
	FlagMetadata map[string]any `json:"flagMetadata"`
	// Payload mirrors python's/node's remote adapter (both already read an
	// item-level "payload" field): task-10b item 5 parity. Attached as
	// fireweave.payload metadata only when the caller's EvaluateOptions sets
	// IncludePayload — the wire value is read unconditionally (like
	// python's FlagResolution.payload) and gated locally, matching node's
	// resolution.payload / options.includePayload split.
	Payload any `json:"payload,omitempty"`
}

type evaluateResponse struct {
	Decisions    []decisionItem `json:"decisions"`
	RequestID    string         `json:"requestId"`
	QuotaLimited bool           `json:"quotaLimited"`
}

type registerTargetRequest struct {
	TargetingKey string         `json:"targetingKey"`
	Kind         string         `json:"kind,omitempty"`
	Environment  string         `json:"environment,omitempty"`
	Properties   map[string]any `json:"properties,omitempty"`
}

// New builds a remote adapter.
func New(cfg Config) *Adapter {
	return &Adapter{cfg: cfg}
}

// Initialize implements domain.BackendAdapter.
func (a *Adapter) Initialize(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return domain.NewError(domain.KindTimeout, "", err)
	}
	apiURL := strings.TrimRight(strings.TrimSpace(a.cfg.APIURL), "/")
	apiKey := strings.TrimSpace(a.cfg.APIKey)
	if apiURL == "" || apiKey == "" {
		return domain.NewError(domain.KindConfiguration, "", nil)
	}
	u, err := url.Parse(apiURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return domain.NewError(domain.KindConfiguration, "", nil)
	}
	host := strings.ToLower(u.Hostname())
	if u.Scheme == "http" && !isLoopback(host) {
		return domain.NewError(domain.KindConfiguration, "", nil)
	}
	allow := a.cfg.AllowedHosts
	if len(allow) == 0 {
		allow = DefaultAllowedHosts
	}
	if !hostAllowed(host, allow) {
		return domain.NewError(domain.KindConfiguration, "", nil)
	}
	client := a.cfg.HTTPClient
	if client == nil {
		// No client-level Timeout here: postJSON derives its own
		// per-request context.WithTimeout from cfg.RequestTimeout (task-10b
		// item 3) and that is the sole, authoritative deadline. A
		// second, independent http.Client.Timeout racing the same duration
		// against a context deadline it cannot see would make timeout
		// classification (ctx.Err() in postJSON) nondeterministic depending
		// on which fires first.
		client = &http.Client{}
	}
	a.client = client
	a.baseURL = apiURL
	a.apiKey = apiKey
	a.ready = true
	return nil
}

// Resolve implements domain.BackendAdapter.
func (a *Adapter) Resolve(ctx context.Context, req domain.ResolveRequest) domain.Decision {
	if a.closed {
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, domain.NewError(domain.KindAlreadyClosed, "", nil), nil)
	}
	if !a.ready {
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, domain.NewError(domain.KindNotReady, "", nil), nil)
	}
	targeting := req.Context.TargetingKey
	if targeting == "" {
		err := domain.NewError(domain.KindInvalidContext, "targeting key missing", nil)
		err.TargetingKeyMissing = true
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, err, nil)
	}

	attrs := map[string]any{}
	for k, v := range req.Context.Attributes {
		if k == "groups" || k == "groupProperties" || k == domain.AttrGroups || k == domain.AttrGroupProperties ||
			strings.HasPrefix(k, "$") || strings.HasPrefix(k, "fireweave.") {
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
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, err, nil)
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
			extra[domain.MetaQuotaLimited] = true
		}
		return domain.ErrorDecision(req.FlagKey, req.DefaultValue, domain.NewError(domain.KindFlagNotFound, "", nil), extra)
	}
	meta := map[string]any{}
	for k, v := range item.FlagMetadata {
		meta[k] = v
	}
	if resp.QuotaLimited {
		meta[domain.MetaQuotaLimited] = true
	}
	if req.IncludePayload && item.Payload != nil {
		if s, ok := payloadString(item.Payload); ok {
			meta[domain.MetaPayload] = s
		}
	}
	reason := domain.Reason(item.Reason)
	if reason == "" {
		reason = domain.ReasonTargetingMatch
	}
	variant := ""
	if item.Variant != nil {
		variant = *item.Variant
	}
	value := item.Value
	if req.Type == domain.FlagTypeNumber {
		value = numberValue(value)
	}
	return domain.Decision{
		FlagKey:  req.FlagKey,
		Value:    value,
		Variant:  variant,
		Reason:   reason,
		Metadata: meta,
	}
}

// numberValue preserves integral wire values EXACTLY for NUMBER-typed
// flags (contracts/evaluation/eval-int-beyond-safe-integer.json), mirroring
// infrastructure/adapters/inmemory's convertValue fix and rationale: since
// postJSON now decodes with json.Decoder.UseNumber (below), a NUMBER-typed
// item.Value arrives as json.Number rather than a lossy float64 — this
// converts it to int64 when it fits exactly, falling back to float64 only
// for genuinely fractional wire values.
func numberValue(v any) any {
	n, ok := v.(json.Number)
	if !ok {
		return v
	}
	if i, err := n.Int64(); err == nil {
		return i
	}
	if f, err := n.Float64(); err == nil {
		return f
	}
	return v
}

// payloadString renders a wire payload as the fireweave.payload metadata
// string. A payload that arrives as a raw JSON string (spec/remote-evaluate.
// schema.json's payload field is unconstrained jsonValue; node's ports.ts
// documents it explicitly: "object or pre-serialized JSON string" — and
// json.Decoder.UseNumber above only affects numbers, so a string wire value
// decodes to a plain Go string here) is passed through VERBATIM, mirroring
// node (runtime.ts) and python (runtime.py)'s identical ternary — re-
// serializing it would double-encode ("\"{...}\"" instead of "{...}").
// Every other JSON shape is serialized via encoding/json.Marshal, matching
// infrastructure/adapters/inmemory's payloadString.
func payloadString(payload any) (string, bool) {
	if s, ok := payload.(string); ok {
		return s, true
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// RegisterTarget implements domain.TargetRegistrar: POST
// /v1/targets/register. Never returns an error for a transport failure by
// panicking — registration sits in login paths, and a targeting concern
// must not break sign-in. Retried once when the error taxonomy marks the
// failure retryable; a rejected payload or bad key is not retried, since it
// would be rejected identically.
func (a *Adapter) RegisterTarget(ctx context.Context, targetingKey string, opts domain.RegisterTargetOptions) domain.RegisterTargetResult {
	if a.closed {
		return domain.RegisterTargetResult{Error: domain.NewError(domain.KindAlreadyClosed, "", nil)}
	}
	if !a.ready {
		return domain.RegisterTargetResult{Error: domain.NewError(domain.KindNotReady, "", nil)}
	}
	if targetingKey == "" {
		err := domain.NewError(domain.KindInvalidContext, "targeting key missing", nil)
		err.TargetingKeyMissing = true
		return domain.RegisterTargetResult{Error: err}
	}

	body := registerTargetRequest{TargetingKey: targetingKey, Environment: opts.Environment}
	if opts.Kind != "" {
		body.Kind = string(opts.Kind)
	}
	if len(opts.Properties) > 0 {
		body.Properties = opts.Properties
	}

	var lastErr *domain.Error
	for attempt := 0; attempt < 2; attempt++ {
		if err := a.postJSON(ctx, registerTargetPath, body, nil); err != nil {
			lastErr = err
			if !domain.Retryable(err.Kind) {
				break
			}
			continue
		}
		return domain.RegisterTargetResult{OK: true}
	}
	return domain.RegisterTargetResult{Error: lastErr}
}

// Close implements domain.BackendAdapter.
func (a *Adapter) Close(ctx context.Context) error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	a.ready = false
	a.mu.Unlock()
	return nil
}

func (a *Adapter) postJSON(ctx context.Context, path string, body any, out any) *domain.Error {
	raw, err := json.Marshal(body)
	if err != nil {
		return domain.NewError(domain.KindInternal, "", err)
	}

	// Derive a per-request deadline from the configured RequestTimeout
	// INSIDE the adapter (task-10b item 3: ControlPoints.Evaluate hardcodes
	// context.Background() with no public-API ctx to carry a deadline — the
	// no-public-ctx ruling from Task 9 stands, so classification cannot
	// depend on the caller supplying one). Relying on http.Client.Timeout
	// alone does not work here: that mechanism cancels the request via its
	// OWN internally-derived context, invisible to the ctx handle this
	// function holds, so checking ctx.Err() after client.Do always saw a
	// live (non-Background-derived) context and misclassified every
	// timeout as Network. Holding our own cancel func means ctx.Err() is
	// authoritative for classification below regardless of what client.Do
	// does internally.
	timeout := a.cfg.RequestTimeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, a.baseURL+path, bytes.NewReader(raw))
	if err != nil {
		return domain.NewError(domain.KindNetwork, "", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.apiKey)
	resp, err := a.client.Do(req)
	if err != nil {
		if reqCtx.Err() != nil {
			return domain.NewError(domain.KindTimeout, "", err)
		}
		return domain.NewError(domain.KindNetwork, "", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	switch {
	case resp.StatusCode == 401:
		return domain.NewError(domain.KindAuthentication, "", nil)
	case resp.StatusCode == 403:
		return domain.NewError(domain.KindAuthorization, "", nil)
	case resp.StatusCode == 429:
		return domain.NewError(domain.KindRateLimited, "", nil)
	case resp.StatusCode >= 500:
		return domain.NewError(domain.KindBackendUnavailable, "", nil)
	case resp.StatusCode >= 400:
		return domain.NewError(domain.KindBackendUnavailable, "", nil)
	}
	if out != nil {
		// UseNumber preserves integral wire values exactly (task-10b item
		// 2's remote-adapter parity check — see numberValue above): the
		// default json.Unmarshal decodes every JSON number into float64,
		// which would silently round a NUMBER-typed value beyond 2^53-1
		// the same way inmemory's convertValue used to.
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.UseNumber()
		if err := dec.Decode(out); err != nil {
			return domain.NewError(domain.KindMalformedResponse, "", err)
		}
	}
	return nil
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

var (
	_ domain.BackendAdapter  = (*Adapter)(nil)
	_ domain.TargetRegistrar = (*Adapter)(nil)
)
