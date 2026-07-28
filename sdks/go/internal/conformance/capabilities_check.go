package conformance

import (
	"encoding/json"
	"fmt"
)

// adjustCapabilitiesResult implements the contracts/harness.md
// getCapabilities exception (ruling 18): the actual result MUST be the
// structured {static, runtime} matrix of spec/capabilities.schema.json —
// validated here in full — while expect.capabilities is compared as a
// subset (undeclared capability keys are language/build-dependent). The
// prune step keeps only expect-declared keys so the strict extra-key
// comparator still applies to everything else.
func adjustCapabilitiesResult(f Fixture, actual map[string]any) []string {
	if f.When.Operation != "getCapabilities" {
		return nil
	}
	caps, ok := actual["capabilities"].(map[string]any)
	if !ok {
		return []string{"capabilities: want the structured {static, runtime} matrix (ruling 18)"}
	}
	diffs := validateCapabilitiesMatrix(caps)
	if expectCaps, ok := f.Expect["capabilities"].(map[string]any); ok {
		actual["capabilities"] = pruneToExpected(caps, expectCaps)
	}
	return diffs
}

// pruneToExpected keeps only the keys declared in expect, recursing into
// nested objects (subset comparison per harness.md).
func pruneToExpected(actual, expect map[string]any) map[string]any {
	out := make(map[string]any, len(expect))
	for k, ev := range expect {
		av, ok := actual[k]
		if !ok {
			continue // Compare will report the missing key
		}
		if em, ok := ev.(map[string]any); ok {
			if am, ok := av.(map[string]any); ok {
				out[k] = pruneToExpected(am, em)
				continue
			}
		}
		out[k] = av
	}
	return out
}

// validateCapabilitiesMatrix checks the full actual capabilities object
// against the structural constraints of spec/capabilities.schema.json:
// required keys, closed objects (additionalProperties: false), enums, and
// const values.
func validateCapabilitiesMatrix(caps map[string]any) []string {
	var diffs []string
	fail := func(format string, args ...any) {
		diffs = append(diffs, "capabilities schema: "+fmt.Sprintf(format, args...))
	}

	checkClosed(caps, "capabilities", []string{"static", "runtime"}, fail)

	static, ok := caps["static"].(map[string]any)
	if !ok {
		fail("static: required object missing")
	} else {
		checkClosed(static, "static", []string{"language", "sdkVersion", "specVersion", "openFeature", "features"}, fail)
		requireKeys(static, "static", []string{"language", "openFeature", "features"}, fail)
		checkEnum(static, "static.language", []string{"node", "python", "go", "java"}, fail)
		if v, ok := static["sdkVersion"]; ok {
			if s, isStr := v.(string); !isStr || s == "" {
				fail("static.sdkVersion: want non-empty string, got %v", v)
			}
		}
		if v, ok := static["specVersion"]; ok && v != "0.1.0" {
			fail("static.specVersion: want const \"0.1.0\", got %v", v)
		}
		if of, ok := static["openFeature"].(map[string]any); ok {
			checkClosed(of, "static.openFeature", []string{"specFloor", "providerName", "serverOnly"}, fail)
			requireKeys(of, "static.openFeature", []string{"specFloor", "providerName"}, fail)
			if v := of["specFloor"]; v != "0.8.0" {
				fail("static.openFeature.specFloor: want const \"0.8.0\", got %v", v)
			}
			if v := of["providerName"]; v != "fireweave" {
				fail("static.openFeature.providerName: want const \"fireweave\", got %v", v)
			}
			if v, ok := of["serverOnly"]; ok && v != true {
				fail("static.openFeature.serverOnly: want const true, got %v", v)
			}
		} else if _, present := static["openFeature"]; present {
			fail("static.openFeature: want object")
		}
		checkBoolMap(static, "static.features", fail)
		if feats, ok := static["features"].(map[string]any); ok {
			if v, ok := feats["flags"]; ok && v != true {
				fail("static.features.flags: want const true, got %v", v)
			}
			if v, ok := feats["inMemoryAdapter"]; ok && v != true {
				fail("static.features.inMemoryAdapter: want const true, got %v", v)
			}
		}
	}

	runtime, ok := caps["runtime"].(map[string]any)
	if !ok {
		fail("runtime: required object missing")
	} else {
		checkClosed(runtime, "runtime", []string{"backend", "lifecycle", "features", "limits"}, fail)
		requireKeys(runtime, "runtime", []string{"backend", "lifecycle"}, fail)
		checkEnum(runtime, "runtime.backend", []string{"posthog", "inmemory", "none", "other"}, fail)
		checkEnum(runtime, "runtime.lifecycle",
			[]string{"UNINITIALIZED", "INITIALIZING", "READY", "STALE", "ERROR", "FATAL", "SHUTDOWN"}, fail)
		checkBoolMap(runtime, "runtime.features", fail)
		if limits, ok := runtime["limits"].(map[string]any); ok {
			checkClosed(limits, "runtime.limits", []string{"intSafeMaxAbs", "shutdownTimeoutMsDefault"}, fail)
			checkNumberConst(limits, "runtime.limits.intSafeMaxAbs", "9007199254740991", fail)
			checkNumberConst(limits, "runtime.limits.shutdownTimeoutMsDefault", "10000", fail)
		}
	}
	return diffs
}

func requireKeys(m map[string]any, path string, keys []string, fail func(string, ...any)) {
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			fail("%s.%s: required key missing", path, k)
		}
	}
}

func checkClosed(m map[string]any, path string, allowed []string, fail func(string, ...any)) {
	allowedSet := map[string]struct{}{}
	for _, k := range allowed {
		allowedSet[k] = struct{}{}
	}
	for k := range m {
		if _, ok := allowedSet[k]; !ok {
			fail("%s.%s: unknown key (additionalProperties: false)", path, k)
		}
	}
}

func checkEnum(m map[string]any, path string, allowed []string, fail func(string, ...any)) {
	key := path[lastDot(path)+1:]
	v, ok := m[key]
	if !ok {
		return // requiredKeys reports absence
	}
	s, isStr := v.(string)
	if !isStr {
		fail("%s: want string, got %v", path, v)
		return
	}
	for _, a := range allowed {
		if s == a {
			return
		}
	}
	fail("%s: %q not in enum %v", path, s, allowed)
}

func checkBoolMap(m map[string]any, path string, fail func(string, ...any)) {
	key := path[lastDot(path)+1:]
	v, ok := m[key]
	if !ok {
		return
	}
	fm, isMap := v.(map[string]any)
	if !isMap {
		fail("%s: want object of booleans", path)
		return
	}
	for k, fv := range fm {
		if _, isBool := fv.(bool); !isBool {
			fail("%s.%s: want boolean, got %v", path, k, fv)
		}
	}
}

func checkNumberConst(m map[string]any, path, want string, fail func(string, ...any)) {
	key := path[lastDot(path)+1:]
	v, ok := m[key]
	if !ok {
		return // optional property
	}
	n, isNum := v.(json.Number)
	if !isNum || n.String() != want {
		fail("%s: want const %s, got %v", path, want, v)
	}
}

func lastDot(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '.' {
			return i
		}
	}
	return -1
}
