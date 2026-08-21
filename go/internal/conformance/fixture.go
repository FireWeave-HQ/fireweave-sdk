// Package conformance runs the canonical contracts/ fixtures against the
// real OpenFeature client + Fireweave provider and emits the
// compatibility-report JSON defined by contracts/README.md.
package conformance

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

// Fixture is one contracts/<suite>/<id>.json case.
type Fixture struct {
	ID            string            `json:"id"`
	Suite         string            `json:"suite"`
	Description   string            `json:"description"`
	SchemaVersion int               `json:"schemaVersion"`
	Provisional   bool              `json:"provisional"`
	Compatibility map[string]string `json:"compatibility"`
	Limitations   map[string]string `json:"limitations"`

	Given  Given          `json:"given"`
	When   When           `json:"when"`
	Expect map[string]any `json:"expect"`

	// Cases is the optional multi-case form (contracts/README.md): when
	// present the fixture has no top-level when/expect and every case must
	// pass against a fresh setup.
	Cases []FixtureCase `json:"cases"`
}

// FixtureCase is one case of a multi-case fixture. Given (when present)
// shallow-merges over the fixture-level given block.
type FixtureCase struct {
	Name   string         `json:"name"`
	Given  *Given         `json:"given"`
	When   When           `json:"when"`
	Expect map[string]any `json:"expect"`
}

// Given is the fixture arrangement block.
type Given struct {
	ProviderState  string                 `json:"providerState"`
	Flags          map[string]FixtureFlag `json:"flags"`
	GlobalContext  *ContextSpec           `json:"globalContext"`
	ClientContext  *ContextSpec           `json:"clientContext"`
	Config         map[string]any         `json:"config"`
	Fault          map[string]any         `json:"fault"`
	Extensions     map[string]bool        `json:"extensions"`
	ExposureQueue  []map[string]any       `json:"exposureQueue"`
	ReleaseContext map[string]any         `json:"releaseContext"`
	ReleaseStatus  string                 `json:"releaseStatus"`
	Domains        map[string]DomainSpec  `json:"domains"`
	Replacement    *ReplacementSpec       `json:"replacement"`
}

// DomainSpec arranges one named provider domain.
type DomainSpec struct {
	ProviderState string                 `json:"providerState"`
	Flags         map[string]FixtureFlag `json:"flags"`
}

// ReplacementSpec arranges the provider swapped in by replaceProvider.
type ReplacementSpec struct {
	Flags map[string]FixtureFlag `json:"flags"`
}

// ContextSpec is a fixture-declared context layer.
type ContextSpec struct {
	TargetingKey string         `json:"targetingKey"`
	Attributes   map[string]any `json:"attributes"`
}

// FixtureFlag is one deterministic flag definition in given.flags.
type FixtureFlag struct {
	Type     string         `json:"type"`
	Enabled  bool           `json:"enabled"`
	Variant  string         `json:"variant"`
	Value    any            `json:"value"`
	Payload  any            `json:"payload"`
	Reason   *FixtureReason `json:"reason"`
	Metadata *struct {
		Version *int64 `json:"version"`
		ID      *int64 `json:"id"`
	} `json:"metadata"`
	FireweaveReason   string         `json:"fireweaveReason"`
	FromCache         bool           `json:"fromCache"`
	MatchAttribute    map[string]any `json:"matchAttribute"`
	MatchGroups       map[string]any `json:"matchGroups"`
	MatchPerson       map[string]any `json:"matchPerson"`
	MatchTargetingKey string         `json:"matchTargetingKey"`
}

// FixtureReason is the vendor-style reason block.
type FixtureReason struct {
	Code           string `json:"code"`
	ConditionIndex *int   `json:"condition_index"`
	Description    string `json:"description"`
}

// When is the fixture action block.
type When struct {
	Operation         string         `json:"operation"`
	Domain            string         `json:"domain"`
	FlagKey           string         `json:"flagKey"`
	FlagType          string         `json:"flagType"`
	DefaultValue      any            `json:"defaultValue"`
	InvocationContext *ContextSpec   `json:"invocationContext"`
	Options           map[string]any `json:"options"`
	Assertions        []string       `json:"assertions"`
	Exposure          map[string]any `json:"exposure"`
	Release           map[string]any `json:"release"`
	Signal            map[string]any `json:"signal"`
	Capability        string         `json:"capability"`
	Args              map[string]any `json:"args"`
	ThenEvaluate      *When          `json:"thenEvaluate"`
}

// LoadFixtures reads every fixture under contractsDir's suite directories.
func LoadFixtures(contractsDir string) ([]Fixture, error) {
	suites := []string{"evaluation", "context", "lifecycle", "faults", "security", "extensions"}
	var fixtures []Fixture
	for _, suite := range suites {
		paths, err := filepath.Glob(filepath.Join(contractsDir, suite, "*.json"))
		if err != nil {
			return nil, err
		}
		sort.Strings(paths)
		for _, p := range paths {
			raw, err := os.ReadFile(p)
			if err != nil {
				return nil, err
			}
			var f Fixture
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber() // preserve 64-bit integer precision
			if err := dec.Decode(&f); err != nil {
				return nil, fmt.Errorf("%s: %w", p, err)
			}
			fixtures = append(fixtures, f)
		}
	}
	return fixtures, nil
}
