package fireweave

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
)

func readyClient(t *testing.T) *Client {
	t.Helper()
	return NewClient(readyRuntime(t, &stubAdapter{}))
}

func TestExposureDedup(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	exp := Exposure{TargetingKey: "org_1", FlagKey: "fw-exp", Variant: "on", Value: true}

	res, err := c.Exposures().Record(ctx, exp)
	if err != nil || res.Queued != 1 || res.Deduped {
		t.Fatalf("first record: %+v err=%v", res, err)
	}
	res, err = c.Exposures().Record(ctx, exp)
	if err != nil || res.Queued != 1 || !res.Deduped {
		t.Fatalf("duplicate should dedup: %+v err=%v", res, err)
	}
	// A different value for the same flag is a distinct tuple.
	res, _ = c.Exposures().Record(ctx, Exposure{TargetingKey: "org_1", FlagKey: "fw-exp", Variant: "off", Value: false})
	if res.Queued != 2 || res.Deduped {
		t.Fatalf("distinct tuple should queue: %+v", res)
	}
}

func TestExposureFlushDrainsQueue(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	_, _ = c.Exposures().Record(ctx, Exposure{TargetingKey: "org_1", FlagKey: "f", Variant: "on", Value: true})
	n, err := c.Exposures().Flush(ctx)
	if err != nil || n != 1 {
		t.Fatalf("flush = %d, %v", n, err)
	}
	if c.Exposures().Pending() != 0 {
		t.Fatalf("pending = %d after flush", c.Exposures().Pending())
	}
}

func TestExposureDedupWindowClearsOnFlush(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	exp := Exposure{TargetingKey: "org_1", FlagKey: "fw-exp", Variant: "on", Value: true}

	if res, _ := c.Exposures().Record(ctx, exp); res.Deduped {
		t.Fatalf("first record deduped: %+v", res)
	}
	if n, err := c.Exposures().Flush(ctx); err != nil || n != 1 {
		t.Fatalf("flush = %d, %v", n, err)
	}
	// Clear-on-flush lifecycle: the same tuple queues again after a flush
	// (dedup state must not grow for the process lifetime).
	res, err := c.Exposures().Record(ctx, exp)
	if err != nil || res.Deduped || res.Queued != 1 {
		t.Fatalf("post-flush record = %+v err=%v (seen-set must clear on flush)", res, err)
	}
}

func TestExposureWithNonComparableValueDoesNotPanic(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	exp := Exposure{TargetingKey: "org_1", FlagKey: "f", Value: map[string]any{"a": []any{1}}}
	if _, err := c.Exposures().Record(ctx, exp); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Exposures().Flush(ctx); err != nil {
		t.Fatal(err)
	}
}

// Schema-valid typed IDs (26-char Crockford ULIDs) for release tests.
const (
	testStampID  = "stmp_01HZXRE0000000000000000001"
	testChangeID = "chg_01HZXRE0000000000000000001"
)

func TestReleaseLifecycle(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	rc := ReleaseContext{RolloutID: "rollout_1", ChangeID: testChangeID, StampIDs: []string{testStampID}}

	if err := c.Releases().SetContext(ctx, rc); err != nil {
		t.Fatal(err)
	}
	got, ok := c.Releases().Context()
	if !ok || got.RolloutID != "rollout_1" || len(got.StampIDs) != 1 {
		t.Fatalf("context = %+v ok=%v", got, ok)
	}
	// Returned context is a copy; mutating it does not affect stored state.
	got.StampIDs[0] = "mutated"
	again, _ := c.Releases().Context()
	if again.StampIDs[0] != testStampID {
		t.Error("release context must be copied out")
	}

	if err := c.Releases().Start(ctx, "rollout_1"); err != nil {
		t.Fatal(err)
	}
	if s := c.Releases().Status(); s != ReleaseStatusInProgress {
		t.Fatalf("status = %s", s)
	}
	if err := c.Releases().Complete(ctx, "rollout_1"); err != nil {
		t.Fatal(err)
	}
	if s := c.Releases().Status(); s != ReleaseStatusCompleted {
		t.Fatalf("status = %s", s)
	}

	// Transition against an unknown rollout is a configuration error.
	if err := c.Releases().Start(ctx, "rollout_other"); !errors.Is(err, ErrConfiguration) {
		t.Fatalf("unknown rollout err = %v", err)
	}
}

func TestReleaseFailRedactsReason(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	_ = c.Releases().SetContext(ctx, ReleaseContext{RolloutID: "rollout_1", StampIDs: []string{testStampID}})
	_ = c.Releases().Start(ctx, "rollout_1")
	if err := c.Releases().Fail(ctx, "rollout_1", "guardrail breach with key phc_SECRET123"); err != nil {
		t.Fatal(err)
	}
	reason := c.Releases().FailReason()
	if strings.Contains(reason, "phc_") {
		t.Errorf("fail reason leaked secret: %q", reason)
	}
	if c.Releases().Status() != ReleaseStatusFailed {
		t.Errorf("status = %s", c.Releases().Status())
	}
}

