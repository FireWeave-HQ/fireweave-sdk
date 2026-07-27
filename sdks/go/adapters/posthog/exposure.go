package posthog

import (
	"sync"

	posthoggo "github.com/posthog/posthog-go"
)

// exposureGate suppresses posthog-go's implicit $feature_flag_called
// events. Snapshot value accessors fire them on every read; Fireweave's
// policy is: only when exposure sending is enabled, and at most once per
// (distinct_id, flag, response) tuple.
//
// Resolve arms one token per (distinct_id, flag) immediately before the
// snapshot read; the BeforeSend hook consumes the token and applies the
// response-level dedup (the response value is only known at event time).
type exposureGate struct {
	send bool

	mu    sync.Mutex
	allow map[string]int  // (distinct_id, flag) tokens armed for imminent reads
	seen  map[string]bool // (distinct_id, flag, response) tuples already sent
}

func gateKey(distinctID, flagKey string) string {
	return distinctID + "\x00" + flagKey
}

// arm permits the next $feature_flag_called for (distinctID, flagKey).
func (g *exposureGate) arm(distinctID, flagKey string) {
	if !g.send {
		return
	}
	g.mu.Lock()
	g.allow[gateKey(distinctID, flagKey)]++
	g.mu.Unlock()
}

// beforeSend is installed as the posthog-go BeforeSend hook. Returning nil
// drops the message.
func (g *exposureGate) beforeSend(msg posthoggo.Message) posthoggo.Message {
	capture, ok := msg.(posthoggo.Capture)
	if !ok {
		return msg
	}
	if capture.Event != "$feature_flag_called" {
		return msg
	}
	if !g.send {
		return nil
	}
	flagKey, _ := capture.Properties["$feature_flag"].(string)
	key := gateKey(capture.DistinctId, flagKey)
	tuple := key + "\x00" + responseString(capture.Properties["$feature_flag_response"])

	g.mu.Lock()
	defer g.mu.Unlock()
	if g.allow[key] == 0 {
		return nil // unarmed access (internal re-read); suppress
	}
	g.allow[key]--
	if g.seen[tuple] {
		return nil // duplicate exposure for the same tuple; dedup
	}
	g.seen[tuple] = true
	return msg
}

func responseString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}
