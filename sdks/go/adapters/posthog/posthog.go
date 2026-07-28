// Package posthog implements the Fireweave BackendAdapter on top of the
// official posthog-go SDK (v1.22.0), per ADR-0002.
//
// Design notes:
//
//   - Resolution uses exclusively the EvaluateFlags snapshot API.
//   - No posthog-go types appear in this package's exported API (asserted by
//     TestNoVendorTypesInPublicAPI).
//   - posthog-go's flags request runs on an internal background context, so
//     Resolve wraps evaluation in a goroutine and honors the caller's
//     context by deadline/cancellation.
//   - Per-flag metadata (version, id, reason code) and the quota_limited
//     signal are not exported from posthog-go's snapshot, so the adapter
//     installs a response-intercepting http.RoundTripper that parses the
//     raw /flags response. Interception is keyed by distinct_id; concurrent
//     evaluations for the same distinct_id may observe each other's
//     metadata (best effort, values are identical in practice).
//   - posthog-go emits $feature_flag_called implicitly whenever a snapshot
//     value is read. A BeforeSend gate drops those events unless exposure
//     sending is enabled and the (distinct_id, flag, response) tuple has
//     not been sent before (exposure dedup; the dedup set clears on every
//     telemetry flush).
//
// # Context attribute mapping
//
// Evaluation-context attributes map onto the vendor /flags payload as
// follows (see buildPayload):
//
//   - The targeting key becomes the PostHog distinct_id.
//   - The canonical carve-out keys "fireweave.groups" and
//     "fireweave.groupProperties" (rulings 12–14) become the vendor
//     "groups" / "group_properties" fields; the plain "groups" /
//     "groupProperties" spellings remain a documented pre-canon alias.
//   - Attributes whose key starts with "$" are treated as PostHog vendor
//     directives (e.g. "$process_person_profile") and are STRIPPED from
//     person properties — they are never transmitted as person data and
//     never appear in the resolved Fireweave context.
//   - Every other attribute becomes a PostHog person property.
//
// Flag payloads are attached to decision metadata (fireweave.payload) only
// when the evaluation was marked with fireweave.WithIncludePayload(ctx).
//
// Concurrency: Adapter is safe for concurrent use. Initialize is called
// once by the runtime; Resolve may run from many goroutines concurrently
// with Close.
package posthog

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	posthoggo "github.com/posthog/posthog-go"
)

// DefaultCloseTimeout bounds Close when neither the caller's context nor
// Config.CloseTimeout supplies a deadline. posthog-go's default is an
// indefinite wait, which must not leak to Fireweave callers.
const DefaultCloseTimeout = 5 * time.Second

// defaultAllowedHosts is the canonical cross-language endpoint allowlist
// applied when Config.AllowedHosts is empty (SSRF guard): the five official
// PostHog hosts plus loopback. Custom (e.g. self-hosted) hosts require an
// explicit Config.AllowedHosts entry. https is required for non-loopback
// hosts; plain http is permitted on loopback only.
var defaultAllowedHosts = []string{
	"app.posthog.com", "us.posthog.com", "eu.posthog.com",
	"us.i.posthog.com", "eu.i.posthog.com",
	"localhost", "127.0.0.1", "::1",
}

// isLoopbackHost reports whether the hostname is the canonical loopback set
// (localhost, 127.0.0.1, ::1).
func isLoopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1" || host == "::1"
}

// Config configures the adapter. It deliberately contains only stdlib
// types.
type Config struct {
	// ProjectAPIKey is the PostHog project API key (phc_...). Required.
	ProjectAPIKey string
	// SecretKey (phs_.../phx_...) enables local flag evaluation.
	SecretKey string
	// Endpoint is the PostHog host, e.g. "https://us.i.posthog.com".
	// Required; the host must be on the allowlist.
	Endpoint string
	// AllowedHosts overrides the endpoint allowlist (hostnames, no port).
	AllowedHosts []string
	// LocalEvaluationOnly forbids remote /flags fallback (requires
	// SecretKey).
	LocalEvaluationOnly bool
	// FlagRequestTimeout bounds each /flags request (default: posthog-go's
	// default, 3s).
	FlagRequestTimeout time.Duration
	// FlagRequestRetries is the number of retries after a failed /flags
	// request. Default 0: Fireweave surfaces the typed error and lets the
	// caller decide (OpenFeature returns the default value either way).
	FlagRequestRetries int
	// SendExposureEvents enables $feature_flag_called exposure events
	// (deduplicated per distinct_id/flag/value). Default false.
	SendExposureEvents bool
	// CloseTimeout bounds Close when the caller's context carries no
	// deadline. Default DefaultCloseTimeout.
	CloseTimeout time.Duration
	// Transport overrides the HTTP transport (test injection; no live
	// network in tests).
	Transport http.RoundTripper
}

