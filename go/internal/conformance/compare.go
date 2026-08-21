package conformance

import (
	"encoding/json"
	"fmt"
	"strings"
)

// excludeSet is the harness.md EXCLUDE_SET baseline: nondeterministic keys
// dropped before comparison.
var excludeSet = map[string]struct{}{
	"timestamp": {}, "evaluatedAt": {}, "ts": {}, "createdAt": {}, "updatedAt": {},
	"stack": {}, "stackTrace": {}, "requestId": {}, "uuid": {}, "traceId": {},
	"spanId": {}, "messageId": {}, "latencyMs": {}, "durationMs": {},
	"pid": {}, "hostname": {},
}

// assertionKeys are expect-block keys that carry negative assertions rather
// than values to compare.
var assertionKeys = map[string]struct{}{
	"errorMessageMustNotContain":    {},
	"recordedMessageMustNotContain": {},
}

// Compare applies the normative comparator: every expect key must match
// (deep), and actual keys absent from expect (and not excluded) fail.
// It returns a list of human-readable diffs (empty means pass).
func Compare(actual, expect map[string]any) []string {
	var diffs []string
	compareMaps("", actual, expect, &diffs)
	return diffs
}

func compareMaps(path string, actual, expect map[string]any, diffs *[]string) {
	for k, ev := range expect {
		if _, isAssertion := assertionKeys[k]; isAssertion && path == "" {
			continue
		}
		p := joinPath(path, k)
		av, ok := actual[k]
		if !ok {
			*diffs = append(*diffs, fmt.Sprintf("missing key %q (want %s)", p, canonical(ev)))
			continue
		}
		compareValues(p, av, ev, diffs)
	}
	for k := range actual {
		if _, expected := expect[k]; expected {
			continue
		}
		if _, excluded := excludeSet[k]; excluded {
			continue
		}
		*diffs = append(*diffs, fmt.Sprintf("unexpected extra key %q = %s", joinPath(path, k), canonical(actual[k])))
	}
}

func compareValues(path string, actual, expect any, diffs *[]string) {
	switch ev := expect.(type) {
	case map[string]any:
		am, ok := actual.(map[string]any)
		if !ok {
			*diffs = append(*diffs, fmt.Sprintf("%q: want object, got %s", path, canonical(actual)))
			return
		}
		compareMaps(path, am, ev, diffs)
	case []any:
		aa, ok := actual.([]any)
		if !ok || len(aa) != len(ev) {
			*diffs = append(*diffs, fmt.Sprintf("%q: want %s, got %s", path, canonical(expect), canonical(actual)))
			return
		}
		for i := range ev {
			compareValues(fmt.Sprintf("%s[%d]", path, i), aa[i], ev[i], diffs)
		}
	default:
		if canonical(actual) != canonical(expect) {
			*diffs = append(*diffs, fmt.Sprintf("%q: want %s, got %s", path, canonical(expect), canonical(actual)))
		}
	}
}

// canonical serializes a value as canonical JSON (sorted keys; numbers as
// written thanks to json.Number / precise Go types).
func canonical(v any) string {
	b, err := json.Marshal(normalizeForJSON(v))
	if err != nil {
		return fmt.Sprintf("<unserializable: %v>", err)
	}
	return string(b)
}

// normalizeForJSON converts non-JSON-native containers ([]string etc.) into
// generic form so map key ordering is canonical (encoding/json sorts map
// keys already).
func normalizeForJSON(v any) any {
	switch t := v.(type) {
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out
	default:
		return v
	}
}

// checkMustNotContain applies the negative assertions from the expect
// block against the given haystacks.
func checkMustNotContain(expect map[string]any, key string, haystacks []string) []string {
	raw, ok := expect[key].([]any)
	if !ok {
		return nil
	}
	var diffs []string
	for _, n := range raw {
		needle, _ := n.(string)
		if needle == "" {
			continue
		}
		for _, h := range haystacks {
			if strings.Contains(h, needle) {
				diffs = append(diffs, fmt.Sprintf("%s: %q must not contain %q", key, h, needle))
			}
		}
	}
	return diffs
}

func joinPath(base, key string) string {
	if base == "" {
		return key
	}
	return base + "." + key
}
