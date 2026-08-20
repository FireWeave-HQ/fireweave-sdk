package application

import "github.com/FireWeave-HQ/fireweave-sdk/sdks/go/domain"

// The BackendAdapter port and its request/result types live in domain (see
// domain/adapter.go's doc comment for why — a Go-specific, import-cycle-
// driven layout adjustment vs node/java, which file the equivalent port
// under application/ports.ts / application/BackendAdapter.java without
// creating a cycle, because their module systems resolve per file rather
// than per package). These aliases let the rest of this package (and its
// tests) refer to the port unqualified, exactly as if it lived here.
type (
	BackendAdapter        = domain.BackendAdapter
	ResolveRequest        = domain.ResolveRequest
	RegisterTargetOptions = domain.RegisterTargetOptions
	RegisterTargetResult  = domain.RegisterTargetResult
	TargetRegistrar       = domain.TargetRegistrar
)
