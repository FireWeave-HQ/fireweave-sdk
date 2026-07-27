package fireweave

import "context"

// includePayloadKey is the context.Context key for the include-payload
// evaluation option. OpenFeature has no per-invocation provider options, so
// payload attachment is requested through the Go context.
type includePayloadKey struct{}

// WithIncludePayload marks the context so the next evaluation attaches the
// flag payload as fireweave.payload metadata.
func WithIncludePayload(ctx context.Context) context.Context {
	return context.WithValue(ctx, includePayloadKey{}, true)
}

// IncludePayloadFromContext reports whether WithIncludePayload was applied.
func IncludePayloadFromContext(ctx context.Context) bool {
	v, _ := ctx.Value(includePayloadKey{}).(bool)
	return v
}

// ResolveRequest carries one flag resolution through the runtime to a
// BackendAdapter. Context has already been merged and validated and is a
// private copy the adapter may read freely.
type ResolveRequest struct {
	FlagKey        string
	Type           FlagType
	DefaultValue   any
	Context        EvaluationContext
	IncludePayload bool
}

// BackendAdapter is the small consumer-oriented contract between the shared
// runtime and a vendor backend. Implementations must be safe for concurrent
// use: Resolve may be called from many goroutines, potentially concurrently
// with Close. Every blocking method accepts a context.Context and must honor
// cancellation and deadlines.
type BackendAdapter interface {
	// Initialize prepares the adapter (client construction, initial polls).
	// A returned *Error with KindConfiguration is treated as fatal.
	Initialize(ctx context.Context) error
	// Resolve evaluates one flag. Failures are reported inside the Decision
	// (Reason ERROR + typed Error); Resolve never panics.
	Resolve(ctx context.Context, req ResolveRequest) Decision
	// Close releases resources. It must be idempotent and must return once
	// ctx is done even if the underlying vendor client would wait longer.
	Close(ctx context.Context) error
}

// TelemetryEvent is a normalized telemetry payload (exposure, signal,
// release transition) forwarded to a backend.
type TelemetryEvent struct {
	Name       string
	DistinctID string
	Properties map[string]any
}

// TelemetrySink is optionally implemented by adapters that can transport
// telemetry events. The Client discovers it via type assertion.
type TelemetrySink interface {
	EnqueueTelemetry(ctx context.Context, ev TelemetryEvent) error
	FlushTelemetry(ctx context.Context) error
}