// Adapter is the PostHog-backed fireweave.BackendAdapter.
type Adapter struct {
	cfg       Config
	intercept *interceptTransport
	gate      *exposureGate

	mu       sync.Mutex
	client   posthoggo.Client // nil until Initialize; owned unless injected
	injected bool             // injected clients are not closed by Close
	closed   bool
}

// New builds an adapter. Configuration is validated in Initialize so the
// runtime can map failures to its FATAL state.
func New(cfg Config) *Adapter {
	if cfg.CloseTimeout <= 0 {
		cfg.CloseTimeout = DefaultCloseTimeout
	}
	return &Adapter{
		cfg:  cfg,
		gate: &exposureGate{send: cfg.SendExposureEvents, seen: map[string]bool{}, allow: map[string]int{}},
	}
}

// newWithClient injects a pre-built posthog-go client (tests only; keeps
// vendor types out of the public API). Injected clients are never closed
// by Close — the injector owns their lifecycle.
func newWithClient(cfg Config, client posthoggo.Client) *Adapter {
	a := New(cfg)
	a.client = client
	a.injected = true
	return a
}

var _ fireweave.BackendAdapter = (*Adapter)(nil)
var _ fireweave.TelemetrySink = (*Adapter)(nil)
var _ fireweave.CapabilityReporter = (*Adapter)(nil)

// validateConfig enforces required keys and the endpoint allowlist. Error
// messages are fixed strings: they never echo the key or endpoint.
func (a *Adapter) validateConfig() *fireweave.Error {
	if a.cfg.ProjectAPIKey == "" {
		return fireweave.NewError(fireweave.KindConfiguration, "invalid configuration", nil)
	}
	u, err := url.Parse(a.cfg.Endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return fireweave.NewError(fireweave.KindConfiguration, "invalid configuration", nil)
	}
	host := u.Hostname()
	// https is required for non-loopback hosts; plain http is allowed on
	// loopback only (the local test-server).
	if u.Scheme == "http" && !isLoopbackHost(host) {
		return fireweave.NewError(fireweave.KindConfiguration, "invalid configuration", nil)
	}
	allowed := a.cfg.AllowedHosts
	if len(allowed) == 0 {
		allowed = defaultAllowedHosts
	}
	ok := false
	for _, h := range allowed {
		if strings.EqualFold(h, host) {
			ok = true
			break
		}
	}
	if !ok {
		return fireweave.NewError(fireweave.KindConfiguration, "invalid configuration", nil)
	}
	if a.cfg.LocalEvaluationOnly && a.cfg.SecretKey == "" {
		return fireweave.NewError(fireweave.KindConfiguration, "invalid configuration", nil)
	}
	return nil
}

// Initialize validates configuration and constructs the owned posthog-go
// client. Configuration failures are fatal (KindConfiguration).
func (a *Adapter) Initialize(ctx context.Context) error {
	if err := a.validateConfig(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return fireweave.NewError(fireweave.KindTimeout, "", err)
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return fireweave.NewError(fireweave.KindAlreadyClosed, "", nil)
	}
	if a.client != nil { // already initialized or injected
		return nil
	}

	base := a.cfg.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	a.intercept = &interceptTransport{base: base}

	retries := a.cfg.FlagRequestRetries
	phCfg := posthoggo.Config{
		Endpoint:                     a.cfg.Endpoint,
		SecretKey:                    a.cfg.SecretKey,
		Transport:                    a.intercept,
		FeatureFlagRequestTimeout:    a.cfg.FlagRequestTimeout,
		FeatureFlagRequestMaxRetries: &retries,
		ShutdownTimeout:              a.cfg.CloseTimeout,
		BeforeSend:                   a.gate.beforeSend,
		Logger:                       silentLogger{},
	}
	client, err := posthoggo.NewWithConfig(a.cfg.ProjectAPIKey, phCfg)
	if err != nil {
		// posthog-go config errors are configuration errors; the vendor
		// message may include field values, so keep only the fixed message.
		return fireweave.NewError(fireweave.KindConfiguration, "invalid configuration", err)
	}
	a.client = client
	return nil
}

func (a *Adapter) currentClient() (posthoggo.Client, *fireweave.Error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil, fireweave.NewError(fireweave.KindAlreadyClosed, "", nil)
	}
	if a.client == nil {
		return nil, fireweave.NewError(fireweave.KindNotReady, "", nil)
	}
	return a.client, nil
}

