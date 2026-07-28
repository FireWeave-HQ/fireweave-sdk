package posthog

import (
	"testing"

	posthoggo "github.com/posthog/posthog-go"
)

func flagCalledEvent(distinctID, flagKey string, response any) posthoggo.Capture {
	return posthoggo.Capture{
		DistinctId: distinctID,
		Event:      "$feature_flag_called",
		Properties: posthoggo.NewProperties().
			Set("$feature_flag", flagKey).
			Set("$feature_flag_response", response),
	}
}

func TestGateDropsAllExposuresWhenDisabled(t *testing.T) {
	g := &exposureGate{send: false, seen: map[string]bool{}, allow: map[string]int{}}
	g.arm("u1", "f1") // arm is a no-op when disabled
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", true)); msg != nil {
		t.Fatal("disabled gate must drop $feature_flag_called")
	}
}

func TestGateAllowsFirstExposureThenDedups(t *testing.T) {
	g := &exposureGate{send: true, seen: map[string]bool{}, allow: map[string]int{}}

	g.arm("u1", "f1")
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", true)); msg == nil {
		t.Fatal("first armed exposure must pass")
	}
	// Second resolve of the same tuple: armed but deduped.
	g.arm("u1", "f1")
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", true)); msg != nil {
		t.Fatal("duplicate (distinct_id, flag, response) must be deduped")
	}
	// A different response value is a fresh tuple.
	g.arm("u1", "f1")
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", "variant-b")); msg == nil {
		t.Fatal("distinct response tuple must pass")
	}
	// A different user is a fresh tuple.
	g.arm("u2", "f1")
	if msg := g.beforeSend(flagCalledEvent("u2", "f1", true)); msg == nil {
		t.Fatal("distinct user tuple must pass")
	}
}

func TestGateSeenClearsOnFlush(t *testing.T) {
	g := &exposureGate{send: true, seen: map[string]bool{}, allow: map[string]int{}}

	g.arm("u1", "f1")
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", true)); msg == nil {
		t.Fatal("first armed exposure must pass")
	}
	g.arm("u1", "f1")
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", true)); msg != nil {
		t.Fatal("duplicate before flush must be deduped")
	}
	// Clear-on-flush lifecycle: the dedup window resets, so the same tuple
	// may emit again (and the set cannot grow unbounded).
	g.clearSeen()
	g.arm("u1", "f1")
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", true)); msg == nil {
		t.Fatal("post-flush exposure for the same tuple must pass")
	}
}

func TestAdapterFlushTelemetryClearsGateSeen(t *testing.T) {
	a := New(Config{SendExposureEvents: true})
	a.gate.mu.Lock()
	a.gate.seen["u\x00f\x00true"] = true
	a.gate.mu.Unlock()

	if err := a.FlushTelemetry(t.Context()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	a.gate.mu.Lock()
	n := len(a.gate.seen)
	a.gate.mu.Unlock()
	if n != 0 {
		t.Fatalf("gate seen-set has %d entries after flush, want 0", n)
	}
}

func TestGateSuppressesUnarmedInternalReads(t *testing.T) {
	g := &exposureGate{send: true, seen: map[string]bool{}, allow: map[string]int{}}
	if msg := g.beforeSend(flagCalledEvent("u1", "f1", true)); msg != nil {
		t.Fatal("unarmed snapshot access must not emit an exposure")
	}
}

func TestGatePassesUnrelatedEvents(t *testing.T) {
	g := &exposureGate{send: false, seen: map[string]bool{}, allow: map[string]int{}}
	ev := posthoggo.Capture{DistinctId: "u1", Event: "$fw_signal_health", Properties: posthoggo.NewProperties()}
	if msg := g.beforeSend(ev); msg == nil {
		t.Fatal("non-exposure telemetry must pass the gate")
	}
}
