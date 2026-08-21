// Package fireweave is the public façade of the Fireweave Go SDK.
//
// The actual implementation is layered — domain/ (pure types and
// validators), application/ (the runtime engine and Client surface), and
// infrastructure/adapters/{inmemory,local,remote} (the BackendAdapter
// implementations) — mirroring node's domain/application/infrastructure
// split (docs/architecture.md §layers) and the same split ratified for
// java (sdks/java, Task 8). This package re-exports the public surface
// those layers assemble into, via type aliases and thin wrapper functions,
// so:
//
//   - existing import paths for callers of this module stay
//     `github.com/FireWeave-HQ/fireweave-sdk/go/fireweave` — no
//     consumer-facing churn from the internal relayering;
//   - the layering itself stays real and mechanically enforced (a separate
//     Go package per directory is Go's only way to express "domain must not
//     import application/infrastructure" — there is no in-language
//     equivalent of a single package's internal folder boundaries), see the
//     architecture guard tests in this package;
//   - Init (the composition root, application/mode.go) is the only file
//     that imports concrete adapter implementations; this façade merely
//     forwards to it and never imports infrastructure/adapters itself.
//
// Exactly two v1 capabilities are exposed (spec/control-points.md "Scope of
// v1"): control points (Client.ControlPoints, the nine methods) and target
// registration (Client.RegisterTarget). Releases, exposures, signals,
// capabilities discovery and guardrails are out of v1 scope and are not
// exposed — enforced by the surface test in this package.
package fireweave

import (
	"github.com/FireWeave-HQ/fireweave-sdk/go/application"
	"github.com/FireWeave-HQ/fireweave-sdk/go/domain"
)

// --- domain: error taxonomy ---

type (
	ErrorKind = domain.ErrorKind
	Error     = domain.Error
)

const (
	KindNotReady              = domain.KindNotReady
	KindFlagNotFound          = domain.KindFlagNotFound
	KindTypeMismatch          = domain.KindTypeMismatch
	KindInvalidContext        = domain.KindInvalidContext
	KindAuthentication        = domain.KindAuthentication
	KindAuthorization         = domain.KindAuthorization
	KindRateLimited           = domain.KindRateLimited
	KindTimeout               = domain.KindTimeout
	KindNetwork               = domain.KindNetwork
	KindBackendUnavailable    = domain.KindBackendUnavailable
	KindMalformedResponse     = domain.KindMalformedResponse
	KindUnsupportedCapability = domain.KindUnsupportedCapability
	KindConfiguration         = domain.KindConfiguration
	KindAlreadyClosed         = domain.KindAlreadyClosed
	KindInternal              = domain.KindInternal
)

var (
	AllErrorKinds  = domain.AllErrorKinds
	DefaultMessage = domain.DefaultMessage
	Retryable      = domain.Retryable
	NewError       = domain.NewError
	Redact         = domain.Redact

	ErrNotReady              = domain.ErrNotReady
	ErrFlagNotFound          = domain.ErrFlagNotFound
	ErrTypeMismatch          = domain.ErrTypeMismatch
	ErrInvalidContext        = domain.ErrInvalidContext
	ErrAuthentication        = domain.ErrAuthentication
	ErrAuthorization         = domain.ErrAuthorization
	ErrRateLimited           = domain.ErrRateLimited
	ErrTimeout               = domain.ErrTimeout
	ErrNetwork               = domain.ErrNetwork
	ErrBackendUnavailable    = domain.ErrBackendUnavailable
	ErrMalformedResponse     = domain.ErrMalformedResponse
	ErrUnsupportedCapability = domain.ErrUnsupportedCapability
	ErrConfiguration         = domain.ErrConfiguration
	ErrAlreadyClosed         = domain.ErrAlreadyClosed
	ErrInternal              = domain.ErrInternal
)

// --- domain: decision / flag type / reason ---

type (
	FlagType = domain.FlagType
	Reason   = domain.Reason
	Decision = domain.Decision
)

const (
	FlagTypeBoolean = domain.FlagTypeBoolean
	FlagTypeString  = domain.FlagTypeString
	FlagTypeNumber  = domain.FlagTypeNumber
	FlagTypeObject  = domain.FlagTypeObject

	ReasonStatic         = domain.ReasonStatic
	ReasonDefault        = domain.ReasonDefault
	ReasonTargetingMatch = domain.ReasonTargetingMatch
	ReasonSplit          = domain.ReasonSplit
	ReasonCached         = domain.ReasonCached
	ReasonDisabled       = domain.ReasonDisabled
	ReasonStale          = domain.ReasonStale
	ReasonError          = domain.ReasonError

	MetaErrorKind    = domain.MetaErrorKind
	MetaFlagVersion  = domain.MetaFlagVersion
	MetaVendorFlagID = domain.MetaVendorFlagID
	MetaReasonCode   = domain.MetaReasonCode
	MetaQuotaLimited = domain.MetaQuotaLimited
	MetaFromCache    = domain.MetaFromCache
)

var ErrorDecision = domain.ErrorDecision

// --- domain: evaluation context ---

type (
	EvaluationContext = domain.EvaluationContext
	Limits            = domain.Limits
)

const (
	AttrGroups          = domain.AttrGroups
	AttrGroupProperties = domain.AttrGroupProperties
)

var (
	NewEvaluationContext = domain.NewEvaluationContext
	MergeContexts        = domain.MergeContexts
	DefaultLimits        = domain.DefaultLimits
)

// --- domain: mode / target kind ---

type (
	Mode       = domain.Mode
	TargetKind = domain.TargetKind
)

const (
	ModeLocal  = domain.ModeLocal
	ModeRemote = domain.ModeRemote

	TargetKindUser   = domain.TargetKindUser
	TargetKindDevice = domain.TargetKindDevice
)

// --- application: runtime ---

type (
	Config          = application.Config
	Runtime         = application.Runtime
	State           = application.State
	BackendAdapter  = application.BackendAdapter
	ResolveRequest  = application.ResolveRequest
	TargetRegistrar = application.TargetRegistrar
)

const (
	StateUninitialized = application.StateUninitialized
	StateInitializing  = application.StateInitializing
	StateReady         = application.StateReady
	StateStale         = application.StateStale
	StateError         = application.StateError
	StateFatal         = application.StateFatal
	StateShutdown      = application.StateShutdown
)

var NewRuntime = application.NewRuntime

// --- application: client ---

type (
	Client                = application.Client
	ControlPoints         = application.ControlPoints
	EvaluateOptions       = application.EvaluateOptions
	RegisterTargetOptions = application.RegisterTargetOptions
	RegisterTargetResult  = application.RegisterTargetResult
)

var NewClient = application.NewClient

// --- application: Init (the composition root; see application/mode.go) ---

type (
	Options      = application.Options
	LocalOptions = application.LocalOptions
)

// Init is the single SDK entry point (spec/modes.md). mode is required and
// never inferred: Init returns a non-nil error (Go's "throw") for every row
// of the initialisation-validation table. Reads on the returned *Client
// never return an error and never panic — failures degrade to the caller's
// default with Decision.Reason == ERROR (spec/control-points.md "Return
// discipline").
//
// Example:
//
//	client, err := fireweave.Init(fireweave.Options{
//	    Mode: fireweave.ModeLocal,
//	    Local: &fireweave.LocalOptions{ControlPoints: map[string]bool{"new-checkout": true}},
//	})
func Init(options Options) (*Client, error) {
	return application.Init(options)
}