// Resolve evaluates one flag through the snapshot API. Failures surface as
// error decisions carrying the caller default (never returned as errors).
func (a *Adapter) Resolve(ctx context.Context, req fireweave.ResolveRequest) fireweave.Decision {
	client, gerr := a.currentClient()
	if gerr != nil {
		return fireweave.ErrorDecision(req.DefaultValue, gerr, nil)
	}

	payload := a.buildPayload(req)

	// posthog-go's /flags request runs on an internal background context;
	// honor the caller's context by racing it.
	type evalResult struct {
		snap *posthoggo.FeatureFlagEvaluations
		err  error
	}
	resCh := make(chan evalResult, 1)
	go func() {
		// EvaluateFlagsWithContext is on the concrete vendor client but not
		// its Client interface; use it when available.
		if cc, ok := client.(interface {
			EvaluateFlagsWithContext(context.Context, posthoggo.EvaluateFlagsPayload) (*posthoggo.FeatureFlagEvaluations, error)
		}); ok {
			snap, err := cc.EvaluateFlagsWithContext(ctx, payload)
			resCh <- evalResult{snap, err}
			return
		}
		snap, err := client.EvaluateFlags(payload)
		resCh <- evalResult{snap, err}
	}()

	var snap *posthoggo.FeatureFlagEvaluations
	var evalErr error
	select {
	case r := <-resCh:
		snap, evalErr = r.snap, r.err
	case <-ctx.Done():
		return fireweave.ErrorDecision(req.DefaultValue,
			fireweave.NewError(fireweave.KindTimeout, "", ctx.Err()), nil)
	}

	captured := a.takeCaptured(req.Context.TargetingKey)

	if evalErr != nil {
		fwErr := mapVendorError(evalErr)
		var extra map[string]any
		if captured != nil && captured.quotaLimited {
			extra = map[string]any{fireweave.MetaQuotaLimited: true}
		}
		return fireweave.ErrorDecision(req.DefaultValue, fwErr, extra)
	}

	keys := snap.Keys()
	found := false
	for _, k := range keys {
		if k == req.FlagKey {
			found = true
			break
		}
	}
	if !found {
		var extra map[string]any
		if captured != nil && captured.quotaLimited {
			extra = map[string]any{fireweave.MetaQuotaLimited: true}
		}
		return fireweave.ErrorDecision(req.DefaultValue,
			fireweave.NewError(fireweave.KindFlagNotFound, "", nil), extra)
	}

	// Arm the exposure gate before touching value accessors (each access
	// may fire a $feature_flag_called event through BeforeSend).
	a.gate.arm(req.Context.TargetingKey, req.FlagKey)

	raw := snap.GetFlag(req.FlagKey)
	var detail *capturedFlagDetail
	if captured != nil {
		detail = captured.flags[req.FlagKey]
	}
	return buildDecision(req, raw, snap.GetFlagPayload(req.FlagKey), detail)
}

// buildPayload maps the Fireweave context onto the vendor payload:
// targetingKey → distinct_id; the canonical fireweave.groups /
// fireweave.groupProperties carve-out keys (rulings 12–14) map to the
// dedicated groups / group_properties fields (the plain "groups" /
// "groupProperties" spellings remain a documented pre-canon alias, with
// the canonical keys taking precedence when both are present);
// "$"-prefixed attributes are vendor directives (not person properties)
// and are stripped from person_properties; everything else becomes a
// person property.
func (a *Adapter) buildPayload(req fireweave.ResolveRequest) posthoggo.EvaluateFlagsPayload {
	payload := posthoggo.EvaluateFlagsPayload{
		DistinctId:          req.Context.TargetingKey,
		OnlyEvaluateLocally: a.cfg.LocalEvaluationOnly,
		FlagKeys:            []string{req.FlagKey},
	}
	attrs := req.Context.Attributes

	if g, ok := groupAttr(attrs, fireweave.AttrGroups, "groups"); ok {
		groups := posthoggo.Groups{}
		for gk, gv := range g {
			groups[gk] = gv
		}
		payload.Groups = groups
	}
	if gp, ok := groupAttr(attrs, fireweave.AttrGroupProperties, "groupProperties"); ok {
		out := map[string]posthoggo.Properties{}
		for gk, gv := range gp {
			if m, ok := gv.(map[string]any); ok {
				props := posthoggo.NewProperties()
				for pk, pv := range m {
					props[pk] = pv
				}
				out[gk] = props
			}
		}
		payload.GroupProperties = out
	}

	person := posthoggo.NewProperties()
	for k, v := range attrs {
		switch {
		case k == "groups" || k == "groupProperties":
			// Group carve-out (canonical or alias spelling): mapped above,
			// never a person property.
		case strings.HasPrefix(k, fireweave.ReservedKeyPrefix):
			// fireweave.* reserved namespace (incl. the canonical group
			// keys): never a person property.
		case strings.HasPrefix(k, "$"):
			// Vendor directive (e.g. $process_person_profile); not a person
			// property.
		default:
			person[k] = v
		}
	}
	if len(person) > 0 {
		payload.PersonProperties = person
	}
	return payload
}

