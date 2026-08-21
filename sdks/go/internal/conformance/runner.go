// Package conformance runs the canonical contracts/ fixtures against the
// real v1 control-points surface (fireweave.Client.ControlPoints — there is
// no OpenFeature bridge to reach for any more; ADR-0010 retired it and the
// go/openfeature package with it) and emits the compatibility-report JSON
// defined by contracts/README.md.
package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/infrastructure/adapters/inmemory"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/infrastructure/adapters/remote"
)

// Result is one compatibility-report row.
type Result struct {
	FixtureID  string  `json:"fixtureId"`
	Suite      string  `json:"suite"`
	Language   string  `json:"language"`
	Status     string  `json:"status"`
	Limitation *string `json:"limitation"`
	Message    *string `json:"message"`
}

// Report is the contracts/README.md compatibility report.
type Report struct {
	SchemaVersion int            `json:"schemaVersion"`
	GeneratedAt   string         `json:"generatedAt"`
	Results       []Result       `json:"results"`
	Summary       map[string]int `json:"summary"`
}

const language = "go"

// v1OutOfScopeExtensionFixtures classifies the 14 contracts/extensions/*.json
// fixtures (contracts/harness.md "Extension fixtures — v1 scope rule",
// ruling 2). They are frozen and were authored against the pre-v1 surface
// (releases/exposures/signals/capabilities discovery) — cut entirely by
// ADR-0010. 13 dispatch onto a cut namespace and are reported
// skipped-v1-out-of-scope without executing; only
// ext-unsupported-capability-degrade exercises real v1 surface
// (Client.InvokeCapability, present and un-cut) and runs for real. See
// sdks/node/test/conformance/run.ts for the fully-annotated per-fixture
// table — the classification is identical across languages because the SDK
// surface these fixtures exercise is the same everywhere.
var v1OutOfScopeExtensionFixtures = map[string]bool{
	"ext-capabilities-get":     true,
	"ext-exposures-dedup":      true,
	"ext-exposures-flush":      true,
	"ext-exposures-record":     true,
	"ext-lifecycle-gating":     true,
	"ext-releases-complete":    true,
	"ext-releases-fail":        true,
	"ext-releases-set-context": true,
	"ext-releases-start":       true,
	"ext-signals-error":        true,
	"ext-signals-health":       true,
	"ext-signals-metric":       true,
	"ext-signals-outcome":      true,
}

func v1OutOfScopeNamespace(id string) string {
	switch {
	case id == "ext-capabilities-get":
		return "capabilities"
	case strings.HasPrefix(id, "ext-exposures-"):
		return "exposures"
	case id == "ext-lifecycle-gating":
		return "signals"
	case strings.HasPrefix(id, "ext-releases-"):
		return "releases"
	case strings.HasPrefix(id, "ext-signals-"):
		return "signals"
	default:
		return "unknown"
	}
}

// Run executes every fixture and returns the aggregated report.
func Run(contractsDir string) (*Report, error) {
	fixtures, err := LoadFixtures(contractsDir)
	if err != nil {
		return nil, err
	}
	report := &Report{
		SchemaVersion: 1,
		GeneratedAt:   "EXCLUDED",
		Summary: map[string]int{
			"pass": 0, "fail": 0,
			"skipped-with-documented-limitation": 0,
			"skipped-v1-out-of-scope":            0,
		},
	}
	for _, f := range fixtures {
		res := runOne(f)
		report.Summary[res.Status]++
		report.Results = append(report.Results, res)
	}
	return report, nil
}

