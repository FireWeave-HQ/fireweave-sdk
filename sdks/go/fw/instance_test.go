package fw

import (
	"regexp"
	"testing"
)

func TestFNV1a64MatchesTheReferenceVectors(t *testing.T) {
	// FNV-1a 64-bit reference values; node's fnv1a64 produces the same.
	for in, want := range map[string]string{"": "cbf29ce484222325", "a": "af63dc4c8601ec8c"} {
		if got := fnv1a64(in); got != want {
			t.Errorf("fnv1a64(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestDeriveInstanceKeyOrder(t *testing.T) {
	host := func() string { return "api-pod-1" }
	noHost := func() string { return "" }
	withID := env(map[string]string{"FIREWEAVE_INSTANCE_ID": "worker-7"})

	if v, src := deriveInstanceKey(" cron-1 ", withID, host); v != "cron-1" || src != instanceSourceOption {
		t.Fatalf("option: got %q (%s)", v, src)
	}
	if v, src := deriveInstanceKey("", withID, host); v != "worker-7" || src != instanceSourceEnv {
		t.Fatalf("env: got %q (%s)", v, src)
	}
	v, src := deriveInstanceKey("", env(nil), host)
	if v != "inst_"+fnv1a64("api-pod-1") || src != instanceSourceHost {
		t.Fatalf("host: got %q (%s)", v, src)
	}
	if !regexp.MustCompile(`^inst_[0-9a-f]{16}$`).MatchString(v) {
		t.Fatalf("host key shape: %q", v)
	}
	r1, src := deriveInstanceKey("", env(nil), noHost)
	r2, _ := deriveInstanceKey("", env(nil), noHost)
	if src != instanceSourceRandom || r1 == r2 || !regexp.MustCompile(`^inst_[0-9a-f]{32}$`).MatchString(r1) {
		t.Fatalf("random: got %q, %q (%s)", r1, r2, src)
	}
}
