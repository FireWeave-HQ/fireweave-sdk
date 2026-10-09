package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// contracts/errors.json rules.redaction, read from the repository's contracts
// directory the way the conformance runner finds it (relative to this
// package directory).
var errorsContract = filepath.Join("..", "..", "..", "contracts", "errors.json")

type redactionRules struct {
	Placeholder     string   `json:"placeholder"`
	AssignmentNames []string `json:"assignmentNames"`
	ValuePrefixes   []string `json:"valuePrefixes"`
	Vectors         []struct {
		In  string `json:"in"`
		Out string `json:"out"`
	} `json:"vectors"`
}

func loadRedactionRules(t *testing.T) redactionRules {
	t.Helper()
	raw, err := os.ReadFile(errorsContract)
	if err != nil {
		t.Fatalf("read %s: %v", errorsContract, err)
	}
	var doc struct {
		Rules struct {
			Redaction redactionRules `json:"redaction"`
		} `json:"rules"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", errorsContract, err)
	}
	r := doc.Rules.Redaction
	if len(r.Vectors) == 0 {
		t.Fatalf("%s has no rules.redaction.vectors", errorsContract)
	}
	return r
}

// SP-26: Redact turns every vector's in into exactly its out.
func TestRedactPassesEveryContractVector(t *testing.T) {
	r := loadRedactionRules(t)
	if r.Placeholder != redactedPlaceholder {
		t.Fatalf("placeholder = %q, contract says %q", redactedPlaceholder, r.Placeholder)
	}
	for _, v := range r.Vectors {
		if got := Redact(v.In); got != v.Out {
			t.Errorf("Redact(%q)\n got %q\nwant %q", v.In, got, v.Out)
		}
	}
}

// Every assignment name and value prefix the contract lists is covered, not
// only the ones its vectors happen to use.
func TestRedactCoversEveryContractNameAndPrefix(t *testing.T) {
	r := loadRedactionRules(t)
	for _, name := range r.AssignmentNames {
		in := name + "=s3cretValue9 and " + name + " alone"
		want := name + "=" + r.Placeholder + " and " + name + " alone"
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
	for _, prefix := range r.ValuePrefixes {
		in := "got " + prefix + "s3cretValue9 and " + prefix + "… here"
		want := "got " + r.Placeholder + " and " + prefix + "… here"
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
}

// Redacting twice changes nothing: messages pass through Redact at every
// layer that builds one.
func TestRedactIsIdempotent(t *testing.T) {
	for _, v := range loadRedactionRules(t).Vectors {
		if got := Redact(Redact(v.In)); got != v.Out {
			t.Errorf("Redact(Redact(%q)) = %q, want %q", v.In, got, v.Out)
		}
	}
}