func runOne(f Fixture) Result {
	res := Result{FixtureID: f.ID, Suite: f.Suite, Language: language}

	// v1-scope rule (contracts/harness.md): extensions fixtures targeting a
	// cut namespace are reported skipped-v1-out-of-scope, never executed,
	// regardless of the fixture's own declared compatibility (frozen "pass",
	// authored pre-cut).
	if f.Suite == "extensions" && v1OutOfScopeExtensionFixtures[f.ID] {
		res.Status = "skipped-v1-out-of-scope"
		lim := fmt.Sprintf("targets the %s namespace, cut from the v1 control-points surface (ADR-0010)", v1OutOfScopeNamespace(f.ID))
		res.Limitation = &lim
		return res
	}

	if f.Compatibility[language] == "skipped-with-documented-limitation" {
		res.Status = "skipped-with-documented-limitation"
		if lim, ok := f.Limitations[language]; ok {
			res.Limitation = &lim
		}
		return res
	}

	// Multi-case fixtures (contracts/README.md): every case runs against a
	// fresh setup with cases[].given shallow-merged over the fixture-level
	// given; all cases must pass. One report row per fixture.
	if len(f.Cases) > 0 {
		var failures []string
		var notes []string
		for _, cs := range f.Cases {
			cf := f
			cf.Cases = nil
			cf.Given = mergeGiven(f.Given, cs.Given)
			cf.When = cs.When
			cf.Expect = cs.Expect
			diffs, note := runSingle(cf)
			if note != "" {
				notes = append(notes, cs.Name+": "+note)
			}
			for _, d := range diffs {
				failures = append(failures, cs.Name+": "+d)
			}
		}
		if len(failures) > 0 {
			res.Status = "fail"
			msg := strings.Join(failures, "; ")
			res.Message = &msg
			return res
		}
		res.Status = "pass"
		if len(notes) > 0 {
			joined := strings.Join(notes, "; ")
			res.Message = &joined
		}
		return res
	}

	diffs, note := runSingle(f)
	if len(diffs) > 0 {
		res.Status = "fail"
		msg := strings.Join(diffs, "; ")
		res.Message = &msg
		return res
	}
	res.Status = "pass"
	if note != "" {
		res.Message = &note
	}
	return res
}

// runSingle executes one single-case fixture and returns comparator diffs
// (empty means pass) plus the harness note.
func runSingle(f Fixture) ([]string, string) {
	actual, note, err := execute(f)
	if err != nil {
		return []string{"harness error: " + err.Error()}, note
	}
	assertionDiffs := assertMustNotContain(f, actual)
	diffs := append(Compare(actual, f.Expect), assertionDiffs...)
	return diffs, note
}

// mergeGiven shallow-merges a case-level given over the fixture-level one:
// keys present in the override replace the base value wholesale.
func mergeGiven(base Given, override *Given) Given {
	if override == nil {
		return base
	}
	out := base
	if override.ProviderState != "" {
		out.ProviderState = override.ProviderState
	}
	if override.Flags != nil {
		out.Flags = override.Flags
	}
	if override.GlobalContext != nil {
		out.GlobalContext = override.GlobalContext
	}
	if override.ClientContext != nil {
		out.ClientContext = override.ClientContext
	}
	if override.Config != nil {
		out.Config = override.Config
	}
	if override.Fault != nil {
		out.Fault = override.Fault
	}
	if override.Extensions != nil {
		out.Extensions = override.Extensions
	}
	if override.ExposureQueue != nil {
		out.ExposureQueue = override.ExposureQueue
	}
	if override.ReleaseContext != nil {
		out.ReleaseContext = override.ReleaseContext
	}
	if override.ReleaseStatus != "" {
		out.ReleaseStatus = override.ReleaseStatus
	}
	if override.Domains != nil {
		out.Domains = override.Domains
	}
	if override.Replacement != nil {
		out.Replacement = override.Replacement
	}
	return out
}

func assertMustNotContain(f Fixture, actual map[string]any) []string {
	var haystacks []string
	if s, ok := actual["errorMessage"].(string); ok {
		haystacks = append(haystacks, s)
	}
	diffs := checkMustNotContain(f.Expect, "errorMessageMustNotContain", haystacks)
	if recorded, ok := actual["__recordedMessage"].(string); ok {
		diffs = append(diffs, checkMustNotContain(f.Expect, "recordedMessageMustNotContain", []string{recorded})...)
		delete(actual, "__recordedMessage")
	}
	return diffs
}

// execute dispatches one fixture; it returns the normalized actual output.
func execute(f Fixture) (map[string]any, string, error) {
	if f.Suite == "faults" {
		return executeFault(f)
	}
	switch f.When.Operation {
	case "evaluate":
		return executeEvaluate(f)
	case "initialize":
		return executeInitialize(f)
	case "shutdown":
		return executeShutdown(f)
	case "replaceProvider":
		return executeReplaceProvider(f)
	case "invokeCapability":
		return executeInvokeCapability(f)
	default:
		return nil, "", fmt.Errorf("unsupported operation %q (should have been classified skipped-v1-out-of-scope)", f.When.Operation)
	}
}

