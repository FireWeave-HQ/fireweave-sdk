package fireweave

// Version is the Fireweave Go SDK package version.
const Version = "0.1.0"

// SpecVersion is the Fireweave SDK spec version this package implements
// (spec/version.json).
const SpecVersion = "0.1.0"

// openFeatureSpecFloor is the minimum OpenFeature spec version supported.
const openFeatureSpecFloor = "0.8.0"

// intSafeMaxAbs is the cross-language safe integer bound (2^53−1),
// spec/capabilities.schema.json.
const intSafeMaxAbs = int64(9007199254740991)

// Capabilities is the structured capability matrix returned by
// Client.Capabilities().Get(), per spec/capabilities.schema.json
// (orchestrator ruling 18). JSON field names match the schema exactly.
type Capabilities struct {
	// Static describes capabilities always true for this package build.
	Static StaticCapabilities `json:"static"`
	// Runtime describes capabilities that depend on adapter selection and
	// configuration at runtime.
	Runtime RuntimeCapabilities `json:"runtime"`
}

// StaticCapabilities are compile-time capabilities of this language binding.
type StaticCapabilities struct {
	Language    string                  `json:"language"`
	SDKVersion  string                  `json:"sdkVersion"`
	SpecVersion string                  `json:"specVersion"`
	OpenFeature OpenFeatureCapabilities `json:"openFeature"`
	Features    map[string]bool         `json:"features"`
}

// OpenFeatureCapabilities describe the OpenFeature integration.
type OpenFeatureCapabilities struct {
	SpecFloor    string `json:"specFloor"`
	ProviderName string `json:"providerName"`
	ServerOnly   bool   `json:"serverOnly"`
}

// RuntimeCapabilities are adapter/config-dependent capabilities.
type RuntimeCapabilities struct {
	// Backend is one of "posthog", "inmemory", "none", "other".
	Backend string `json:"backend"`
	// Lifecycle is the current runtime lifecycle state (UNINITIALIZED,
	// INITIALIZING, READY, STALE, ERROR, FATAL, SHUTDOWN).
	Lifecycle string `json:"lifecycle"`
	// Features are adapter-reported runtime feature toggles
	// (remoteEvaluation, localEvaluation, exposureEmission, ...).
	Features map[string]bool `json:"features,omitempty"`
	// Limits are effective numeric bounds (intSafeMaxAbs, ...).
	Limits map[string]int64 `json:"limits,omitempty"`
}

// AdapterCapabilities is the runtime capability report an adapter provides
// through the optional CapabilityReporter interface.
type AdapterCapabilities struct {
	// Backend names the adapter backend ("posthog", "inmemory", "other").
	Backend string
	// Features are backend-specific runtime feature toggles.
	Features map[string]bool
}

// CapabilityReporter is optionally implemented by adapters that can
// describe their runtime capabilities; Client.Capabilities().Get()
// discovers it via type assertion. Adapters that do not implement it are
// reported with backend "other" and no runtime features.
type CapabilityReporter interface {
	ReportCapabilities() AdapterCapabilities
}