// groupAttr reads a map-valued attribute preferring the canonical
// fireweave.* key over the legacy plain-spelling alias.
func groupAttr(attrs map[string]any, canonical, alias string) (map[string]any, bool) {
	if m, ok := attrs[canonical].(map[string]any); ok {
		return m, true
	}
	if m, ok := attrs[alias].(map[string]any); ok {
		return m, true
	}
	return nil, false
}

// buildDecision converts vendor values into a normalized Decision,
// enforcing the requested type strictly (TypeMismatch instead of coercion).
func buildDecision(req fireweave.ResolveRequest, raw any, payload string, detail *capturedFlagDetail) fireweave.Decision {
	meta := map[string]any{}
	variant := ""
	reason := fireweave.ReasonTargetingMatch
	if detail != nil {
		if detail.Variant != nil {
			variant = *detail.Variant
		}
		if detail.Metadata.Version != 0 {
			meta[fireweave.MetaFlagVersion] = int64(detail.Metadata.Version)
		}
		if detail.Metadata.ID != 0 && detail.Reason != nil && detail.Reason.ConditionIndex != nil {
			meta[fireweave.MetaVendorFlagID] = int64(detail.Metadata.ID)
			meta[fireweave.MetaReasonCode] = detail.Reason.Code
		}
		if !detail.Enabled {
			reason = fireweave.ReasonDisabled
		}
	}
	if req.IncludePayload && payload != "" {
		meta[fireweave.MetaPayload] = payload
	}
	if len(meta) == 0 {
		meta = nil
	}

	value, ok := coerceValue(req.Type, raw, payload)
	if !ok {
		return fireweave.ErrorDecision(req.DefaultValue,
			fireweave.NewError(fireweave.KindTypeMismatch, "", nil), nil)
	}
	if b, isBool := raw.(bool); isBool && !b {
		reason = fireweave.ReasonDisabled
	}
	return fireweave.Decision{Value: value, Variant: variant, Reason: reason, Metadata: meta}
}

// coerceValue maps the vendor value (bool or variant string) plus optional
// JSON payload onto the requested type. PostHog flags are natively boolean
// or multivariate-string; integer/float/object values come from payloads.
func coerceValue(t fireweave.FlagType, raw any, payload string) (any, bool) {
	switch t {
	case fireweave.FlagTypeBoolean:
		b, ok := raw.(bool)
		if ok {
			return b, true
		}
		return nil, false
	case fireweave.FlagTypeString:
		s, ok := raw.(string)
		return s, ok
	case fireweave.FlagTypeInteger:
		var n json.Number
		if err := json.Unmarshal([]byte(payload), &n); err != nil {
			return nil, false
		}
		i, err := n.Int64()
		if err != nil {
			return nil, false
		}
		return i, true
	case fireweave.FlagTypeFloat:
		var n json.Number
		if err := json.Unmarshal([]byte(payload), &n); err != nil {
			return nil, false
		}
		f, err := n.Float64()
		if err != nil {
			return nil, false
		}
		return f, true
	case fireweave.FlagTypeObject:
		var obj map[string]any
		if err := json.Unmarshal([]byte(payload), &obj); err != nil {
			return nil, false
		}
		return obj, true
	}
	return nil, false
}