// --- setup helpers ---

func runtimeConfigFrom(given Given) fireweave.Config {
	cfg := fireweave.Config{}
	if given.GlobalContext != nil {
		cfg.GlobalContext = contextFrom(given.GlobalContext)
	}
	if given.Config == nil {
		return cfg
	}
	if rt, ok := given.Config["requireTargetingKey"].(bool); ok {
		cfg.RequireTargetingKey = rt
	}
	if limits, ok := given.Config["limits"].(map[string]any); ok {
		asInt := func(key string) int {
			if n, ok := limits[key]; ok {
				return numberLikeToInt(n)
			}
			return 0
		}
		cfg.Limits = fireweave.Limits{
			MaxAttributes:      asInt("maxAttributeCount"),
			MaxKeyBytes:        asInt("maxKeyBytes"),
			MaxValueBytes:      asInt("maxValueBytes"),
			MaxNestingDepth:    asInt("maxNestingDepth"),
			MaxSerializedBytes: asInt("maxSerializedContextBytes"),
		}
	}
	return cfg
}

func contextFrom(spec *ContextSpec) domain.EvaluationContext {
	if spec == nil {
		return domain.EvaluationContext{}
	}
	return domain.NewEvaluationContext(spec.TargetingKey, spec.Attributes)
}

func inmemoryFrom(flags map[string]FixtureFlag) *inmemory.Adapter {
	out := map[string]inmemory.Flag{}
	for key, ff := range flags {
		out[key] = toInmemoryFlag(ff)
	}
	return inmemory.New(inmemory.WithFlags(out))
}

func toInmemoryFlag(ff FixtureFlag) inmemory.Flag {
	flag := inmemory.Flag{
		Type:              toFlagType(ff.Type),
		Enabled:           ff.Enabled,
		Variant:           ff.Variant,
		Value:             ff.Value,
		OverrideReason:    fireweave.Reason(ff.FireweaveReason),
		FromCache:         ff.FromCache,
		MatchTargetingKey: ff.MatchTargetingKey,
		MatchAttributes:   ff.MatchAttribute,
		MatchGroups:       ff.MatchGroups,
		MatchPerson:       ff.MatchPerson,
	}
	if ff.Reason != nil {
		flag.ReasonCode = ff.Reason.Code
		flag.ConditionIndex = ff.Reason.ConditionIndex
	}
	if ff.Metadata != nil {
		flag.Version = ff.Metadata.Version
		flag.VendorID = ff.Metadata.ID
	}
	return flag
}

// toFlagType maps a fixture's declared flag type onto v1's four-member
// FlagType (boolean/string/number/object) — v1 has no separate integer/float
// distinction (conformance/surface/control-points.surface.json: "number, NOT
// integer"). NOTE: eval-numeric-coercion-int-float specifically requests
// flagType "integer" against a stored "float" value expecting TYPE_MISMATCH;
// collapsing both to "number" here means the in-memory adapter's flag.Type
// == req.Type check can no longer see that distinction, so this fixture
// fails for go the same way it does for python — a v1-wide gap (every
// language's public surface only knows "number"), not a go-specific bug. See
// task-10-report.md "Concerns".
func toFlagType(raw string) fireweave.FlagType {
	if raw == "integer" || raw == "float" {
		return fireweave.FlagTypeNumber
	}
	return fireweave.FlagType(raw)
}

// session is one arranged client + runtime (+ the in-memory adapter, when
// used, for LastContext()/ResolveCount() observations).
type session struct {
	client  *fireweave.Client
	adapter *inmemory.Adapter
}

func (s *session) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.client.Runtime().Shutdown(ctx)
}

