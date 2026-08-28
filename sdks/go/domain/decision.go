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
// (spec/decision.schema.json standardMetadataKeys).
//
// MetaPayload (task-10b item 5, contracts/evaluation/eval-payload-
// attached.json): despite this file's prior claim that "v1 carries no
// fireweave.payload key... cut alongside the extension surface", node's own
// EvaluateOptions.includePayload was never actually cut (application/
// runtime.ts attaches it unconditionally when the caller opts in) — v1 reads
// remain side-effect free (spec/control-points.md "Side effects": no
// telemetry is EMITTED as a consequence of a read), which is an orthogonal
// concern from surfacing metadata the resolved flag already carries. That
// prior claim was the divergence itself, not a description of the ratified
// surface; this key restores go to node/python parity.
const (
	MetaErrorKind    = "fireweave.errorKind"
	MetaFlagVersion  = "fireweave.flagVersion"
	MetaVendorFlagID = "fireweave.vendorFlagId"
	MetaReasonCode   = "fireweave.reasonCode"
	MetaQuotaLimited = "fireweave.quotaLimited"
	MetaFromCache    = "fireweave.fromCache"
	MetaPayload      = "fireweave.payload"
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
