package fireweave

// FlagType names the requested flag value type.
type FlagType string

const (
	FlagTypeBoolean FlagType = "boolean"
	FlagTypeString  FlagType = "string"
	FlagTypeInteger FlagType = "integer"
	FlagTypeFloat   FlagType = "float"
	FlagTypeObject  FlagType = "object"
)

// Reason is the normalized resolution reason, aligned with OpenFeature.
type Reason string

const (
	ReasonTargetingMatch Reason = "TARGETING_MATCH"
	ReasonSplit          Reason = "SPLIT"
	ReasonDisabled       Reason = "DISABLED"
	ReasonDefault        Reason = "DEFAULT"
	ReasonStale          Reason = "STALE"
	ReasonCached         Reason = "CACHED"
	ReasonError          Reason = "ERROR"
)

// Stable flag-metadata keys exposed under the fireweave.* namespace
// (spec/decision.schema.json).
const (
	MetaErrorKind    = "fireweave.errorKind"
	MetaFlagVersion  = "fireweave.flagVersion"
	MetaVendorFlagID = "fireweave.vendorFlagId"
	MetaReasonCode   = "fireweave.reasonCode"
	MetaPayload      = "fireweave.payload"
	MetaQuotaLimited = "fireweave.quotaLimited"
	MetaFromCache    = "fireweave.fromCache"
)

// Decision is the normalized outcome of a flag resolution. On error paths
// Value carries the caller default, Reason is ERROR, and Error carries the
// typed Fireweave error (defaults are returned, never thrown, per
// OpenFeature semantics).
type Decision struct {
	Value    any
	Variant  string
	Reason   Reason
	Error    *Error
	Metadata map[string]any
}

// ErrorDecision builds the canonical error-path decision: default value,
// ERROR reason, and fireweave.errorKind metadata (plus any extras such as
// fireweave.quotaLimited).
func ErrorDecision(defaultValue any, err *Error, extraMeta map[string]any) Decision {
	meta := map[string]any{MetaErrorKind: string(err.Kind)}
	for k, v := range extraMeta {
		meta[k] = v
	}
	return Decision{
		Value:    defaultValue,
		Reason:   ReasonError,
		Error:    err,
		Metadata: meta,
	}
}