// setupSession arranges a client per the fixture given block. providerState
// drives lifecycle: READY/STALE initialize, NOT_READY leaves the runtime
// uninitialized (go's lifecycle-error mapping treats UNINITIALIZED and a
// hypothetical in-flight INITIALIZING identically — both -> NotReady — so
// there is no in-flight-init gate to model, unlike node's async runtime),
// CLOSED initializes then shuts down.
func setupSession(given Given, flags map[string]FixtureFlag, state string) (*session, error) {
	adapter := inmemoryFrom(flags)
	// Security-suite fixtures declare protocol faults but run on the
	// in-memory adapter (not the faults suite's real remote/HTTP path):
	// model them as a fixed error the adapter raises on every Resolve, the
	// same way node/python's runners wrap their in-memory adapter. Faults
	// scoped to other endpoints (e.g. fault-stale-cache's applyTo:
	// "definitions") do not affect evaluation reads.
	var runtimeAdapter domain.BackendAdapter = adapter
	if given.Fault != nil {
		applyTo, _ := given.Fault["applyTo"].(string)
		if applyTo == "" || applyTo == "flags" {
			runtimeAdapter = &faultyAdapter{inner: adapter, err: faultToError(given.Fault)}
		}
	}
	client := fireweave.NewClient(fireweave.NewRuntime(runtimeAdapter, runtimeConfigFrom(given)))
	s := &session{client: client, adapter: adapter}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	switch state {
	case "READY", "STALE", "":
		if err := client.Runtime().Initialize(ctx); err != nil {
			return s, fmt.Errorf("init: %w", err)
		}
		if state == "STALE" {
			client.Runtime().MarkStale()
		}
	case "NOT_READY":
		// leave uninitialized
	case "CLOSED":
		if err := client.Runtime().Initialize(ctx); err != nil {
			return s, fmt.Errorf("pre-close init: %w", err)
		}
		if err := client.Runtime().Shutdown(ctx); err != nil {
			return s, fmt.Errorf("pre-close shutdown: %w", err)
		}
	default:
		return s, fmt.Errorf("unsupported providerState %q", state)
	}
	return s, nil
}

// faultyAdapter wraps a BackendAdapter so every Resolve raises a fixed
// error — the in-memory-path fault model for security-suite fixtures that
// declare a protocol fault (contracts/security/sec-pii-redaction-in-messages,
// sec-secrets-not-in-errors).
type faultyAdapter struct {
	inner domain.BackendAdapter
	err   *domain.Error
}

func (a *faultyAdapter) Initialize(ctx context.Context) error { return a.inner.Initialize(ctx) }
func (a *faultyAdapter) Resolve(ctx context.Context, req domain.ResolveRequest) domain.Decision {
	return domain.ErrorDecision(req.FlagKey, req.DefaultValue, a.err, nil)
}
func (a *faultyAdapter) Close(ctx context.Context) error { return a.inner.Close(ctx) }

// faultToError maps a fixture fault declaration to the FireweaveError kind
// it must produce (mirrors node's faultToErrorKind / python's
// _fault_to_error).
func faultToError(fault map[string]any) *domain.Error {
	mode, _ := fault["mode"].(string)
	switch mode {
	case "httpStatus":
		status := 500
		if s, ok := fault["status"].(json.Number); ok {
			if v, err := s.Int64(); err == nil {
				status = int(v)
			}
		}
		switch status {
		case 401:
			return domain.NewError(domain.KindAuthentication, "", nil)
		case 403:
			return domain.NewError(domain.KindAuthorization, "", nil)
		case 429:
			return domain.NewError(domain.KindRateLimited, "", nil)
		default:
			return domain.NewError(domain.KindBackendUnavailable, "", nil)
		}
	case "networkError", "offline":
		return domain.NewError(domain.KindNetwork, "", nil)
	case "timeout":
		return domain.NewError(domain.KindTimeout, "", nil)
	case "invalidJson", "malformedJson", "truncated":
		return domain.NewError(domain.KindMalformedResponse, "", nil)
	default:
		return domain.NewError(domain.KindInternal, "", nil)
	}
}

// --- evaluate ---

