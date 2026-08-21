module github.com/FireWeave-HQ/fireweave-sdk/examples/go

go 1.25.13

require github.com/FireWeave-HQ/fireweave-sdk/sdks/go v0.0.0

// The SDK module is not published yet; resolve it from the sibling path.
replace github.com/FireWeave-HQ/fireweave-sdk/sdks/go => ../../sdks/go
