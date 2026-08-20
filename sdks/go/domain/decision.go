package domain

// FlagType names the requested flag value type for typed evaluation
// (spec/control-points.md "The nine methods").
//
// Exactly four: boolean, string, number, object — there is no separate
// integer/float distinction in v1 (Decision.Value is jsonValue;
// GetNumberValue returns number, not integer —
// conformance/surface/control-points.surface.json). The pre-v1 Go surface
// exposed a five-way Boolean/String/Integer/Float/Object split; this is the
// drift the v1 cut brings in line with node/java/python.
type FlagType string

const (
	FlagTypeBoolean FlagType = "boolean"
	FlagTypeString  FlagType = "string"
	FlagTypeNumber  FlagType = "number"
	FlagTypeObject  FlagType = "object"
)

// Reason is the normalized resolution reason (spec/decision.schema.json).
type Reason string

const (
	ReasonStatic         Reason = "STATIC"
	ReasonDefault        Reason = "DEFAULT"
	ReasonTargetingMatch Reason = "TARGETING_MATCH"
	ReasonSplit          Reason = "SPLIT"
	ReasonCached         Reason = "CACHED"
	ReasonDisabled       Reason = "DISABLED"
	ReasonStale          Reason = "STALE"
	ReasonError          Reason = "ERROR"
)

// Stable flag-metadata keys exposed under the fireweave.* namespace
// (spec/decision.schema.json standardMetadataKeys). v1 carries no
// fireweave.payload key: a v1 read is side-effect free and the pre-v1
// includePayload/payload mechanism was cut alongside the extension surface
// (spec/control-points.md "Side effects"; matches the java precedent, which
// also dropped Decision.payload as part of the same cut).
const (
	MetaErrorKind    = "fireweave.errorKind"
	MetaFlagVersion  = "fireweave.flagVersion"
	MetaVendorFlagID = "fireweave.vendorFlagId"
	MetaReasonCode   = "fireweave.reasonCode"
	MetaQuotaLimited = "fireweave.quotaLimited"
	MetaFromCache    = "fireweave.fromCache"
)

// Decision is the normalized outcome of a flag resolution
// (spec/decision.schema.json). On error paths Value carries the caller
// default, Reason is ERROR, and Error carries the typed Fireweave error —
// defaults are returned, never thrown (spec/control-points.md "Return
// discipline").
type Decision struct {
	FlagKey  string
	Value    any
	Variant  string
	Reason   Reason
	Error    *Error
	Metadata map[string]any
}

// ErrorDecision builds the canonical error-path decision: default value,
// ERROR reason, and fireweave.errorKind metadata (plus any extras such as
// fireweave.quotaLimited).
func ErrorDecision(flagKey string, defaultValue any, err *Error, extraMeta map[string]any) Decision {
	meta := map[string]any{MetaErrorKind: string(err.Kind)}
	for k, v := range extraMeta {
		meta[k] = v
	}
	return Decision{
		FlagKey:  flagKey,
		Value:    defaultValue,
		Reason:   ReasonError,
		Error:    err,
		Metadata: meta,
	}
}