func executeEvaluate(f Fixture) (map[string]any, string, error) {
	given := f.Given
	flags := given.Flags
	state := given.ProviderState
	when := f.When

	// Multi-domain lifecycle fixture support: independent session per
	// domain (no OpenFeature domain multiplexing to reach for post-ADR-0010).
	if len(given.Domains) > 0 {
		d, ok := given.Domains[when.Domain]
		if !ok {
			return nil, "", fmt.Errorf("unknown domain %q", when.Domain)
		}
		for name, other := range given.Domains {
			if name == when.Domain {
				continue
			}
			otherSess, err := setupSession(Given{ProviderState: other.ProviderState}, other.Flags, other.ProviderState)
			if err != nil {
				return nil, "", err
			}
			defer otherSess.close()
		}
		flags = d.Flags
		state = d.ProviderState
		given = Given{ProviderState: state, Flags: flags}
	}

	s, err := setupSession(given, flags, state)
	if err != nil {
		return nil, "", err
	}
	defer s.close()

	// Client-context layer folded into the per-call context before
	// evaluation (contracts/context/ctx-merge-global-client-invocation.json
	// "later layers win"): go's Client/Runtime has no separate durable
	// "client context" setter the way node/python do (a real surface gap,
	// documented in task-10-report.md), so this pre-merges clientContext
	// under invocationContext at the call site — client, then invocation
	// overriding it — which reproduces the fixture's merge-order assertion
	// exactly (global is still applied by Runtime itself, via
	// Config.GlobalContext, one layer beneath this).
	invocationCtx := contextFrom(when.InvocationContext)
	if f.Given.ClientContext != nil {
		invocationCtx = domain.MergeContexts(contextFrom(f.Given.ClientContext), invocationCtx)
	}

	actual := evaluateThrough(s, when, invocationCtx)

	if _, wantResolved := f.Expect["resolvedContext"]; wantResolved {
		if rc, ok := s.adapter.LastContext(); ok {
			actual["resolvedContext"] = contextToJSON(rc)
		}
	}
	if _, wantSnapshot := f.Expect["contextSnapshotAfter"]; wantSnapshot && when.InvocationContext != nil {
		snap := map[string]any{}
		if when.InvocationContext.TargetingKey != "" {
			snap["targetingKey"] = when.InvocationContext.TargetingKey
		}
		if when.InvocationContext.Attributes != nil {
			snap["attributes"] = when.InvocationContext.Attributes
		}
		actual["contextSnapshotAfter"] = snap
	}
	if _, wantNet := f.Expect["networkCalls"]; wantNet {
		actual["networkCalls"] = s.adapter.ResolveCount()
	}
	return actual, "", nil
}

// evaluateThrough performs the typed evaluation via the real v1
// ControlPoints surface and normalizes the Decision.
func evaluateThrough(s *session, when When, evalCtx domain.EvaluationContext) map[string]any {
	flagType := toFlagType(when.FlagType)
	defaultValue := defaultValueFor(when.FlagType, when.DefaultValue)

	d := s.client.ControlPoints().Evaluate(when.FlagKey, flagType, defaultValue, &evalCtx, &fireweave.EvaluateOptions{})

	actual := map[string]any{
		"value":        d.Value,
		"variant":      nilIfEmpty(d.Variant),
		"reason":       string(d.Reason),
		"errorCode":    decisionErrorCode(d),
		"errorMessage": decisionErrorMessage(d),
	}
	if len(d.Metadata) > 0 {
		actual["flagMetadata"] = d.Metadata
	}
	return actual
}

// defaultValueFor converts a fixture-declared default value (json.Number for
// numerics, since fixture.go decodes with UseNumber) into the concrete Go
// type domain.MatchesExpectedType recognizes for the requested flag type.
func defaultValueFor(flagType string, raw any) any {
	if flagType == "integer" || flagType == "float" {
		return numberToFloat(raw)
	}
	return raw
}

// --- faults ---

