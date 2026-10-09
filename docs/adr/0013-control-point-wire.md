# ADR-0013: The wire and the envelopes say control point; 3.0.0

- **Status:** Accepted
- **Date:** 2026-10-06
- **Scope:** every SDK in `sdks/` (node, web, python, go, java, rust, dart, swift), `spec/`, `contracts/`, `test-server/`
- **Supersedes:** ADR-0007's four `flag` boundaries and its `flags` alias; ADR-0010's restatement of them (§"`flag` still stays at the four boundaries")
- **Related:** ADR-0005 (fw-server proxy backend), ADR-0012 (start profile)

## Context and Problem Statement

ADR-0007 made **control point** the product noun but kept `flag` at four boundaries it did not
own: the OpenFeature vocabulary, the fw-server wire (`POST /v1/flags/evaluate`, `flagKeys`,
`flagKey`), the canonical envelopes (`Decision.flagKey`, `Exposure.flagKey`, `Signal.flagKey`)
and `capabilities…features.flags`. It said retiring them needed its own major and its own ADR.

The wire boundary has since moved. fw-server renamed its runtime surface (platform decisions
Q30 and Q52): it serves `POST /v1/control-points/evaluate` with `controlPointKeys` in and
`controlPointKey` / `controlPointMetadata` out, accepts `controlPointKey` on `/v1/capture`, and
keeps the 2.x route and field names only as thin aliases for SDKs already published. The
OpenFeature provider is gone (ADR-0010), so only OpenFeature's error code names remain from that
boundary. Keeping `flagKey` in the SDK now means two vocabularies inside one product for no
external reason.

## Decision

From **3.0.0**, released together for all eight SDKs:

| Boundary | 2.x | 3.0.0 |
| --- | --- | --- |
| Evaluate route | `POST /v1/flags/evaluate` | `POST /v1/control-points/evaluate` |
| Evaluate request | `flagKeys` | `controlPointKeys` |
| Decision (wire and public type) | `flagKey`, `flagMetadata` | `controlPointKey`, `controlPointMetadata` (each language's casing) |
| Metadata keys | `fireweave.flagVersion`, `fireweave.vendorFlagId` | `fireweave.controlPointVersion`, `fireweave.vendorControlPointId` |
| Capture and signal envelopes | `events[].flagKey` | `events[].controlPointKey` |
| Error kind | `FlagNotFound` | `ControlPointNotFound` |
| Capabilities | `features.flags` (pinned `true`) | removed; `features.controlPoints` remains |
| Client alias | `client.flags` | removed; `client.controlPoints` remains |
| Start profile option (ADR-0012) | `flags` | `controlPoints` |
| Conformance fixture keys | `given.flags`, `when.flagKey`, `expect.flagMetadata` | `given.controlPoints`, `when.controlPointKey`, `expect.controlPointMetadata` |

**Stays:** OpenFeature's error code `FLAG_NOT_FOUND` in the mapping column of `errors.json`, and
PostHog's own vocabulary where the spec names PostHog (`/flags`, `$feature_flag_called`).

**Compatibility.** A 3.x SDK never sends the old names. fw-server keeps the 2.x aliases until no
supported SDK version calls them; their removal is fw-server's release, announced ahead. A 2.x
SDK keeps working against fw-server until then.

## Consequences

- Every rename above breaks the public API of each SDK, so all eight take one major together.
- The spec, the fixtures, the test server and every SDK change in one change, as GOVERNANCE
  requires for `spec/` and `contracts/**`.
- ADR-0007's guard that pinned the `flags` alias, and ADR-0010's restatement, no longer apply;
  their texts are kept and their status lines point here.
