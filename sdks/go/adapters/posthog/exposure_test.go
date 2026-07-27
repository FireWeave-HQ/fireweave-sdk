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