func TestSignalsRecordAndRedact(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()

	if err := c.Signals().RecordHealth(ctx, HealthSignal{Name: "provider", Status: "ok", RolloutID: "r1"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Signals().RecordError(ctx, ErrorSignal{Name: "evaluation", ErrorKind: KindTimeout, Message: "timed out talking to phs_SECRETKEY"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Signals().RecordMetric(ctx, MetricSignal{Name: "rollout.adoption", Value: 0.42, StampID: "stmp_1"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Signals().RecordOutcome(ctx, OutcomeSignal{Name: "release", Status: "completed", ChangeID: "chg_1"}); err != nil {
		t.Fatal(err)
	}

	recorded := c.Signals().Recorded()
	if len(recorded) != 4 {
		t.Fatalf("recorded %d signals", len(recorded))
	}
	if strings.Contains(recorded[1].Message, "phs_") {
		t.Errorf("error signal message leaked secret: %q", recorded[1].Message)
	}
	kinds := []SignalKind{SignalKindHealth, SignalKindError, SignalKindMetric, SignalKindOutcome}
	for i, k := range kinds {
		if recorded[i].Kind != k {
			t.Errorf("signal %d kind = %s, want %s", i, recorded[i].Kind, k)
		}
	}
}

func TestSignalRequiresName(t *testing.T) {
	c := readyClient(t)
	if err := c.Signals().RecordHealth(context.Background(), HealthSignal{Status: "ok"}); !errors.Is(err, ErrConfiguration) {
		t.Fatalf("err = %v", err)
	}
}

func TestGuardrailsPhaseOneStub(t *testing.T) {
	c := readyClient(t)
	err := c.Guardrails().Check(context.Background(), "latency", nil)
	if !errors.Is(err, ErrUnsupportedCapability) {
		t.Fatalf("err = %v", err)
	}
}

func TestReleaseSetContextValidation(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	longRollout := strings.Repeat("r", 129)
	cases := []struct {
		name string
		rc   ReleaseContext
	}{
		{"missing rolloutId", ReleaseContext{StampIDs: []string{testStampID}}},
		{"rolloutId too long", ReleaseContext{RolloutID: longRollout, StampIDs: []string{testStampID}}},
		{"missing stampIds", ReleaseContext{RolloutID: "rollout_1"}},
		{"malformed stampId", ReleaseContext{RolloutID: "rollout_1", StampIDs: []string{"stmp_short"}}},
		{"non-crockford stampId (L)", ReleaseContext{RolloutID: "rollout_1", StampIDs: []string{"stmp_01HZXLE0000000000000000001"}}},
		{"duplicate stampIds", ReleaseContext{RolloutID: "rollout_1", StampIDs: []string{testStampID, testStampID}}},
		{"malformed changeId", ReleaseContext{RolloutID: "rollout_1", ChangeID: "chg_1", StampIDs: []string{testStampID}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := c.Releases().SetContext(ctx, tc.rc); !errors.Is(err, ErrConfiguration) {
				t.Fatalf("err = %v, want Configuration", err)
			}
		})
	}
	// Valid per spec/release-context.schema.json: rolloutId + well-formed
	// stampIds; changeId optional.
	if err := c.Releases().SetContext(ctx, ReleaseContext{RolloutID: "rollout_1", StampIDs: []string{testStampID}}); err != nil {
		t.Fatalf("valid context rejected: %v", err)
	}
}

func TestFlagsEvaluateDoesNotRequireRuntimeReachIn(t *testing.T) {
	// Ruling 16: portable detailed evaluation uses Client.Flags().Evaluate
	// only — the call site must not name Runtime().
	c := readyClient(t)
	ctx := context.Background()
	d := c.Flags().Evaluate(
		ctx,
		"fw-on",
		FlagTypeBoolean,
		false,
		EvaluationContext{TargetingKey: "user_42"},
		EvaluateOptions{},
	)
	if d.Error != nil {
		t.Fatalf("decision error: %v", d.Error)
	}
	if d.Value != true {
		t.Fatalf("value = %v, want true", d.Value)
	}
	send := false
	d2 := c.Flags().Evaluate(
		ctx,
		"fw-on",
		FlagTypeBoolean,
		false,
		EvaluationContext{TargetingKey: "user_42"},
		EvaluateOptions{IncludePayload: true, SendExposure: &send},
	)
	if d2.Error != nil {
		t.Fatalf("decision with options error: %v", d2.Error)
	}
}

func TestCapabilitiesStructuredMatrix(t *testing.T) {
	c := readyClient(t)
	caps := c.Capabilities().Get()

	if caps.Static.Language != "go" || caps.Static.SDKVersion == "" || caps.Static.SpecVersion != "0.1.0" {
		t.Fatalf("static = %+v", caps.Static)
	}
	of := caps.Static.OpenFeature
	if of.SpecFloor != "0.8.0" || of.ProviderName != "fireweave" || !of.ServerOnly {
		t.Fatalf("openFeature = %+v", of)
	}
	for _, feature := range []string{"flags", "inMemoryAdapter", "releases", "exposures", "signals"} {
		if !caps.Static.Features[feature] {
			t.Errorf("static feature %q should be true", feature)
		}
	}
	if caps.Static.Features["guardrails"] {
		t.Error("guardrails is a phase-one stub and must report false")
	}
	if caps.Runtime.Lifecycle != "READY" {
		t.Errorf("lifecycle = %q, want READY", caps.Runtime.Lifecycle)
	}
	// stubAdapter implements no CapabilityReporter → backend "other".
	if caps.Runtime.Backend != "other" {
		t.Errorf("backend = %q, want other", caps.Runtime.Backend)
	}
	if caps.Runtime.Limits["intSafeMaxAbs"] != int64(9007199254740991) {
		t.Errorf("limits = %v", caps.Runtime.Limits)
	}
	if caps.Runtime.Limits["shutdownTimeoutMsDefault"] != int64(10_000) {
		t.Errorf("shutdownTimeoutMsDefault = %v, want 10000", caps.Runtime.Limits["shutdownTimeoutMsDefault"])
	}

	// Lifecycle reflects the live state.
	_ = c.Runtime().Shutdown(context.Background())
	if got := c.Capabilities().Get().Runtime.Lifecycle; got != "SHUTDOWN" {
		t.Errorf("post-shutdown lifecycle = %q", got)
	}
}

func TestCapabilityOperationsAndInvoke(t *testing.T) {
	c := readyClient(t)
	ops := c.Capabilities().Operations()
	want := []string{
		"releases.setContext", "releases.start", "releases.complete", "releases.fail",
		"exposures.record", "exposures.flush",
		"signals.recordHealth", "signals.recordError", "signals.recordMetric", "signals.recordOutcome",
		"capabilities.get",
	}
	if len(ops) != len(want) {
		t.Fatalf("operations = %v", ops)
	}
	for i := range want {
		if ops[i] != want[i] {
			t.Errorf("operation[%d] = %s, want %s", i, ops[i], want[i])
		}
	}
	if err := c.Capabilities().Invoke(context.Background(), "releases.teleport", nil); !errors.Is(err, ErrUnsupportedCapability) {
		t.Fatalf("unknown capability err = %v", err)
	}
	if err := c.Capabilities().Invoke(context.Background(), "capabilities.get", nil); err != nil {
		t.Fatalf("known capability err = %v", err)
	}
}

func TestExtensionsGatedByLifecycle(t *testing.T) {
	rt := NewRuntime(&stubAdapter{}, Config{})
	c := NewClient(rt)
	ctx := context.Background()

	// Ruling 17: pre-ready extension calls degrade as UnsupportedCapability.
	if err := c.Releases().SetContext(ctx, ReleaseContext{RolloutID: "r"}); !errors.Is(err, ErrUnsupportedCapability) {
		t.Errorf("before init: %v", err)
	}
	_ = rt.Initialize(ctx)
	_ = rt.Shutdown(ctx)
	if _, err := c.Exposures().Record(ctx, Exposure{TargetingKey: "k", FlagKey: "f"}); !errors.Is(err, ErrAlreadyClosed) {
		t.Errorf("after close: %v", err)
	}
}

func TestClientConcurrentSafety(t *testing.T) {
	c := readyClient(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _ = c.Exposures().Record(ctx, Exposure{TargetingKey: "k", FlagKey: "f", Value: i})
			_ = c.Signals().RecordHealth(ctx, HealthSignal{Name: "h", Status: "ok"})
			_ = c.Capabilities().Get()
			_, _ = c.Exposures().Flush(ctx)
		}(i)
	}
	wg.Wait()
}

func TestTelemetrySanitizerAllowlistAndRedaction(t *testing.T) {
	props := sanitizeTelemetryProperties(map[string]any{
		"flagKey":  "fw-x",
		"message":  "failed with phc_SECRET",
		"email":    "user@example.com", // not on allowlist
		"password": "hunter2",          // not on allowlist
	})
	if _, ok := props["email"]; ok {
		t.Error("non-allowlisted key must be dropped")
	}
	if _, ok := props["password"]; ok {
		t.Error("non-allowlisted key must be dropped")
	}
	if msg := props["message"].(string); strings.Contains(msg, "phc_") {
		t.Errorf("message not redacted: %q", msg)
	}
	if props["flagKey"] != "fw-x" {
		t.Errorf("flagKey = %v", props["flagKey"])
	}
}
