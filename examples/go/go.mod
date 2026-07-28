module github.com/FireWeave-HQ/fireweave-sdk/examples/go

go 1.25.12

require (
	github.com/FireWeave-HQ/fireweave-sdk/sdks/go v0.0.0
	github.com/open-feature/go-sdk v1.17.2
)

require (
	github.com/andybalholm/brotli v1.1.1 // indirect
	github.com/go-logr/logr v1.4.3 // indirect
	github.com/goccy/go-json v0.10.5 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/hashicorp/golang-lru/v2 v2.0.7 // indirect
	github.com/klauspost/compress v1.17.11 // indirect
	github.com/posthog/posthog-go v1.22.0 // indirect
	go.uber.org/mock v0.6.0 // indirect
	golang.org/x/sys v0.21.0 // indirect
)

// The SDK module is not published yet; resolve it from the sibling path.
replace github.com/FireWeave-HQ/fireweave-sdk/sdks/go => ../../sdks/go
