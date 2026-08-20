# ADR-0010: v1 is control points and target registration; the OpenFeature provider is retired

- **Status:** Accepted
- **Date:** 2026-08-20
- **Scope:** every SDK in `sdks/` — node, web, python, java, go, and the rust/swift additions
- **Supersedes:** ADR-0003's dual-surface decision ("Users may use only OF, or only FireweaveClient, or both")
- **Related:** ADR-0006 (node drops the direct PostHog adapter), ADR-0007 (control-point vocabulary), ADR-0009 (browser control points)

## Context and Problem Statement

ADR-0003 made OpenFeature and `FireweaveClient` two parallel faces on one runtime. That was
right while OpenFeature compatibility was the adoption story. Three things have changed it.

**The two faces are not two implementations.** `ControlPointsApi.getBooleanValue` and
`FireweaveProvider.resolveBooleanEvaluation` are each a five-line delegation to
`runtime.evaluate()`. The provider is 161 lines of translation, not a second evaluation path,
so keeping it costs a dependency and buys no isolation.

**The dependency was never free, and it was mandatory by accident.** Both npm packages
declared `peerDependencies` with an empty `peerDependenciesMeta`, so a consumer who only ever
called `controlPoints.*` was still told to install an OpenFeature SDK they never imported.

**The surface is expanding to seven languages.** Building the primary evaluation path on
OpenFeature means every language needs a mature OpenFeature SDK — a hard dependency on
another project's language coverage, precisely at the edge where rust and swift are being
added. `dependencies: {}` is what makes seven languages tractable; ADR-0003's shape did not
threaten that, but promoting OpenFeature to the internal evaluation path would.

The question this ADR settles is not whether control points are the product noun — ADR-0007
settled that — but whether Fireweave owns the evaluation path outright.

## Decision

**v1 exposes exactly two capabilities: control points and target registration.**

Removed from the SDK surface:

- `FireweaveProvider`, `FireweaveWebProvider`, and every language's OpenFeature bridge package
- `makeFireweaveLocalProvider` and the local-provider capture helpers
- the `releases`, `exposures`, `signals`, `capabilities` and `guardrails` namespaces
- the PostHog adapters that survived ADR-0006 in python, go and java

The control-point surface is fixed by `spec/control-points.md` — nine methods, including the
four `*Details` variants that no SDK implemented — and mode selection by `spec/modes.md`.
Both are enforced by `conformance/surface/`, which fails a language for a *missing method*
rather than only for a wrong value.

**`flag` still stays at the four boundaries ADR-0007 named** — the wire protocol, the
canonical envelopes, the conformance fixtures, and `capabilities.features.flags`. Removing
the OpenFeature *dependency* does not rename `flagKey`.

**OpenFeature compatibility is not forbidden, it is unbundled.** Nothing here prevents a
future optional bridge package that depends on both this SDK and an OpenFeature SDK. What is
retired is the bridge shipping *inside* the core, where every consumer pays for it.

## Consequences

**This is a major.** Removing public value exports breaks any consumer importing
`FireweaveProvider` or `makeFireweaveLocalProvider`. Combined with the
`@fireweaveai/sdk` → `@fireweaveai/server-sdk` rename, v1 ships as a new package name, and
`@fireweaveai/sdk` 2.1.0 is deprecated pointing at it.

**The v2 compatibility guard is retired here, deliberately.**
`packages/sdk/test/compat/v2-surface.compat.test.ts` and `v2-types.compat.ts` encode the
promise that a v2 application keeps working unedited. That promise is what this ADR breaks,
and the guard's own header prescribes the resolution: *"Either keep the surface, or retire it
deliberately in a major with its own ADR."* This is that ADR. The files are deleted rather
than edited — an assertion softened to pass would leave a guard that no longer guards
anything while still looking like one.

**Accepted cost — OpenFeature-standardised teams lose the drop-in path** until an optional
bridge exists. That is a real adoption cost and it is taken knowingly: the alternative is
every consumer in seven languages carrying a dependency so that some can skip a small
adapter.

**What this does not decide.** Whether the optional bridge gets built, and whether hooks,
lifecycle events and the cut namespaces return in v2. `spec/` names them as extension points
so their absence reads as scope rather than oversight.