// executeFault exercises the remote adapter's real HTTP path
// (POST /v1/flags/evaluate). Baseline: an injected fake http.RoundTripper
// (faults.go) reproducing the Fireweave-native response shape — the
// canonical dockerized `golang:1.25-alpine` run has no `node` binary to
// spawn test-server/implementation/server.mjs with, unlike node/python's
// runners, so this package cannot depend on a live stub being available.
// FIREWEAVE_TEST_SERVER_URL / FW_TEST_SERVER_URL opt into a real spawned
// stub for local iteration when node happens to be on PATH.
func executeFault(f Fixture) (map[string]any, string, error) {
	given := f.Given
	when := f.When
	fault := given.Fault
	if fault == nil {
		fault = map[string]any{"mode": "none"}
	}

	// Stale-cache runs on the in-memory adapter (cache state provisioned directly).
	if f.ID == "fault-stale-cache" {
		return executeEvaluate(f)
	}

	apiKey := "phc_TESTKEY0000000000000000000001"
	if k, ok := given.Config["projectApiKey"].(string); ok && k != "" {
		apiKey = k
	}
	timeout := 3 * time.Second
	if t, ok := given.Config["featureFlagsRequestTimeoutMs"].(json.Number); ok {
		if ms, err := t.Int64(); err == nil {
			timeout = time.Duration(ms) * time.Millisecond
		}
	}

	mode, _ := fault["mode"].(string)
	stubURL := stubBaseURL()
	stubBody := stubFaultBody(fault)

	var apiURL string
	var transport http.RoundTripper
	note := ""
	switch {
	case stubURL != "" && stubBody != nil:
		if err := stubResetState(stubURL); err != nil {
			return nil, "", fmt.Errorf("stub reset: %w", err)
		}
		if err := stubSetFault(stubURL, stubBody); err != nil {
			return nil, "", fmt.Errorf("stub fault: %w", err)
		}
		apiURL = stubURL
		note = "fault exercised via live test-server HTTP stub"
	case mode == "networkError" || mode == "offline":
		apiURL = deadLoopbackURL()
		note = "network/offline fault exercised via a real refused loopback connection"
	default:
		apiURL = "http://127.0.0.1:1" // never dialed; the fake Transport intercepts every request
		transport = newFaultTransport(fault)
		note = "fault simulated via injected fake Transport (hermetic; no test-server stub)"
	}

	// http.Client.Timeout (not remote.Config.RequestTimeout, which only
	// takes effect when THIS package leaves HTTPClient nil) bounds the
	// request: ControlPoints.Evaluate hardcodes context.Background()
	// (application/client.go), so there is no caller-supplied deadline for
	// the adapter's own ctx.Err() check to observe — see the fault-timeout
	// concern in task-10-report.md. Setting Timeout here at least keeps this
	// fixture fast; it does not fix the misclassification.
	httpClient := &http.Client{Timeout: timeout}
	if transport != nil {
		httpClient.Transport = transport
	}

	adapter := remote.New(remote.Config{APIURL: apiURL, APIKey: apiKey, HTTPClient: httpClient})
	runtime := fireweave.NewRuntime(adapter, fireweave.Config{})
	ctx := context.Background()
	if err := runtime.Initialize(ctx); err != nil {
		return nil, note, fmt.Errorf("remote adapter init: %w", err)
	}
	defer func() {
		if stubURL != "" {
			_ = stubResetState(stubURL)
		}
		_ = runtime.Shutdown(ctx)
	}()
	client := fireweave.NewClient(runtime)

	evalCtx := contextFrom(when.InvocationContext)
	actual := evaluateThrough(&session{client: client}, when, evalCtx)
	return actual, note, nil
}

// deadLoopbackURL binds an ephemeral loopback port and immediately releases
// it, producing a real ECONNREFUSED on connect — no fake transport involved
// for the networkError/offline fault modes.
func deadLoopbackURL() string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "http://127.0.0.1:1"
	}
	addr := l.Addr().String()
	_ = l.Close()
	return "http://" + addr
}

// --- initialize / shutdown / replaceProvider ---

