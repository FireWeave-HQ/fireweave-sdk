// Package fireweave contains the shared Fireweave SDK runtime: the
// lifecycle state machine, evaluation-context handling, the typed error
// model, the BackendAdapter contract, and the FireweaveClient extension
// surface (releases, exposures, signals, guardrails, capabilities).
//
// # Concurrency
//
// All exported types in this package that carry mutable state (Runtime,
// Client) are safe for concurrent use by multiple goroutines. Value types
// (EvaluationContext, Decision, Error) are treated as immutable after
// construction; the SDK copies them at API boundaries instead of sharing
// references. The package holds no package-level mutable state.
package fireweave

import (
	"regexp"
)

// ErrorKind identifies one of the fifteen canonical Fireweave error kinds
// defined by contracts/errors.json. Kinds are PascalCase and stable across
// languages.
type ErrorKind string

const (
	KindNotReady              ErrorKind = "NotReady"
	KindFlagNotFound          ErrorKind = "FlagNotFound"
	KindTypeMismatch          ErrorKind = "TypeMismatch"
	KindInvalidContext        ErrorKind = "InvalidContext"
	KindAuthentication        ErrorKind = "Authentication"
	KindAuthorization         ErrorKind = "Authorization"
	KindRateLimited           ErrorKind = "RateLimited"
	KindTimeout               ErrorKind = "Timeout"
	KindNetwork               ErrorKind = "Network"
	KindBackendUnavailable    ErrorKind = "BackendUnavailable"
	KindMalformedResponse     ErrorKind = "MalformedResponse"
	KindUnsupportedCapability ErrorKind = "UnsupportedCapability"
	KindConfiguration         ErrorKind = "Configuration"
	KindAlreadyClosed         ErrorKind = "AlreadyClosed"
	KindInternal              ErrorKind = "Internal"
)

// AllErrorKinds lists every canonical kind. Useful for exhaustiveness tests.
var AllErrorKinds = []ErrorKind{
	KindNotReady, KindFlagNotFound, KindTypeMismatch, KindInvalidContext,
	KindAuthentication, KindAuthorization, KindRateLimited, KindTimeout,
	KindNetwork, KindBackendUnavailable, KindMalformedResponse,
	KindUnsupportedCapability, KindConfiguration, KindAlreadyClosed,
	KindInternal,
}

var defaultMessages = map[ErrorKind]string{
	KindNotReady:              "provider not ready",
	KindFlagNotFound:          "flag not found",
	KindTypeMismatch:          "flag type mismatch",
	KindInvalidContext:        "invalid evaluation context",
	KindAuthentication:        "authentication failed",
	KindAuthorization:         "authorization failed",
	KindRateLimited:           "rate limited",
	KindTimeout:               "request timed out",
	KindNetwork:               "network error",
	KindBackendUnavailable:    "backend unavailable",
	KindMalformedResponse:     "malformed backend response",
	KindUnsupportedCapability: "unsupported capability",
	KindConfiguration:         "invalid configuration",
	KindAlreadyClosed:         "provider already closed",
	KindInternal:              "internal error",
}

var retryableKinds = map[ErrorKind]bool{
	KindNotReady:           true,
	KindRateLimited:        true,
	KindTimeout:            true,
	KindNetwork:            true,
	KindBackendUnavailable: true,
}

// DefaultMessage returns the canonical safe message for a kind.
func DefaultMessage(kind ErrorKind) string {
	if m, ok := defaultMessages[kind]; ok {
		return m
	}
	return defaultMessages[KindInternal]
}

// Retryable reports whether the kind is classified transient/retryable by
// the canonical taxonomy.
func Retryable(kind ErrorKind) bool { return retryableKinds[kind] }

// Error is the typed Fireweave error. It supports errors.Is against the
// exported Err* sentinels (kind match) and errors.As for *Error. Messages
// never include secrets: they are passed through Redact at construction,
// and wrapped causes are reachable only via Unwrap (never interpolated).
type Error struct {
	Kind    ErrorKind
	Message string
	// TargetingKeyMissing marks InvalidContext errors caused specifically by
	// a missing targeting key; providers map these to the OpenFeature
	// TARGETING_KEY_MISSING error code instead of INVALID_CONTEXT.
	TargetingKeyMissing bool

	cause error
}

// NewError constructs a typed error. An empty message selects the canonical
// default message for the kind. The message is redacted defensively.
func NewError(kind ErrorKind, message string, cause error) *Error {
	if message == "" {
		message = DefaultMessage(kind)
	}
	return &Error{Kind: kind, Message: Redact(message), cause: cause}
}

func (e *Error) Error() string {
	return "fireweave: " + string(e.Kind) + ": " + e.Message
}

// Unwrap exposes the wrapped cause for errors.Is / errors.As chains.
func (e *Error) Unwrap() error { return e.cause }

// Is matches another *Error by kind, so errors.Is(err, fireweave.ErrTimeout)
// works regardless of message.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	if !ok {
		return false
	}
	return t.Kind == e.Kind && (t.Message == "" || t.Message == e.Message)
}

// Sentinel errors, one per canonical kind, for use with errors.Is.
var (
	ErrNotReady              = &Error{Kind: KindNotReady}
	ErrFlagNotFound          = &Error{Kind: KindFlagNotFound}
	ErrTypeMismatch          = &Error{Kind: KindTypeMismatch}
	ErrInvalidContext        = &Error{Kind: KindInvalidContext}
	ErrAuthentication        = &Error{Kind: KindAuthentication}
	ErrAuthorization         = &Error{Kind: KindAuthorization}
	ErrRateLimited           = &Error{Kind: KindRateLimited}
	ErrTimeout               = &Error{Kind: KindTimeout}
	ErrNetwork               = &Error{Kind: KindNetwork}
	ErrBackendUnavailable    = &Error{Kind: KindBackendUnavailable}
	ErrMalformedResponse     = &Error{Kind: KindMalformedResponse}
	ErrUnsupportedCapability = &Error{Kind: KindUnsupportedCapability}
	ErrConfiguration         = &Error{Kind: KindConfiguration}
	ErrAlreadyClosed         = &Error{Kind: KindAlreadyClosed}
	ErrInternal              = &Error{Kind: KindInternal}
)

// secretPatterns cover the canonical secret shapes from contracts/errors.json:
// PostHog project keys (phc_), personal keys (phx_), secret keys (phs_),
// bearer tokens, and the FW_PROJECT_API_KEY environment variable name.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`ph[cxs]_[A-Za-z0-9_-]*`),
	regexp.MustCompile(`Bearer\s+\S*`),
	regexp.MustCompile(`Bearer\s*`),
	regexp.MustCompile(`FW_PROJECT_API_KEY`),
}

// Redact removes secret material (API keys, bearer tokens) from a string.
// It is applied to every error message and telemetry string the SDK emits.
func Redact(s string) string {
	for _, re := range secretPatterns {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	return s
}
