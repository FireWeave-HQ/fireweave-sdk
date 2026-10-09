# ADR-0007: "Control point" is the product noun; `flag` stays at fixed boundaries

- **Status:** Accepted; its `flag` wire, envelope and alias boundaries are superseded by ADR-0013 (3.0.0)
- **Date:** 2026-08-08
- **Scope:** Node SDK (`sdks/node`) and repo-level documentation. Python / Go / Java adopt the vocabulary when they next take a pass.
- **Related:** ADR-0003 (OpenFeature boundary), ADR-0006 (Node drops the direct PostHog adapter)

## Context and Problem Statement

The SDK was written as an OpenFeature-compatible feature-flag SDK, and its documentation led with that. That framing understates what the product does: flag evaluation is one capability beside target registration, release lifecycle, exposure recording, health/outcome signals, and capability discovery. "Feature flag" also names the mechanism rather than the job — the thing an operator reasons about is a **point of control over a release**, not a boolean.

So the product noun becomes **control point**. The question this ADR settles is not *whether* to rename, but *how far the rename may travel* — because "flag" is load-bearing in places that are not ours to name.

## Decision

Adopt **control point** as the product noun. The rename is **additive**: no existing name is removed or repurposed.

`flag` remains the term at four boundaries, each fixed by something outside this repo's control:

| Boundary | Term | Fixed by |
| --- | --- | --- |
| OpenFeature API — `getBooleanValue`, `flagKey`, `flagMetadata`, `FLAG_NOT_FOUND` | `flag` | the OpenFeature specification; renaming would break spec compliance and every consumer's provider wiring |
| Wire protocol — `POST /v1/flags/evaluate`, `flagKeys`, `flagKey` | `flag` | the fw-server contract, shared with the Python, Go, and Java SDKs |
| Canonical envelopes — `Decision.flagKey`, `Exposure.flagKey`, `Signal.flagKey` | `flag` | `spec/decision.schema.json` and siblings; 65 cross-language conformance fixtures assert these names |
| `capabilities…static.features.flags` | `flag` | `contracts/extensions/ext-capabilities-get.json` pins it `true` in all four languages |

What changes in the Node SDK:

- `FireweaveClient.controlPoints` is the documented namespace for evaluation.
- `FireweaveClient.flags` **remains**, as a getter returning the same object — `client.flags === client.controlPoints`. Marked `@deprecated` in JSDoc, which surfaces in editors without touching runtime behavior.
- `capabilities…features.controlPoints: true` is **added** beside the retained `flags: true`.
- `InMemoryAdapterOptions.flags`, `FlagValueType`, and `InMemoryFlagDefinition` are untouched: they sit on the testing path, and renaming them would break every consumer's test suite for no functional gain.
- Prose — README, docs, error guidance — says "control point".

## Deprecation policy

`client.flags` emits **no runtime warning by default**. A per-call `console.warn` in a server SDK becomes log spam at request volume, which is how deprecation notices get suppressed wholesale and then ignored. Instead: `@deprecated` JSDoc, plus one notice per process behind `FW_DEPRECATION_WARNINGS=1`.

**The alias is not scheduled for removal in v3.** Retiring it requires its own major and its own ADR superseding this one.

## Consequences

**Accepted cost — two vocabularies coexist.** Docs say "control point"; code says `flagKey`. That is more surface to explain, and it is the price of not breaking consumers. The mitigation is documentary, not technical: this table is the canonical answer to "which term applies where", so the duality reads as a decision rather than an unfinished refactor.

**Guard.** `sdks/node/test/unit/control-points-surface.test.ts` ("the deprecated flags alias shares identity with controlPoints") pins the alias. The broader v2 compatibility files this paragraph used to cite (`v2-surface.compat.test.ts`, `v2-types.compat.ts`) were retired deliberately by ADR-0010 along with the v2 surface they guarded.

**Explicit non-goal.** Renaming `flagKey` anywhere in `spec/`, the wire protocol, or the OpenFeature boundary. A future contributor reading this ADR should understand the rename is *complete*, not partially applied.
