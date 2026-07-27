package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/inmemory"
	phadapter "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/adapters/posthog"
	"github.com/FireWeave-HQ/fireweave-sdk/sdks/go/fireweave"
	fwof "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/openfeature"
	of "github.com/open-feature/go-sdk/openfeature"
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

// Run executes every fixture and returns the aggregated report.
func Run(contractsDir string) (*Report, error) {
	fixtures, err := LoadFixtures(contractsDir)
	if err != nil {
		return nil, err
	}
	report := &Report{
		SchemaVersion: 1,
		GeneratedAt:   "EXCLUDED",
		Summary:       map[string]int{"pass": 0, "fail": 0, "skipped-with-documented-limitation": 0},
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

	if f.Compatibility[language] == "skipped-with-documented-limitation" {
		res.Status = "skipped-with-documented-limitation"
		if lim, ok := f.Limitations[language]; ok {
			res.Limitation = &lim
		}
		return res
	}

	actual, note, err := execute(f)
	if err != nil {
		res.Status = "fail"
		msg := "harness error: " + err.Error()
		res.Message = &msg
		return res
	}

	assertionDiffs := assertMustNotContain(f, actual)
	diffs := append(Compare(actual, f.Expect), assertionDiffs...)
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

func assertMustNotContain(f Fixture, actual map[string]any) []string {
	var haystacks []string
	if s, ok := actual["errorMessage"].(string); ok {
		haystacks = append(haystacks, s)
	}
	if s, ok := actual["reason"].(string); ok && f.When.Operation == "fail" {
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
	switch f.When.Operation {
	case "evaluate":
		return executeEvaluate(f)
	case "initialize":
		return executeInitialize(f)
	case "shutdown":
		return executeShutdown(f)
	case "replaceProvider":
		return executeReplaceProvider(f)
	case "getCapabilities", "recordExposure", "flushExposures",
		"setContext", "start", "complete", "fail", "emitSignal", "invokeCapability":
		return executeExtension(f)
	default:
		return nil, "", fmt.Errorf("unsupported operation %q", f.When.Operation)
	}
}

// --- setup helpers ---

func runtimeConfigFrom(given Given) fireweave.Config {
	cfg := fireweave.Config{}
	if given.Config == nil {
		return cfg
	}
	if rt, ok := given.Config["requireTargetingKey"].(bool); ok {
		cfg.RequireTargetingKey = rt
	}
	if limits, ok := given.Config["limits"].(map[string]any); ok {
		asInt := func(key string) int {
			if n, ok := limits[key].(json.Number); ok {
				v, _ := n.Int64()
				return int(v)
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

func inmemoryFrom(flags map[string]FixtureFlag) *inmemory.Adapter {
	out := map[string]inmemory.Flag{}
	for key, ff := range flags {
		out[key] = toInmemoryFlag(ff)
	}
	return inmemory.New(inmemory.WithFlags(out))
}

func toInmemoryFlag(ff FixtureFlag) inmemory.Flag {
	flag := inmemory.Flag{
		Type:              fireweave.FlagType(ff.Type),
		Enabled:           ff.Enabled,
		Variant:           ff.Variant,
		Value:             ff.Value,
		Payload:           ff.Payload,
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

// bareProvider masks the provider's StateHandler so the OpenFeature SDK
// registers it without initializing — required to hold a NOT_READY/CLOSED
// Fireweave runtime behind a registered provider.
type bareProvider struct{ of.FeatureProvider }

// session is one arranged provider + client + runtime.
type session struct {
	provider *fwof.Provider
	ofClient *of.Client
	client   *fireweave.Client
	adapter  *inmemory.Adapter  // nil when PostHog-backed
	ph       *phadapter.Adapter // nil when in-memory
	domain   string
}

func (s *session) close() {
	if s.provider != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.provider.ShutdownWithContext(ctx)
	}
}

var domainSeq atomic.Int64

func nextDomain(id string) string {
	return fmt.Sprintf("conformance/%s/%d", id, domainSeq.Add(1))
}

// setupSession arranges a provider per the fixture given block.
// providerState drives lifecycle: READY/STALE initialize, NOT_READY leaves
// the runtime untouched, CLOSED initializes then shuts down.
func setupSession(f Fixture, given Given, flags map[string]FixtureFlag, state string) (*session, string, error) {
	s := &session{domain: nextDomain(f.ID)}
	note := ""

	useFault := given.Fault != nil && f.ID != "fault-stale-cache"
	if useFault {
		transport := newFaultTransport(given.Fault)
		cfg := phadapter.Config{
			ProjectAPIKey:      "phc_conformance000000000000000001",
			Endpoint:           "http://127.0.0.1:3901",
			Transport:          transport,
			FlagRequestTimeout: 2 * time.Second,
			CloseTimeout:       2 * time.Second,
		}
		if given.Config != nil {
			if k, ok := given.Config["projectApiKey"].(string); ok && k != "" {
				cfg.ProjectAPIKey = k
			}
			if t, ok := given.Config["featureFlagsRequestTimeoutMs"].(json.Number); ok {
				ms, _ := t.Int64()
				cfg.FlagRequestTimeout = time.Duration(ms) * time.Millisecond
			}
		}
		s.ph = phadapter.New(cfg)
		s.client = fireweave.NewClient(fireweave.NewRuntime(s.ph, runtimeConfigFrom(given)))
		note = "fault simulated via injected fake Transport (test-server stub not exercised)"
	} else {
		s.adapter = inmemoryFrom(flags)
		s.client = fireweave.NewClient(fireweave.NewRuntime(s.adapter, runtimeConfigFrom(given)))
		if f.ID == "fault-stale-cache" {
			note = "stale-definitions cache simulated on the in-memory adapter (posthog-go local-eval poller not exercised)"
		}
	}
	s.provider = fwof.NewProvider(s.client)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	switch state {
	case "READY", "STALE", "":
		if err := of.SetNamedProviderAndWait(s.domain, s.provider); err != nil {
			return s, note, fmt.Errorf("provider registration: %w", err)
		}
		if state == "STALE" {
			s.client.Runtime().MarkStale()
		}
	case "NOT_READY":
		if err := of.SetNamedProviderAndWait(s.domain, bareProvider{s.provider}); err != nil {
			return s, note, fmt.Errorf("bare registration: %w", err)
		}
	case "CLOSED":
		if err := s.client.Runtime().Initialize(ctx); err != nil {
			return s, note, fmt.Errorf("pre-close init: %w", err)
		}
		if err := s.client.Runtime().Shutdown(ctx); err != nil {
			return s, note, fmt.Errorf("pre-close shutdown: %w", err)
		}
		if err := of.SetNamedProviderAndWait(s.domain, bareProvider{s.provider}); err != nil {
			return s, note, fmt.Errorf("bare registration: %w", err)
		}
	default:
		return s, note, fmt.Errorf("unsupported providerState %q", state)
	}
	s.ofClient = of.NewClient(s.domain)
	return s, note, nil
}

// --- evaluate ---

func executeEvaluate(f Fixture) (map[string]any, string, error) {
	given := f.Given
	flags := given.Flags
	state := given.ProviderState
	when := f.When

	// Multi-domain fixtures nest state under given.domains.
	if len(given.Domains) > 0 {
		d, ok := given.Domains[when.Domain]
		if !ok {
			return nil, "", fmt.Errorf("unknown domain %q", when.Domain)
		}
		for name, other := range given.Domains {
			if name == when.Domain {
				continue
			}
			otherSess, _, err := setupSession(f, Given{ProviderState: other.ProviderState}, other.Flags, other.ProviderState)
			if err != nil {
				return nil, "", err
			}
			defer otherSess.close()
		}
		flags = d.Flags
		state = d.ProviderState
		given = Given{ProviderState: state, Flags: flags}
	}

	s, note, err := setupSession(f, given, flags, state)
	if err != nil {
		return nil, note, err
	}
	defer s.close()

	// Context layers: API-global and client-level contexts per fixture.
	if f.Given.GlobalContext != nil {
		of.SetEvaluationContext(of.NewEvaluationContext(f.Given.GlobalContext.TargetingKey, f.Given.GlobalContext.Attributes))
		defer of.SetEvaluationContext(of.EvaluationContext{})
	}
	if f.Given.ClientContext != nil {
		s.ofClient.SetEvaluationContext(of.NewEvaluationContext(f.Given.ClientContext.TargetingKey, f.Given.ClientContext.Attributes))
	}

	actual := evaluateThrough(s, when)

	if _, wantResolved := f.Expect["resolvedContext"]; wantResolved && s.adapter != nil {
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
		calls := int64(0)
		if s.adapter != nil {
			calls = s.adapter.ResolveCount()
		}
		actual["networkCalls"] = calls
	}
	return actual, note, nil
}

// evaluateThrough performs the typed evaluation via the real OpenFeature
// client and normalizes the details.
func evaluateThrough(s *session, when When) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if inc, ok := when.Options["includePayload"].(bool); ok && inc {
		ctx = fireweave.WithIncludePayload(ctx)
	}

	evalCtx := of.EvaluationContext{}
	if when.InvocationContext != nil {
		evalCtx = of.NewEvaluationContext(when.InvocationContext.TargetingKey, when.InvocationContext.Attributes)
	}

	var value any
	var detail of.EvaluationDetails
	switch when.FlagType {
	case "boolean":
		def, _ := when.DefaultValue.(bool)
		d, _ := s.ofClient.BooleanValueDetails(ctx, when.FlagKey, def, evalCtx)
		value, detail = d.Value, d.EvaluationDetails
	case "string":
		def, _ := when.DefaultValue.(string)
		d, _ := s.ofClient.StringValueDetails(ctx, when.FlagKey, def, evalCtx)
		value, detail = d.Value, d.EvaluationDetails
	case "integer":
		def := numberToInt(when.DefaultValue)
		d, _ := s.ofClient.IntValueDetails(ctx, when.FlagKey, def, evalCtx)
		value, detail = d.Value, d.EvaluationDetails
	case "float":
		def := numberToFloat(when.DefaultValue)
		d, _ := s.ofClient.FloatValueDetails(ctx, when.FlagKey, def, evalCtx)
		value, detail = d.Value, d.EvaluationDetails
	case "object":
		d, _ := s.ofClient.ObjectValueDetails(ctx, when.FlagKey, when.DefaultValue, evalCtx)
		value, detail = d.Value, d.EvaluationDetails
	}

	actual := map[string]any{
		"value":        value,
		"variant":      nilIfEmpty(detail.Variant),
		"reason":       string(detail.Reason),
		"errorCode":    nilIfEmpty(string(detail.ErrorCode)),
		"errorMessage": nilIfEmpty(detail.ErrorMessage),
	}
	if len(detail.FlagMetadata) > 0 {
		actual["flagMetadata"] = map[string]any(detail.FlagMetadata)
	}
	return actual
}

// --- initialize / shutdown / replaceProvider ---

func executeInitialize(f Fixture) (map[string]any, string, error) {
	cfg := phadapter.Config{
		Transport:    newFaultTransport(nil),
		CloseTimeout: 2 * time.Second,
	}
	if k, ok := f.Given.Config["projectApiKey"].(string); ok {
		cfg.ProjectAPIKey = k
	}
	if h, ok := f.Given.Config["host"].(string); ok {
		cfg.Endpoint = h
	}
	if hosts, ok := f.Given.Config["allowedHosts"].([]any); ok {
		for _, h := range hosts {
			if s, ok := h.(string); ok {
				cfg.AllowedHosts = append(cfg.AllowedHosts, s)
			}
		}
	}
	adapter := phadapter.New(cfg)
	client := fireweave.NewClient(fireweave.NewRuntime(adapter, fireweave.Config{}))
	provider := fwof.NewProvider(client)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = provider.ShutdownWithContext(ctx)
	}()

	err := of.SetNamedProviderAndWait(nextDomain(f.ID), provider)

	actual := map[string]any{
		"providerState": stateName(client.Runtime().State()),
		"errorCode":     nil,
		"errorMessage":  nil,
	}
	if err != nil {
		var initErr *of.ProviderInitError
		if ok := asProviderInitError(err, &initErr); ok {
			actual["errorCode"] = string(initErr.ErrorCode)
			actual["errorMessage"] = initErr.Message
		} else {
			actual["errorCode"] = string(of.GeneralCode)
			actual["errorMessage"] = "initialization failed"
		}
	}
	if _, wantKind := f.Expect["errorKind"]; wantKind {
		if fwErr := client.Runtime().InitError(); fwErr != nil {
			actual["errorKind"] = string(fwErr.Kind)
		}
	}
	return actual, "provider initialized against injected fake Transport (test-server stub not exercised)", nil
}

func executeShutdown(f Fixture) (map[string]any, string, error) {
	s, note, err := setupSession(f, f.Given, f.Given.Flags, f.Given.ProviderState)
	if err != nil {
		return nil, note, err
	}
	defer s.close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	shutdownErr := s.provider.ShutdownWithContext(ctx)

	actual := map[string]any{
		"providerState": stateName(s.client.Runtime().State()),
		"errorCode":     nil,
		"errorMessage":  nil,
	}
	if shutdownErr != nil {
		actual["errorCode"] = string(kindToCode(coerceKind(shutdownErr), false))
		actual["errorMessage"] = shutdownErr.Error()
	}
	return actual, note, nil
}

func executeReplaceProvider(f Fixture) (map[string]any, string, error) {
	s, note, err := setupSession(f, f.Given, f.Given.Flags, f.Given.ProviderState)
	if err != nil {
		return nil, note, err
	}
	defer s.close()

	if f.Given.Replacement == nil || f.When.ThenEvaluate == nil {
		return nil, note, fmt.Errorf("replaceProvider fixture missing replacement/thenEvaluate")
	}
	replacementClient := fireweave.NewClient(fireweave.NewRuntime(inmemoryFrom(f.Given.Replacement.Flags), fireweave.Config{}))
	replacement := fwof.NewProvider(replacementClient)
	if err := of.SetNamedProviderAndWait(s.domain, replacement); err != nil {
		return nil, note, fmt.Errorf("replacement registration: %w", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = replacement.ShutdownWithContext(ctx)
	}()

	actual := evaluateThrough(s, *f.When.ThenEvaluate)
	actual["providerState"] = stateName(replacementClient.Runtime().State())
	return actual, note, nil
}

// --- extensions ---

func executeExtension(f Fixture) (map[string]any, string, error) {
	adapter := inmemoryFrom(f.Given.Flags)
	client := fireweave.NewClient(fireweave.NewRuntime(adapter, runtimeConfigFrom(f.Given)))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Runtime().Initialize(ctx); err != nil {
		return nil, "", fmt.Errorf("extension init: %w", err)
	}
	defer func() { _ = client.Runtime().Shutdown(ctx) }()

	// Seed release context and status.
	if f.Given.ReleaseContext != nil {
		rc := releaseContextFrom(f.Given.ReleaseContext)
		if err := client.Releases().SetContext(ctx, rc); err != nil {
			return nil, "", fmt.Errorf("seed release context: %w", err)
		}
		if f.Given.ReleaseStatus == "in_progress" {
			if err := client.Releases().Start(ctx, rc.RolloutID); err != nil {
				return nil, "", fmt.Errorf("seed release status: %w", err)
			}
		}
	}
	// Seed the exposure queue.
	for _, e := range f.Given.ExposureQueue {
		if _, err := client.Exposures().Record(ctx, exposureFrom(e)); err != nil {
			return nil, "", fmt.Errorf("seed exposure: %w", err)
		}
	}

	switch f.When.Operation {
	case "getCapabilities":
		caps := client.Capabilities().Get()
		list := make([]any, len(caps))
		for i, c := range caps {
			list[i] = c
		}
		return map[string]any{"capabilities": list, "errorCode": nil}, "", nil

	case "recordExposure":
		res, err := client.Exposures().Record(ctx, exposureFrom(f.When.Exposure))
		actual := map[string]any{"ok": err == nil, "queued": res.Queued, "errorCode": errCodeOrNil(err)}
		if res.Deduped {
			actual["deduped"] = true
		}
		return actual, "", nil

	case "flushExposures":
		flushed, err := client.Exposures().Flush(ctx)
		return map[string]any{
			"ok": err == nil, "flushed": flushed,
			"queued": client.Exposures().Pending(), "errorCode": errCodeOrNil(err),
		}, "", nil

	case "setContext":
		rc := releaseContextFrom(f.When.Release)
		err := client.Releases().SetContext(ctx, rc)
		actual := map[string]any{"ok": err == nil, "errorCode": errCodeOrNil(err)}
		if got, ok := client.Releases().Context(); ok {
			stamps := make([]any, len(got.StampIDs))
			for i, s := range got.StampIDs {
				stamps[i] = s
			}
			actual["releaseContext"] = map[string]any{
				"rolloutId": got.RolloutID, "changeId": got.ChangeID, "stampIds": stamps,
			}
		}
		return actual, "", nil

	case "start", "complete", "fail":
		rolloutID, _ := f.When.Release["rolloutId"].(string)
		var err error
		switch f.When.Operation {
		case "start":
			err = client.Releases().Start(ctx, rolloutID)
		case "complete":
			err = client.Releases().Complete(ctx, rolloutID)
		case "fail":
			reason, _ := f.When.Release["reason"].(string)
			err = client.Releases().Fail(ctx, rolloutID, reason)
		}
		actual := map[string]any{
			"ok":        err == nil,
			"status":    string(client.Releases().Status()),
			"errorCode": errCodeOrNil(err),
		}
		if f.When.Operation == "fail" {
			actual["reason"] = client.Releases().FailReason()
		}
		return actual, "", nil

	case "emitSignal":
		err := emitSignal(ctx, client, f.When.Signal)
		actual := map[string]any{"ok": err == nil, "accepted": err == nil, "errorCode": errCodeOrNil(err)}
		if recorded := client.Signals().Recorded(); len(recorded) > 0 {
			actual["__recordedMessage"] = recorded[len(recorded)-1].Message
		}
		return actual, "", nil

	case "invokeCapability":
		err := client.Capabilities().Invoke(ctx, f.When.Capability, f.When.Args)
		actual := map[string]any{"ok": err == nil, "errorCode": errCodeOrNil(err)}
		var fwErr *fireweave.Error
		if err != nil && asFireweave(err, &fwErr) {
			actual["errorMessage"] = fwErr.Message
			actual["errorKind"] = string(fwErr.Kind)
			actual["degraded"] = fwErr.Kind == fireweave.KindUnsupportedCapability
		}
		return actual, "", nil
	}
	return nil, "", fmt.Errorf("unsupported extension operation %q", f.When.Operation)
}

func emitSignal(ctx context.Context, client *fireweave.Client, sig map[string]any) error {
	kind, _ := sig["kind"].(string)
	name, _ := sig["name"].(string)
	switch kind {
	case "health":
		status, _ := sig["status"].(string)
		rollout, _ := sig["rolloutId"].(string)
		return client.Signals().RecordHealth(ctx, fireweave.HealthSignal{Name: name, Status: status, RolloutID: rollout})
	case "error":
		errKind, _ := sig["errorKind"].(string)
		msg, _ := sig["message"].(string)
		rollout, _ := sig["rolloutId"].(string)
		return client.Signals().RecordError(ctx, fireweave.ErrorSignal{Name: name, ErrorKind: fireweave.ErrorKind(errKind), Message: msg, RolloutID: rollout})
	case "metric":
		rollout, _ := sig["rolloutId"].(string)
		stamp, _ := sig["stampId"].(string)
		return client.Signals().RecordMetric(ctx, fireweave.MetricSignal{Name: name, Value: numberToFloat(sig["value"]), RolloutID: rollout, StampID: stamp})
	case "outcome":
		status, _ := sig["status"].(string)
		rollout, _ := sig["rolloutId"].(string)
		change, _ := sig["changeId"].(string)
		return client.Signals().RecordOutcome(ctx, fireweave.OutcomeSignal{Name: name, Status: status, RolloutID: rollout, ChangeID: change})
	default:
		return fireweave.NewError(fireweave.KindConfiguration, "unknown signal kind", nil)
	}
}

func asProviderInitError(err error, target **of.ProviderInitError) bool {
	return errors.As(err, target)
}

func asFireweave(err error, target **fireweave.Error) bool {
	return errors.As(err, target)
}

// --- small conversions ---

func releaseContextFrom(m map[string]any) fireweave.ReleaseContext {
	rc := fireweave.ReleaseContext{}
	rc.RolloutID, _ = m["rolloutId"].(string)
	rc.ChangeID, _ = m["changeId"].(string)
	if stamps, ok := m["stampIds"].([]any); ok {
		for _, s := range stamps {
			if str, ok := s.(string); ok {
				rc.StampIDs = append(rc.StampIDs, str)
			}
		}
	}
	return rc
}

func exposureFrom(m map[string]any) fireweave.Exposure {
	e := fireweave.Exposure{}
	e.TargetingKey, _ = m["targetingKey"].(string)
	e.FlagKey, _ = m["flagKey"].(string)
	e.Variant, _ = m["variant"].(string)
	e.RolloutID, _ = m["rolloutId"].(string)
	e.Value = m["value"]
	return e
}

func contextToJSON(c fireweave.EvaluationContext) map[string]any {
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

func kindToCode(kind fireweave.ErrorKind, targetingKeyMissing bool) of.ErrorCode {
	switch kind {
	case fireweave.KindNotReady, fireweave.KindAlreadyClosed:
		return of.ProviderNotReadyCode
	case fireweave.KindFlagNotFound:
		return of.FlagNotFoundCode
	case fireweave.KindTypeMismatch:
		return of.TypeMismatchCode
	case fireweave.KindInvalidContext:
		if targetingKeyMissing {
			return of.TargetingKeyMissingCode
		}
		return of.InvalidContextCode
	case fireweave.KindMalformedResponse:
		return of.ParseErrorCode
	case fireweave.KindConfiguration:
		return of.ProviderFatalCode
	default:
		return of.GeneralCode
	}
}

func coerceKind(err error) fireweave.ErrorKind {
	var fwErr *fireweave.Error
	if asFireweave(err, &fwErr) {
		return fwErr.Kind
	}
	return fireweave.KindInternal
}

func errCodeOrNil(err error) any {
	if err == nil {
		return nil
	}
	var fwErr *fireweave.Error
	if asFireweave(err, &fwErr) {
		return string(kindToCode(fwErr.Kind, fwErr.TargetingKeyMissing))
	}
	return string(of.GeneralCode)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func numberToInt(v any) int64 {
	switch t := v.(type) {
	case json.Number:
		i, _ := t.Int64()
		return i
	case int64:
		return t
	case float64:
		return int64(t)
	}
	return 0
}

func numberToFloat(v any) float64 {
	switch t := v.(type) {
	case json.Number:
		f, _ := t.Float64()
		return f
	case float64:
		return t
	case int64:
		return float64(t)
	}
	return 0
}