func executeInitialize(f Fixture) (map[string]any, string, error) {
	config := f.Given.Config
	host, hasHost := config["host"].(string)

	var adapter domain.BackendAdapter
	if hasHost {
		// Host-allowlist-testing fixtures (life-init-fail-configuration,
		// life-init-success, sec-endpoint-ssrf-allowlist) route through the
		// remote adapter: go's Runtime.Config carries no host/allowed-hosts
		// concept of its own (unlike node's FireweaveRuntimeConfig) — only
		// infrastructure/adapters/remote's own Initialize validates a host.
		apiKey, _ := config["projectApiKey"].(string)
		cfg := remote.Config{APIURL: host, APIKey: apiKey}
		if hosts, ok := config["allowedHosts"].([]any); ok {
			for _, h := range hosts {
				if s, ok := h.(string); ok {
					cfg.AllowedHosts = append(cfg.AllowedHosts, s)
				}
			}
		}
		adapter = remote.New(cfg)
	} else {
		adapter = inmemoryFrom(f.Given.Flags)
	}

	runtime := fireweave.NewRuntime(adapter, fireweave.Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	initErr := runtime.Initialize(ctx)
	defer func() {
		ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel2()
		_ = runtime.Shutdown(ctx2)
	}()

	actual := map[string]any{
		"providerState": stateName(runtime.State()),
		"errorCode":     nil,
		"errorMessage":  nil,
	}
	if initErr != nil {
		var fwErr *fireweave.Error
		if errors.As(initErr, &fwErr) {
			actual["errorCode"] = codeForKind(fwErr.Kind, fwErr.TargetingKeyMissing)
			actual["errorMessage"] = fwErr.Message
			if _, wantKind := f.Expect["errorKind"]; wantKind {
				actual["errorKind"] = string(fwErr.Kind)
			}
		} else {
			actual["errorCode"] = "GENERAL"
			actual["errorMessage"] = initErr.Error()
		}
	}
	return actual, "", nil
}

func executeShutdown(f Fixture) (map[string]any, string, error) {
	s, err := setupSession(f.Given, f.Given.Flags, f.Given.ProviderState)
	if err != nil {
		return nil, "", err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownErr := s.client.Runtime().Shutdown(ctx)

	actual := map[string]any{
		"providerState": stateName(s.client.Runtime().State()),
		"errorCode":     nil,
		"errorMessage":  nil,
	}
	if shutdownErr != nil {
		actual["errorCode"] = errCodeOrNil(shutdownErr)
		actual["errorMessage"] = shutdownErr.Error()
	}
	return actual, "", nil
}

func executeReplaceProvider(f Fixture) (map[string]any, string, error) {
	if f.Given.Replacement == nil || f.When.ThenEvaluate == nil {
		return nil, "", fmt.Errorf("replaceProvider fixture missing replacement/thenEvaluate")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	runtimeA := fireweave.NewRuntime(inmemoryFrom(f.Given.Flags), fireweave.Config{})
	if err := runtimeA.Initialize(ctx); err != nil {
		return nil, "", fmt.Errorf("old provider init: %w", err)
	}
	if err := runtimeA.Shutdown(ctx); err != nil {
		return nil, "", fmt.Errorf("old provider shutdown: %w", err)
	}

	adapterB := inmemoryFrom(f.Given.Replacement.Flags)
	runtimeB := fireweave.NewRuntime(adapterB, fireweave.Config{})
	if err := runtimeB.Initialize(ctx); err != nil {
		return nil, "", fmt.Errorf("replacement init: %w", err)
	}
	defer func() { _ = runtimeB.Shutdown(ctx) }()
	clientB := fireweave.NewClient(runtimeB)

	then := *f.When.ThenEvaluate
	evalCtx := contextFrom(then.InvocationContext)
	actual := evaluateThrough(&session{client: clientB, adapter: adapterB}, then, evalCtx)
	actual["providerState"] = stateName(runtimeB.State())
	return actual, "", nil
}

// --- extensions (only invokeCapability reaches here; see
// v1OutOfScopeExtensionFixtures) ---

func executeInvokeCapability(f Fixture) (map[string]any, string, error) {
	adapter := inmemoryFrom(f.Given.Flags)
	client := fireweave.NewClient(fireweave.NewRuntime(adapter, runtimeConfigFrom(f.Given)))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	state := f.Given.ProviderState
	if state == "" {
		state = "READY"
	}
	switch state {
	case "NOT_READY":
		// leave uninitialized
	case "CLOSED":
		if err := client.Runtime().Initialize(ctx); err != nil {
			return nil, "", fmt.Errorf("extension pre-close init: %w", err)
		}
		if err := client.Runtime().Shutdown(ctx); err != nil {
			return nil, "", fmt.Errorf("extension pre-close shutdown: %w", err)
		}
	default: // READY, STALE
		if err := client.Runtime().Initialize(ctx); err != nil {
			return nil, "", fmt.Errorf("extension init: %w", err)
		}
		defer func() { _ = client.Runtime().Shutdown(ctx) }()
	}

	fwErr := client.InvokeCapability(f.When.Capability, f.When.Args)
	actual := map[string]any{"ok": fwErr == nil}
	if fwErr == nil {
		actual["errorCode"] = nil
	} else {
		actual["errorCode"] = codeForKind(fwErr.Kind, fwErr.TargetingKeyMissing)
		actual["errorMessage"] = fwErr.Message
		actual["errorKind"] = string(fwErr.Kind)
		actual["degraded"] = isDegradedKind(fwErr.Kind)
	}
	return actual, "", nil
}

// isDegradedKind reports whether an extension error kind is a ruling-17
// graceful degradation (structured result instead of a throw/panic).
func isDegradedKind(kind fireweave.ErrorKind) bool {
	return kind == fireweave.KindUnsupportedCapability || kind == fireweave.KindAlreadyClosed
}

// --- small conversions ---

func contextToJSON(c domain.EvaluationContext) map[string]any {
	out := map[string]any{"targetingKey": c.TargetingKey}
	attrs := map[string]any{}
	for k, v := range c.Attributes {
		if strings.HasPrefix(k, "$") {
			continue // vendor directives are not context attributes
		}
		attrs[k] = v
	}
	if len(attrs) > 0 {
		out["attributes"] = attrs
	}
	return out
}

func stateName(s fireweave.State) string {
	switch s {
	case fireweave.StateUninitialized, fireweave.StateInitializing:
		return "NOT_READY"
	case fireweave.StateReady:
		return "READY"
	case fireweave.StateStale:
		return "STALE"
	case fireweave.StateError:
		return "ERROR"
	case fireweave.StateFatal:
		return "FATAL"
	case fireweave.StateShutdown:
		return "CLOSED"
	}
	return string(s)
}

// codeForKind maps a Fireweave error kind to its OpenFeature-vocabulary wire
// code (spec/errors.schema.json). go's public SDK carries no OpenFeature
// bridge in v1 (ADR-0010) — these strings exist only for the conformance
// report / contracts/errors.json parity, not as an SDK export.
func codeForKind(kind fireweave.ErrorKind, targetingKeyMissing bool) string {
	switch kind {
	case fireweave.KindNotReady, fireweave.KindAlreadyClosed:
		return "PROVIDER_NOT_READY"
	case fireweave.KindFlagNotFound:
		return "FLAG_NOT_FOUND"
	case fireweave.KindTypeMismatch:
		return "TYPE_MISMATCH"
	case fireweave.KindInvalidContext:
		if targetingKeyMissing {
			return "TARGETING_KEY_MISSING"
		}
		return "INVALID_CONTEXT"
	case fireweave.KindMalformedResponse:
		return "PARSE_ERROR"
	case fireweave.KindConfiguration:
		return "PROVIDER_FATAL"
	default:
		return "GENERAL"
	}
}

func decisionErrorCode(d domain.Decision) any {
	if d.Error == nil {
		return nil
	}
	return codeForKind(d.Error.Kind, d.Error.TargetingKeyMissing)
}

func decisionErrorMessage(d domain.Decision) any {
	if d.Error == nil {
		return nil
	}
	return d.Error.Message
}

func errCodeOrNil(err error) any {
	if err == nil {
		return nil
	}
	var fwErr *fireweave.Error
	if errors.As(err, &fwErr) {
		return codeForKind(fwErr.Kind, fwErr.TargetingKeyMissing)
	}
	return "GENERAL"
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// numberLikeToInt reads an integer out of the subset of encoding/json's
// decoded numeric shapes this package needs (fixture.go decodes with
// UseNumber, so these are always json.Number in practice; the other cases
// guard against a future decoder change).
func numberLikeToInt(v any) int {
	switch t := v.(type) {
	case interface{ Int64() (int64, error) }: // json.Number
		i, _ := t.Int64()
		return int(i)
	case int64:
		return int(t)
	case float64:
		return int(t)
	}
	return 0
}

func numberToFloat(v any) any {
	switch t := v.(type) {
	case interface{ Float64() (float64, error) }: // json.Number
		f, _ := t.Float64()
		return f
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return v
}
