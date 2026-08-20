// Package domain contains the Fireweave SDK's pure, dependency-free types and
// validation rules: the typed 15-kind error model, Decision/FlagType/Reason,
// EvaluationContext (merge + cycle-safe copy), the Validated-style validators
// (spec/control-points.md "Validation, before any I/O" and spec/modes.md
// "Initialisation validation"), Mode, and TargetKind.
//
// domain imports nothing from application/ or infrastructure/ — it is pure
// computation (no I/O, no ambient state), so it is reachable and testable
// offline, mirroring node's domain/ and java's ai.fireweave.sdk.domain
// package (docs/architecture.md §layers; the layering guard in the
// fireweave facade package enforces this mechanically).
package domain

import "regexp"

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
	// a missing targeting key.
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

// Is matches another *Error by kind, so errors.Is(err, domain.ErrTimeout)
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
// vendor project/personal/secret keys, bearer tokens, and the
// FW_PROJECT_API_KEY environment variable name.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`ph[cxs]_[A-Za-z0-9_-]*`),
	regexp.MustCompile(`Bearer\s+\S*`),
	regexp.MustCompile(`Bearer\s*`),
	regexp.MustCompile(`FW_PROJECT_API_KEY`),
}

// Redact removes secret material (API keys, bearer tokens) from a string.
// It is applied to every error message the SDK emits.
func Redact(s string) string {
	for _, re := range secretPatterns {
		s = re.ReplaceAllString(s, "[redacted]")
	}
	return s
}