// mapVendorError maps posthog-go errors to the canonical taxonomy. The
// vendor error is wrapped as the cause; its text never reaches Message.
func mapVendorError(err error) *fireweave.Error {
	var apiErr *posthoggo.APIError
	if errors.As(err, &apiErr) {
		switch {
		case apiErr.StatusCode == http.StatusUnauthorized:
			return fireweave.NewError(fireweave.KindAuthentication, "", err)
		case apiErr.StatusCode == http.StatusForbidden:
			return fireweave.NewError(fireweave.KindAuthorization, "", err)
		case apiErr.StatusCode == http.StatusTooManyRequests:
			return fireweave.NewError(fireweave.KindRateLimited, "", err)
		case apiErr.StatusCode >= 500:
			return fireweave.NewError(fireweave.KindBackendUnavailable, "", err)
		default:
			return fireweave.NewError(fireweave.KindInternal, "", err)
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || os.IsTimeout(err) {
		return fireweave.NewError(fireweave.KindTimeout, "", err)
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		if netErr.Timeout() {
			return fireweave.NewError(fireweave.KindTimeout, "", err)
		}
		return fireweave.NewError(fireweave.KindNetwork, "", err)
	}
	var opErr *net.OpError
	var dnsErr *net.DNSError
	if errors.As(err, &opErr) || errors.As(err, &dnsErr) {
		return fireweave.NewError(fireweave.KindNetwork, "", err)
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return fireweave.NewError(fireweave.KindNetwork, "", err)
	}
	// posthog-go wraps JSON decode failures with this fixed prefix (no
	// typed error is exposed).
	if strings.Contains(err.Error(), "error parsing response") {
		return fireweave.NewError(fireweave.KindMalformedResponse, "", err)
	}
	if strings.Contains(err.Error(), "sending request") {
		return fireweave.NewError(fireweave.KindNetwork, "", err)
	}
	return fireweave.NewError(fireweave.KindInternal, "", err)
}

// Close shuts the owned client down, bounded by the caller's context or
// CloseTimeout — posthog-go's indefinite default never leaks. Idempotent.
func (a *Adapter) Close(ctx context.Context) error {
	a.mu.Lock()
	if a.closed {
		a.mu.Unlock()
		return nil
	}
	a.closed = true
	client := a.client
	a.client = nil
	injected := a.injected
	a.mu.Unlock()

	if client == nil || injected {
		return nil
	}

	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, a.cfg.CloseTimeout)
		defer cancel()
	}

	done := make(chan error, 1)
	go func() { done <- client.CloseWithContext(ctx) }()
	select {
	case err := <-done:
		if err != nil && !errors.Is(err, posthoggo.ErrClosed) {
			return fireweave.NewError(fireweave.KindInternal, "close failed", err)
		}
		return nil
	case <-ctx.Done():
		return fireweave.NewError(fireweave.KindTimeout, "close deadline exceeded", ctx.Err())
	}
}

// EnqueueTelemetry forwards one normalized telemetry event as a vendor
// capture event.
func (a *Adapter) EnqueueTelemetry(ctx context.Context, ev fireweave.TelemetryEvent) error {
	client, gerr := a.currentClient()
	if gerr != nil {
		return gerr
	}
	props := posthoggo.NewProperties()
	for k, v := range ev.Properties {
		props[k] = v
	}
	capture := posthoggo.Capture{
		DistinctId: ev.DistinctID,
		Event:      ev.Name,
		Properties: props,
	}
	var err error
	if cc, ok := client.(interface {
		EnqueueWithContext(context.Context, posthoggo.Message) error
	}); ok {
		err = cc.EnqueueWithContext(ctx, capture)
	} else {
		err = client.Enqueue(capture)
	}
	if err != nil {
		return fireweave.NewError(fireweave.KindInternal, "telemetry enqueue failed", err)
	}
	return nil
}

// FlushTelemetry is best-effort: posthog-go batches on an interval and
// drains deterministically only on Close, which the adapter performs with
// a bounded deadline. Flushing clears the exposure gate's response-level
// dedup set (clear-on-flush lifecycle) so it cannot grow unbounded in
// long-lived, high-cardinality services.
func (a *Adapter) FlushTelemetry(ctx context.Context) error {
	a.gate.clearSeen()
	return ctx.Err()
}

// ReportCapabilities implements fireweave.CapabilityReporter for the
// structured capabilities.get matrix (ruling 18).
func (a *Adapter) ReportCapabilities() fireweave.AdapterCapabilities {
	return fireweave.AdapterCapabilities{
		Backend: "posthog",
		Features: map[string]bool{
			"remoteEvaluation":    !a.cfg.LocalEvaluationOnly,
			"localEvaluation":     a.cfg.SecretKey != "",
			"localOnly":           a.cfg.LocalEvaluationOnly,
			"exposureEmission":    a.cfg.SendExposureEvents,
			"sideEffectFreeReads": !a.cfg.SendExposureEvents,
			"groupAnalytics":      true,
		},
	}
}

// takeCaptured returns intercepted /flags response data for a distinct_id.
func (a *Adapter) takeCaptured(distinctID string) *capturedResponse {
	if a.intercept == nil {
		return nil
	}
	return a.intercept.take(distinctID)
}

// silentLogger drops posthog-go's internal logging (it may interpolate
// hosts/keys).
type silentLogger struct{}

func (silentLogger) Logf(string, ...any)   {}
func (silentLogger) Errorf(string, ...any) {}
func (silentLogger) Warnf(string, ...any)  {}
func (silentLogger) Debugf(string, ...any) {}
